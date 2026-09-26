/**
 * Which files and folders in a library are manga. Pure functions, shared by the scanner and
 * the folder indexer; mirrored by the PC hub (tools/hub/mangarino_hub/library.py).
 */

export const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
export const ARCHIVE_RE = /\.(cbz|zip)$/i;

/**
 * A folder's own loose images are a volume only if there are more than this many, or nothing
 * below it holds a volume. Up to 3 images (cover, back, spine) next to volume or chapter
 * folders are artwork, not a one-page volume.
 */
export const COVER_IMAGES_MAX = 3;

/** Never manga: hidden files, macOS leftovers (`._x.jpg`, `__MACOSX`), Windows thumbnail caches. */
export function isJunkName(name: string): boolean {
  const n = name.toLowerCase();
  return name.startsWith('.') || n === '__macosx' || n === 'thumbs.db' || n === 'desktop.ini';
}

export function isPageImage(name: string): boolean {
  return !isJunkName(name) && IMAGE_RE.test(name);
}

export function isArchiveName(name: string): boolean {
  return !isJunkName(name) && ARCHIVE_RE.test(name);
}

/**
 * Should a folder's own loose images count as a volume?
 * @param ownImages page images directly in the folder
 * @param hasArchivesHere archives sit next to them (then the images are extras)
 * @param hasSubVolumes a subfolder holds a volume or chapter
 */
export function folderImagesAreVolume(ownImages: number, hasArchivesHere: boolean, hasSubVolumes: boolean): boolean {
  return !hasArchivesHere && ownImages > 0 && (ownImages > COVER_IMAGES_MAX || !hasSubVolumes);
}
