/**
 * Filename intelligence: pure functions, no platform imports. Unit-tested in __tests__/parse.test.ts.
 */

export interface ArchiveNameInfo {
  series?: string;
  volume?: number;
  chapter?: number;
  year?: number;
}

export interface EntryNameInfo {
  dir: string;
  chapter?: number;
  volume?: number;
  page?: number;
  extra?: string;
}

const ARCHIVE_EXT = /\.(cbz|cbr|cb7|cbt|zip|rar|7z)$/i;
const VOLUME_RE = /\b(?:v|vol\.?|volume|tome)\s*(\d{1,3}(?:\.\d+)?)\b/i;
const CHAPTER_RE = /(?:\b(?:c|ch\.?|chapter|chap\.?)|#)\s*(\d{1,4}(?:\.\d+)?)\b/i;
const TRAILING_DASH_NUM = /\s[-–]\s(\d{1,4}(?:\.\d+)?)\s*$/;
const TRAILING_NUM = /\s(\d{1,4}(?:\.\d+)?)\s*$/;

function stripFolder(name: string): string {
  const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf(String.fromCharCode(92)));
  return i >= 0 ? name.slice(i + 1) : name;
}

function cleanTrailing(s: string): string {
  return s.replace(/[\s\-–_,:.]+$/g, '').trim();
}

export function parseArchiveName(fileName: string): ArchiveNameInfo {
  let s = stripFolder(fileName).replace(ARCHIVE_EXT, '');
  s = s.replace(/\[[^\]]*\]/g, ' ');

  let year: number | undefined;
  s = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    const y = inner.match(/^\s*((?:19|20)\d{2})\s*$/);
    if (y && year === undefined) {
      year = Number(y[1]);
      return ' ';
    }
    if (VOLUME_RE.test(inner) || CHAPTER_RE.test(inner)) return ` ${inner} `;
    return ' ';
  });

  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  const info: ArchiveNameInfo = {};
  if (year !== undefined) info.year = year;

  let cut = s.length;
  const v = VOLUME_RE.exec(s);
  if (v) {
    info.volume = Number(v[1]);
    cut = Math.min(cut, v.index);
  }
  const c = CHAPTER_RE.exec(s);
  if (c) {
    info.chapter = Number(c[1]);
    cut = Math.min(cut, c.index);
  } else {
    const t = TRAILING_DASH_NUM.exec(s) ?? (info.volume === undefined ? TRAILING_NUM.exec(s) : null);
    if (t) {
      info.chapter = Number(t[1]);
      cut = Math.min(cut, t.index);
    }
  }

  const series = cleanTrailing(s.slice(0, cut));
  if (series) info.series = series;
  return info;
}

const DANKE_RE = /^(.+?)\s[-–]\s(?:c|ch)?(\d{1,4}(?:\.\d+)?)\s\(v(\d{1,3})\)\s[-–]\sp(\d{1,4})(?:x(\d{1,2}))?\b/i;
const ENTRY_VOL_RE = /\bv(?:ol)?\.?\s*(\d{1,3})\b/i;
const ENTRY_CH_RE = /\b(?:c|ch|chapter)\.?\s*(\d{1,4}(?:\.\d+)?)\b/i;
const ENTRY_PAGE_RE = /\bp(?:g|age)?\.?\s*(\d{1,4})(?:x(\d{1,2}))?\b/i;
const ANY_NUM_RE = /(\d{1,4})(x\d{1,2}|[a-z])?(?![\d])/gi;

export function parseEntryName(entryName: string): EntryNameInfo {
  const slash = entryName.lastIndexOf('/');
  const dir = slash >= 0 ? entryName.slice(0, slash) : '';
  let base = slash >= 0 ? entryName.slice(slash + 1) : entryName;
  base = base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const d = DANKE_RE.exec(base);
  if (d) {
    const info: EntryNameInfo = { dir, chapter: Number(d[2]), volume: Number(d[3]), page: Number(d[4]) };
    if (d[5]) info.extra = `x${d[5]}`;
    return info;
  }

  const info: EntryNameInfo = { dir };
  const v = ENTRY_VOL_RE.exec(base);
  if (v) info.volume = Number(v[1]);
  const c = ENTRY_CH_RE.exec(base);
  if (c) info.chapter = Number(c[1]);
  const p = ENTRY_PAGE_RE.exec(base);
  if (p) {
    info.page = Number(p[1]);
    if (p[2]) info.extra = `x${p[2]}`;
    return info;
  }
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  ANY_NUM_RE.lastIndex = 0;
  while ((m = ANY_NUM_RE.exec(base)) !== null) last = m;
  if (last) {
    info.page = Number(last[1]);
    if (last[2]) info.extra = last[2].toLowerCase();
  }
  return info;
}

const TOKEN_RE = /(\d+)|(\D+)/g;

/** Human ordering: digit runs compare numerically, text case-insensitively. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.match(TOKEN_RE) ?? [];
  const tb = b.match(TOKEN_RE) ?? [];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    const xd = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
    const yd = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
    if (xd && yd) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      if (x.length !== y.length) return x.length - y.length;
      continue;
    }
    if (xd !== yd) return xd ? -1 : 1;
    const xl = x.toLowerCase();
    const yl = y.toLowerCase();
    if (xl !== yl) return xl < yl ? -1 : 1;
  }
  return ta.length - tb.length;
}

const EXT_RE = /\.[^./\\]+$/;

/**
 * Reading order of the pages in a volume: natural order of the names without their extensions
 * first, so "image.png" comes before "image (1).png" (how Windows names copies of a download).
 * Must match page_key() in tools/hub/mangarino_hub/library.py: synced progress is a page number.
 */
export function pageCompare(a: string, b: string): number {
  return naturalCompare(a.replace(EXT_RE, ''), b.replace(EXT_RE, '')) || naturalCompare(a, b);
}

/** A string whose plain byte order equals natural order (for SQL ORDER BY). */
export function naturalKey(s: string): string {
  return s.toLowerCase().replace(/\d+/g, (d) => d.padStart(8, '0'));
}

function padNum(n: number | undefined, fallback: number, width: number): string {
  const v = n === undefined ? fallback : n;
  return v.toFixed(2).padStart(width, '0');
}

/** Order archives within a series: volumes first, then chapters, then name. */
export function archiveSortKey(info: { volume?: number; chapter?: number }, fileName: string): string {
  return `${padNum(info.volume, 9999, 8)}|${padNum(info.chapter, 99999, 9)}|${naturalKey(fileName)}`;
}

export function normalizeSeriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function archiveLabel(info: { volume?: number | null; chapter?: number | null }, fileName: string): string {
  const parts: string[] = [];
  if (info.volume !== undefined && info.volume !== null) parts.push(`Vol. ${info.volume}`);
  if (info.chapter !== undefined && info.chapter !== null) parts.push(`Ch. ${info.chapter}`);
  if (parts.length) return parts.join(' ');
  return stripFolder(fileName).replace(ARCHIVE_EXT, '');
}
