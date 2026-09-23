/**
 * Random-access byte source over a file. The single seam between the pure zip
 * code and the platform (expo-file-system on device, Node fs in tests).
 */
export interface ByteSource {
  readonly size: number;
  /** Read exactly `length` bytes starting at `offset`. Throws on short reads. */
  readAt(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}

export class ZipError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ZipError';
  }
}
