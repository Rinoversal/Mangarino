import { ByteSource } from './byteSource';
import { inflateEntry } from './inflate';
import { readCentralDirectory, resolveDataOffset, ZipEntry } from './zipIndex';

/**
 * An open archive: central directory in memory, per-entry data offsets cached,
 * random-access extraction of single entries. Platform-agnostic.
 */
export class ZipArchive {
  private offsets = new Map<number, number>();

  private constructor(
    private readonly src: ByteSource,
    public readonly entries: ZipEntry[],
    public readonly comment: string,
  ) {}

  static async open(src: ByteSource): Promise<ZipArchive> {
    const dir = await readCentralDirectory(src);
    return new ZipArchive(src, dir.entries, dir.comment);
  }

  /** Callers that persisted offsets (SQLite) can skip the local-header read. */
  primeDataOffset(entryIndex: number, dataOffset: number): void {
    this.offsets.set(entryIndex, dataOffset);
  }

  async dataOffset(entry: ZipEntry): Promise<number> {
    const cached = this.offsets.get(entry.index);
    if (cached !== undefined) return cached;
    const off = await resolveDataOffset(this.src, entry);
    this.offsets.set(entry.index, off);
    return off;
  }

  async extract(entry: ZipEntry): Promise<Uint8Array> {
    const off = await this.dataOffset(entry);
    return inflateEntry(this.src, entry, off);
  }

  findByName(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  close(): void {
    this.src.close();
  }
}
