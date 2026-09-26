import { getDb } from './index';

export type ArchiveKind = 'cbz' | 'dir';
export type SourceKind = 'folder' | 'imported';

export interface SeriesRow {
  id: number;
  key: string;
  title: string;
  title_override: string | null;
  cover_uri: string | null;
  created_ms: number;
  updated_ms: number;
}

export interface ArchiveRow {
  id: number;
  series_id: number;
  source_id: number | null;
  kind: ArchiveKind;
  uri: string;
  file_name: string;
  size: number;
  mtime_ms: number | null;
  volume: number | null;
  chapter: number | null;
  year: number | null;
  page_count: number;
  has_panels: number;
  indexed_ms: number | null;
  sort_key: string;
  error: string | null;
  cover_uri: string | null;
}

export interface ZipEntryRow {
  archive_id: number;
  entry_index: number;
  name: string;
  method: number;
  flags: number;
  crc32: number;
  comp_size: number;
  uncomp_size: number;
  local_header_offset: number;
  data_offset: number | null;
}

export interface PageRow {
  archive_id: number;
  page_index: number;
  entry_index: number | null;
  uri: string | null;
  entry_name: string;
  chapter: number | null;
  page_no: number | null;
  extra: string | null;
  width: number | null;
  height: number | null;
  panels_json: string | null;
}

export interface ProgressRow {
  archive_id: number;
  page_index: number;
  panel_index: number | null;
  completed: number;
  updated_ms: number;
}

export interface BookmarkRow {
  id: number;
  archive_id: number;
  page_index: number;
  panel_index: number | null;
  note: string | null;
  created_ms: number;
}

export interface SourceRow {
  id: number;
  kind: SourceKind;
  uri: string;
  label: string | null;
  last_scan_ms: number | null;
}

export interface CacheRow {
  archive_id: number;
  page_index: number;
  uri: string;
  bytes: number;
  last_access_ms: number;
}

export interface SeriesSummary extends SeriesRow {
  archive_count: number;
  read_count: number;
  last_read_ms: number | null;
}

export interface ArchiveWithProgress extends ArchiveRow {
  progress_page: number | null;
  progress_completed: number | null;
  progress_updated_ms: number | null;
}

export interface ContinueItem {
  series_id: number;
  series_title: string;
  cover_uri: string | null;
  archive_id: number;
  file_name: string;
  volume: number | null;
  chapter: number | null;
  page_index: number;
  page_count: number;
  updated_ms: number;
}

const now = () => Date.now();

// ---------- settings ----------

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await getDb().getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb().runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

// ---------- sources ----------

export function listSources(): Promise<SourceRow[]> {
  return getDb().getAllAsync<SourceRow>('SELECT * FROM sources ORDER BY id');
}

export async function addSource(kind: SourceKind, uri: string, label: string | null): Promise<SourceRow> {
  await getDb().runAsync(
    'INSERT INTO sources (kind, uri, label) VALUES (?, ?, ?) ON CONFLICT(uri) DO UPDATE SET label = excluded.label',
    kind,
    uri,
    label,
  );
  const row = await getDb().getFirstAsync<SourceRow>('SELECT * FROM sources WHERE uri = ?', uri);
  if (!row) throw new Error('source insert failed');
  return row;
}

export async function removeSource(id: number): Promise<void> {
  await getDb().runAsync('DELETE FROM sources WHERE id = ?', id);
}

export async function touchSource(id: number): Promise<void> {
  await getDb().runAsync('UPDATE sources SET last_scan_ms = ? WHERE id = ?', now(), id);
}

// ---------- series ----------

export function listSeries(): Promise<SeriesSummary[]> {
  return getDb().getAllAsync<SeriesSummary>(`
    SELECT s.*,
      (SELECT COUNT(*) FROM archives a WHERE a.series_id = s.id) AS archive_count,
      (SELECT COUNT(*) FROM archives a JOIN progress p ON p.archive_id = a.id WHERE a.series_id = s.id AND p.completed = 1) AS read_count,
      (SELECT sp.updated_ms FROM series_progress sp WHERE sp.series_id = s.id) AS last_read_ms
    FROM series s
    ORDER BY COALESCE(s.title_override, s.title) COLLATE NOCASE
  `);
}

export function getSeries(id: number): Promise<SeriesRow | null> {
  return getDb().getFirstAsync<SeriesRow>('SELECT * FROM series WHERE id = ?', id);
}

export async function upsertSeries(key: string, title: string): Promise<SeriesRow> {
  const t = now();
  await getDb().runAsync(
    'INSERT INTO series (key, title, created_ms, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated_ms = excluded.updated_ms',
    key,
    title,
    t,
    t,
  );
  const row = await getDb().getFirstAsync<SeriesRow>('SELECT * FROM series WHERE key = ?', key);
  if (!row) throw new Error('series upsert failed');
  return row;
}

export async function renameSeries(id: number, title: string | null): Promise<void> {
  await getDb().runAsync('UPDATE series SET title_override = ?, updated_ms = ? WHERE id = ?', title, now(), id);
}

export async function setSeriesCover(id: number, coverUri: string | null): Promise<void> {
  await getDb().runAsync('UPDATE series SET cover_uri = ? WHERE id = ?', coverUri, id);
}

export async function deleteEmptySeries(): Promise<void> {
  await getDb().runAsync('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM archives)');
}

// ---------- archives ----------

export function listArchives(seriesId: number): Promise<ArchiveWithProgress[]> {
  return getDb().getAllAsync<ArchiveWithProgress>(
    `SELECT a.*, p.page_index AS progress_page, p.completed AS progress_completed, p.updated_ms AS progress_updated_ms
     FROM archives a LEFT JOIN progress p ON p.archive_id = a.id
     WHERE a.series_id = ? ORDER BY a.sort_key`,
    seriesId,
  );
}

export function listAllArchives(): Promise<ArchiveRow[]> {
  return getDb().getAllAsync<ArchiveRow>('SELECT * FROM archives ORDER BY series_id, sort_key');
}

export function getArchive(id: number): Promise<ArchiveRow | null> {
  return getDb().getFirstAsync<ArchiveRow>('SELECT * FROM archives WHERE id = ?', id);
}

export function getArchiveByUri(uri: string): Promise<ArchiveRow | null> {
  return getDb().getFirstAsync<ArchiveRow>('SELECT * FROM archives WHERE uri = ?', uri);
}

export interface ArchiveInput {
  series_id: number;
  source_id: number | null;
  kind: ArchiveKind;
  uri: string;
  file_name: string;
  size: number;
  mtime_ms: number | null;
  volume: number | null;
  chapter: number | null;
  year: number | null;
  sort_key: string;
}

export async function upsertArchive(a: ArchiveInput): Promise<ArchiveRow> {
  await getDb().runAsync(
    `INSERT INTO archives (series_id, source_id, kind, uri, file_name, size, mtime_ms, volume, chapter, year, sort_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       series_id = excluded.series_id, source_id = excluded.source_id, file_name = excluded.file_name,
       size = excluded.size, mtime_ms = excluded.mtime_ms, volume = excluded.volume, chapter = excluded.chapter,
       year = excluded.year, sort_key = excluded.sort_key`,
    a.series_id,
    a.source_id,
    a.kind,
    a.uri,
    a.file_name,
    a.size,
    a.mtime_ms,
    a.volume,
    a.chapter,
    a.year,
    a.sort_key,
  );
  const row = await getArchiveByUri(a.uri);
  if (!row) throw new Error('archive upsert failed');
  return row;
}

export async function markArchiveIndexed(
  id: number,
  pageCount: number,
  hasPanels: boolean,
  error: string | null,
): Promise<void> {
  await getDb().runAsync(
    'UPDATE archives SET page_count = ?, has_panels = ?, indexed_ms = ?, error = ? WHERE id = ?',
    pageCount,
    hasPanels ? 1 : 0,
    now(),
    error,
    id,
  );
}

export async function invalidateArchiveIndex(id: number): Promise<void> {
  await getDb().runAsync('UPDATE archives SET indexed_ms = NULL, page_count = 0, has_panels = 0 WHERE id = ?', id);
}

export async function deleteArchivesNotIn(sourceId: number, keepUris: string[]): Promise<number> {
  const all = await getDb().getAllAsync<{ id: number; uri: string }>(
    'SELECT id, uri FROM archives WHERE source_id = ?',
    sourceId,
  );
  const keep = new Set(keepUris);
  let removed = 0;
  for (const a of all) {
    if (!keep.has(a.uri)) {
      await getDb().runAsync('DELETE FROM archives WHERE id = ?', a.id);
      removed++;
    }
  }
  return removed;
}

export async function deleteArchive(id: number): Promise<void> {
  await getDb().runAsync('DELETE FROM archives WHERE id = ?', id);
}

export async function setArchiveCover(id: number, coverUri: string | null): Promise<void> {
  await getDb().runAsync('UPDATE archives SET cover_uri = ? WHERE id = ?', coverUri, id);
}

export function listArchivesMissingCovers(): Promise<ArchiveRow[]> {
  return getDb().getAllAsync<ArchiveRow>(
    'SELECT * FROM archives WHERE cover_uri IS NULL AND page_count > 0 ORDER BY series_id, sort_key',
  );
}

export async function removeSourceAndArchives(id: number): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM archives WHERE source_id = ?', id);
    await db.runAsync('DELETE FROM sources WHERE id = ?', id);
    await db.runAsync('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM archives)');
  });
}

// ---------- zip entries + pages ----------

export interface ZipEntryInput {
  entry_index: number;
  name: string;
  method: number;
  flags: number;
  crc32: number;
  comp_size: number;
  uncomp_size: number;
  local_header_offset: number;
  data_offset: number | null;
}

export interface PageInput {
  page_index: number;
  entry_index: number | null;
  uri: string | null;
  entry_name: string;
  chapter: number | null;
  page_no: number | null;
  extra: string | null;
  width: number | null;
  height: number | null;
  panels_json: string | null;
}

export async function replaceArchiveIndex(
  archiveId: number,
  entries: ZipEntryInput[],
  pages: PageInput[],
): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM zip_entries WHERE archive_id = ?', archiveId);
    await db.runAsync('DELETE FROM pages WHERE archive_id = ?', archiveId);
    const es = await db.prepareAsync(
      `INSERT INTO zip_entries (archive_id, entry_index, name, method, flags, crc32, comp_size, uncomp_size, local_header_offset, data_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const e of entries) {
        await es.executeAsync(
          archiveId,
          e.entry_index,
          e.name,
          e.method,
          e.flags,
          e.crc32,
          e.comp_size,
          e.uncomp_size,
          e.local_header_offset,
          e.data_offset,
        );
      }
    } finally {
      await es.finalizeAsync();
    }
    const ps = await db.prepareAsync(
      `INSERT INTO pages (archive_id, page_index, entry_index, uri, entry_name, chapter, page_no, extra, width, height, panels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const p of pages) {
        await ps.executeAsync(
          archiveId,
          p.page_index,
          p.entry_index,
          p.uri,
          p.entry_name,
          p.chapter,
          p.page_no,
          p.extra,
          p.width,
          p.height,
          p.panels_json,
        );
      }
    } finally {
      await ps.finalizeAsync();
    }
  });
}

/**
 * New panel boxes for an archive's pages (by entry name), e.g. the PC's, made with the
 * speech-bubble fix. Returns how many pages got them.
 */
export async function applyArchivePanels(
  archiveId: number,
  pages: Record<string, { w: number | null; h: number | null; panels: unknown[] }>,
): Promise<number> {
  const db = getDb();
  let changed = 0;
  await db.withTransactionAsync(async () => {
    for (const [name, p] of Object.entries(pages)) {
      const r = await db.runAsync(
        'UPDATE pages SET panels_json = ?, width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE archive_id = ? AND entry_name = ?',
        JSON.stringify(p.panels),
        p.w,
        p.h,
        archiveId,
        name,
      );
      changed += r.changes;
    }
    if (changed) await db.runAsync('UPDATE archives SET has_panels = 1 WHERE id = ?', archiveId);
  });
  return changed;
}

export function getZipEntries(archiveId: number): Promise<ZipEntryRow[]> {
  return getDb().getAllAsync<ZipEntryRow>(
    'SELECT * FROM zip_entries WHERE archive_id = ? ORDER BY entry_index',
    archiveId,
  );
}

export async function setDataOffset(archiveId: number, entryIndex: number, dataOffset: number): Promise<void> {
  await getDb().runAsync(
    'UPDATE zip_entries SET data_offset = ? WHERE archive_id = ? AND entry_index = ?',
    dataOffset,
    archiveId,
    entryIndex,
  );
}

export function getPages(archiveId: number): Promise<PageRow[]> {
  return getDb().getAllAsync<PageRow>('SELECT * FROM pages WHERE archive_id = ? ORDER BY page_index', archiveId);
}

export async function setPageDims(archiveId: number, pageIndex: number, width: number, height: number): Promise<void> {
  await getDb().runAsync(
    'UPDATE pages SET width = ?, height = ? WHERE archive_id = ? AND page_index = ?',
    width,
    height,
    archiveId,
    pageIndex,
  );
}

// ---------- progress ----------

export function getProgress(archiveId: number): Promise<ProgressRow | null> {
  return getDb().getFirstAsync<ProgressRow>('SELECT * FROM progress WHERE archive_id = ?', archiveId);
}

export interface SyncProgressRow {
  archive_id: number;
  series_id: number;
  uri: string;
  file_name: string;
  kind: ArchiveKind;
  page_index: number;
  panel_index: number | null;
  completed: number;
  updated_ms: number;
}

/** Progress rows changed after `ms`, with what identifies their archive across devices. */
export function listProgressChangedSince(ms: number): Promise<SyncProgressRow[]> {
  return getDb().getAllAsync<SyncProgressRow>(
    `SELECT p.archive_id, a.series_id, a.uri, a.file_name, a.kind, p.page_index, p.panel_index, p.completed, p.updated_ms
       FROM progress p JOIN archives a ON a.id = p.archive_id
      WHERE p.updated_ms > ?`,
    ms,
  );
}

/**
 * Progress read on another device (through the PC hub). Applied only if it is newer than what
 * this device has, keeping the other device's timestamp so the newest change wins everywhere.
 * Returns whether anything changed.
 */
export async function applySyncedProgress(
  archiveId: number,
  seriesId: number,
  pageIndex: number,
  panelIndex: number | null,
  completed: boolean,
  updatedMs: number,
): Promise<boolean> {
  const db = getDb();
  let changed = false;
  await db.withTransactionAsync(async () => {
    const r = await db.runAsync(
      `INSERT INTO progress (archive_id, page_index, panel_index, completed, updated_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(archive_id) DO UPDATE SET page_index = excluded.page_index, panel_index = excluded.panel_index,
         completed = excluded.completed, updated_ms = excluded.updated_ms
       WHERE excluded.updated_ms > progress.updated_ms`,
      archiveId,
      pageIndex,
      panelIndex,
      completed ? 1 : 0,
      updatedMs,
    );
    changed = r.changes > 0;
    if (changed) {
      await db.runAsync(
        `INSERT INTO series_progress (series_id, archive_id, page_index, updated_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(series_id) DO UPDATE SET archive_id = excluded.archive_id, page_index = excluded.page_index,
           updated_ms = excluded.updated_ms
         WHERE excluded.updated_ms > series_progress.updated_ms`,
        seriesId,
        archiveId,
        pageIndex,
        updatedMs,
      );
    }
  });
  return changed;
}

export async function saveProgress(
  seriesId: number,
  archiveId: number,
  pageIndex: number,
  panelIndex: number | null,
  completed: boolean,
): Promise<void> {
  const db = getDb();
  const t = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO progress (archive_id, page_index, panel_index, completed, updated_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(archive_id) DO UPDATE SET page_index = excluded.page_index, panel_index = excluded.panel_index,
         completed = MAX(progress.completed, excluded.completed), updated_ms = excluded.updated_ms`,
      archiveId,
      pageIndex,
      panelIndex,
      completed ? 1 : 0,
      t,
    );
    await db.runAsync(
      `INSERT INTO series_progress (series_id, archive_id, page_index, updated_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET archive_id = excluded.archive_id, page_index = excluded.page_index, updated_ms = excluded.updated_ms`,
      seriesId,
      archiveId,
      pageIndex,
      t,
    );
  });
}

export async function setArchiveCompleted(archiveId: number, completed: boolean): Promise<void> {
  const a = await getArchive(archiveId);
  if (!a) return;
  await getDb().runAsync(
    `INSERT INTO progress (archive_id, page_index, panel_index, completed, updated_ms) VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(archive_id) DO UPDATE SET completed = excluded.completed,
       page_index = CASE WHEN excluded.completed = 0 THEN 0 ELSE progress.page_index END,
       updated_ms = excluded.updated_ms`,
    archiveId,
    completed ? Math.max(0, a.page_count - 1) : 0,
    completed ? 1 : 0,
    now(),
  );
}

export function getSeriesProgress(seriesId: number): Promise<{ archive_id: number; page_index: number } | null> {
  return getDb().getFirstAsync('SELECT archive_id, page_index FROM series_progress WHERE series_id = ?', seriesId);
}

export function listContinueReading(limit: number): Promise<ContinueItem[]> {
  return getDb().getAllAsync<ContinueItem>(
    `SELECT s.id AS series_id, COALESCE(s.title_override, s.title) AS series_title, s.cover_uri,
            a.id AS archive_id, a.file_name, a.volume, a.chapter, a.page_count, sp.page_index, sp.updated_ms
     FROM series_progress sp JOIN series s ON s.id = sp.series_id JOIN archives a ON a.id = sp.archive_id
     ORDER BY sp.updated_ms DESC LIMIT ?`,
    limit,
  );
}

// ---------- history ----------

export async function openHistory(archiveId: number, pageIndex: number): Promise<number> {
  const r = await getDb().runAsync(
    'INSERT INTO history (archive_id, page_index, opened_ms) VALUES (?, ?, ?)',
    archiveId,
    pageIndex,
    now(),
  );
  return r.lastInsertRowId;
}

export async function closeHistory(id: number, pageIndex: number, pagesRead: number): Promise<void> {
  await getDb().runAsync(
    'UPDATE history SET page_index = ?, closed_ms = ?, pages_read = ? WHERE id = ?',
    pageIndex,
    now(),
    pagesRead,
    id,
  );
}

// ---------- bookmarks ----------

export interface BookmarkView extends BookmarkRow {
  series_id: number;
  series_title: string;
  file_name: string;
  volume: number | null;
  chapter: number | null;
}

export function listBookmarks(): Promise<BookmarkView[]> {
  return getDb().getAllAsync<BookmarkView>(
    `SELECT b.*, s.id AS series_id, COALESCE(s.title_override, s.title) AS series_title, a.file_name, a.volume, a.chapter
     FROM bookmarks b JOIN archives a ON a.id = b.archive_id JOIN series s ON s.id = a.series_id
     ORDER BY series_title COLLATE NOCASE, a.sort_key, b.page_index, b.panel_index`,
  );
}

export function listArchiveBookmarks(archiveId: number): Promise<BookmarkRow[]> {
  return getDb().getAllAsync<BookmarkRow>(
    'SELECT * FROM bookmarks WHERE archive_id = ? ORDER BY page_index, panel_index',
    archiveId,
  );
}

export async function addBookmark(
  archiveId: number,
  pageIndex: number,
  panelIndex: number | null,
  note: string | null,
): Promise<void> {
  await getDb().runAsync(
    'INSERT OR REPLACE INTO bookmarks (archive_id, page_index, panel_index, note, created_ms) VALUES (?, ?, ?, ?, ?)',
    archiveId,
    pageIndex,
    panelIndex,
    note,
    now(),
  );
}

export async function removeBookmark(archiveId: number, pageIndex: number, panelIndex: number | null): Promise<void> {
  if (panelIndex === null) {
    await getDb().runAsync(
      'DELETE FROM bookmarks WHERE archive_id = ? AND page_index = ? AND panel_index IS NULL',
      archiveId,
      pageIndex,
    );
  } else {
    await getDb().runAsync(
      'DELETE FROM bookmarks WHERE archive_id = ? AND page_index = ? AND panel_index = ?',
      archiveId,
      pageIndex,
      panelIndex,
    );
  }
}

export async function deleteBookmark(id: number): Promise<void> {
  await getDb().runAsync('DELETE FROM bookmarks WHERE id = ?', id);
}

export async function updateBookmarkNote(id: number, note: string | null): Promise<void> {
  await getDb().runAsync('UPDATE bookmarks SET note = ? WHERE id = ?', note, id);
}

// ---------- page cache ----------

export async function upsertCacheRow(archiveId: number, pageIndex: number, uri: string, bytes: number): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO page_cache (archive_id, page_index, uri, bytes, last_access_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(archive_id, page_index) DO UPDATE SET uri = excluded.uri, bytes = excluded.bytes, last_access_ms = excluded.last_access_ms`,
    archiveId,
    pageIndex,
    uri,
    bytes,
    now(),
  );
}

export async function touchCacheRow(archiveId: number, pageIndex: number): Promise<void> {
  await getDb().runAsync(
    'UPDATE page_cache SET last_access_ms = ? WHERE archive_id = ? AND page_index = ?',
    now(),
    archiveId,
    pageIndex,
  );
}

export function getCacheRows(archiveId: number): Promise<CacheRow[]> {
  return getDb().getAllAsync<CacheRow>('SELECT * FROM page_cache WHERE archive_id = ?', archiveId);
}

export async function totalCacheBytes(): Promise<number> {
  const r = await getDb().getFirstAsync<{ total: number | null }>('SELECT SUM(bytes) AS total FROM page_cache');
  return r?.total ?? 0;
}

export function oldestCacheRows(limit: number): Promise<CacheRow[]> {
  return getDb().getAllAsync<CacheRow>('SELECT * FROM page_cache ORDER BY last_access_ms ASC LIMIT ?', limit);
}

export async function deleteCacheRow(archiveId: number, pageIndex: number): Promise<void> {
  await getDb().runAsync('DELETE FROM page_cache WHERE archive_id = ? AND page_index = ?', archiveId, pageIndex);
}

export async function clearCacheRows(): Promise<void> {
  await getDb().runAsync('DELETE FROM page_cache');
}

export async function deleteArchiveCacheRows(archiveId: number): Promise<void> {
  await getDb().runAsync('DELETE FROM page_cache WHERE archive_id = ?', archiveId);
}
