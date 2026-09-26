import { Directory, File, Paths } from 'expo-file-system';

import {
  clearCacheRows,
  deleteArchiveCacheRows,
  deleteCacheRow,
  getCacheRows,
  oldestCacheRows,
  totalCacheBytes,
  touchCacheRow,
  upsertCacheRow,
} from '@/db/repo';

const EVICT_SLACK = 20 * 1024 * 1024;
let evicting: Promise<void> | null = null;

export function pageCacheRoot(): Directory {
  return new Directory(Paths.cache, 'pages');
}

/** Forget one archive's cached pages, after its file was replaced by a different copy. */
export async function clearArchivePages(archiveId: number): Promise<void> {
  try {
    const d = new Directory(pageCacheRoot(), String(archiveId));
    if (d.exists) d.delete();
  } catch {
    // already gone
  }
  await deleteArchiveCacheRows(archiveId);
}

function archiveDir(archiveId: number): Directory {
  const d = new Directory(pageCacheRoot(), String(archiveId));
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** In-memory mirror of cache rows for the open archive, so a hit costs no query. */
export class ArchiveCacheView {
  private uris = new Map<number, string>();

  constructor(private archiveId: number) {}

  async load(): Promise<void> {
    const rows = await getCacheRows(this.archiveId);
    for (const r of rows) this.uris.set(r.page_index, r.uri);
  }

  /** Returns a usable URI or null. Android may purge the cache dir, so existence is re-checked. */
  get(pageIndex: number): string | null {
    const uri = this.uris.get(pageIndex);
    if (!uri) return null;
    try {
      if (new File(uri).exists) {
        void touchCacheRow(this.archiveId, pageIndex);
        return uri;
      }
    } catch {
      // fall through
    }
    this.uris.delete(pageIndex);
    void deleteCacheRow(this.archiveId, pageIndex);
    return null;
  }

  async store(pageIndex: number, ext: string, bytes: Uint8Array, capBytes: number): Promise<string> {
    const file = new File(archiveDir(this.archiveId), `${pageIndex}.${ext}`);
    if (file.exists) file.delete();
    file.write(bytes);
    this.uris.set(pageIndex, file.uri);
    await upsertCacheRow(this.archiveId, pageIndex, file.uri, bytes.length);
    void evictIfNeeded(capBytes);
    return file.uri;
  }
}

export function evictIfNeeded(capBytes: number): Promise<void> {
  if (evicting) return evicting;
  evicting = (async () => {
    try {
      let total = await totalCacheBytes();
      if (total <= capBytes) return;
      const target = Math.max(0, capBytes - EVICT_SLACK);
      while (total > target) {
        const rows = await oldestCacheRows(25);
        if (rows.length === 0) break;
        for (const r of rows) {
          try {
            const f = new File(r.uri);
            if (f.exists) f.delete();
          } catch {
            // ignore
          }
          await deleteCacheRow(r.archive_id, r.page_index);
          total -= r.bytes;
          if (total <= target) break;
        }
      }
    } finally {
      evicting = null;
    }
  })();
  return evicting;
}

export async function clearPageCache(): Promise<void> {
  try {
    const root = pageCacheRoot();
    if (root.exists) root.delete();
  } catch {
    // ignore
  }
  await clearCacheRows();
}

export async function pageCacheSizeBytes(): Promise<number> {
  return totalCacheBytes();
}
