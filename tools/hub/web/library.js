// The library and the reader, inside the hub window. Reading progress is saved to the hub,
// which syncs it with paired devices. Uses api/post/h/icon/paint/toast/bytes/ago from app.js.
'use strict';

(() => {
  const imageUrl = (path, version) => `/admin/${path}?v=${encodeURIComponent(version || '')}&k=${encodeURIComponent(KEY)}`;

  /** Same identity as the hub and the app: "<series folder>/<file name>", normalised, lower case. */
  const progressKey = (folder, file) => `${folder}/${file}`.normalize('NFC').toLowerCase();
  const label = (file) => file.replace(/\.(cbz|zip)$/i, '');

  // ---------------------------------------------------------------- panel reading order
  // Port of readingOrder() in src/library/panels.ts (itself a port of panelize.py), so panels
  // run in the same order here as on the tablet.
  const ROW_OVERLAP = 0.4;
  function cmpKey(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }
  function sortBy(items, key) {
    return items
      .map((item, i) => ({ item, i, k: key(item) }))
      .sort((a, b) => cmpKey(a.k, b.k) || a.i - b.i)
      .map((d) => d.item);
  }
  function shareRow(a, b) {
    const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const shorter = Math.min(a[3] - a[1], b[3] - b[1]);
    return shorter > 0 && overlap >= ROW_OVERLAP * shorter;
  }
  function shareCol(a, b) {
    const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const narrower = Math.min(a[2] - a[0], b[2] - b[0]);
    return narrower > 0 && overlap >= ROW_OVERLAP * narrower;
  }
  function cluster(boxes, same, key) {
    const groups = [];
    for (const b of boxes) {
      const g = groups.find((grp) => grp.some((o) => same(b, o)));
      if (g) g.push(b);
      else groups.push([b]);
    }
    return sortBy(groups, key);
  }
  function orderBoxes(input, rtl) {
    const boxes = sortBy(input, (r) => [r[1], r[0]]);
    if (boxes.length <= 1) return boxes;
    const rows = cluster(boxes, shareRow, (g) => [Math.min(...g.map((r) => r[1]))]);
    const colKey = rtl
      ? (g) => [-Math.max(...g.map((r) => r[2])), Math.min(...g.map((r) => r[1]))]
      : (g) => [Math.min(...g.map((r) => r[0])), Math.min(...g.map((r) => r[1]))];
    const boxKey = rtl ? (r) => [-r[2], r[1]] : (r) => [r[0], r[1]];
    const ordered = [];
    for (const row of rows) {
      if (row.length === 1) {
        ordered.push(...row);
        continue;
      }
      const cols = cluster(sortBy(row, boxKey), shareCol, colKey);
      if (cols.length === 1 && rows.length === 1) {
        ordered.push(...sortBy(row, boxKey));
        continue;
      }
      for (const col of cols) {
        if (col.length === 1 || col.length === boxes.length) ordered.push(...sortBy(col, boxKey));
        else ordered.push(...orderBoxes(col, rtl));
      }
    }
    return ordered;
  }
  function readingOrder(rects, rtl) {
    const boxes = rects.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h]);
    return orderBoxes(boxes, rtl).map(([x1, y1, x2, y2]) => ({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }));
  }

  // ---------------------------------------------------------------- preferences (this PC only)
  const prefs = { rtl: true, panels: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem('mangarino-reader') || '{}'));
  } catch {
    // storage off: defaults
  }
  function savePrefs() {
    try {
      localStorage.setItem('mangarino-reader', JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------- library
  // The PC's own volumes, plus what paired devices have that the PC doesn't (as they last
  // reported it). A device's volume comes over when it's opened here.
  let listing = null;
  let remote = [];
  const progress = new Map();
  let rev = 0;
  let openSeries = null; // the open series' id
  let loading = null;
  let lastSummary = '';
  let lastRemoteSig = '';

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const norm = (s) => String(s || '').normalize('NFC').toLowerCase();
  const relOf = (folder, file) => (folder ? `${folder}/${file}` : file);
  const itemFile = (item) => (item.pc ? item.pc.file : item.vol.file);
  const kindWord = (dev) => (dev.kind === 'phone' ? 'phone' : 'tablet');
  const deviceCover = (dev, v) =>
    `/admin/remote/${encodeURIComponent(dev.deviceId)}/cover/${v.id}?v=${encodeURIComponent(v.cover || '')}&k=${encodeURIComponent(KEY)}`;
  const remoteSig = (devices) => JSON.stringify(devices.map((d) => [d.deviceId, d.updatedMs, d.listening]));

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const [lib, p, r] = await Promise.all([api('library'), api(`progress?since=${rev}`), api('remote').catch(() => ({ devices: [] }))]);
      listing = lib;
      remote = r.devices || [];
      lastRemoteSig = remoteSig(remote);
      for (const row of p.rows) progress.set(row.key, row);
      rev = p.rev;
      render();
    })().finally(() => (loading = null));
    return loading;
  }

  /** Every series from every source: {id, title, folder, series (the PC's, or null), items}, where an
   * item is {pc: volume} or {dev, vol} (a device's volume the PC doesn't have), in reading order. */
  function merged() {
    const out = [];
    const byFolder = new Map();
    const have = new Set();
    for (const s of listing ? listing.series : []) {
      const entry = { id: s.id, title: s.title, folder: s.folder, series: s, items: s.volumes.map((v) => ({ pc: v })) };
      out.push(entry);
      byFolder.set(norm(s.folder), entry);
      for (const v of s.volumes) have.add(norm(relOf(s.folder, v.file)));
    }
    for (const dev of remote) {
      for (const rs of dev.series) {
        for (const v of rs.volumes) {
          const rel = norm(relOf(v.folder, v.file));
          if (v.kind !== 'cbz' || have.has(rel)) continue;
          have.add(rel);
          let entry = byFolder.get(norm(v.folder));
          if (!entry) {
            entry = { id: `dev-${dev.deviceId}-${rs.id}`, title: rs.title, folder: v.folder, series: null, items: [] };
            out.push(entry);
            byFolder.set(norm(v.folder), entry);
          }
          entry.items.push({ dev, vol: v });
        }
      }
    }
    for (const e of out) e.items.sort((a, b) => collator.compare(itemFile(a), itemFile(b)));
    out.sort((a, b) => collator.compare(a.title, b.title));
    return out.filter((e) => e.items.length);
  }

  function stateOf(entry, item) {
    const r = progress.get(item.pc ? progressKey(entry.folder, item.pc.file) : item.vol.key);
    return r ? { done: !!r.completed, page: r.page, at: r.updatedMs } : null;
  }

  function coverEl(className, item) {
    const el = h('div', { className });
    if (item) el.style.backgroundImage = `url("${item.pc ? imageUrl(`cover/${item.pc.id}`, item.pc.version) : deviceCover(item.dev, item.vol)}")`;
    return el;
  }

  function open(entry, item) {
    if (item.pc) openVolume(entry.series, item.pc);
    else fetchFromDevice(item);
  }

  function volumeTile(entry, item) {
    const st = stateOf(entry, item);
    const cover = coverEl('tile-cover', item);
    if (st && st.done) cover.append(h('span', { className: 'chip done' }, icon('check'), 'Read'));
    else if (st) cover.append(h('span', { className: 'chip' }, `p. ${st.page + 1}`));
    if (item.dev) cover.append(h('span', { className: 'chip device' }, icon(glyphFor(item.dev.kind)), `On ${kindWord(item.dev)}`));
    let meta;
    if (st) meta = st.done ? `Finished ${ago(st.at)}` : `Page ${st.page + 1} · ${ago(st.at)}`;
    else if (item.dev) meta = `${bytes(item.vol.size)} · on ${item.dev.name}`;
    else meta = item.pc.panels === 'ready' || item.pc.panels === 'old' ? 'Panels ready' : bytes(item.pc.size);
    const tile = h('button', { className: 'tile', title: itemFile(item) }, cover, h('div', { className: 'tile-name' }, label(itemFile(item))), h('div', { className: 'tile-meta' }, meta));
    tile.onclick = () => open(entry, item);
    return tile;
  }

  function seriesTile(entry) {
    const states = entry.items.map((it) => stateOf(entry, it));
    const read = states.filter((s) => s && s.done).length;
    const started = states.filter((s) => s && !s.done).length;
    const onDevice = entry.items.filter((it) => it.dev);
    const cover = coverEl('tile-cover', entry.items[0]);
    if (read === entry.items.length && read) cover.append(h('span', { className: 'chip done' }, icon('check'), 'Read'));
    if (onDevice.length === entry.items.length) cover.append(h('span', { className: 'chip device' }, icon(glyphFor(onDevice[0].dev.kind)), `On ${kindWord(onDevice[0].dev)}`));
    const bits = [`${entry.items.length} volume${entry.items.length === 1 ? '' : 's'}`];
    if (read && read < entry.items.length) bits.push(`${read} read`);
    else if (started && !read) bits.push('reading');
    if (onDevice.length && onDevice.length < entry.items.length) bits.push(`${onDevice.length} on ${kindWord(onDevice[0].dev)}`);
    const tile = h('button', { className: 'tile' }, cover, h('div', { className: 'tile-name' }, entry.title), h('div', { className: 'tile-meta' }, bits.join(' · ')));
    tile.onclick = () => {
      openSeries = entry.id;
      render();
      document.querySelector('.stage').scrollTop = 0;
    };
    return tile;
  }

  function shelfCard(entry, item, r) {
    const card = h('button', { className: 'shelf-card' },
      coverEl('shelf-cover', item),
      h('div', { className: 'shelf-text' },
        h('div', { className: 'shelf-series' }, entry.title),
        h('div', { className: 'shelf-name' }, label(itemFile(item))),
        h('div', { className: 'shelf-pos' }, `Page ${r.page + 1} · ${ago(r.updatedMs)}` + (item.dev ? ` · on ${kindWord(item.dev)}` : '')),
        h('div', { className: 'shelf-resume' }, icon('play'), item.dev ? 'Get and read' : 'Resume')));
    card.onclick = () => open(entry, item);
    return card;
  }

  function render() {
    const all = merged();
    const empty = !!listing && all.length === 0;
    $('libEmpty').hidden = !empty;
    $('grid').hidden = empty;
    $('gridTitle').hidden = empty;
    // Continue reading: unfinished volumes, most recent first (read here or on a device).
    const recent = [];
    for (const e of all) {
      for (const it of e.items) {
        const r = progress.get(it.pc ? progressKey(e.folder, it.pc.file) : it.vol.key);
        if (r && !r.completed) recent.push({ e, it, r });
      }
    }
    recent.sort((a, b) => b.r.updatedMs - a.r.updatedMs);
    $('continueWrap').hidden = recent.length === 0 || !!openSeries;
    $('continue').replaceChildren(...recent.slice(0, 8).map(({ e, it, r }) => shelfCard(e, it, r)));

    const entry = openSeries ? all.find((e) => e.id === openSeries) : null;
    if (openSeries && !entry) openSeries = null;
    if (entry) {
      const onDevice = entry.items.filter((it) => it.dev);
      $('libEyebrow').textContent = 'Series';
      $('libHeading').textContent = entry.title;
      $('libLede').textContent =
        `${entry.items.length} volume${entry.items.length === 1 ? '' : 's'}` +
        (onDevice.length ? ` · ${onDevice.length} still on your ${kindWord(onDevice[0].dev)}, click one to get it` : '');
      $('gridTitle').textContent = 'Volumes';
      $('backToSeries').hidden = false;
      $('grid').replaceChildren(...entry.items.map((it) => volumeTile(entry, it)));
    } else {
      const onDevice = all.reduce((n, e) => n + e.items.filter((it) => it.dev).length, 0);
      const dev = remote.find((d) => d.series.length);
      $('libEyebrow').textContent = 'On this PC' + (dev ? ` and ${dev.name}` : '');
      $('libHeading').textContent = 'Library';
      $('libLede').textContent = lastSummary + (onDevice && dev ? ` · ${onDevice} more on ${dev.name}` : '');
      $('gridTitle').textContent = 'All series';
      $('backToSeries').hidden = true;
      $('grid').replaceChildren(...all.map(seriesTile));
    }
    paint($('view-library'));
  }

  $('backToSeries').onclick = () => {
    openSeries = null;
    render();
  };

  // ---------------------------------------------------------------- getting a volume from a device
  let fetching = null;

  function setFetch(text, fraction, detail) {
    $('fetchText').textContent = text;
    $('fetchMeterWrap').hidden = fraction == null;
    $('fetchMeter').style.width = `${Math.round((fraction || 0) * 100)}%`;
    $('fetchFoot').textContent = detail || '';
  }

  function findPcVolume(id) {
    for (const s of listing ? listing.series : []) {
      const v = s.volumes.find((x) => x.id === id);
      if (v) return { series: s, vol: v };
    }
    return null;
  }

  async function fetchFromDevice(item) {
    const { dev, vol } = item;
    const token = {};
    fetching = token;
    const base = `remote/${encodeURIComponent(dev.deviceId)}/want/${vol.id}`;
    $('fetchTitle').textContent = `Getting ${label(vol.file)}`;
    $('fetchGlyph').dataset.icon = glyphFor(dev.kind);
    paint($('fetchScrim'));
    $('fetchScrim').hidden = false;
    setFetch(`Asking ${dev.name}…`, null);
    let st;
    let startedAt = Date.now();
    try {
      st = await post(base);
    } catch {
      setFetch(`Couldn’t ask ${dev.name}.`, null);
      return;
    }
    while (fetching === token) {
      if (st.state === 'ready') {
        await load();
        fetching = null;
        $('fetchScrim').hidden = true;
        const found = findPcVolume(st.volumeId);
        if (found) openVolume(found.series, found.vol);
        return;
      }
      if (st.state === 'gone') {
        setFetch(`${dev.name} doesn’t have it any more.`, null);
        return;
      }
      if (st.state === 'sending') {
        startedAt = null;
        setFetch(`Coming over from ${dev.name}…`, st.total ? st.bytes / st.total : 0, `${bytes(st.bytes)} of ${bytes(st.total)}`);
      } else if (st.state === 'starting' && startedAt !== null && Date.now() - startedAt > 45000) {
        setFetch(`${dev.name} didn’t send it. Check Mangarino is open on it, then try again.`, null);
        return;
      } else if (st.listening) setFetch(`Asking ${dev.name}…`, null);
      else setFetch(`Open Mangarino on ${dev.name}. It sends this volume as soon as it’s open, and it opens here.`, null, 'You can close this; the volume still comes over.');
      await new Promise((r) => setTimeout(r, 700));
      try {
        st = await api(base);
      } catch {
        // the hub is busy; ask again
      }
    }
  }

  $('fetchClose').onclick = () => {
    fetching = null;
    $('fetchScrim').hidden = true;
  };

  // ---------------------------------------------------------------- reader
  let cur = null; // { series, vol, key, pages, page, panel }
  let saveTimer = null;
  let wheelLock = 0;
  let idleTimer = null;
  const FIT_MARGIN = 0.96;
  const MAX_PAGE_FIT_MULTIPLE = 3;
  const FOCUS_PAD_FRAC = 0.02;

  function pagePanels() {
    const p = cur.pages[cur.page];
    return prefs.panels && p.panels.length ? readingOrder(p.panels, prefs.rtl) : [];
  }

  async function openVolume(series, vol) {
    $('reader').hidden = false;
    $('loading').hidden = false;
    let meta;
    try {
      const [m, p] = await Promise.all([api(`pages/${vol.id}`), api(`progress?since=${rev}`).catch(() => null)]);
      meta = m;
      if (p) {
        for (const row of p.rows) progress.set(row.key, row);
        rev = p.rev;
      }
    } catch {
      closeReader();
      toast('Couldn’t open this volume.', { bad: true });
      return;
    }
    const key = progressKey(series.folder, vol.file);
    const saved = progress.get(key);
    const pages = meta.pages;
    if (!pages.length) {
      closeReader();
      toast('This volume has no pages.', { bad: true });
      return;
    }
    cur = { series, vol, key, pages, page: 0, panel: 0 };
    if (saved && !saved.completed) {
      cur.page = Math.min(Math.max(0, saved.page), pages.length - 1);
      cur.panel = saved.panel ?? 0;
    }
    $('rTitle').textContent = `${series.title} · ${label(vol.file)}`;
    $('scrub').max = String(pages.length);
    showPage(false);
    wake();
  }

  function closeReader() {
    flushSave();
    cur = null;
    $('reader').hidden = true;
    $('readerToast').hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    render();
  }

  /** Load the current page image (if needed) and lay it out; `animate` for panel-to-panel moves. */
  function showPage(animate) {
    const p = cur.pages[cur.page];
    const img = $('page');
    const src = imageUrl(`page/${cur.vol.id}/${cur.page}`, cur.vol.version);
    if (img.dataset.src !== src) {
      $('sheet').classList.remove('animate');
      img.dataset.src = src;
      img.onload = () => {
        $('loading').hidden = true;
        p.w = p.w || img.naturalWidth;
        p.h = p.h || img.naturalHeight;
        layout(false);
      };
      img.src = src;
      $('loading').hidden = !!img.complete;
      if (img.complete && img.naturalWidth) layout(false);
      for (const n of [cur.page + 1, cur.page + 2]) {
        if (n < cur.pages.length) new Image().src = imageUrl(`page/${cur.vol.id}/${n}`, cur.vol.version);
      }
    } else {
      layout(animate);
    }
    updateBar();
  }

  function layout(animate) {
    if (!cur) return;
    const p = cur.pages[cur.page];
    const img = $('page');
    const W = p.w || img.naturalWidth;
    const H = p.h || img.naturalHeight;
    if (!W || !H) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sheet = $('sheet');
    sheet.classList.toggle('animate', !!animate);
    sheet.style.width = `${W}px`;
    sheet.style.height = `${H}px`;
    const fit = Math.min(vw / W, vh / H);
    const panels = pagePanels();
    let rect = { x: 0, y: 0, w: W, h: H };
    let s = fit;
    if (panels.length) {
      cur.panel = Math.min(Math.max(0, cur.panel), panels.length - 1);
      const r = panels[cur.panel];
      const pad = FOCUS_PAD_FRAC * Math.min(W, H);
      const x1 = Math.max(0, r.x - pad);
      const y1 = Math.max(0, r.y - pad);
      rect = { x: x1, y: y1, w: Math.min(W, r.x + r.w + pad) - x1, h: Math.min(H, r.y + r.h + pad) - y1 };
      s = Math.min(Math.min(vw / rect.w, vh / rect.h) * FIT_MARGIN, MAX_PAGE_FIT_MULTIPLE * fit);
    }
    const tx = vw / 2 - (rect.x + rect.w / 2) * s;
    const ty = vh / 2 - (rect.y + rect.h / 2) * s;
    sheet.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const on = panels.length > 0;
    const place = (id, x, y, w, hgt) => {
      const el = $(id);
      el.hidden = !on;
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, hgt)}px` });
    };
    place('maskTop', 0, 0, W, rect.y);
    place('maskBottom', 0, rect.y + rect.h, W, H - rect.y - rect.h);
    place('maskLeft', 0, rect.y, rect.x, rect.h);
    place('maskRight', rect.x + rect.w, rect.y, W - rect.x - rect.w, rect.h);
    place('outline', rect.x, rect.y, rect.w, rect.h);
    $('outline').style.borderWidth = `${4 / s}px`;
  }

  function updateBar() {
    const panels = pagePanels();
    $('rPos').textContent = `Page ${cur.page + 1} of ${cur.pages.length}` + (panels.length ? ` · panel ${cur.panel + 1} of ${panels.length}` : '');
    $('scrub').value = String(cur.page + 1);
    $('modeBtn').classList.toggle('on', prefs.panels);
    $('dirLabel').textContent = prefs.rtl ? 'Manga' : 'Western';
  }

  function next() {
    if (!cur) return;
    const panels = pagePanels();
    if (panels.length && cur.panel < panels.length - 1) {
      cur.panel++;
      showPage(true);
    } else if (cur.page < cur.pages.length - 1) {
      cur.page++;
      cur.panel = 0;
      showPage(false);
    } else {
      save(true);
      endOfVolume();
      return;
    }
    save(false);
  }

  function prev() {
    if (!cur) return;
    const panels = pagePanels();
    if (panels.length && cur.panel > 0) {
      cur.panel--;
      showPage(true);
    } else if (cur.page > 0) {
      cur.page--;
      const before = cur.pages[cur.page];
      cur.panel = prefs.panels && before.panels.length ? before.panels.length - 1 : 0;
      showPage(false);
    } else {
      return;
    }
    save(false);
  }

  function goToPage(n) {
    cur.page = Math.min(Math.max(0, n), cur.pages.length - 1);
    cur.panel = 0;
    showPage(false);
    save(false);
  }

  function save(finished) {
    if (!cur) return;
    const row = {
      key: cur.key,
      page: cur.page,
      panel: prefs.panels ? cur.panel : null,
      completed: finished || cur.page >= cur.pages.length - 1,
      updatedMs: Date.now(),
    };
    progress.set(cur.key, row);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => post('progress', { rows: [row] }).catch(() => {}), 700);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      const row = cur && progress.get(cur.key);
      if (row) post('progress', { rows: [row] }).catch(() => {});
    }
  }

  function endOfVolume() {
    const vols = cur.series.volumes;
    const i = vols.findIndex((v) => v.id === cur.vol.id);
    const nextVol = i >= 0 ? vols[i + 1] : null;
    if (nextVol) {
      const series = cur.series;
      const btn = h('button', { className: 'btn primary sm' }, `Next: ${label(nextVol.file)}`);
      btn.onclick = (e) => {
        e.stopPropagation();
        flushSave();
        $('readerToast').hidden = true;
        openVolume(series, nextVol);
      };
      readerToast('End of the volume.', btn);
    } else {
      readerToast('That’s the end of the series.');
    }
  }

  function readerToast(text, action) {
    const t = $('readerToast');
    t.replaceChildren(h('span', {}, text), ...(action ? [action] : []));
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), action ? 9000 : 2600);
  }

  function wake() {
    $('reader').classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => $('reader').classList.add('idle'), 2600);
  }

  $('stage').onclick = (e) => {
    const x = e.clientX / window.innerWidth;
    if (x > 0.3 && x < 0.7) {
      $('reader').classList.contains('idle') ? wake() : $('reader').classList.add('idle');
      return;
    }
    const forward = prefs.rtl ? x <= 0.3 : x >= 0.7;
    forward ? next() : prev();
  };
  $('reader').onmousemove = wake;
  $('stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 250) return;
    wheelLock = now;
    e.deltaY > 0 ? next() : prev();
  }, { passive: false });
  $('close').onclick = closeReader;
  $('modeBtn').onclick = () => {
    prefs.panels = !prefs.panels;
    savePrefs();
    cur.panel = 0;
    showPage(false);
    save(false);
  };
  $('dirBtn').onclick = () => {
    prefs.rtl = !prefs.rtl;
    savePrefs();
    showPage(false);
  };
  let appFullscreen = false;
  $('fsBtn').onclick = async () => {
    if (typeof status !== 'undefined' && status && status.desktop && status.desktop.window) {
      const res = await post('window/fullscreen').catch(() => null);
      if (res && res.ok) appFullscreen = !appFullscreen;
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $('reader').requestFullscreen().catch(() => {});
  };
  $('scrub').oninput = () => goToPage(Number($('scrub').value) - 1);
  document.addEventListener('keydown', (e) => {
    if ($('reader').hidden || !cur) return;
    const k = e.key;
    if (k === 'ArrowLeft') prefs.rtl ? next() : prev();
    else if (k === 'ArrowRight') prefs.rtl ? prev() : next();
    else if (k === ' ' || k === 'PageDown' || k === 'ArrowDown') next();
    else if (k === 'PageUp' || k === 'ArrowUp' || k === 'Backspace') prev();
    else if (k === 'p' || k === 'P') $('modeBtn').click();
    else if (k === 'd' || k === 'D') $('dirBtn').click();
    else if (k === 'f' || k === 'F') $('fsBtn').click();
    else if (k === 'Home') goToPage(0);
    else if (k === 'End') goToPage(cur.pages.length - 1);
    else if (k === 'Escape') {
      if (appFullscreen) $('fsBtn').click(); // leave full screen first, like a browser does
      else if (!document.fullscreenElement) closeReader();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener('resize', () => cur && layout(false));
  window.addEventListener('beforeunload', flushSave);

  // Keep covers and progress in step with devices while the library is on screen.
  setInterval(() => {
    if (!$('view-library').hidden && $('reader').hidden) {
      Promise.all([api('library'), api(`progress?since=${rev}`), api('remote').catch(() => ({ devices: remote }))])
        .then(([lib, p, r]) => {
          const devices = r.devices || [];
          const sig = remoteSig(devices);
          const changed = lib.generation !== (listing && listing.generation) || p.rows.length > 0 || sig !== lastRemoteSig;
          listing = lib;
          remote = devices;
          lastRemoteSig = sig;
          for (const row of p.rows) progress.set(row.key, row);
          rev = p.rev;
          if (changed) render();
        })
        .catch(() => {});
    }
  }, 8000);

  paint($('reader'));

  /** #read/<volume id> opens a volume straight away (from a link, or the tray). */
  function openFromHash() {
    const m = /^#read\/([\w-]+)$/.exec(location.hash);
    if (!m || !listing) return;
    for (const s of listing.series) {
      const v = s.volumes.find((x) => x.id === m[1]);
      if (v) {
        history.replaceState(null, '', '#library');
        openVolume(s, v);
        return;
      }
    }
  }
  window.addEventListener('hashchange', () => load().then(openFromHash).catch(() => {}));

  window.Library = {
    shown() {
      load().then(openFromHash).catch(() => {
        $('grid').replaceChildren(h('p', { className: 'quiet' }, 'Couldn’t load the library. Is the hub still running?'));
      });
    },
    reload() {
      load().catch(() => {});
    },
    summary(s) {
      const lib = s.library;
      const text = lib.exists
        ? `${lib.series} series · ${lib.volumes} volume${lib.volumes === 1 ? '' : 's'} · ${bytes(lib.bytes)}`
        : 'Choose your manga folder in Settings.';
      if (text !== lastSummary) {
        lastSummary = text;
        if (!openSeries && listing) render();
      }
    },
  };
})();
