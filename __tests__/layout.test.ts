import {
  COVER_IMAGES_MAX,
  folderImagesAreVolume,
  isArchiveName,
  isJunkName,
  isPageImage,
} from '../src/library/layout';

describe('junk and page files', () => {
  it('ignores macOS, Windows and hidden leftovers', () => {
    for (const name of ['._p001.jpg', '.DS_Store', '__MACOSX', 'Thumbs.db', 'desktop.ini', '.hidden']) {
      expect(isJunkName(name)).toBe(true);
    }
    expect(isPageImage('._p001.jpg')).toBe(false);
    expect(isArchiveName('._Berserk v01.cbz')).toBe(false);
  });

  it('accepts real pages and archives, and nothing else', () => {
    for (const name of ['p001.jpg', 'P001.JPEG', 'page.png', 'x.webp', 'x.avif', 'x.gif', 'x.bmp']) {
      expect(isPageImage(name)).toBe(true);
    }
    expect(isArchiveName('Berserk v01.cbz')).toBe(true);
    expect(isArchiveName('Berserk v01.ZIP')).toBe(true);
    for (const name of ['notes.txt', 'info.nfo', 'site.url', 'Berserk v01.cbr', 'book.pdf', 'p001.jpg.part']) {
      expect(isPageImage(name) || isArchiveName(name)).toBe(false);
    }
  });
});

describe('folderImagesAreVolume', () => {
  it('a folder of pages with nothing else is a volume', () => {
    expect(folderImagesAreVolume(1, false, false)).toBe(true);
    expect(folderImagesAreVolume(180, false, false)).toBe(true);
  });

  it('a few cover images next to volume or chapter folders are not a volume', () => {
    for (let n = 1; n <= COVER_IMAGES_MAX; n++) expect(folderImagesAreVolume(n, false, true)).toBe(false);
  });

  it('many pages stay a volume even with an extras folder beside them', () => {
    expect(folderImagesAreVolume(COVER_IMAGES_MAX + 1, false, true)).toBe(true);
  });

  it('images next to archives are extras', () => {
    expect(folderImagesAreVolume(50, true, false)).toBe(false);
  });

  it('no images, no volume', () => {
    expect(folderImagesAreVolume(0, false, false)).toBe(false);
  });
});
