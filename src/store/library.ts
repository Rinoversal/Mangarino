import { create } from 'zustand';

import {
  ContinueItem,
  SeriesSummary,
  SourceRow,
  addSource,
  listAllArchives,
  listArchivesMissingCovers,
  listContinueReading,
  listSeries,
  listSources,
  setSeriesCover,
} from '@/db/repo';
import { indexArchive, makeArchiveCover } from '@/library/indexer';
import { ScanProgress, scanSource } from '@/library/scanner';
import { toFileUri } from '@/platform/paths';

interface LibraryState {
  series: SeriesSummary[];
  continueReading: ContinueItem[];
  sources: SourceRow[];
  scan: ScanProgress | null;
  loaded: boolean;
  lastScanError: string | null;
  refresh: () => Promise<void>;
  ensureDefaultSource: (rootPath: string) => Promise<void>;
  rescan: () => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  series: [],
  continueReading: [],
  sources: [],
  scan: null,
  loaded: false,
  lastScanError: null,

  async refresh() {
    const [series, continueReading, sources] = await Promise.all([listSeries(), listContinueReading(6), listSources()]);
    set({ series, continueReading, sources, loaded: true });
  },

  async ensureDefaultSource(rootPath) {
    const sources = await listSources();
    if (sources.length === 0) {
      await addSource('folder', toFileUri(rootPath), 'Mangarino folder');
    }
  },

  async rescan() {
    if (get().scan) return;
    set({ scan: { phase: 'listing', current: 0, total: 0 }, lastScanError: null });
    try {
      const sources = await listSources();
      for (const s of sources) {
        await scanSource(s, (p) => set({ scan: p }));
      }

      const archives = await listAllArchives();
      const todo = archives.filter((a) => a.indexed_ms === null);
      for (let i = 0; i < todo.length; i++) {
        set({ scan: { phase: 'indexing', current: i + 1, total: todo.length, label: todo[i].file_name } });
        await indexArchive(todo[i]);
      }
      await get().refresh();

      const missing = await listArchivesMissingCovers();
      for (let i = 0; i < missing.length; i++) {
        set({ scan: { phase: 'covers', current: i + 1, total: missing.length, label: missing[i].file_name } });
        await makeArchiveCover(missing[i]);
      }

      const all = await listAllArchives();
      for (const s of get().series) {
        const first = all.find((a) => a.series_id === s.id && a.cover_uri);
        if (first && first.cover_uri !== s.cover_uri) await setSeriesCover(s.id, first.cover_uri);
      }
    } catch (err) {
      set({ lastScanError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ scan: null });
      await get().refresh();
    }
  },
}));
