/**
 * Moving volumes between the device and the PC hub. Both directions stream from disk to disk.
 *
 * Download: the hub gets the volume ready (warm-up), then it downloads into a temporary
 * `.mangarino-<id>.part` file in the destination folder. Only a complete download whose zip
 * directory reads cleanly replaces anything, so a cancelled or broken transfer never leaves a
 * half file in the library (the scanner ignores `.part` files anyway).
 */
import { File, Paths, UploadType } from 'expo-file-system';

import { createFreshFile, ensureDirectory } from '../platform/externalFs';
import { FileHandleSource } from '../platform/fileSource';
import { readCentralDirectory } from '../zip/zipIndex';

import { HubError, PcLink, authHeaders, deviceCoverUrl, fileUrl, uploadUrl, warmUp } from './api';

/** Room left free on the device after a download: 500 MB or 2 % of the file, whichever is more. */
export const SPACE_MARGIN_BYTES = 500 * 1024 * 1024;

export class DeviceFullError extends Error {
  constructor(
    readonly needed: number,
    readonly free: number,
  ) {
    super('device_full');
    this.name = 'DeviceFullError';
  }
}

export const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || /abort|cancel/i.test(e.message));

export const partName = (id: string) => `.mangarino-${id}.part`;

async function checkZip(uri: string): Promise<void> {
  const src = new FileHandleSource(uri);
  try {
    await readCentralDirectory(src);
  } finally {
    src.close();
  }
}

export async function downloadVolume(
  link: PcLink,
  id: string,
  dest: { dirPath: string; fileName: string },
  opts: { signal: AbortSignal; onProgress: (bytes: number, total: number) => void },
): Promise<void> {
  const info = await warmUp(link, id);
  const free = Paths.availableDiskSpace;
  const needed = info.size + Math.max(SPACE_MARGIN_BYTES, info.size * 0.02);
  if (free > 0 && free < needed) throw new DeviceFullError(needed, free);
  opts.onProgress(0, info.size);

  const dir = ensureDirectory(dest.dirPath);
  const tmp = createFreshFile(dir, partName(id));
  try {
    await File.downloadFileAsync(fileUrl(link, id, info.version), tmp, {
      headers: authHeaders(link),
      idempotent: true, // the temp file already exists: it had to be created first
      signal: opts.signal,
      onProgress: ({ bytesWritten }) => opts.onProgress(bytesWritten, info.size),
    });
    const got = new File(dir, partName(id)).size ?? 0;
    if (got !== info.size) throw new Error(`The download stopped early (${got} of ${info.size} bytes).`);
    await checkZip(tmp.uri);
    const old = new File(dir, dest.fileName);
    if (old.exists) old.delete();
    tmp.rename(dest.fileName);
  } catch (e) {
    try {
      const t = new File(dir, partName(id));
      if (t.exists) t.delete();
    } catch {
      // cleaned up on the next visit to the PC screen
    }
    throw e;
  }
}

export async function uploadVolume(
  link: PcLink,
  v: { uri: string; file: string; size: number },
  folder: string,
  opts: { signal: AbortSignal; onProgress: (bytes: number, total: number) => void },
): Promise<'stored' | 'exists'> {
  const f = new File(v.uri);
  const size = f.size ?? v.size;
  opts.onProgress(0, size);
  const res = await f.upload(uploadUrl(link, folder, v.file, size), {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...authHeaders(link), 'Content-Type': 'application/octet-stream' },
    signal: opts.signal,
    onProgress: ({ bytesSent }) => opts.onProgress(bytesSent, size),
  });
  if (res.status === 201) return 'stored';
  if (res.status === 200) return 'exists';
  let code = String(res.status);
  try {
    code = (JSON.parse(res.body) as { error?: string }).error ?? code;
  } catch {
    // not JSON
  }
  throw new HubError(res.status, code);
}

/** A volume's cover image, for the PC's view of this device's library. */
export async function uploadCover(link: PcLink, archiveId: number, uri: string): Promise<boolean> {
  const f = new File(uri);
  if (!f.exists) return false;
  const res = await f.upload(deviceCoverUrl(link, archiveId), {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...authHeaders(link), 'Content-Type': 'application/octet-stream' },
  });
  return res.status === 200;
}

/** Leftover temp files from a transfer the app didn't get to finish (killed, crashed). */
export function removeStalePartFiles(dirs: { list: () => unknown[] }[]): void {
  for (const d of dirs) {
    try {
      for (const item of d.list()) {
        if (item instanceof File && /^\.mangarino-.*\.part$/.test(item.name)) item.delete();
      }
    } catch {
      // unreadable folder
    }
  }
}
