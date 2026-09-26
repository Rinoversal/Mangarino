import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { APP_NAME, APP_SCHEME, BRAND_HUB_PORT, HUB_NAME } from '@/brand';
import { archiveLabel, parseArchiveName } from '@/library/parse';
import { PcLink, authHeaders, coverUrl } from '@/pc/api';
import { CopyMode } from '@/pc/copyPlan';
import { FoundHub } from '@/pc/discover';
import { DeviceVolume, MatchedVolume, PcSeries, deviceOnly, matchPcSeries, updateReason } from '@/pc/match';
import { formatBytes, parseManualAddress, parsePairLink } from '@/pc/net';
import { QrScanModal } from '@/pc/QrScanModal';
import { TransferJob, usePcSync } from '@/store/pcSync';
import { Icon } from '@/ui/Icon';
import { readableColumn } from '@/ui/layout';
import { colors, radius, spacing } from '@/ui/theme';

type Row = { kind: 'pc'; v: MatchedVolume; series: PcSeries } | { kind: 'dev'; d: DeviceVolume };

interface Section {
  key: string;
  title: string;
  subtitle: string;
  data: Row[];
  cover: { uri: string; headers?: Record<string, string>; cacheKey?: string } | null;
  have: number;
  total: number;
  action?: { label: string; run: () => void };
  done?: boolean;
  firstDeviceOnly?: boolean;
}

const label = (file: string) => archiveLabel(parseArchiveName(file), file);

/** A volume whose redone panels this device already took from the PC counts as here. */
function matchWithPanels(series: PcSeries, device: DeviceVolume[], fromPc: Record<number, string>): MatchedVolume[] {
  return matchPcSeries(series, device).map((v) =>
    v.state === 'changed' && v.device && fromPc[v.device.archiveId] === v.version ? { ...v, state: 'onDevice' as const } : v,
  );
}

/** The PC's address that works right now: its Tailscale one when away from home. */
function reachable(link: PcLink, via: 'home' | 'tailscale' | null): PcLink {
  return via === 'tailscale' && link.remoteHost ? { ...link, host: link.remoteHost } : link;
}

// ---------------------------------------------------------------------------- small pieces
function Button({
  title,
  onPress,
  kind = 'ghost',
  small,
  disabled,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: 'accent' | 'ghost' | 'quiet';
  small?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  const fg = kind === 'accent' ? colors.accentText : kind === 'quiet' ? colors.muted : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        kind === 'accent' && styles.buttonAccent,
        kind === 'quiet' && styles.buttonQuiet,
        small && styles.buttonSmall,
        (pressed || disabled) && styles.dim,
      ]}>
      {icon ? <Icon name={icon} size={small ? 16 : 18} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }, small && styles.buttonTextSmall]}>{title}</Text>
    </Pressable>
  );
}

function Bar({ fraction, thin }: { fraction: number; thin?: boolean }) {
  return (
    <View style={[styles.bar, thin && styles.barThin]}>
      <View style={[styles.barFill, { width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }]} />
    </View>
  );
}

/** Rings spreading out from the PC icon while the Wi-Fi is searched. */
function Radar() {
  const a = useRef(new Animated.Value(0)).current;
  const b = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const ring = (v: Animated.Value) =>
      Animated.loop(Animated.timing(v, { toValue: 1, duration: 2200, easing: Easing.out(Easing.cubic), useNativeDriver: true }));
    const ra = ring(a);
    const rb = ring(b);
    ra.start();
    const t = setTimeout(() => rb.start(), 1100);
    return () => {
      clearTimeout(t);
      ra.stop();
      rb.stop();
    };
  }, [a, b]);
  const ringStyle = (v: Animated.Value) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.7, 2.1] }) }],
  });
  return (
    <View style={styles.radar}>
      <Animated.View style={[styles.radarRing, ringStyle(a)]} />
      <Animated.View style={[styles.radarRing, ringStyle(b)]} />
      <View style={styles.radarCore}>
        <Icon name="laptop_windows" size={30} color={colors.accentSoft} />
      </View>
    </View>
  );
}

/** Three dots passing from this device to the PC. */
function Dots() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 3, duration: 1500, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { opacity: v.interpolate({ inputRange: [0, i, i + 0.5, i + 1, 3], outputRange: [0.25, 0.25, 1, 0.25, 0.25], extrapolate: 'clamp' }) },
          ]}
        />
      ))}
    </View>
  );
}

function Glyph({ name, online, size = 56 }: { name: React.ComponentProps<typeof Icon>['name']; online?: boolean | null; size?: number }) {
  return (
    <View style={[styles.glyph, { width: size, height: size, borderRadius: size * 0.3 }]}>
      <Icon name={name} size={size * 0.5} color={colors.accentSoft} />
      {online != null ? <View style={[styles.glyphDot, { backgroundColor: online ? colors.success : colors.danger }]} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------- the top card
function AskingCard() {
  const asking = usePcSync((s) => s.asking);
  const { cancelAsk } = usePcSync.getState();
  if (!asking) return null;
  return (
    <View style={[styles.hero, styles.heroCenter, styles.heroLit]}>
      <View style={styles.pairArt}>
        <Glyph name="tablet_android" size={52} />
        <Dots />
        <Glyph name="laptop_windows" size={52} />
      </View>
      <Text style={styles.heroTitle}>Choose Allow on {asking.hub.name}</Text>
      <Text style={[styles.heroText, styles.center]}>{HUB_NAME} on your PC is asking whether this device can connect.</Text>
      <View style={styles.matchBox}>
        <Text style={styles.matchLabel}>It shows the same number</Text>
        {asking.match ? <Text style={styles.matchDigits}>{asking.match.split('').join(' ')}</Text> : <ActivityIndicator color={colors.accent} />}
      </View>
      <Button title="Cancel" onPress={cancelAsk} />
    </View>
  );
}

function FoundRow({ hub }: { hub: FoundHub }) {
  const { requestPair } = usePcSync.getState();
  return (
    <Pressable onPress={() => void requestPair(hub)} style={({ pressed }) => [styles.foundRow, pressed && styles.foundRowPressed]}>
      <Glyph name="laptop_windows" size={48} />
      <View style={styles.flex}>
        <Text style={styles.foundName} numberOfLines={1}>
          {hub.name}
        </Text>
        <Text style={styles.muted}>{hub.canApprove ? `${HUB_NAME} · tap to connect` : `${HUB_NAME} · connect with its code`}</Text>
      </View>
      <Icon name="chevron_right" size={24} color={colors.muted} />
    </Pressable>
  );
}

function FindCard() {
  const phase = usePcSync((s) => s.phase);
  const found = usePcSync((s) => s.found);
  const sweep = usePcSync((s) => s.sweep);
  const searched = usePcSync((s) => s.searched);
  const onWifi = usePcSync((s) => s.onWifi);
  const { search } = usePcSync.getState();

  if (found.length) {
    return (
      <View style={styles.hero}>
        <Text style={styles.kicker}>Found on your Wi-Fi</Text>
        <View style={styles.gap}>
          {found.map((h) => (
            <FoundRow key={h.serverId} hub={h} />
          ))}
        </View>
        {sweep ? <Text style={styles.faint}>Still looking for others…</Text> : null}
      </View>
    );
  }
  if (sweep || phase === 'searching' || phase === 'loading') {
    return (
      <View style={[styles.hero, styles.heroCenter]}>
        <Radar />
        <Text style={styles.heroTitle}>Looking for your PC</Text>
        <Text style={[styles.heroText, styles.center]}>Open {HUB_NAME} on your PC. It appears here by itself.</Text>
        {sweep ? (
          <View style={styles.sweep}>
            <Bar fraction={sweep.total ? sweep.done / sweep.total : 0} thin />
          </View>
        ) : null}
      </View>
    );
  }
  if (onWifi === false) {
    return (
      <View style={[styles.hero, styles.heroCenter]}>
        <Glyph name="wifi_off" />
        <Text style={styles.heroTitle}>Connect to Wi-Fi</Text>
        <Text style={[styles.heroText, styles.center]}>Your PC and this device need to be on the same Wi-Fi.</Text>
        <Button title="Search again" icon="refresh" onPress={() => void search()} />
      </View>
    );
  }
  if (searched) {
    return (
      <View style={styles.hero}>
        <View style={styles.heroRow}>
          <Glyph name="search" />
          <View style={styles.flex}>
            <Text style={styles.heroTitle}>No PC found yet</Text>
            <Text style={styles.heroText}>{HUB_NAME} needs to be open on your PC.</Text>
          </View>
        </View>
        <View style={styles.tips}>
          <Text style={styles.tip}>• Install it with {APP_NAME}-Hub-Setup.exe, then open it from the Start menu.</Text>
          <Text style={styles.tip}>• Keep this device and the PC on the same Wi-Fi.</Text>
          <Text style={styles.tip}>• Still hidden? In {HUB_NAME} open Settings: if Network access shows Allow devices, click it.</Text>
        </View>
        <Button title="Search again" kind="accent" icon="refresh" onPress={() => void search()} />
      </View>
    );
  }
  return (
    <View style={[styles.hero, styles.heroCenter]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

function ConnectedCard() {
  const phase = usePcSync((s) => s.phase);
  const link = usePcSync((s) => s.link);
  const via = usePcSync((s) => s.via);
  const listing = usePcSync((s) => s.listing);
  const device = usePcSync((s) => s.device);
  const fromPc = usePcSync((s) => s.panelsFromPc);
  const { connect, forget } = usePcSync.getState();
  const [confirmForget, setConfirmForget] = useState(false);
  const stats = useMemo(() => {
    if (!listing) return null;
    let fresh = 0;
    for (const s of listing.series) fresh += matchWithPanels(s, device, fromPc).filter((v) => v.state !== 'onDevice').length;
    return { series: listing.series.length, fresh, onlyHere: deviceOnly(listing.series, device).length };
  }, [listing, device, fromPc]);
  if (!link) return null;
  const connected = phase === 'connected';
  const checking = phase === 'checking';
  const panels = listing?.panels;
  const panelText =
    panels && panels.state === 'working'
      ? `Adding panels on the PC · ${panels.queued} waiting`
      : panels && panels.queued > 0 && ['starting', 'loading', 'paused'].includes(panels.state)
        ? `${panels.queued} volumes waiting for panels on the PC`
        : '';
  return (
    <View style={styles.hero}>
      <View style={styles.heroRow}>
        <Glyph name="laptop_windows" online={checking ? null : connected} />
        <View style={styles.flex}>
          <Text style={styles.heroTitle} numberOfLines={1}>
            {link.name}
          </Text>
          <Text style={styles.heroText}>
            {checking
              ? 'Connecting…'
              : connected
                ? via === 'tailscale'
                  ? 'Connected through Tailscale'
                  : 'Connected on your Wi-Fi'
                : 'Not reachable right now'}
          </Text>
        </View>
        {checking ? <ActivityIndicator color={colors.accent} /> : null}
      </View>
      {connected && stats ? (
        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statNum}>{stats.series}</Text>
            <Text style={styles.statLabel}>series on the PC</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statNum, stats.fresh > 0 && styles.statHot]}>{stats.fresh}</Text>
            <Text style={styles.statLabel}>new or updated</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statNum}>{stats.onlyHere}</Text>
            <Text style={styles.statLabel}>only on this device</Text>
          </View>
        </View>
      ) : null}
      {connected && via === 'tailscale' ? (
        <Text style={styles.faint}>Away from home: transfers run at your home internet&apos;s upload speed.</Text>
      ) : null}
      {panelText ? <Text style={styles.faint}>{panelText}</Text> : null}
      <View style={styles.row}>
        {phase === 'offline' ? <Button title="Try again" kind="accent" icon="refresh" onPress={() => void connect()} /> : null}
        {confirmForget ? (
          <>
            <Text style={styles.muted}>Forget {link.name}?</Text>
            <Button title="Forget" small onPress={() => void forget()} />
            <Button title="Keep" small kind="quiet" onPress={() => setConfirmForget(false)} />
          </>
        ) : (
          <Button title="Forget this PC" small kind="quiet" onPress={() => setConfirmForget(true)} />
        )}
      </View>
    </View>
  );
}

const COPY_OPTIONS: { mode: CopyMode; label: string; text: string }[] = [
  { mode: 'reading', label: 'What I’m reading', text: 'Volumes you’ve started, and the next two in each series you’re reading.' },
  { mode: 'all', label: 'Everything', text: 'Your whole library, starting with what you’re reading.' },
  { mode: 'off', label: 'Off', text: 'Only the volumes you send yourself.' },
];

/** Copies on the PC, so the PC can read them while this device is off. */
function CopyCard() {
  const link = usePcSync((s) => s.link);
  const phase = usePcSync((s) => s.phase);
  const via = usePcSync((s) => s.via);
  const mode = usePcSync((s) => s.copyMode);
  const listing = usePcSync((s) => s.listing);
  const device = usePcSync((s) => s.device);
  const { setCopyMode } = usePcSync.getState();
  const counts = useMemo(() => {
    if (!listing) return null;
    const sendable = device.filter((d) => d.kind === 'cbz');
    const onlyHere = deviceOnly(listing.series, device);
    return { onPc: sendable.length - onlyHere.length, total: sendable.length, bytesLeft: onlyHere.reduce((n, d) => n + d.size, 0) };
  }, [listing, device]);
  if (!link || phase !== 'connected') return null;
  const chosen = COPY_OPTIONS.find((o) => o.mode === mode) ?? COPY_OPTIONS[0];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Read on {link.name} with this device off</Text>
      <Text style={styles.muted}>
        While {APP_NAME} is open here, it copies volumes to your PC in the background: on your home Wi-Fi only, and only while
        charging or above 30% battery.
      </Text>
      <View style={styles.segment}>
        {COPY_OPTIONS.map((o) => (
          <Pressable
            key={o.mode}
            onPress={() => void setCopyMode(o.mode)}
            style={[styles.segButton, mode === o.mode && styles.segOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === o.mode }}>
            <Text style={[styles.segText, mode === o.mode && styles.segTextOn]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.faint}>{chosen.text}</Text>
      {counts && counts.total ? (
        <View style={styles.gapSmall}>
          <Bar fraction={counts.onPc / counts.total} thin />
          <Text style={styles.muted}>
            {counts.onPc} of {counts.total} volumes are on the PC
            {counts.bytesLeft && mode === 'all' ? ` · ${formatBytes(counts.bytesLeft)} to go` : ''}
            {via === 'tailscale' ? ' · copying waits until you’re home' : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function CodeCard() {
  const codeFor = usePcSync((s) => s.codeFor);
  const phase = usePcSync((s) => s.phase);
  const { pairWith, setCodeFor } = usePcSync.getState();
  const [code, setCode] = useState('');
  if (!codeFor) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Enter the code from {codeFor.name}</Text>
      <Text style={styles.muted}>In {HUB_NAME}, open Devices › Other ways to connect. Older versions show it on their main page.</Text>
      <View style={styles.row}>
        <TextInput
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          placeholder="000 000"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          style={[styles.input, styles.codeInput]}
        />
        <Button
          title={phase === 'pairing' ? 'Connecting…' : 'Connect'}
          kind="accent"
          disabled={code.length !== 6 || phase === 'pairing'}
          onPress={() => void pairWith(codeFor.host, codeFor.port, code).then((ok) => ok && setCode(''))}
        />
        <Button title="Cancel" kind="quiet" onPress={() => setCodeFor(null)} />
      </View>
    </View>
  );
}

function OtherWays() {
  const found = usePcSync((s) => s.found);
  const codeFor = usePcSync((s) => s.codeFor);
  const { pairFromLink, setCodeFor, setMessage } = usePcSync.getState();
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [address, setAddress] = useState('');
  if (codeFor) return null;
  return (
    <View style={styles.other}>
      <Pressable onPress={() => setOpen(!open)} style={styles.otherHead} hitSlop={6}>
        <Text style={styles.otherTitle}>Other ways to connect</Text>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={22} color={colors.muted} />
      </Pressable>
      {open ? (
        <View style={styles.gap}>
          <View style={styles.row}>
            <Button title="Scan QR code" icon="qr_code_scanner" onPress={() => setScanning(true)} />
            <Button
              title="Enter a code"
              icon="keyboard"
              onPress={() => {
                if (found.length) setCodeFor({ host: found[0].host, port: found[0].port, name: found[0].name });
                else setTyping(true);
              }}
            />
          </View>
          <Text style={styles.faint}>
            The QR code is in {HUB_NAME} under Devices › Other ways to connect. Scanning it at home also sets up Tailscale, so
            this device can reach your PC from anywhere.
          </Text>
          {typing ? (
            <View style={styles.row}>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder={`PC address, like 192.168.1.20:${BRAND_HUB_PORT}`}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                style={[styles.input, styles.flex]}
              />
              <Button
                title="Next"
                kind="accent"
                disabled={!parseManualAddress(address, BRAND_HUB_PORT)}
                onPress={() => {
                  const a = parseManualAddress(address, BRAND_HUB_PORT);
                  if (!a) return;
                  setTyping(false);
                  setCodeFor({ ...a, name: a.host });
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <QrScanModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onLink={(p) => {
          setScanning(false);
          setMessage(null);
          void pairFromLink(p);
        }}
      />
    </View>
  );
}

function TransfersCard() {
  const jobs = usePcSync((s) => s.jobs);
  const { cancel, cancelAll, clearFinished } = usePcSync.getState();
  if (jobs.length === 0) return null;
  const running = jobs.find((j) => j.state === 'running');
  const queued = jobs.filter((j) => j.state === 'queued').length;
  const failed = jobs.filter((j) => j.state === 'failed');
  const finished = jobs.filter((j) => j.state !== 'queued' && j.state !== 'running').length;
  return (
    <View style={styles.card}>
      {running ? (
        <View style={styles.gap}>
          <View style={styles.spread}>
            <View style={styles.xferIcon}>
              <Icon name={running.kind === 'down' ? 'download' : 'upload'} size={20} color={colors.accentSoft} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.text} numberOfLines={1}>
                {running.kind === 'down' ? 'Getting' : 'Sending'} {label(running.file)}
              </Text>
              <Text style={styles.muted}>
                {formatBytes(running.bytes)} of {formatBytes(running.total)}
                {queued ? ` · ${queued} more waiting` : ''}
              </Text>
            </View>
            <Button title="Cancel" small onPress={() => cancel(running.key)} />
          </View>
          <Bar fraction={running.total ? running.bytes / running.total : 0} />
          <Text style={styles.faint}>Keep {APP_NAME} open until it finishes.</Text>
        </View>
      ) : (
        <View style={styles.spread}>
          <Text style={[styles.text, styles.flex]}>{queued ? `${queued} waiting…` : 'Transfers finished.'}</Text>
          {queued ? <Button title="Cancel all" small kind="quiet" onPress={cancelAll} /> : null}
        </View>
      )}
      {failed.slice(0, 3).map((j) => (
        <Text key={j.key} style={styles.error}>
          {label(j.file)}: {j.note}
        </Text>
      ))}
      {finished ? <Button title="Clear finished" small kind="quiet" onPress={clearFinished} /> : null}
    </View>
  );
}

function JobChip({ job, onRetry }: { job: TransferJob; onRetry: () => void }) {
  const { cancel } = usePcSync.getState();
  if (job.state === 'running') {
    return (
      <View style={styles.chipRow}>
        <Text style={styles.muted}>{job.total ? Math.floor((job.bytes / job.total) * 100) : 0}%</Text>
        <Button title="Cancel" small onPress={() => cancel(job.key)} />
      </View>
    );
  }
  if (job.state === 'queued') {
    return (
      <View style={styles.chipRow}>
        <Text style={styles.muted}>Waiting</Text>
        <Button title="Cancel" small onPress={() => cancel(job.key)} />
      </View>
    );
  }
  if (job.state === 'failed') return <Button title="Retry" small onPress={onRetry} />;
  if (job.state === 'done') return <Text style={styles.ok}>{job.settling ? 'Adding to your library…' : (job.note ?? 'Done')}</Text>;
  return null;
}

// ---------------------------------------------------------------------------- the screen
export default function PcScreen() {
  // Opened from the hub's QR code with the phone's own camera app: APP_SCHEME://pc?h=…&c=…
  const params = useLocalSearchParams<{ h?: string; c?: string; p?: string; t?: string }>();
  const linkQuery = (['h', 'c', 'p', 't'] as const)
    .filter((k) => typeof params[k] === 'string' && params[k])
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  const linkUsed = useRef('');
  useEffect(() => {
    if (!linkQuery || linkUsed.current === linkQuery) return;
    linkUsed.current = linkQuery; // once per link
    const p = parsePairLink(`${APP_SCHEME}://pc?${linkQuery}`, BRAND_HUB_PORT);
    if (p) void usePcSync.getState().pairFromLink(p);
  }, [linkQuery]);

  const phase = usePcSync((s) => s.phase);
  const link = usePcSync((s) => s.link);
  const via = usePcSync((s) => s.via);
  const listing = usePcSync((s) => s.listing);
  const device = usePcSync((s) => s.device);
  const titles = usePcSync((s) => s.seriesTitles);
  const covers = usePcSync((s) => s.seriesCovers);
  const fromPc = usePcSync((s) => s.panelsFromPc);
  const jobs = usePcSync((s) => s.jobs);
  const message = usePcSync((s) => s.message);
  const asking = usePcSync((s) => s.asking);
  const { queueDownload, queueUpload } = usePcSync.getState();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useFocusEffect(
    useCallback(() => {
      void usePcSync.getState().onFocus();
      const t = setInterval(() => {
        const s = usePcSync.getState();
        if (s.phase === 'connected') void s.refresh();
      }, 5000);
      return () => clearInterval(t);
    }, []),
  );

  const jobByKey = useMemo(() => new Map(jobs.map((j) => [j.key, j])), [jobs]);

  const sections = useMemo<Section[]>(() => {
    if (phase !== 'connected' || !listing || !link) return [];
    const pcLink = reachable(link, via);
    const out: Section[] = [];
    for (const series of listing.series) {
      const matched = matchWithPanels(series, device, fromPc);
      const have = matched.filter((v) => v.state === 'onDevice').length;
      const wanted = matched.filter((v) => v.state !== 'onDevice');
      const newOnes = wanted.filter((v) => v.state === 'missing');
      const updates = wanted.length - newOnes.length;
      const bits = [`${have} of ${matched.length} on this device`];
      if (newOnes.length) bits.push(`${newOnes.length} new · ${formatBytes(newOnes.reduce((n, v) => n + v.size, 0))}`);
      if (updates) bits.push(`${updates} ${updates === 1 ? 'update' : 'updates'}`);
      const first = series.volumes[0];
      const key = `pc:${series.id}`;
      out.push({
        key,
        title: series.title,
        subtitle: bits.join(' · '),
        cover: first
          ? { uri: coverUrl(pcLink, first.id, first.version), headers: authHeaders(pcLink), cacheKey: `${link.serverId}:${first.id}:${first.version}` }
          : null,
        have,
        total: matched.length,
        data: open[key] ? matched.map((v) => ({ kind: 'pc' as const, v, series })) : [],
        action: wanted.length ? { label: `Get ${wanted.length}`, run: () => wanted.forEach((v) => queueDownload(v, series)) } : undefined,
        done: !wanted.length,
      });
    }
    const only = deviceOnly(listing.series, device);
    const bySeries = new Map<number, DeviceVolume[]>();
    for (const d of only) bySeries.set(d.seriesId, [...(bySeries.get(d.seriesId) ?? []), d]);
    let firstOnly = true;
    for (const [seriesId, vols] of bySeries) {
      const key = `dev:${seriesId}`;
      const cover = covers[seriesId];
      out.push({
        key,
        title: titles[seriesId] ?? 'Unknown series',
        subtitle: `${vols.length} only here · ${formatBytes(vols.reduce((n, d) => n + d.size, 0))}`,
        cover: cover ? { uri: cover } : null,
        have: 0,
        total: 0,
        data: open[key] ? vols.map((d) => ({ kind: 'dev' as const, d })) : [],
        action: { label: `Send ${vols.length}`, run: () => vols.forEach((d) => queueUpload(d)) },
        firstDeviceOnly: firstOnly,
      });
      firstOnly = false;
    }
    return out;
  }, [phase, listing, link, via, device, titles, covers, fromPc, open, queueDownload, queueUpload]);

  const paired = !!link && phase !== 'unpaired' && phase !== 'searching' && phase !== 'asking';

  const header = (
    <View style={styles.headerWrap}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={styles.back} hitSlop={8}>
        <Icon name="arrow_back" size={20} color={colors.accentSoft} />
        <Text style={styles.backText}>Library</Text>
      </Pressable>
      <View>
        <Text style={styles.eyebrow}>SYNC</Text>
        <Text style={styles.h1}>Your PC</Text>
        <Text style={styles.lede}>Get manga from your PC, send yours over, and pick up where you left off on either.</Text>
      </View>
      {asking ? <AskingCard /> : paired ? <ConnectedCard /> : <FindCard />}
      {paired && !asking ? <CopyCard /> : null}
      {message ? (
        <View style={styles.banner}>
          <Icon name="info" size={18} color={colors.accentSoft} />
          <Text style={[styles.text, styles.flex]}>{message}</Text>
        </View>
      ) : null}
      {!paired && !asking ? <CodeCard /> : null}
      {!paired && !asking ? <OtherWays /> : null}
      <TransfersCard />
      {phase === 'connected' && listing ? (
        <Text style={styles.h2}>{listing.series.length ? 'On your PC' : 'Your PC’s manga folder is empty'}</Text>
      ) : null}
      {phase === 'connected' && listing && !listing.series.length ? (
        <Text style={styles.muted}>Send volumes from this device below, or add manga to the folder {HUB_NAME} shares.</Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <SectionList<Row, Section>
        sections={sections}
        keyExtractor={(r) => (r.kind === 'pc' ? `pc:${r.v.id}` : `dev:${r.d.archiveId}`)}
        ListHeaderComponent={header}
        contentContainerStyle={[styles.list, readableColumn]}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderSectionHeader={({ section }) => (
          <View>
            {section.firstDeviceOnly ? (
              <View>
                <Text style={styles.h2}>Only on this device</Text>
                <Text style={[styles.muted, styles.h2Sub]}>Send these to your PC to read them there, or to get panels made on its graphics card.</Text>
              </View>
            ) : null}
            <Pressable
              onPress={() => setOpen((o) => ({ ...o, [section.key]: !o[section.key] }))}
              style={({ pressed }) => [styles.seriesRow, open[section.key] && styles.seriesRowOpen, pressed && styles.seriesRowPressed]}>
              <View style={styles.thumb}>
                {section.cover ? (
                  <Image source={section.cover} style={styles.thumbImage} contentFit="cover" transition={120} cachePolicy="memory-disk" />
                ) : (
                  <Text style={styles.thumbLetter}>{section.title.slice(0, 1).toUpperCase()}</Text>
                )}
              </View>
              <View style={[styles.flex, styles.gapSmall]}>
                <Text style={styles.seriesTitle} numberOfLines={1}>
                  {section.title}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {section.subtitle}
                </Text>
                {section.total ? <Bar fraction={section.have / section.total} thin /> : null}
              </View>
              {section.action ? (
                <Button title={section.action.label} small kind="accent" onPress={section.action.run} />
              ) : section.done ? (
                <Icon name="check_circle" size={22} color={colors.success} />
              ) : null}
              <Icon name={open[section.key] ? 'expand_less' : 'expand_more'} size={22} color={colors.muted} />
            </Pressable>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === 'pc') {
            const { v, series } = item;
            const job = jobByKey.get(`down:${v.id}`);
            const reason = updateReason(v);
            return (
              <View style={styles.item}>
                <View style={styles.flex}>
                  <Text style={styles.text} numberOfLines={1}>
                    {label(v.file)}
                  </Text>
                  <Text style={styles.muted}>
                    {formatBytes(v.size)}
                    {v.panels === 'ready' ? ' · panels' : v.panels === 'working' ? ' · adding panels…' : ''}
                  </Text>
                  {job?.state === 'failed' && job.note ? <Text style={styles.error}>{job.note}</Text> : null}
                </View>
                {job && job.state !== 'cancelled' && !(job.state === 'done' && v.state !== 'onDevice' && !job.settling) ? (
                  <JobChip job={job} onRetry={() => queueDownload(v, series)} />
                ) : v.state === 'onDevice' ? (
                  <View style={styles.chipRow}>
                    <Icon name="check_circle" size={18} color={colors.success} />
                    <Text style={styles.ok}>On this device</Text>
                  </View>
                ) : (
                  <Button
                    title={v.state === 'changed' ? `Update${reason ? ` · ${reason}` : ''}` : 'Get'}
                    small
                    kind="accent"
                    icon="download"
                    onPress={() => queueDownload(v, series)}
                  />
                )}
              </View>
            );
          }
          const { d } = item;
          const job = jobByKey.get(`up:${d.archiveId}`);
          return (
            <View style={styles.item}>
              <View style={styles.flex}>
                <Text style={styles.text} numberOfLines={1}>
                  {label(d.file)}
                </Text>
                <Text style={styles.muted}>{formatBytes(d.size)}</Text>
                {job?.state === 'failed' && job.note ? <Text style={styles.error}>{job.note}</Text> : null}
              </View>
              {job && job.state !== 'cancelled' ? (
                <JobChip job={job} onRetry={() => queueUpload(d)} />
              ) : (
                <Button title="Send" small icon="upload" onPress={() => queueUpload(d)} />
              )}
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  headerWrap: { gap: spacing.md, marginBottom: spacing.sm },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: spacing.xs, alignSelf: 'flex-start' },
  backText: { color: colors.accentSoft, fontSize: 15, fontWeight: '600' },
  eyebrow: { color: colors.accentSoft, fontSize: 11, fontWeight: '800', letterSpacing: 2.4 },
  h1: { color: colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginTop: 6 },
  lede: { color: colors.muted, fontSize: 15, lineHeight: 21, marginTop: 6 },
  h2: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.xs },
  h2Sub: { marginBottom: spacing.sm },

  hero: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  heroCenter: { alignItems: 'center' },
  heroLit: { borderColor: colors.accent, backgroundColor: colors.cardActive },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroTitle: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.2 },
  heroText: { color: colors.muted, fontSize: 14.5, lineHeight: 20 },
  center: { textAlign: 'center' },
  kicker: { color: colors.accentSoft, fontSize: 12, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase' },

  glyph: { backgroundColor: colors.cardActive, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  glyphDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: colors.card },

  radar: { width: 150, height: 150, alignItems: 'center', justifyContent: 'center' },
  radarRing: { position: 'absolute', width: 80, height: 80, borderRadius: 40, borderWidth: 2, borderColor: colors.accent },
  radarCore: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: colors.cardActive,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accentWash,
  },
  sweep: { alignSelf: 'stretch', paddingHorizontal: spacing.xl },

  pairArt: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  matchBox: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accentSoft,
    backgroundColor: colors.bg,
  },
  matchLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  matchDigits: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: 4, fontVariant: ['tabular-nums'] },

  foundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 16,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  foundRowPressed: { borderColor: colors.accent, backgroundColor: colors.cardActive },
  foundName: { color: colors.text, fontSize: 17, fontWeight: '700' },

  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, backgroundColor: colors.bg, borderRadius: 14, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md, gap: 2 },
  statNum: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statHot: { color: colors.accentSoft },
  statLabel: { color: colors.muted, fontSize: 12 },

  tips: { gap: 6 },
  tip: { color: colors.muted, fontSize: 14, lineHeight: 20 },

  banner: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.accentWash,
    borderRadius: radius.md,
    padding: spacing.md,
  },

  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  other: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  otherHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  otherTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },

  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  faint: { color: colors.muted, fontSize: 12.5, opacity: 0.85 },
  error: { color: colors.danger, fontSize: 13 },
  ok: { color: colors.success, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  spread: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  gap: { gap: spacing.sm },
  gapSmall: { gap: 4 },
  flex: { flex: 1 },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.cardActive,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  buttonAccent: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonQuiet: { backgroundColor: 'transparent', borderColor: 'transparent', paddingHorizontal: 8 },
  buttonSmall: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  dim: { opacity: 0.5 },
  buttonText: { fontWeight: '700', fontSize: 14.5 },
  buttonTextSmall: { fontSize: 13 },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 15, backgroundColor: colors.bg },
  codeInput: { minWidth: 150, fontSize: 22, letterSpacing: 6, fontWeight: '700' },

  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: 12, padding: 3, gap: 3 },
  segButton: { flex: 1, paddingVertical: 9, paddingHorizontal: 6, borderRadius: 9, alignItems: 'center' },
  segOn: { backgroundColor: colors.cardActive, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accentSoft },
  segText: { color: colors.muted, fontWeight: '700', fontSize: 13 },
  segTextOn: { color: colors.text },
  xferIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.cardActive, alignItems: 'center', justifyContent: 'center' },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.bg, overflow: 'hidden' },
  barThin: { height: 3 },
  barFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3 },

  seriesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.sm + 2,
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  seriesRowOpen: { borderBottomLeftRadius: 6, borderBottomRightRadius: 6 },
  seriesRowPressed: { backgroundColor: colors.cardActive },
  seriesTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  thumb: { width: 46, height: 66, borderRadius: 8, backgroundColor: colors.cardActive, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbImage: { width: '100%', height: '100%' },
  thumbLetter: { color: colors.muted, fontSize: 20, fontWeight: '800' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
