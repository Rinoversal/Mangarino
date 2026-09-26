/**
 * Everything the PC screen needs: the paired hub, finding and pairing, the hub's library, this
 * device's volumes, and a one-at-a-time transfer queue in both directions.
 *
 * Pairing, like a Bluetooth device: the screen looks for PCs on the Wi-Fi by itself, you tap
 * yours, and the PC asks "<this device> wants to connect" with an Allow button. Older hubs
 * (and the QR code) use the 6-digit code instead.
 */
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import { Directory } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { create } from 'zustand';

import { HUB_NAME } from '@/brand';
import { clearArchivePages } from '@/cache/pageCache';
import { applyArchivePanels, getAllSettings, listAllArchives, listProgressChangedSince, listSeries, setSetting } from '@/db/repo';
import { parsePanelsJson } from '@/library/panels';
import {
  DeviceKind,
  HubError,
  HubListing,
  PairAnswer,
  PcLink,
  askToPair,
  getLibrary,
  getPanels,
  getRequests,
  hello,
  pair,
  pairAnswer,
  postCatalog,
  unpair,
  withdrawPairRequest,
} from '@/pc/api';
import { Catalog, buildCatalog } from '@/pc/catalog';
import { CopyMode, copyPlan } from '@/pc/copyPlan';
import { FoundHub, findHubs, wifiInfo } from '@/pc/discover';
import { DeviceVolume, MatchedVolume, PcSeries, destinationFolder, deviceOnly, matchPcSeries, safeFolderName, seriesFolderOf } from '@/pc/match';
import { PairLink, formatBytes, isTailscaleIPv4 } from '@/pc/net';
import { syncProgress } from '@/pc/progressSync';
import { DeviceFullError, downloadVolume, isAbort, removeStalePartFiles, uploadCover, uploadVolume } from '@/pc/transfer';
import { fromFileUri, toFileUri } from '@/platform/paths';
import { useLibrary } from '@/store/library';
import { useSettings } from '@/store/settings';

export type PcPhase = 'loading' | 'unpaired' | 'searching' | 'asking' | 'pairing' | 'checking' | 'connected' | 'offline';

export interface TransferJob {
  key: string; // down:<pc volume id> | up:<archive id>
  kind: 'down' | 'up';
  file: string;
  series: string;
  bytes: number;
  total: number;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  note?: string;
  /** Downloaded, and the library is still adding it (the volume isn't listed on this device yet). */
  settling?: boolean;
  // downloads
  volumeId?: string;
  destFolder?: string;
  replacesArchiveId?: number;
  // uploads
  uri?: string;
  folder?: string;
  /** A copy kept on the PC by itself (not asked for on this screen). */
  auto?: boolean;
}

/** Waiting for someone to press Allow on the PC. */
export interface PairingAsk {
  hub: FoundHub;
  /** The number the PC shows too; null until the PC has the question. */
  match: string | null;
  expiresAt: number;
}

export interface CodeTarget {
  host: string;
  port: number;
  name: string;
}

interface PcSyncState {
  phase: PcPhase;
  link: PcLink | null;
  /** How the hub is reached right now: the home network, or Tailscale when away. */
  via: 'home' | 'tailscale' | null;
  deviceId: string;
  message: string | null;
  found: FoundHub[];
  sweep: { done: number; total: number } | null;
  /** A search has finished since the screen opened (so "no PC found" can be shown). */
  searched: boolean;
  /** Whether this device is on a Wi-Fi (home) network; null before the first check. */
  onWifi: boolean | null;
  asking: PairingAsk | null;
  /** Pair with the 6-digit code: an older hub, or chosen under "Other ways to connect". */
  codeFor: CodeTarget | null;
  listing: HubListing | null;
  device: DeviceVolume[];
  seriesTitles: Record<number, string>;
  seriesCovers: Record<number, string | null>;
  jobs: TransferJob[];
  /** What to keep a copy of on the PC, so it can be read there while this device is off. */
  copyMode: CopyMode;
  /** Archives whose panels came from the PC (archive id -> the PC file version they came from). */
  panelsFromPc: Record<number, string>;
  setCopyMode: (mode: CopyMode) => Promise<void>;
  /** While the app is open: let the PC see this library and ask for volumes (see startRemote). */
  startRemote: () => void;
  stopRemote: () => void;
  onFocus: () => Promise<void>;
  /** Sync reading progress with the PC if it can be reached; quiet, for app start and resume. */
  backgroundSync: (force?: boolean) => Promise<void>;
  connect: () => Promise<void>;
  search: () => Promise<void>;
  cancelSearch: () => void;
  requestPair: (hub: FoundHub) => Promise<void>;
  cancelAsk: () => void;
  setCodeFor: (target: CodeTarget | null) => void;
  pairWith: (host: string, port: number, code: string, remote?: string) => Promise<boolean>;
  pairFromLink: (p: PairLink) => Promise<boolean>;
  refresh: () => Promise<void>;
  loadDevice: () => Promise<void>;
  forget: () => Promise<void>;
  queueDownload: (v: MatchedVolume, series: PcSeries) => void;
  queueUpload: (d: DeviceVolume, opts?: { priority?: boolean; auto?: boolean }) => void;
  cancel: (key: string) => void;
  /** Stop the running transfer and drop the waiting ones. */
  cancelAll: () => void;
  clearFinished: () => void;
  setMessage: (m: string | null) => void;
}

let initialised = false;
let cleanedUp = false; // leftover .part files removed this session
let searchCancelled = false;
let searchRunning = false;
let queueRunning = false;
let syncing = false;
let lastSyncAt = 0;
let refreshMisses = 0; // library refreshes that failed in a row
const SYNC_EVERY_MS = 15000;
let current: { key: string; controller: AbortController } | null = null;
let askTicket = 0; // bumped to abandon the current ask
let remoteWanted = false; // the app is in the foreground
let remoteRunning = false;
let lastCatalogText = '';
let lastCatalogAt = 0;
let coverQueue: { id: number; uri: string }[] = [];
const copyTried = new Set<number>(); // queued for copying this session (a failed copy isn't retried by itself)
const CATALOG_EVERY_MS = 3 * 60 * 1000; // re-sent now and then, in case the PC restarted
const COVERS_PER_ROUND = 6;
const PANELS_PER_ROUND = 4;
const REQUEST_WAIT_S = 20;
let openAsk: { host: string; port: number; id: string } | null = null;

const deviceName = () => Device.deviceName || Device.modelName || 'Android device';
const deviceKind = (): DeviceKind => {
  switch (Device.deviceType) {
    case Device.DeviceType.PHONE:
      return 'phone';
    case Device.DeviceType.TABLET:
      return 'tablet';
    case Device.DeviceType.DESKTOP:
      return 'desktop';
    case Device.DeviceType.TV:
      return 'tv';
    default:
      return '';
  }
};
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { safeFolderName } from '@/pc/match';

function describe(e: unknown, pcName: string): string {
  if (e instanceof DeviceFullError) {
    return `Not enough space on this device: needs ${formatBytes(e.needed)}, ${formatBytes(e.free)} free.`;
  }
  if (e instanceof HubError) {
    switch (e.code) {
      case 'pc_full':
        return `${pcName}'s disk is full.`;
      case 'changed':
        return 'The file changed on the PC. Tap to try again.';
      case 'busy':
        return 'The PC is adding panels to this file. Try again in a moment.';
      case 'gone':
        return 'The file is no longer on the PC.';
      case 'not_paired':
        return 'The PC no longer knows this device. Connect again.';
      default:
        return `The PC refused it (${e.code}).`;
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /network|timeout|connect|socket|failed to fetch|unable to resolve|abort/i.test(msg) ? `Lost contact with ${pcName}.` : msg;
}

export const usePcSync = create<PcSyncState>((set, get) => {
  const updateJob = (key: string, patch: Partial<TransferJob>) =>
    set({ jobs: get().jobs.map((j) => (j.key === key ? { ...j, ...patch } : j)) });

  /** Load the saved PC link and this device's id, once. */
  const init = async () => {
    if (initialised) return;
    initialised = true;
    const all = await getAllSettings();
    let deviceId = all.pcDeviceId;
    if (!deviceId) {
      deviceId = randomId();
      await setSetting('pcDeviceId', deviceId);
    }
    let link: PcLink | null = null;
    try {
      link = all.pcLink ? (JSON.parse(all.pcLink) as PcLink) : null;
    } catch {
      link = null;
    }
    const copyMode: CopyMode = all.pcCopy === 'off' || all.pcCopy === 'all' ? all.pcCopy : 'reading';
    let panelsFromPc: Record<number, string> = {};
    try {
      panelsFromPc = all.pcPanels ? (JSON.parse(all.pcPanels) as Record<number, string>) : {};
    } catch {
      panelsFromPc = {};
    }
    set({ deviceId, link, copyMode, panelsFromPc, phase: link ? 'checking' : 'unpaired' });
  };

  const doSync = async (link: PcLink) => {
    if (syncing) return;
    syncing = true;
    try {
      const root = fromFileUri(useSettings.getState().settings.libraryRoot);
      const res = await syncProgress(link, root);
      lastSyncAt = Date.now();
      if (res.pulled > 0) void useLibrary.getState().refresh(); // "Continue reading" follows
    } catch {
      // the PC went away mid-sync; next time
    } finally {
      syncing = false;
    }
  };

  const saveLink = async (link: PcLink | null) => {
    await setSetting('pcLink', link ? JSON.stringify(link) : '');
    set({ link });
  };

  /** Paired: remember the PC and show its library. */
  const paired = async (link: PcLink, via: 'home' | 'tailscale') => {
    await saveLink(link);
    set({ phase: 'connected', via, found: [], listing: null, asking: null, codeFor: null, message: null, searched: false });
    await get().refresh();
    void get().loadDevice();
  };

  /** The paired PC if it answers now: at home first, then through Tailscale. */
  const reachablePc = async (): Promise<{ link: PcLink; via: 'home' | 'tailscale'; features: string[] } | null> => {
    const link = get().link;
    if (!link) return null;
    const home = await hello(link.host, link.port, 2500, link.token);
    if (home?.paired && home.serverId === link.serverId) return { link, via: 'home', features: home.features ?? [] };
    if (link.remoteHost) {
      const away = await hello(link.remoteHost, link.port, 5000, link.token);
      if (away?.paired && away.serverId === link.serverId) return { link: { ...link, host: link.remoteHost }, via: 'tailscale', features: away.features ?? [] };
    }
    return null;
  };

  /** Tell the PC what this device has (when it changed, and now and then), then send covers it lacks. */
  const publishCatalog = async (link: PcLink): Promise<Catalog> => {
    const catalog = await buildCatalog(fromFileUri(useSettings.getState().settings.libraryRoot));
    const text = JSON.stringify(catalog.series);
    if (text !== lastCatalogText || Date.now() - lastCatalogAt > CATALOG_EVERY_MS) {
      const res = await postCatalog(link, catalog.series);
      lastCatalogText = text;
      lastCatalogAt = Date.now();
      coverQueue = res.missingCovers.flatMap((id) => {
        const uri = catalog.covers.get(id);
        return uri ? [{ id, uri }] : [];
      });
    }
    for (const c of coverQueue.splice(0, COVERS_PER_ROUND)) await uploadCover(link, c.id, c.uri).catch(() => false);
    return catalog;
  };

  /** Copying uses the Wi-Fi and the screen stays on: only while charging or above 30%. */
  const batteryOk = async (): Promise<boolean> => {
    try {
      const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
      return state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL || level < 0 || level >= 0.3;
    } catch {
      return true;
    }
  };

  /** Keep copies on the PC as chosen: on the home network only, never through Tailscale. */
  const planCopies = async (link: PcLink, via: 'home' | 'tailscale', catalog: Catalog) => {
    const mode = get().copyMode;
    if (mode === 'off' || via !== 'home' || !(await batteryOk())) return;
    const res = await getLibrary(link, get().listing?.generation);
    if (!('unchanged' in res)) set({ listing: res });
    const listing = get().listing;
    if (!listing) return;
    await get().loadDevice();
    const device = get().device;
    const onlyHere = new Set(deviceOnly(listing.series, device).map((d) => d.archiveId));
    const plan = copyPlan(catalog.series, await listProgressChangedSince(0), mode);
    for (const id of plan) {
      if (!onlyHere.has(id) || copyTried.has(id)) continue;
      const d = device.find((x) => x.archiveId === id);
      if (!d) continue;
      copyTried.add(id);
      get().queueUpload(d, { auto: true });
    }
    // Copies that waited (away from home, low battery) carry on now that it's fine again.
    if (get().jobs.some((j) => j.state === 'queued')) void runQueue();
  };

  /**
   * Volumes this device has that the PC redid with the speech-bubble fix: take just their new
   * panel boxes (a few KB), instead of downloading the whole volume again.
   */
  const pullPanels = async (link: PcLink) => {
    const res = await getLibrary(link, get().listing?.generation).catch(() => null);
    if (res && !('unchanged' in res)) set({ listing: res });
    const listing = get().listing;
    if (!listing) return;
    if (!get().device.length) await get().loadDevice();
    const done = { ...get().panelsFromPc };
    let pulled = 0;
    for (const series of listing.series) {
      for (const v of matchPcSeries(series, get().device)) {
        if (pulled >= PANELS_PER_ROUND) break;
        // Same name, different file: the PC's copy was redone (an identical file has the same panels).
        if (!v.device || v.state !== 'changed' || v.panels !== 'ready' || done[v.device.archiveId] === v.version) continue;
        try {
          const res = await getPanels(link, v.id);
          const doc = parsePanelsJson(JSON.stringify(res.doc));
          if (doc && (await applyArchivePanels(v.device.archiveId, doc.pages)) > 0) {
            done[v.device.archiveId] = res.version;
            pulled++;
          }
        } catch {
          // not ready after all, or the PC went away: next round
        }
      }
    }
    if (pulled) {
      set({ panelsFromPc: done });
      await setSetting('pcPanels', JSON.stringify(done));
      void get().loadDevice();
    }
  };

  /** The link with the address that works right now (Tailscale when away from home). */
  const activeLink = (): PcLink | null => {
    const { link, via } = get();
    return link && via === 'tailscale' && link.remoteHost ? { ...link, host: link.remoteHost } : link;
  };

  /** Automatic copies (not ones you or the PC asked for) wait for home Wi-Fi and enough battery. */
  const autoCopyAllowed = async (): Promise<boolean> => {
    if (get().via === 'tailscale') return false;
    const wifi = await wifiInfo();
    return wifi.onWifi && (await batteryOk());
  };

  const runQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;
    await activateKeepAwakeAsync('pc-sync').catch(() => {});
    try {
      for (;;) {
        const queued = get().jobs.filter((j) => j.state === 'queued');
        const autoOk = queued.some((j) => j.auto) ? await autoCopyAllowed() : true;
        const job = queued.find((j) => !j.auto || autoOk);
        const link = activeLink();
        if (!job || !link) break;
        const controller = new AbortController();
        current = { key: job.key, controller };
        updateJob(job.key, { state: 'running', bytes: 0, note: undefined });
        let lastUi = 0;
        const onProgress = (bytes: number, total: number) => {
          const now = Date.now();
          if (now - lastUi > 250 || bytes >= total) {
            lastUi = now;
            updateJob(job.key, { bytes, total });
          }
        };
        try {
          if (job.kind === 'down') {
            const root = useSettings.getState().settings.libraryRoot.replace(/\/+$/, '');
            const dirPath = job.destFolder ? `${root}/${job.destFolder}` : root;
            await downloadVolume(link, job.volumeId!, { dirPath, fileName: job.file }, { signal: controller.signal, onProgress });
            if (job.replacesArchiveId) await clearArchivePages(job.replacesArchiveId);
            updateJob(job.key, { state: 'done', settling: true });
            void useLibrary
              .getState()
              .rescan()
              .then(() => get().loadDevice())
              .finally(() => updateJob(job.key, { settling: false }));
          } else {
            const res = await uploadVolume(link, { uri: job.uri!, file: job.file, size: job.total }, job.folder ?? '', {
              signal: controller.signal,
              onProgress,
            });
            updateJob(job.key, { state: 'done', note: res === 'exists' ? 'Already on the PC' : undefined });
            void get().refresh();
          }
        } catch (e) {
          if (isAbort(e)) {
            updateJob(job.key, { state: 'cancelled' });
          } else {
            updateJob(job.key, { state: 'failed', note: describe(e, link.name) });
            if (e instanceof DeviceFullError) {
              // every other download would fail the same way
              set({ jobs: get().jobs.map((j) => (j.kind === 'down' && j.state === 'queued' ? { ...j, state: 'cancelled' } : j)) });
            }
            if (e instanceof HubError && e.status === 401) {
              set({ jobs: get().jobs.map((j) => (j.state === 'queued' ? { ...j, state: 'cancelled' } : j)) });
              await saveLink(null);
              set({ phase: 'unpaired', listing: null, message: 'The PC no longer knows this device. Connect again.' });
              break;
            }
          }
        } finally {
          current = null;
        }
      }
    } finally {
      queueRunning = false;
      deactivateKeepAwake('pc-sync').catch(() => {});
    }
  };

  return {
    phase: 'loading',
    link: null,
    via: null,
    deviceId: '',
    message: null,
    found: [],
    sweep: null,
    searched: false,
    onWifi: null,
    asking: null,
    codeFor: null,
    listing: null,
    device: [],
    seriesTitles: {},
    seriesCovers: {},
    jobs: [],
    copyMode: 'reading',
    panelsFromPc: {},

    async setCopyMode(mode) {
      await setSetting('pcCopy', mode);
      set({ copyMode: mode });
      if (mode === 'off') set({ jobs: get().jobs.filter((j) => !(j.auto && j.state === 'queued')) });
      else copyTried.clear();
    },

    /**
     * While the app is open and the paired PC can be reached: keep the PC's view of this library
     * current, keep copies there as chosen, and send any volume the PC asks for, first.
     */
    startRemote() {
      remoteWanted = true;
      if (remoteRunning) return;
      remoteRunning = true;
      void (async () => {
        try {
          await init();
          while (remoteWanted) {
            const pc = await reachablePc();
            if (!pc || !pc.features.includes('catalog')) {
              await sleep(pc ? 60000 : 15000); // not reachable now, or an older hub
              continue;
            }
            if (get().via !== pc.via) set({ via: pc.via });
            try {
              const catalog = await publishCatalog(pc.link);
              await planCopies(pc.link, pc.via, catalog);
              if (pc.features.includes('panel-data')) await pullPanels(pc.link);
              const { requests } = await getRequests(pc.link, REQUEST_WAIT_S);
              if (requests.length) await get().loadDevice();
              for (const r of requests) {
                const d = get().device.find((x) => x.archiveId === r.volumeId);
                if (r.kind === 'send' && d && d.kind === 'cbz') get().queueUpload(d, { priority: true });
              }
            } catch (e) {
              if (e instanceof HubError && e.status === 401) {
                get().cancelAll();
                await saveLink(null);
                set({ phase: 'unpaired', listing: null, message: 'The PC no longer knows this device. Connect again.' });
              }
              await sleep(5000);
            }
          }
        } finally {
          remoteRunning = false;
        }
      })();
    },

    stopRemote() {
      remoteWanted = false;
    },

    setMessage: (m) => set({ message: m }),
    setCodeFor: (target) => set({ codeFor: target, message: null }),

    async backgroundSync(force = false) {
      if (syncing || (!force && Date.now() - lastSyncAt < SYNC_EVERY_MS)) return;
      await init();
      const link = get().link;
      if (!link) return;
      const home = await hello(link.host, link.port, 2000, link.token);
      if (home?.paired) {
        await doSync(link);
        return;
      }
      if (link.remoteHost) {
        const away = await hello(link.remoteHost, link.port, 5000, link.token);
        if (away?.paired) await doSync({ ...link, host: link.remoteHost });
      }
    },

    async onFocus() {
      await init();
      if (!cleanedUp) {
        cleanedUp = true;
        // Temp files from a transfer the app didn't finish (killed or crashed).
        try {
          const root = new Directory(toFileUri(useSettings.getState().settings.libraryRoot));
          if (root.exists) {
            const dirs = [root, ...root.list().filter((x): x is Directory => x instanceof Directory)];
            removeStalePartFiles(dirs);
          }
        } catch {
          // no access yet
        }
      }
      await get().loadDevice();
      const { link, phase } = get();
      if (link && phase !== 'connected') await get().connect();
      else if (link) await get().refresh();
      else if (phase === 'unpaired' || phase === 'loading') void get().search(); // find the PC straight away
    },

    async connect() {
      const link = get().link;
      if (!link) return;
      set({ phase: 'checking', message: null });
      // Home network first (fast), then Tailscale (from anywhere).
      const routes: ['home' | 'tailscale', string, number][] = [['home', link.host, 3000]];
      if (link.remoteHost) routes.push(['tailscale', link.remoteHost, 6000]);
      for (const [via, host, ms] of routes) {
        const h = await hello(host, link.port, ms, link.token);
        if (!h || h.serverId !== link.serverId) continue;
        if (!h.paired) {
          get().cancelAll();
          await saveLink(null);
          set({ phase: 'unpaired', via: null, listing: null, message: `${link.name} no longer knows this device. Connect again.` });
          void get().search();
          return;
        }
        if (h.name && h.name !== link.name) await saveLink({ ...link, name: h.name }); // renamed on the PC
        set({ phase: 'connected', via });
        await get().refresh();
        return;
      }
      // The PC may have a new address, or both may be on another Wi-Fi now: look for the same
      // hub on this network (private networks only; it stops as soon as that PC answers).
      const wifi = await wifiInfo();
      if (wifi.ip) {
        const found = await findHubs({ ownIp: wifi.ip, preferred: [link.host], stopAt: link.serverId });
        const same = found.find((f) => f.serverId === link.serverId);
        if (same && (same.host !== link.host || same.port !== link.port)) {
          await saveLink({ ...link, host: same.host, port: same.port });
          return get().connect();
        }
      }
      set({
        phase: 'offline',
        via: null,
        onWifi: wifi.onWifi,
        message: link.remoteHost
          ? `Can't reach ${link.name}, at home or through Tailscale. Is ${HUB_NAME} running, and Tailscale on on both devices?`
          : wifi.onWifi
            ? `Can't reach ${link.name}. Is ${HUB_NAME} running on it, on this Wi-Fi?`
            : 'Connect this device to the same Wi-Fi as your PC.',
      });
    },

    async search() {
      if (searchRunning) return;
      const wifi = await wifiInfo();
      if (!wifi.ip) {
        set({ onWifi: false, searched: true, found: [], sweep: null, phase: get().link ? get().phase : 'unpaired' });
        return;
      }
      searchRunning = true;
      searchCancelled = false;
      const pairedAlready = !!get().link;
      set({ phase: pairedAlready ? get().phase : 'searching', onWifi: true, found: [], sweep: { done: 0, total: 253 }, searched: false });
      let lastUi = 0;
      try {
        await findHubs({
          ownIp: wifi.ip,
          preferred: [get().link?.host],
          isCancelled: () => searchCancelled,
          onFound: (hub) => set({ found: [...get().found, hub] }),
          onProgress: (done, total) => {
            const now = Date.now();
            if (now - lastUi > 200 || done === total) {
              lastUi = now;
              set({ sweep: { done, total } });
            }
          },
        });
      } finally {
        searchRunning = false;
        // Tapping a PC mid-search moves on to asking: leave that alone.
        set({ sweep: null, searched: true, phase: get().phase === 'searching' ? 'unpaired' : get().phase });
      }
    },

    cancelSearch() {
      searchCancelled = true;
    },

    async requestPair(hub) {
      if (!hub.canApprove) {
        // An older Mangarino Hub: it pairs with the code on its screen.
        set({ codeFor: { host: hub.host, port: hub.port, name: hub.name }, message: null });
        return;
      }
      const ticket = ++askTicket;
      searchCancelled = true; // it's found: no need to keep looking
      set({ phase: 'asking', asking: { hub, match: null, expiresAt: Date.now() + 120000 }, codeFor: null, message: null });
      let requestId: string;
      try {
        const ask = await askToPair(hub.host, hub.port, get().deviceId, deviceName(), deviceKind());
        requestId = ask.requestId;
        if (ticket !== askTicket) {
          void withdrawPairRequest(hub.host, hub.port, requestId);
          return;
        }
        openAsk = { host: hub.host, port: hub.port, id: requestId };
        set({ asking: { hub, match: ask.match, expiresAt: Date.now() + ask.expiresMs } });
      } catch (e) {
        if (ticket !== askTicket) return;
        let message = `Couldn't reach ${hub.name}. Is ${HUB_NAME} still open on it?`;
        if (e instanceof HubError) {
          if (e.code === 'denied_recently') message = `${hub.name} said no a moment ago. Try again in ${Number(e.detail.retryAfterS ?? 30)} seconds.`;
          else if (e.code === 'busy') message = `${hub.name} has other devices waiting to connect. Try again in a minute.`;
          else if (e.status === 404) {
            set({ phase: 'unpaired', asking: null, codeFor: { host: hub.host, port: hub.port, name: hub.name } });
            return;
          }
        }
        set({ phase: 'unpaired', asking: null, message });
        return;
      }
      for (;;) {
        let answer: PairAnswer;
        try {
          answer = await pairAnswer(hub.host, hub.port, requestId, 10);
        } catch {
          if (ticket !== askTicket) return;
          const asking = get().asking;
          if (!asking || Date.now() > asking.expiresAt) answer = { state: 'expired' };
          else {
            await sleep(1500); // Wi-Fi hiccup: keep waiting
            continue;
          }
        }
        if (ticket !== askTicket) return;
        if (answer.state === 'pending') continue;
        openAsk = null;
        if (answer.state === 'approved') {
          await paired({ host: hub.host, port: hub.port, token: answer.token, serverId: answer.serverId, name: answer.name }, 'home');
          return;
        }
        set({
          phase: 'unpaired',
          asking: null,
          message:
            answer.state === 'denied'
              ? `${hub.name} didn't allow this device.`
              : `No answer from ${hub.name}. Tap it to ask again, then choose Allow on the PC.`,
        });
        return;
      }
    },

    cancelAsk() {
      askTicket++;
      const ask = openAsk;
      openAsk = null;
      if (ask) void withdrawPairRequest(ask.host, ask.port, ask.id);
      set({ phase: 'unpaired', asking: null });
    },

    async pairWith(host, port, code, remote) {
      set({ phase: 'pairing', message: null });
      try {
        const link = await pair(host, port, code, get().deviceId, deviceName(), deviceKind());
        // Pairing over Tailscale: remember that address for away, and learn the home one later.
        const remoteHost = remote ?? (isTailscaleIPv4(host) ? host : undefined);
        await paired({ ...link, ...(remoteHost ? { remoteHost } : {}) }, isTailscaleIPv4(host) ? 'tailscale' : 'home');
        return true;
      } catch (e) {
        let message = "Couldn't reach that PC.";
        if (e instanceof HubError) {
          if (e.code === 'bad_code') {
            const left = Number(e.detail.attemptsLeft ?? 0);
            message = `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
          } else if (e.code === 'code_changed') message = 'Too many wrong codes, so the PC is showing a new one.';
          else message = `The PC refused to pair (${e.code}).`;
        }
        set({ phase: 'unpaired', message });
        return false;
      }
    },

    async pairFromLink(p) {
      await init(); // a link can open the app straight onto this screen
      // At home the home address answers; away, only the Tailscale one can.
      set({ phase: 'pairing', message: null });
      const home = await hello(p.host, p.port, 2500);
      const host = !home && p.remote && (await hello(p.remote, p.port, 6000)) ? p.remote : p.host;
      if (!home && host === p.host) {
        set({
          phase: get().link ? get().phase : 'unpaired',
          message: `Found the QR code, but can't reach the PC at ${p.host}. Check both are on the same Wi-Fi, and press "Fix firewall" in ${HUB_NAME}'s settings.`,
        });
        return false;
      }
      return get().pairWith(host, p.port, p.code, p.remote);
    },

    async refresh() {
      const link = activeLink();
      if (!link) return;
      try {
        const res = await getLibrary(link, get().listing?.generation);
        refreshMisses = 0;
        if (!('unchanged' in res)) set({ listing: res });
        if (get().phase !== 'connected') set({ phase: 'connected', message: null });
        if (Date.now() - lastSyncAt > SYNC_EVERY_MS) void doSync(link);
      } catch (e) {
        if (e instanceof HubError && e.status === 401) {
          get().cancelAll();
          await saveLink(null);
          set({ phase: 'unpaired', listing: null, message: 'The PC no longer knows this device. Connect again.' });
          void get().search();
        } else if (++refreshMisses >= 2) {
          set({ phase: 'offline', message: `Lost contact with ${link.name}.` });
        }
      }
    },

    async loadDevice() {
      const root = fromFileUri(useSettings.getState().settings.libraryRoot);
      const [archives, series] = await Promise.all([listAllArchives(), listSeries()]);
      const titles: Record<number, string> = {};
      const covers: Record<number, string | null> = {};
      for (const s of series) {
        titles[s.id] = s.title_override ?? s.title;
        covers[s.id] = s.cover_uri;
      }
      const rootNorm = root.replace(/\/+$/, '').toLowerCase() + '/';
      const device: DeviceVolume[] = archives.map((a) => ({
        archiveId: a.id,
        seriesId: a.series_id,
        uri: a.uri,
        folder: seriesFolderOf(a.uri, root),
        file: a.file_name,
        size: a.size,
        hasPanels: a.has_panels === 1,
        kind: a.kind,
        underRoot: fromFileUri(a.uri).toLowerCase().startsWith(rootNorm),
      }));
      set({ device, seriesTitles: titles, seriesCovers: covers });
    },

    async forget() {
      get().cancelAll();
      const link = get().link;
      if (link) await unpair(link);
      await saveLink(null);
      set({ phase: 'unpaired', via: null, listing: null, found: [], message: null, searched: false });
      void get().search();
    },

    queueDownload(v, series) {
      const key = `down:${v.id}`;
      if (get().jobs.some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'))) return;
      const folders = [...new Set(get().device.filter((d) => d.underRoot && d.folder).map((d) => d.folder))];
      const job: TransferJob = {
        key,
        kind: 'down',
        file: v.file,
        series: series.title,
        bytes: 0,
        total: v.size,
        state: 'queued',
        volumeId: v.id,
        destFolder: series.folder ? destinationFolder(series.folder, folders) : '',
        replacesArchiveId: v.state === 'changed' ? v.device?.archiveId : undefined,
      };
      set({ jobs: [...get().jobs.filter((j) => j.key !== key), job] });
      void runQueue();
    },

    queueUpload(d, opts = {}) {
      const key = `up:${d.archiveId}`;
      const existing = get().jobs.find((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
      if (existing) {
        // Asked for by the PC: move it to the front of the queue.
        if (opts.priority && existing.state === 'queued') set({ jobs: [existing, ...get().jobs.filter((j) => j !== existing)] });
        return;
      }
      const title = get().seriesTitles[d.seriesId] ?? '';
      const job: TransferJob = {
        key,
        kind: 'up',
        file: d.file,
        series: title,
        bytes: 0,
        total: d.size,
        state: 'queued',
        uri: d.uri,
        folder: d.underRoot ? d.folder : safeFolderName(title),
        auto: opts.auto,
      };
      const others = get().jobs.filter((j) => j.key !== key);
      set({ jobs: opts.priority ? [job, ...others] : [...others, job] });
      void runQueue();
    },

    cancel(key) {
      if (current?.key === key) current.controller.abort();
      else updateJob(key, { state: 'cancelled' });
    },

    cancelAll() {
      current?.controller.abort();
      set({ jobs: get().jobs.map((j) => (j.state === 'queued' ? { ...j, state: 'cancelled' } : j)) });
    },

    clearFinished() {
      set({ jobs: get().jobs.filter((j) => j.state === 'queued' || j.state === 'running') });
    },
  };
});
