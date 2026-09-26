/**
 * Talking to Mangarino Hub (tools/hub). JSON only: files move with expo-file-system's
 * download and upload, which stream to and from disk.
 */
import type { CatalogSeries } from './copyPlan';
import type { PcSeries } from './match';

export interface PcLink {
  host: string; // the hub's home-network address
  port: number;
  token: string;
  serverId: string;
  name: string;
  remoteHost?: string; // its Tailscale address, for away from home
}

export interface HubHello {
  service: 'mangarino-hub';
  api: number;
  version: string;
  serverId: string;
  name: string;
  serverMs: number;
  paired: boolean;
  /** What this hub can do; "approve" = pairing by pressing Allow on the PC (hub 0.2 and later). */
  features?: string[];
}

export interface HubListing {
  generation: number;
  rootName: string;
  series: PcSeries[];
  panels?: { state: string; device: string; queued: number };
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'HubError';
  }
}

export const hubBase = (host: string, port: number) => `http://${host}:${port}`;
export const authHeaders = (link: PcLink): Record<string, string> => ({ Authorization: `Bearer ${link.token}` });

/** fetch with a deadline. React Native's fetch has no timeout of its own. */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function json<T>(res: Response): Promise<T> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty or not JSON
  }
  if (!res.ok) throw new HubError(res.status, String(body.error ?? res.status), body);
  return body as T;
}

/** Who answers at this address, or null (nobody, not a hub, or too slow). */
export async function hello(host: string, port: number, ms = 800, token?: string): Promise<HubHello | null> {
  try {
    const res = await fetchWithTimeout(`${hubBase(host, port)}/api/hello`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, ms);
    if (!res.ok) return null;
    const body = (await res.json()) as HubHello;
    return body.service === 'mangarino-hub' ? body : null;
  } catch {
    return null;
  }
}

export async function pair(
  host: string,
  port: number,
  code: string,
  deviceId: string,
  deviceName: string,
  deviceKind: DeviceKind = '',
): Promise<PcLink> {
  const res = await fetchWithTimeout(
    `${hubBase(host, port)}/api/pair`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceId, deviceName, deviceKind }) },
    8000,
  );
  const body = await json<{ token: string; serverId: string; name: string }>(res);
  return { host, port, token: body.token, serverId: body.serverId, name: body.name };
}

export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'tv' | '';

export interface PairAsk {
  requestId: string;
  /** Shown on this device and on the PC, so the person at the PC can tell it's really this device. */
  match: string;
  expiresMs: number;
  serverId: string;
  name: string;
}

/** Ask the PC to pair; it shows "<device> wants to connect" with an Allow button. */
export async function askToPair(host: string, port: number, deviceId: string, deviceName: string, deviceKind: DeviceKind): Promise<PairAsk> {
  const res = await fetchWithTimeout(
    `${hubBase(host, port)}/api/pair-request`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, deviceName, deviceKind }) },
    8000,
  );
  return json<PairAsk>(res);
}

export type PairAnswer =
  | { state: 'pending' | 'denied' | 'expired' }
  | { state: 'approved'; token: string; serverId: string; name: string };

/** The PC's answer, waiting up to `waitS` seconds for someone to press Allow or Don't allow. */
export async function pairAnswer(host: string, port: number, requestId: string, waitS = 10): Promise<PairAnswer> {
  const res = await fetchWithTimeout(
    `${hubBase(host, port)}/api/pair-request/${encodeURIComponent(requestId)}?wait=${waitS}`,
    {},
    (waitS + 6) * 1000,
  );
  return json<PairAnswer>(res);
}

/** Stop asking (the PC's question disappears). */
export async function withdrawPairRequest(host: string, port: number, requestId: string): Promise<void> {
  await fetchWithTimeout(`${hubBase(host, port)}/api/pair-request/${encodeURIComponent(requestId)}`, { method: 'DELETE' }, 4000).catch(() => {});
}

export async function unpair(link: PcLink): Promise<void> {
  await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/pair`, { method: 'DELETE', headers: authHeaders(link) }, 5000).catch(() => {});
}

export async function getLibrary(link: PcLink, since?: number): Promise<HubListing | { generation: number; unchanged: true }> {
  const q = since ? `?since=${since}` : '';
  return json(await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/library${q}`, { headers: authHeaders(link) }, 10000));
}

/**
 * Ask the hub to get a volume ready (spin up its disk, pack a folder volume) before the real
 * download, whose read timeout is short. Returns the size and version to download.
 */
export async function warmUp(link: PcLink, id: string): Promise<{ size: number; version: string; panels: string }> {
  return json(await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/volume/${encodeURIComponent(id)}`, { headers: authHeaders(link) }, 120000));
}

export interface SyncedProgress {
  key: string;
  page: number;
  panel: number | null;
  completed: boolean;
  updatedMs: number;
}

export async function getProgress(link: PcLink, since: number): Promise<{ rev: number; rows: SyncedProgress[] }> {
  return json(await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/progress?since=${since}`, { headers: authHeaders(link) }, 10000));
}

export async function postProgress(link: PcLink, rows: SyncedProgress[]): Promise<{ rev: number; accepted: number }> {
  return json(
    await fetchWithTimeout(
      `${hubBase(link.host, link.port)}/api/progress`,
      { method: 'POST', headers: { ...authHeaders(link), 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) },
      10000,
    ),
  );
}

/** This device's library, for the PC to show. Returns the volumes whose covers the PC lacks. */
export async function postCatalog(link: PcLink, series: CatalogSeries[]): Promise<{ missingCovers: number[] }> {
  return json(
    await fetchWithTimeout(
      `${hubBase(link.host, link.port)}/api/catalog`,
      { method: 'POST', headers: { ...authHeaders(link), 'Content-Type': 'application/json' }, body: JSON.stringify({ series }) },
      20000,
    ),
  );
}

export interface PcRequest {
  id: string;
  kind: 'send';
  volumeId: number;
}

/** The PC's requests for this device (it wants to read a volume), waiting up to `waitS` seconds. */
export async function getRequests(link: PcLink, waitS: number): Promise<{ requests: PcRequest[] }> {
  return json(
    await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/requests?wait=${waitS}`, { headers: authHeaders(link) }, (waitS + 8) * 1000),
  );
}

/** A PC volume's panel boxes, once the PC made them with the speech-bubble fix (409 before). */
export async function getPanels(link: PcLink, pcVolumeId: string): Promise<{ version: string; doc: unknown }> {
  return json(await fetchWithTimeout(`${hubBase(link.host, link.port)}/api/panels/${encodeURIComponent(pcVolumeId)}`, { headers: authHeaders(link) }, 20000));
}

export const deviceCoverUrl = (link: PcLink, archiveId: number) => `${hubBase(link.host, link.port)}/api/device-cover/${archiveId}`;

/** A small cover image (the hub shrinks the first page); needs authHeaders(link). */
export const coverUrl = (link: PcLink, id: string, version: string) =>
  `${hubBase(link.host, link.port)}/api/cover/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`;

export const fileUrl = (link: PcLink, id: string, version: string) =>
  `${hubBase(link.host, link.port)}/api/file/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`;

export const uploadUrl = (link: PcLink, folder: string, file: string, size: number) =>
  `${hubBase(link.host, link.port)}/api/upload?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}&size=${size}`;
