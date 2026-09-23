import { Inflate, inflateSync } from 'fflate';

import { ByteSource, ZipError } from './byteSource';
import { ZipEntry } from './zipIndex';

const ONE_SHOT_LIMIT = 1024 * 1024; // compressed bytes; above this we stream and yield
const CHUNK = 512 * 1024;

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Decompress one entry given the resolved data offset. Pure JS (fflate).
 * This is the only function to swap for a native implementation if Hermes is too slow.
 */
export async function inflateEntry(src: ByteSource, entry: ZipEntry, dataOffset: number): Promise<Uint8Array> {
  const { compressedSize, uncompressedSize, method } = entry;

  if (method === 0) {
    return src.readAt(dataOffset, compressedSize);
  }
  if (method !== 8) {
    throw new ZipError(`unsupported-method-${method}`, `${entry.name}: compression method ${method} not supported`);
  }

  if (compressedSize <= ONE_SHOT_LIMIT) {
    const comp = await src.readAt(dataOffset, compressedSize);
    if (uncompressedSize > 0) {
      const out = new Uint8Array(uncompressedSize);
      inflateSync(comp, { out });
      return out;
    }
    return inflateSync(comp);
  }

  // Streaming path: bounded transient memory, yields between chunks so touches keep working.
  const out = uncompressedSize > 0 ? new Uint8Array(uncompressedSize) : null;
  const parts: Uint8Array[] = [];
  let pos = 0;
  const inf = new Inflate();
  inf.ondata = (chunk) => {
    if (out) {
      if (pos + chunk.length > out.length) throw new ZipError('corrupt', `${entry.name}: inflated past declared size`);
      out.set(chunk, pos);
    } else {
      parts.push(chunk);
    }
    pos += chunk.length;
  };
  for (let off = 0; off < compressedSize; off += CHUNK) {
    const n = Math.min(CHUNK, compressedSize - off);
    const piece = await src.readAt(dataOffset + off, n);
    inf.push(piece, off + n >= compressedSize);
    if (off + n < compressedSize) await yieldToEventLoop();
  }
  if (out) {
    if (pos !== out.length) throw new ZipError('corrupt', `${entry.name}: inflated ${pos} of ${out.length} bytes`);
    return out;
  }
  const joined = new Uint8Array(pos);
  let p = 0;
  for (const part of parts) {
    joined.set(part, p);
    p += part.length;
  }
  return joined;
}
