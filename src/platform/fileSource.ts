import { File, FileHandle, FileMode } from 'expo-file-system';

import { ByteSource, ZipError } from '@/zip/byteSource';

/** ByteSource over expo-file-system's FileHandle (random access, no base64, no full reads). */
export class FileHandleSource implements ByteSource {
  readonly size: number;
  private handle: FileHandle;

  constructor(public readonly uri: string) {
    const file = new File(uri);
    if (!file.exists) throw new ZipError('missing', `File not found: ${uri}`);
    this.handle = file.open(FileMode.ReadOnly);
    this.size = this.handle.size ?? file.size ?? 0;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    this.handle.offset = offset;
    const bytes = this.handle.readBytes(length);
    if (bytes.length !== length) {
      throw new ZipError('short-read', `read ${bytes.length}/${length} bytes at ${offset}`);
    }
    return bytes;
  }

  close(): void {
    try {
      this.handle.close();
    } catch {
      // already closed
    }
  }
}
