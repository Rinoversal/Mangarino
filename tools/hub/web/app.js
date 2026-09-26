// Mangarino Hub window: sections, live status, devices (and the Allow dialog), settings.
// Talks only to this PC's hub, with the per-run admin key. The library and reader are in library.js.
'use strict';

const KEY = document.querySelector('meta[name="admin-key"]').content;
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch('/admin/' + path, {
    ...options,
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(String(res.status));
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

/** Build an element: h('div', {className: 'x'}, 'text', child). Text is never parsed as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  Object.assign(el, props || {});
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

function bytes(n) {
  if (!n) return '0 MB';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return Math.max(1, Math.round(n / 1e6)) + ' MB';
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ------------------------------------------------------------------ icons and art (our own SVG)
const S = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</svg>`;
const ICONS = {
  library: S('<path d="M3 5.5c3-1.2 6-.9 9 1 3-1.9 6-2.2 9-1v13c-3-1.2-6-.9-9 1-3-1.9-6-2.2-9-1z"/><path d="M12 6.5v13"/>'),
  devices: S('<path d="M13 20H5.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2.5"/><rect x="15" y="10" width="6" height="11" rx="1.5"/>'),
  settings: S('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  tablet: S('<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  phone: S('<rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M11 18.5h2"/>'),
  pc: S('<rect x="4" y="5" width="16" height="10.5" rx="1.6"/><path d="M2.5 19h19"/>'),
  folder: S('<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  panels: S('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 11H13M13 3.5v17M13 14h7.5"/>'),
  globe: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z"/>'),
  power: S('<path d="M12 3.5v8"/><path d="M6.6 7.2a7.5 7.5 0 1 0 10.8 0"/>'),
  shield: S('<path d="M12 3.2 19 6v5.4c0 4.4-3 8-7 9.4-4-1.4-7-5-7-9.4V6z"/><path d="m9 12 2 2 4-4"/>'),
  log: S('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5"/>'),
  qr: S('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM20 14v.5M14 20h.5"/>'),
  back: S('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  expand: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  down: S('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  up: S('<path d="M12 16V5M7 9.5l5-5 5 5M5 20h14"/>'),
  check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  x: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  play: S('<path d="M8 5.5v13l10-6.5z" fill="currentColor"/>'),
  direction: S('<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>'),
  warn: S('<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>'),
  link: S('<path d="M9.5 14.5l5-5"/><path d="M11 6.5 12.6 5a4 4 0 0 1 5.7 5.7l-1.6 1.6M13 17.5 11.4 19a4 4 0 0 1-5.7-5.7l1.6-1.6"/>'),
};
const ART = {
  link: `<svg viewBox="0 0 240 166" aria-hidden="true">
    <circle cx="120" cy="88" r="74" class="art-fill"/>
    <rect x="22" y="40" width="64" height="92" rx="11" class="art-stroke"/>
    <path d="M47 121h14" class="art-stroke"/>
    <path d="M33 52h42v28H33zM33 86h19v24H33zM56 86h19v24H56z" class="art-faint"/>
    <rect x="142" y="56" width="82" height="56" rx="7" class="art-stroke"/>
    <path d="M130 124h106" class="art-stroke"/>
    <path d="M153 68h58M153 78h40M153 88h50M153 98h30" class="art-faint"/>
    <path d="M92 46C108 14 130 14 146 44" class="art-dash"/>
    <circle cx="92" cy="46" r="3.5" fill="#ff2d95"/><circle cx="146" cy="44" r="3.5" fill="#ff2d95"/>
  </svg>`,
  books: `<svg viewBox="0 0 220 150" aria-hidden="true">
    <circle cx="110" cy="80" r="66" class="art-fill"/>
    <rect x="56" y="36" width="32" height="92" rx="4" class="art-stroke"/>
    <rect x="93" y="26" width="36" height="102" rx="4" class="art-stroke"/>
    <path d="m136 46 25-6 22 83-25 6z" class="art-stroke"/>
    <path d="M36 128h148" class="art-stroke"/>
    <path d="M63 52h18M63 60h18M100 44h22M100 52h22M143 58l14-3M145 66l14-3" class="art-faint"/>
  </svg>`,
};
function paint(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstElementChild || el.dataset.painted !== el.dataset.icon) {
      el.innerHTML = ICONS[el.dataset.icon] || '';
      el.dataset.painted = el.dataset.icon;
    }
  });
  root.querySelectorAll('[data-art]').forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = ART[el.dataset.art] || '';
  });
}
function icon(name, className = 'ico') {
  const el = h('span', { className });
  el.innerHTML = ICONS[name] || '';
  return el;
}
const glyphFor = (kind) => (kind === 'phone' ? 'phone' : kind === 'desktop' || kind === 'tv' ? 'pc' : 'tablet');

// ------------------------------------------------------------------ toasts
function toast(text, { name = 'check', bad = false, ms = 4500 } = {}) {
  const el = h('div', { className: 'toast' + (bad ? ' bad' : '') }, icon(bad ? 'warn' : name, 't-ico'), h('span', {}, text));
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------------ sections
const VIEWS = ['library', 'devices', 'settings'];
let view = null;
let status = null;

function show(name, remember = true) {
  if (!VIEWS.includes(name)) name = 'library';
  view = name;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (remember) {
    try {
      localStorage.setItem('hub-view', name);
    } catch {
      // storage off: fine
    }
    if (!location.hash.startsWith('#read/')) history.replaceState(null, '', '#' + name);
  }
  if (name === 'library' && window.Library) window.Library.shown();
  if (name === 'devices' && status) renderDevices(status);
  document.querySelector('.stage').scrollTop = 0;
}
document.querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => show(b.dataset.view)));

function firstView(s) {
  const fromHash = location.hash.slice(1);
  if (VIEWS.includes(fromHash)) return fromHash;
  if (fromHash.startsWith('read/')) return 'library';
  if (location.pathname === '/read') return 'library';
  if (!s.devices.length && !s.library.volumes) return 'devices'; // first run: connect something
  try {
    const saved = localStorage.getItem('hub-view');
    if (VIEWS.includes(saved)) return saved;
  } catch {
    // ignore
  }
  return s.library.volumes ? 'library' : 'devices';
}

// ------------------------------------------------------------------ rail
function renderRail(s) {
  $('status').classList.remove('off');
  const online = s.devices.filter((d) => d.online);
  const active = s.transfers.active;
  $('statusText').textContent = active.length
    ? 'Syncing'
    : online.length === 1
      ? `${online[0].name} connected`
      : online.length > 1
        ? `${online.length} devices connected`
        : 'Ready';
  $('railPc').textContent = s.name;
  const waiting = s.pairRequests.length;
  $('navBadge').hidden = !waiting;
  $('navBadge').textContent = String(waiting);
  $('navWarn').hidden = !needsAttention(s);

  const lines = active.slice(0, 2).map((x) =>
    h('div', { className: 'ra-line' }, icon(x.kind === 'to PC' ? 'down' : 'up'),
      h('span', {}, `${x.total ? Math.floor((x.bytes / x.total) * 100) : 0}% · ${shortName(x.name)}`)));
  const p = s.panels;
  if (p.state === 'working' && p.current) {
    lines.push(h('div', { className: 'ra-line' }, icon('panels'),
      h('span', {}, `Panels · ${shortName(p.current.name)}` + (p.current.total ? ` · ${p.current.done}/${p.current.total}` : ''))));
  }
  $('railActivity').replaceChildren(...lines);
  $('railActivity').hidden = !lines.length;
}
const shortName = (rel) => String(rel).split('/').pop().replace(/\.(cbz|zip)$/i, '');

function needsAttention(s) {
  if (!s.library.exists) return true;
  const f = s.firewall || {};
  return !s.reachedFromNetwork && !!Object.keys(f).length && !f.error && !(f.allowRule && !f.blocked);
}

// ------------------------------------------------------------------ devices
let qrCode = null;

function renderRequests(s) {
  $('requestList').replaceChildren(...s.pairRequests.map((r) => {
    const allow = h('button', { className: 'btn primary sm', textContent: 'Allow' });
    const deny = h('button', { className: 'btn ghost sm', textContent: 'Don’t allow' });
    allow.onclick = () => decide(r, true);
    deny.onclick = () => decide(r, false);
    const sub = h('div', { className: 'request-sub' }, 'Check it shows ', h('b', {}, r.match));
    return h('div', { className: 'request' },
      h('div', { className: 'device-glyph' }, icon(glyphFor(r.kind), 'ico')),
      h('div', { className: 'grow' }, h('div', { className: 'request-title' }, `${r.deviceName} wants to connect`), sub),
      h('div', { className: 'row' }, deny, allow));
  }));
}

function renderDevices(s) {
  renderRequests(s);
  $('devices').replaceChildren(...s.devices.map((d) => {
    const remove = h('button', { className: 'btn ghost sm remove', textContent: 'Remove' });
    remove.onclick = async () => {
      remove.disabled = true;
      await post('forget', { deviceId: d.id }).catch(() => {});
      toast(`${d.name || 'The device'} was removed. It can connect again any time.`, { name: 'x' });
      refresh();
    };
    const when = d.online ? 'Connected now' : d.lastSeenMs ? `Last seen ${ago(d.lastSeenMs)}` : d.pairedMs ? `Paired ${ago(d.pairedMs)}` : 'Paired';
    return h('div', { className: 'device' + (d.online ? ' online' : '') },
      h('div', { className: 'device-glyph' }, icon(glyphFor(d.kind), 'ico')),
      h('div', { className: 'device-body' },
        h('div', { className: 'device-name' }, d.name || 'Device'),
        h('div', { className: 'device-meta' }, h('span', { className: 'led' }), when)),
      remove);
  }));
  $('devices').hidden = !s.devices.length;
  $('connect').classList.toggle('compact', s.devices.length > 0);
  $('connectTitle').textContent = s.devices.length ? 'Connect another device' : 'Connect a phone or tablet';
  document.querySelectorAll('.pc-name').forEach((el) => (el.textContent = s.name));

  const code = s.code || '';
  $('code').textContent = code.slice(0, 3) + ' ' + code.slice(3);
  const addr = s.addresses.map((ip) => `${ip}:${s.port}`);
  if (s.tailscale.length) addr.push(`Tailscale ${s.tailscale[0]}`);
  $('addresses').textContent = addr.length ? `This PC: ${addr.join(' · ')}` : 'This PC has no network connection.';
  if (!$('otherWays').hidden && code !== qrCode) loadQr(code);
  renderTransfers(s.transfers);
}

async function loadQr(code) {
  qrCode = code;
  try {
    $('qr').innerHTML = await api('qr.svg'); // our own SVG from segno, not user input
  } catch {
    $('qr').textContent = '';
  }
  if (!$('bigqr').hidden) showBigQr();
}

async function showBigQr() {
  try {
    $('bigqrCode').innerHTML = await api('qr.svg?scale=12'); // sized by CSS
  } catch {
    return;
  }
  $('bigqrText').textContent = $('code').textContent;
  $('bigqr').hidden = false;
}

function renderTransfers(t) {
  const items = t.active.map((x) => {
    const fill = h('div', { className: 'meter-fill' });
    fill.style.width = (x.total ? Math.round((x.bytes / x.total) * 100) : 0) + '%';
    return h('div', { className: 'xfer' },
      h('div', { className: 'xfer-ico' }, icon(x.kind === 'to PC' ? 'down' : 'up', 'ico')),
      h('div', { className: 'xfer-name' }, `${shortName(x.name)} ${x.kind === 'to PC' ? `from ${x.device || 'a device'}` : `to ${x.device || 'a device'}`}`),
      h('div', { className: 'xfer-num' }, `${bytes(x.bytes)} of ${bytes(x.total)} · ${bytes(x.bps)}/s`),
      h('div', { className: 'meter' }, fill));
  });
  const recent = t.recent.slice(0, 6).map((x) =>
    h('div', { className: 'recent-line' },
      h('span', { className: x.ok ? 'ok' : 'bad' }, icon(x.ok ? 'check' : 'x')),
      h('span', {}, `${x.kind === 'to PC' ? 'Received' : 'Sent'} ${shortName(x.name)}` +
        (x.device ? ` ${x.kind === 'to PC' ? 'from' : 'to'} ${x.device}` : '') + (x.ok ? '' : ` · ${x.error || 'stopped'}`))));
  $('transfers').replaceChildren(
    items.length ? h('div', { className: 'xfer-list' }, ...items) : h('p', { className: 'quiet' }, 'Nothing is transferring. Volumes you send or get show up here.'),
    ...(recent.length ? [h('div', { className: 'recent' }, ...recent)] : []));
}

// ------------------------------------------------------------------ the Allow dialog
let asking = null; // { id, deadline }
let dialogTimer = null;
const dismissed = new Set(); // requests closed with Esc: they wait under Devices, without popping up again

function renderPairDialog(s) {
  const reqs = s.pairRequests;
  const current = asking && reqs.find((r) => r.id === asking.id);
  if (asking && !current) closePairDialog(); // answered here, withdrawn or expired
  document.title = reqs.length ? `Allow ${reqs[0].deviceName}? · Mangarino Hub` : 'Mangarino Hub';
  for (const id of dismissed) if (!reqs.some((x) => x.id === id)) dismissed.delete(id);
  const r = reqs.find((x) => !dismissed.has(x.id));
  if (asking || !r) return;
  asking = { id: r.id, deadline: Date.now() + r.expiresMs, req: r };
  $('pairName').textContent = r.deviceName;
  $('pairMatch').textContent = r.match;
  const glyph = $('pairGlyph');
  glyph.dataset.icon = glyphFor(r.kind);
  paint($('pairScrim'));
  $('pairScrim').hidden = false;
  $('pairAllow').disabled = $('pairDeny').disabled = false;
  tickDialog();
  clearInterval(dialogTimer);
  dialogTimer = setInterval(tickDialog, 1000);
  if ($('fetchScrim').hidden) $('pairAllow').focus();
}

function tickDialog() {
  if (!asking) return;
  const left = Math.max(0, Math.round((asking.deadline - Date.now()) / 1000));
  $('pairFoot').textContent = `From ${asking.req.ip} · the question expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (!left) closePairDialog();
}

function closePairDialog() {
  asking = null;
  clearInterval(dialogTimer);
  $('pairScrim').hidden = true;
}

async function decide(r, allow) {
  const inDialog = asking && asking.id === r.id;
  if (inDialog) $('pairAllow').disabled = $('pairDeny').disabled = true;
  try {
    await post('pair-request', { id: r.id, allow });
    toast(allow ? `Allowed. ${r.deviceName} is finishing the connection…` : `${r.deviceName} wasn’t allowed.`, { name: allow ? 'check' : 'x' });
  } catch {
    toast(`${r.deviceName} stopped asking.`, { name: 'x' });
  }
  if (inDialog && asking && asking.id === r.id) closePairDialog();
  refresh();
}
$('pairAllow').onclick = () => asking && decide(asking.req, true);
$('pairDeny').onclick = () => asking && decide(asking.req, false);

// ------------------------------------------------------------------ settings
let lastPanelMode = null;

const PANEL_TEXT = {
  starting: 'Starting…',
  loading: 'Loading the detection models…',
  idle: 'Every volume is ready.',
  paused: 'Paused while a device is syncing.',
  working: 'Adding panels…',
  off: 'Off.',
  unavailable: 'Not available on this PC.',
};

function renderSettings(s) {
  const nameInput = $('nameInput');
  if (document.activeElement !== nameInput && !nameInput.dataset.dirty) nameInput.value = s.name || '';
  const lib = s.library;
  $('libPath').textContent = lib.root;
  if (!lib.exists) {
    $('libStats').replaceChildren(h('span', { className: 'warn' }, 'This folder doesn’t exist yet. Choose where your manga is.'));
  } else {
    const withPanels = (lib.panels.ready || 0) + (lib.panels.old || 0);
    $('libStats').textContent = `${lib.series} series · ${lib.volumes} volumes · ${bytes(lib.bytes)} · ${withPanels} with panels`;
  }
  const notes = [];
  if (lib.pending.length) notes.push(h('div', { className: 'faint' }, `Still copying (shared once finished): ${lib.pending.join(', ')}`));
  if (lib.unreadable.length) notes.push(h('div', { className: 'bad' }, `Can’t read these as zip files: ${lib.unreadable.join(', ')}`));
  $('libNote').replaceChildren(...notes);

  const p = s.panels;
  let text = PANEL_TEXT[p.state] || p.state;
  if (p.state === 'working' && p.current) {
    const { name, done, total } = p.current;
    text = `Adding panels to ${shortName(name)}` + (total ? ` · ${done} of ${total} pages` : '');
    $('panelBarWrap').hidden = false;
    $('panelBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
  } else {
    $('panelBarWrap').hidden = true;
  }
  if ((p.state === 'off' || p.state === 'unavailable' || p.state === 'paused') && p.reason) text = p.reason;
  $('panelState').textContent = text;
  const bits = [];
  if (p.device) bits.push(`Using ${p.device}`);
  if (p.queued) bits.push(`${p.queued} waiting`);
  if (p.done) bits.push(`${p.done} done since the hub started`);
  $('panelStats').textContent = bits.join(' · ');
  if (p.mode !== lastPanelMode && document.activeElement !== $('panelMode')) {
    lastPanelMode = p.mode;
    $('panelMode').value = p.mode;
  }
  $('upgrade').hidden = true; // volumes from before the speech-bubble fix are redone by themselves now
  $('choosePanelizer').hidden = !p.needsPanelizer;
  $('retry').hidden = !(p.failed > 0);
  $('retry').textContent = `Retry ${p.failed} failed`;
  $('panelActions').hidden = $('upgrade').hidden && $('choosePanelizer').hidden && $('retry').hidden;

  // Away from home: nothing about Tailscale unless it's switched on.
  const tailscaleOn = (s.tailscale || []).length > 0;
  $('awaySwitch').setAttribute('aria-checked', String(!!s.away));
  $('awayBody').hidden = !s.away;
  $('awayState').replaceChildren(tailscaleOn
    ? h('span', {}, h('span', { className: 'ok' }, 'Tailscale is on here. '), 'Devices that scanned this PC’s QR code reach it from anywhere.')
    : h('span', {}, 'Tailscale isn’t running on this PC yet.'));
  $('getTailscale').hidden = tailscaleOn;
  $('codeNote').textContent = 'The code changes after each use and every 10 minutes.' + (s.away ? ' Scanning also sets up away from home.' : '');

  const d = s.desktop;
  $('autostartRow').hidden = !(d && d.canAutostart);
  if (d) $('autostart').setAttribute('aria-checked', String(!!d.autostart));
  $('openLogs').hidden = !d;

  renderFirewall(s.firewall, s.reachedFromNetwork);
  $('version').textContent = `Mangarino Hub ${s.version}${s.build ? ` (build ${s.build})` : ''} · port ${s.port}`;
}

/** Calm unless something is really wrong: a device got through lately, or Windows allows the hub. */
function renderFirewall(f, reached) {
  let text;
  let problem = false;
  let note = '';
  if (reached) {
    text = h('span', { className: 'ok' }, 'Your devices can reach this PC.');
  } else if (!f || !Object.keys(f).length || f.error) {
    text = 'Ready for your devices.';
  } else if (f.allowRule && !f.blocked) {
    text = h('span', { className: 'ok' }, 'Ready for your devices.');
  } else {
    problem = true;
    text = h('span', { className: 'warn' }, 'Windows may be stopping your devices from reaching this PC.');
    note = 'Allow devices asks Windows once, then lets your phone or tablet through on your home Wi-Fi.';
  }
  $('firewall').replaceChildren(text);
  $('firewallNote').textContent = note;
  $('fixFirewall').hidden = !problem;
  $('checkFirewall').hidden = !problem;
}

// ------------------------------------------------------------------ events worth a toast
let seenDevices = null;
let seenTransfers = null;

function announce(s) {
  const ids = new Set(s.devices.map((d) => d.id));
  if (seenDevices) {
    for (const d of s.devices) if (!seenDevices.has(d.id)) toast(`${d.name} is connected. It can now get manga from this PC.`, { name: glyphFor(d.kind) });
  }
  seenDevices = ids;
  const done = s.transfers.recent.filter((x) => x.id != null);
  if (seenTransfers) {
    for (const x of done) {
      if (seenTransfers.has(x.id)) continue;
      const what = shortName(x.name);
      if (x.ok) toast(x.kind === 'to PC' ? `Received ${what}${x.device ? ` from ${x.device}` : ''}` : `Sent ${what}${x.device ? ` to ${x.device}` : ''}`, { name: x.kind === 'to PC' ? 'down' : 'up' });
      else toast(`${x.kind === 'to PC' ? 'Receiving' : 'Sending'} ${what} stopped: ${x.error || 'the connection dropped'}`, { bad: true });
      if (x.ok && x.kind === 'to PC' && window.Library) window.Library.reload();
    }
  }
  seenTransfers = new Set(done.map((x) => x.id));
}

// ------------------------------------------------------------------ status loop
function render(s) {
  status = s;
  if (!view) show(firstView(s), false);
  renderRail(s);
  renderPairDialog(s);
  if (view === 'devices') {
    // Rebuild the device cards only when they change (not every second): rebuilt buttons swallow
    // clicks and lose keyboard focus. Transfer progress updates on its own.
    const sig = JSON.stringify([
      s.devices.map((d) => [d.id, d.name, d.kind, d.online, Math.floor((d.lastSeenMs || 0) / 60000)]),
      s.pairRequests.map((r) => r.id), s.code, s.addresses, s.tailscale, s.away, s.name,
    ]);
    if (sig !== devicesSig) {
      devicesSig = sig;
      renderDevices(s);
    } else {
      renderTransfers(s.transfers);
    }
  } else {
    devicesSig = '';
    renderRequests(s);
  }
  renderSettings(s);
  announce(s);
  if (window.Library) window.Library.summary(s);
}

let busy = false;
let failures = 0;
let devicesSig = '';
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    render(await api('status'));
    failures = 0;
  } catch {
    if (++failures >= 2) {
      $('status').classList.add('off');
      $('statusText').textContent = 'Not responding';
    }
  } finally {
    busy = false;
  }
}

function withBusy(button, fn) {
  button.onclick = async () => {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(`That didn’t work (${e.message}).`, { bad: true });
    } finally {
      button.disabled = false;
      refresh();
    }
  };
}

// ------------------------------------------------------------------ wiring
$('otherWaysBtn').onclick = () => {
  const open = $('otherWays').hidden;
  $('otherWays').hidden = !open;
  $('otherWaysBtn').setAttribute('aria-expanded', String(open));
  if (open && status) loadQr(status.code);
};
withBusy($('newCode'), () => post('new-code'));
$('qr').onclick = showBigQr;
$('qr').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') showBigQr();
};
$('bigqr').onclick = () => ($('bigqr').hidden = true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('bigqr').hidden) $('bigqr').hidden = true;
  else if (!$('pairScrim').hidden && asking) {
    // Not now: this question stays under Devices until it expires; other devices still ask.
    dismissed.add(asking.id);
    closePairDialog();
  }
});

const chooseFolder = async () => {
  const res = await post('choose-folder');
  if (res.ok) {
    toast('Manga folder changed. Scanning it now.', { name: 'folder' });
    if (window.Library) window.Library.reload();
  }
};
withBusy($('chooseFolder'), chooseFolder);
withBusy($('emptyChoose'), chooseFolder);
withBusy($('upgrade'), () => post('panels/upgrade'));
withBusy($('retry'), () => post('panels/retry'));
withBusy($('choosePanelizer'), async () => {
  const res = await post('panelizer', { choose: true }).catch(() => ({ ok: false }));
  if (!res.ok && !res.cancelled) toast('That folder doesn’t have the panelizer. Choose tools\\panelizer after setting it up (see its README).', { bad: true, ms: 8000 });
});
withBusy($('fixFirewall'), async () => {
  const res = await post('firewall/fix');
  if (res.cancelled) toast('Nothing changed: Windows didn’t get the go-ahead.', { name: 'shield' });
  else if (res.ok) toast('Done. Your devices can reach this PC.', { name: 'shield' });
  else toast('Windows didn’t accept the change.', { bad: true });
});
$('awaySwitch').onclick = async () => {
  const on = $('awaySwitch').getAttribute('aria-checked') !== 'true';
  $('awaySwitch').setAttribute('aria-checked', String(on));
  $('awayBody').hidden = !on;
  await post('away', { on }).catch(() => {});
  refresh();
};
withBusy($('getTailscale'), () => post('open-url', { url: 'https://tailscale.com/download' }));
$('awayQr').onclick = () => {
  show('devices');
  if ($('otherWays').hidden) $('otherWaysBtn').click();
  showBigQr();
};
withBusy($('checkFirewall'), () => post('firewall/check'));
withBusy($('openLogs'), () => post('open-logs'));
$('autostart').onclick = async () => {
  const on = $('autostart').getAttribute('aria-checked') !== 'true';
  $('autostart').setAttribute('aria-checked', String(on));
  try {
    await post('autostart', { on });
    toast(on ? 'Mangarino Hub will start with Windows, in the tray.' : 'Mangarino Hub won’t start with Windows.', { name: 'power' });
  } catch {
    toast('Couldn’t change that setting.', { bad: true });
  }
  refresh();
};
$('panelMode').onchange = () => post('panels', { mode: $('panelMode').value }).then(refresh, () => refresh());
$('pathForm').onsubmit = async (e) => {
  e.preventDefault();
  const path = $('pathInput').value.trim();
  if (!path) return;
  try {
    await post('folder', { path });
    $('pathInput').value = '';
    toast('Manga folder changed. Scanning it now.', { name: 'folder' });
    if (window.Library) window.Library.reload();
  } catch {
    toast('That folder wasn’t found.', { bad: true });
  }
  refresh();
};
$('nameInput').oninput = () => ($('nameInput').dataset.dirty = '1');
$('nameForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  if (!name) return;
  try {
    await post('name', { name });
    delete $('nameInput').dataset.dirty;
    $('nameInput').blur();
    toast('Saved. Your devices show the new name when they next connect.', { name: 'pc' });
  } catch {
    toast('That name can’t be used.', { bad: true });
  }
  refresh();
};
let quitArmed = false;
$('quit').onclick = async () => {
  if (!quitArmed) {
    quitArmed = true;
    $('quit').textContent = 'Click again to quit';
    setTimeout(() => {
      quitArmed = false;
      $('quit').textContent = 'Quit';
    }, 4000);
    return;
  }
  await post('stop').catch(() => {});
  $('status').classList.add('off');
  $('statusText').textContent = 'Stopped';
};
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEWS.includes(v) && v !== view) show(v, false);
});

paint();
refresh();
setInterval(refresh, 1000);
