import { Directory, File } from 'expo-file-system';

import {
  ArchiveRow,
  SourceRow,
  deleteArchivesNotIn,
  deleteEmptySeries,
  getArchiveByUri,
  invalidateArchiveIndex,
  touchSource,
  upsertArchive,
  upsertSeries,
} from '@/db/repo';

import { archiveSortKey, naturalCompare, normalizeSeriesKey, parseArchiveName } from './parse';

const ARCHIVE_RE = /\.(cbz|zip)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

export interface ScanProgress {
  phase: 'listing' | 'indexing' | 'covers' | 'done';
  current: number;
  total: number;
  label?: string;
}

export interface FoundArchive {
  uri: string;
  fileName: string;
  kind: 'cbz' | 'dir';
  size: number;
  mtime: number | null;
  seriesKey: string;
  seriesTitle: string;
  volume?: number;
  chapter?: number;
  year?: number;
}

function safeList(dir: Directory): (Directory | File)[] {
  try {
    return dir.list();
  } catch {
    return [];
  }
}

function filesOf(items: (Directory | File)[]): File[] {
  return items.filter((x): x is File => x instanceof File);
}

function dirsOf(items: (Directory | File)[]): Directory[] {
  return items.filter((x): x is Directory => x instanceof Directory && !x.name.startsWith('.'));
}

function hasImages(items: (Directory | File)[]): boolean {
  return filesOf(items).some((f) => IMAGE_RE.test(f.name));
}

function fileMeta(f: File): { size: number; mtime: number | null } {
  let size = 0;
  let mtime: number | null = null;
  try {
    size = f.size ?? 0;
  } catch {
    // unreadable size
  }
  try {
    mtime = f.modificationTime ?? null;
  } catch {
    // unreadable mtime
  }
  return { size, mtime };
}

function dirMtime(_d: Directory): number | null {
  try {
    return null;
  } catch {
    return null;
  }
}

function pushArchiveFile(out: FoundArchive[], f: File, seriesKey: string, seriesTitle: string): void {
  const info = parseArchiveName(f.name);
  const { size, mtime } = fileMeta(f);
  out.push({
    uri: f.uri,
    fileName: f.name,
    kind: 'cbz',
    size,
    mtime,
    seriesKey,
    seriesTitle,
    volume: info.volume,
    chapter: info.chapter,
    year: info.year,
  });
}

function pushDirArchive(out: FoundArchive[], d: Directory, label: string, seriesKey: string, seriesTitle: string): void {
  const info = parseArchiveName(label);
  out.push({
    uri: d.uri,
    fileName: label,
    kind: 'dir',
    size: 0,
    mtime: dirMtime(d),
    seriesKey,
    seriesTitle,
    volume: info.volume,
    chapter: info.chapter,
    year: info.year,
  });
}

/**
 * Walk a library root. Layout rules:
 *   root/<Series>/*.cbz                  archives of that series
 *   root/<Series>/<Vol>/*.jpg            folder archive
 *   root/<Series>/<Vol>/<Ch>/*.jpg       folder archive named "<Vol> <Ch>"
 *   root/<Series>/*.jpg                  the series folder itself is one archive
 *   root/*.cbz                           grouped by the series name parsed from the file name
 */
export function discoverArchives(rootUri: string): FoundArchive[] {
  const out: FoundArchive[] = [];
  const root = new Directory(rootUri);
  if (!root.exists) return out;
  const items = safeList(root);

  for (const f of filesOf(items)) {
    if (!ARCHIVE_RE.test(f.name)) continue;
    const info = parseArchiveName(f.name);
    const title = info.series ?? f.name.replace(ARCHIVE_RE, '');
    pushArchiveFile(out, f, normalizeSeriesKey(title) || title.toLowerCase(), title);
  }

  for (const s of dirsOf(items)) {
    const seriesTitle = s.name;
    const seriesKey = normalizeSeriesKey(s.name) || s.name.toLowerCase();
    const sItems = safeList(s);
    const archives = filesOf(sItems).filter((f) => ARCHIVE_RE.test(f.name));
    for (const f of archives) pushArchiveFile(out, f, seriesKey, seriesTitle);
    if (archives.length === 0 && hasImages(sItems)) pushDirArchive(out, s, s.name, seriesKey, seriesTitle);

    for (const d of dirsOf(sItems)) {
      const dItems = safeList(d);
      for (const f of filesOf(dItems)) if (ARCHIVE_RE.test(f.name)) pushArchiveFile(out, f, seriesKey, seriesTitle);
      if (hasImages(dItems)) {
        pushDirArchive(out, d, d.name, seriesKey, seriesTitle);
        continue;
      }
      for (const leaf of dirsOf(dItems)) {
        if (hasImages(safeList(leaf))) pushDirArchive(out, leaf, `${d.name} ${leaf.name}`, seriesKey, seriesTitle);
      }
    }
  }
  return out;
}

/** Sync the DB with what is on disk for one source. Existing index data survives unless the file changed. */
export async function scanSource(source: SourceRow, onProgress?: (p: ScanProgress) => void): Promise<ArchiveRow[]> {
  onProgress?.({ phase: 'listing', current: 0, total: 0, label: source.label ?? source.uri });
  const found = discoverArchives(source.uri);
  found.sort((a, b) => naturalCompare(a.uri, b.uri));

  const rows: ArchiveRow[] = [];
  const seriesIds = new Map<string, number>();
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    let seriesId = seriesIds.get(f.seriesKey);
    if (seriesId === undefined) {
      const s = await upsertSeries(f.seriesKey, f.seriesTitle);
      seriesId = s.id;
      seriesIds.set(f.seriesKey, seriesId);
    }
    const existing = await getArchiveByUri(f.uri);
    const row = await upsertArchive({
      series_id: seriesId,
      source_id: source.id,
      kind: f.kind,
      uri: f.uri,
      file_name: f.fileName,
      size: f.size,
      mtime_ms: f.mtime,
      volume: f.volume ?? null,
      chapter: f.chapter ?? null,
      year: f.year ?? null,
      sort_key: archiveSortKey(f, f.fileName),
    });
    if (existing && existing.indexed_ms !== null && (existing.size !== f.size || existing.mtime_ms !== f.mtime)) {
      await invalidateArchiveIndex(row.id);
    }
    rows.push(row);
    onProgress?.({ phase: 'listing', current: i + 1, total: found.length, label: f.fileName });
  }

  await deleteArchivesNotIn(
    source.id,
    found.map((f) => f.uri),
  );
  await deleteEmptySeries();
  await touchSource(source.id);
  return rows;
}
