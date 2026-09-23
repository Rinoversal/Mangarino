import { ArchiveRow, PageRow, ZipEntryRow, setDataOffset } from '@/db/repo';
import { FileHandleSource } from '@/platform/fileSource';
import { entryExtension } from '@/zip/zipIndex';
import { ZipArchive } from '@/zip/zipReader';

import { ArchiveCacheView } from './pageCache';

export interface LoaderCallbacks {
  onPage: (pageIndex: number, uri: string) => void;
  onError: (pageIndex: number, message: string) => void;
}

const PREFETCH_AHEAD = 3;
const PREFETCH_BEHIND = 1;

/**
 * Single-flight page extractor with a distance-priority queue: whatever is
 * closest to the reader's cursor is extracted next, so fast jumps reprioritise
 * without cancellation logic. One inflate at a time bounds transient memory.
 */
export class PageLoader {
  private zip: ZipArchive | null = null;
  private cache: ArchiveCacheView;
  private pending = new Set<number>();
  private done = new Set<number>();
  private cursor = 0;
  private running = false;
  private closed = false;
  private offsets = new Map<number, number | null>();

  constructor(
    private readonly archive: ArchiveRow,
    private readonly pages: PageRow[],
    entries: ZipEntryRow[],
    private readonly capBytes: number,
    private readonly cb: LoaderCallbacks,
  ) {
    for (const e of entries) this.offsets.set(e.entry_index, e.data_offset);
    this.cache = new ArchiveCacheView(archive.id);
  }

  async open(): Promise<void> {
    await this.cache.load();
    if (this.archive.kind !== 'cbz') return;
    const src = new FileHandleSource(this.archive.uri);
    this.zip = await ZipArchive.open(src);
    for (const [idx, off] of this.offsets) if (off !== null) this.zip.primeDataOffset(idx, off);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  setCursor(pageIndex: number, direction: 1 | -1 = 1): void {
    this.cursor = pageIndex;
    const want: number[] = [pageIndex];
    for (let k = 1; k <= PREFETCH_AHEAD; k++) want.push(pageIndex + k * direction);
    for (let k = 1; k <= PREFETCH_BEHIND; k++) want.push(pageIndex - k * direction);
    for (const w of want) {
      if (w >= 0 && w < this.pages.length && !this.done.has(w)) this.pending.add(w);
    }
    void this.run();
  }

  retry(pageIndex: number): void {
    this.done.delete(pageIndex);
    this.pending.add(pageIndex);
    void this.run();
  }

  private pickNext(): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const p of this.pending) {
      const d = Math.abs(p - this.cursor);
      if (d < bestDistance) {
        bestDistance = d;
        best = p;
      }
    }
    return best;
  }

  private async run(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed) {
        const i = this.pickNext();
        if (i === null) break;
        this.pending.delete(i);
        try {
          const uri = await this.load(i);
          this.done.add(i);
          if (!this.closed) this.cb.onPage(i, uri);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[mangarino] page', i, 'failed:', message);
          if (!this.closed) this.cb.onError(i, message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async load(i: number): Promise<string> {
    const page = this.pages[i];
    if (!page) throw new Error(`page ${i} out of range`);
    if (this.archive.kind === 'dir') {
      if (!page.uri) throw new Error('page has no file');
      return page.uri;
    }
    const cached = this.cache.get(i);
    if (cached) return cached;
    if (!this.zip || page.entry_index === null) throw new Error('archive not open');
    const entry = this.zip.entries[page.entry_index];
    if (!entry) throw new Error(`entry ${page.entry_index} missing`);

    const knownOffset = this.offsets.get(entry.index) ?? null;
    const t0 = Date.now();
    const bytes = await this.zip.extract(entry);
    const t1 = Date.now();
    const uri = await this.cache.store(i, entryExtension(entry.name), bytes, this.capBytes);
    const t2 = Date.now();
    console.log(
      `[mangarino] page ${i}: inflate ${t1 - t0} ms, write ${t2 - t1} ms, ${(bytes.length / 1048576).toFixed(2)} MB`,
    );
    if (knownOffset === null) {
      const off = await this.zip.dataOffset(entry);
      this.offsets.set(entry.index, off);
      void setDataOffset(this.archive.id, entry.index, off);
    }
    return uri;
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.zip?.close();
    this.zip = null;
  }
}
