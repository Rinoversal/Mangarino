import { strFromU8 } from 'fflate';

import { ByteSource, ZipError } from './byteSource';

export interface ZipEntry {
  index: number;
  name: string;
  method: number; // 0 = stored, 8 = deflate
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  comment: string;
  zip64: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export const PANELS_ENTRY_NAME = 'mangarino-panels.json';
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function u64(v: DataView, off: number): number {
  const big = v.getBigUint64(off, true);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('too-large', 'zip64 value exceeds 2^53');
  return Number(big);
}

interface EocdInfo {
  eocdPos: number;
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
  comment: string;
  zip64: boolean;
}

/** Scan backward from EOF for the End Of Central Directory record (handles trailing comments). */
async function findEocd(src: ByteSource): Promise<EocdInfo> {
  const attempt = async (tailLen: number): Promise<EocdInfo | null> => {
    if (tailLen < EOCD_MIN) return null;
    const start = src.size - tailLen;
    const tail = await src.readAt(start, tailLen);
    const v = view(tail);
    for (let i = tailLen - EOCD_MIN; i >= 0; i--) {
      if (v.getUint32(i, true) !== SIG_EOCD) continue;
      const commentLen = v.getUint16(i + 20, true);
      if (i + EOCD_MIN + commentLen !== tailLen) continue; // false positive inside a comment
      return {
        eocdPos: start + i,
        totalEntries: v.getUint16(i + 10, true),
        cdSize: v.getUint32(i + 12, true),
        cdOffset: v.getUint32(i + 16, true),
        comment: strFromU8(tail.subarray(i + EOCD_MIN, i + EOCD_MIN + commentLen), true),
        zip64: false,
      };
    }
    return null;
  };

  let info = await attempt(Math.min(src.size, 1024));
  if (!info) info = await attempt(Math.min(src.size, EOCD_MIN + MAX_COMMENT));
  if (!info) throw new ZipError('not-a-zip', 'End of central directory not found');

  const needs64 =
    info.totalEntries === 0xffff || info.cdSize === 0xffffffff || info.cdOffset === 0xffffffff;
  if (!needs64) return info;

  // ZIP64: implemented per spec, untested (no sample archive >4 GB available).
  if (info.eocdPos < 20) throw new ZipError('zip64-unsupported', 'zip64 sentinel without locator');
  const loc = view(await src.readAt(info.eocdPos - 20, 20));
  if (loc.getUint32(0, true) !== SIG_EOCD64_LOCATOR) {
    throw new ZipError('zip64-unsupported', 'zip64 locator missing');
  }
  const eocd64Pos = u64(loc, 8);
  const e64 = view(await src.readAt(eocd64Pos, 56));
  if (e64.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('zip64-unsupported', 'bad zip64 EOCD');
  return {
    ...info,
    totalEntries: u64(e64, 32),
    cdSize: u64(e64, 40),
    cdOffset: u64(e64, 48),
    zip64: true,
  };
}

/** Parse the central directory into an entry index. Directories are dropped. */
export async function readCentralDirectory(src: ByteSource): Promise<ZipDirectory> {
  const eocd = await findEocd(src);
  if (eocd.cdOffset + eocd.cdSize > src.size) throw new ZipError('corrupt', 'central directory out of range');
  const cd = await src.readAt(eocd.cdOffset, eocd.cdSize);
  const v = view(cd);
  const entries: ZipEntry[] = [];
  let pos = 0;
  let index = 0;
  let seen = 0;
  while (pos + 46 <= cd.length && seen < eocd.totalEntries) {
    if (v.getUint32(pos, true) !== SIG_CENTRAL) throw new ZipError('corrupt', `bad central header at ${pos}`);
    const flags = v.getUint16(pos + 8, true);
    const method = v.getUint16(pos + 10, true);
    const crc32 = v.getUint32(pos + 16, true);
    let compressedSize = v.getUint32(pos + 20, true);
    let uncompressedSize = v.getUint32(pos + 24, true);
    const nameLen = v.getUint16(pos + 28, true);
    const extraLen = v.getUint16(pos + 30, true);
    const commentLen = v.getUint16(pos + 32, true);
    let localHeaderOffset = v.getUint32(pos + 42, true);
    const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLen);
    const utf8 = (flags & 0x800) !== 0;
    const name = strFromU8(nameBytes, !utf8);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      // ZIP64 extended information extra field (id 0x0001)
      let ep = pos + 46 + nameLen;
      const end = ep + extraLen;
      while (ep + 4 <= end) {
        const id = v.getUint16(ep, true);
        const len = v.getUint16(ep + 2, true);
        if (id === 0x0001) {
          let q = ep + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(v, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(v, q); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(v, q); q += 8; }
          break;
        }
        ep += 4 + len;
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;
    seen++;
    if (name.endsWith('/')) continue;
    entries.push({ index: index++, name, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset });
  }
  return { entries, comment: eocd.comment, zip64: eocd.zip64 };
}

/** Resolve where an entry's data actually starts (local header has its own name/extra lengths). */
export async function resolveDataOffset(src: ByteSource, entry: ZipEntry): Promise<number> {
  const h = view(await src.readAt(entry.localHeaderOffset, 30));
  if (h.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('corrupt', `bad local header for ${entry.name}`);
  const nameLen = h.getUint16(26, true);
  const extraLen = h.getUint16(28, true);
  return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

function baseName(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** True for entries that are readable page images (junk from macOS/Windows excluded). */
export function isImageEntry(entry: ZipEntry): boolean {
  const name = entry.name;
  if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return false;
  const base = baseName(name);
  if (base.startsWith('._') || base === 'Thumbs.db' || base === '.DS_Store') return false;
  return IMAGE_EXT.test(base);
}

export function isPanelsEntry(entry: ZipEntry): boolean {
  return baseName(entry.name) === PANELS_ENTRY_NAME;
}

export function entryExtension(name: string): string {
  const m = baseName(name).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : 'bin';
}
