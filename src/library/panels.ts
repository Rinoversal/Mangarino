export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The panel as detected, before it grew over speech balloons (panel files from 1.1.1's
   * panelizer). Reading order uses it, so growth never changes the order. */
  frame?: { x: number; y: number; w: number; h: number };
}

export interface PagePanels {
  w: number | null;
  h: number | null;
  panels: PanelRect[];
}

export interface PanelsDoc {
  rtl: boolean;
  pages: Record<string, PagePanels>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normRects(v: unknown): PanelRect[] {
  if (!Array.isArray(v)) return [];
  const out: PanelRect[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const w = num(o.w);
    const h = num(o.h);
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
    const f = Array.isArray(o.frame) && o.frame.length === 4 ? o.frame.map(num) : null;
    const frame = f && f.every((n) => n !== null) && f[2]! > 0 && f[3]! > 0 ? { x: f[0]!, y: f[1]!, w: f[2]!, h: f[3]! } : null;
    out.push(frame ? { x, y, w, h, frame } : { x, y, w, h });
  }
  return out;
}

/** Accepts the full document form and the bare {entry: [rects]} form. */
export function parsePanelsJson(text: string): PanelsDoc | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return null;
    const pagesRaw = (raw.pages && typeof raw.pages === 'object' ? raw.pages : raw) as Record<string, unknown>;
    const pages: Record<string, PagePanels> = {};
    for (const [name, v] of Object.entries(pagesRaw)) {
      if (Array.isArray(v)) {
        pages[name] = { w: null, h: null, panels: normRects(v) };
      } else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        pages[name] = { w: num(o.w), h: num(o.h), panels: normRects(o.panels) };
      }
    }
    return { rtl: raw.rtl !== false, pages };
  } catch {
    return null;
  }
}

/**
 * Panel rects for one page. With `rtl` given, the panels are re-sorted into that reading
 * order, so a volume panelized for manga still reads left to right in Western mode.
 */
export function parsePagePanels(json: string | null, rtl?: boolean): PanelRect[] {
  if (!json) return [];
  let rects: PanelRect[];
  try {
    rects = normRects(JSON.parse(json));
  } catch {
    return [];
  }
  return rtl === undefined ? rects : readingOrder(rects, rtl);
}

// ----------------------------------------------------------------------------- reading order
// Port of reading_order() in tools/panelizer/panelize.py. Keep the two in step:
// __tests__/panels.test.ts checks them against each other when Python is available.

type Box = [number, number, number, number]; // x1, y1, x2, y2
type Key = number[];

const ROW_OVERLAP = 0.4;

function cmpKey(a: Key, b: Key): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Stable sort by a tuple key, like Python's sorted(key=...). */
function sortBy<T>(items: T[], key: (t: T) => Key): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => cmpKey(a.k, b.k) || a.i - b.i)
    .map((d) => d.item);
}

function shareRow(a: Box, b: Box): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const shorter = Math.min(a[3] - a[1], b[3] - b[1]);
  return shorter > 0 && overlap >= ROW_OVERLAP * shorter;
}

function shareCol(a: Box, b: Box): boolean {
  const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const narrower = Math.min(a[2] - a[0], b[2] - b[0]);
  return narrower > 0 && overlap >= ROW_OVERLAP * narrower;
}

/** Greedy clustering: a box joins the first group holding any box it matches; groups are then sorted. */
function cluster(boxes: Box[], same: (a: Box, b: Box) => boolean, key: (g: Box[]) => Key): Box[][] {
  const groups: Box[][] = [];
  for (const b of boxes) {
    const g = groups.find((grp) => grp.some((o) => same(b, o)));
    if (g) g.push(b);
    else groups.push([b]);
  }
  return sortBy(groups, key);
}

function orderBoxes(input: Box[], rtl: boolean): Box[] {
  const boxes = sortBy(input, (r) => [r[1], r[0]]);
  if (boxes.length <= 1) return boxes;
  const rows = cluster(boxes, shareRow, (g) => [Math.min(...g.map((r) => r[1]))]);
  const colKey = rtl
    ? (g: Box[]) => [-Math.max(...g.map((r) => r[2])), Math.min(...g.map((r) => r[1]))]
    : (g: Box[]) => [Math.min(...g.map((r) => r[0])), Math.min(...g.map((r) => r[1]))];
  const boxKey = rtl ? (r: Box) => [-r[2], r[1]] : (r: Box) => [r[0], r[1]];
  const ordered: Box[] = [];
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

/**
 * Manga/comic reading order: rows top to bottom, then right to left (rtl) or left to right
 * inside a row, with stacked column groups inside a row ordered recursively.
 */
export function readingOrder(rects: PanelRect[], rtl: boolean): PanelRect[] {
  // Ordered by each panel's frame when the file has one: how far a panel grew over balloons must
  // not change the order. orderBoxes hands back the same box arrays, so map them back to panels.
  const panelOf = new Map<Box, PanelRect>();
  const boxes = rects.map((r): Box => {
    const f = r.frame ?? r;
    const box: Box = [f.x, f.y, f.x + f.w, f.y + f.h];
    panelOf.set(box, r);
    return box;
  });
  return orderBoxes(boxes, rtl).map((box) => panelOf.get(box)!);
}
