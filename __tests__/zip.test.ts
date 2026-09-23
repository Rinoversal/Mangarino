import * as fs from 'fs';
import * as path from 'path';

import { ByteSource } from '../src/zip/byteSource';
import { isImageEntry, readCentralDirectory, resolveDataOffset } from '../src/zip/zipIndex';
import { ZipArchive } from '../src/zip/zipReader';

// To run the real-file tests, put the folder holding the two sample archives into
// __tests__/sample-dir.txt (git-ignored). Environment variables are not used because
// babel-preset-expo rewrites process.env reads at compile time under jest.
function readSampleDir(): string {
  try {
    return fs.readFileSync(path.join(__dirname, 'sample-dir.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}
const SAMPLE_DIR = readSampleDir();
const V01 = path.join(SAMPLE_DIR, 'Berserk v01 (2003) (Digital) (danke-Empire).cbz');
const V38 = path.join(SAMPLE_DIR, 'Berserk v38 (2017) (Digital) (danke-Empire).cbz');

class NodeFsSource implements ByteSource {
  readonly size: number;
  private fd: number;
  constructor(file: string) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    const n = fs.readSync(this.fd, buf, 0, length, offset);
    if (n !== length) throw new Error(`short read ${n}/${length} at ${offset}`);
    return buf;
  }
  close() {
    fs.closeSync(this.fd);
  }
}

const haveV01 = SAMPLE_DIR !== '' && fs.existsSync(V01);

(haveV01 ? describe : describe.skip)('real Berserk v01 CBZ', () => {
  it('finds the EOCD despite the archive comment and lists 219 entries', async () => {
    const src = new NodeFsSource(V01);
    const dir = await readCentralDirectory(src);
    expect(dir.entries).toHaveLength(219);
    expect(dir.comment).toContain('danke');
    expect(dir.entries.every((e) => e.method === 8)).toBe(true);
    expect(dir.entries.filter(isImageEntry)).toHaveLength(219);
    const first = dir.entries[0];
    expect(first.name).toBe('Berserk - 001 (v01) - p000 [Digital-HD] [danke-Empire].jpg');
    expect(await resolveDataOffset(src, first)).toBe(88);
    src.close();
  });

  it('extracts page 0 as a JPEG of the declared size', async () => {
    const zip = await ZipArchive.open(new NodeFsSource(V01));
    const entry = zip.entries[0];
    const t0 = Date.now();
    const bytes = await zip.extract(entry);
    const ms = Date.now() - t0;
    expect(bytes.length).toBe(entry.uncompressedSize);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(ms).toBeLessThan(5000);
    zip.close();
  });
});

const haveV38 = SAMPLE_DIR !== '' && fs.existsSync(V38);

(haveV38 ? describe : describe.skip)('real Berserk v38 CBZ (large pages, streaming path)', () => {
  it('inflates the largest page through the streaming path', async () => {
    const zip = await ZipArchive.open(new NodeFsSource(V38));
    const biggest = zip.entries.reduce((a, b) => (b.uncompressedSize > a.uncompressedSize ? b : a));
    expect(biggest.compressedSize).toBeGreaterThan(1024 * 1024);
    const bytes = await zip.extract(biggest);
    expect(bytes.length).toBe(biggest.uncompressedSize);
    expect(bytes[0]).toBe(0xff);
    zip.close();
  });
});
