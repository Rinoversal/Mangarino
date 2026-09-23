import {
  archiveSortKey,
  naturalCompare,
  normalizeSeriesKey,
  parseArchiveName,
  parseEntryName,
} from '../src/library/parse';

describe('parseArchiveName', () => {
  const cases: [string, ReturnType<typeof parseArchiveName>][] = [
    ['Berserk v01 (2003) (Digital) (danke-Empire).cbz', { series: 'Berserk', volume: 1, year: 2003 }],
    ['Berserk v10 (2006) (Digital) (danke-Empire).cbz', { series: 'Berserk', volume: 10, year: 2006 }],
    ['Series Vol.01 Ch.005.cbz', { series: 'Series', volume: 1, chapter: 5 }],
    ['Series - Chapter 12.cbz', { series: 'Series', chapter: 12 }],
    ['[Group] Series 012.cbz', { series: 'Series', chapter: 12 }],
    ['Series - 012.cbz', { series: 'Series', chapter: 12 }],
    ['One Piece 1050 [Scan].cbz', { series: 'One Piece', chapter: 1050 }],
    ['Series_v03_c021.cbz', { series: 'Series', volume: 3, chapter: 21 }],
    ['Random Scans.cbz', { series: 'Random Scans' }],
    ['Vagabond v05.zip', { series: 'Vagabond', volume: 5 }],
    ['C:/stuff/Chainsaw Man #7.cbz', { series: 'Chainsaw Man', chapter: 7 }],
  ];
  it.each(cases)('%s', (input, expected) => {
    expect(parseArchiveName(input)).toEqual(expected);
  });
});

describe('parseEntryName', () => {
  it('parses danke-style names', () => {
    expect(parseEntryName('Berserk - 001 (v01) - p000 [Digital-HD] [danke-Empire].jpg')).toEqual({
      dir: '',
      chapter: 1,
      volume: 1,
      page: 0,
    });
    expect(parseEntryName('Berserk - 001 (v01) - p000x1 [Digital-HD] [danke-Empire].png')).toEqual({
      dir: '',
      chapter: 1,
      volume: 1,
      page: 0,
      extra: 'x1',
    });
    expect(parseEntryName('Berserk - c048 (v10) - p238 [Digital-HD] [danke-Empire].jpg')).toEqual({
      dir: '',
      chapter: 48,
      volume: 10,
      page: 238,
    });
  });
  it('falls back to generic tokens and last number', () => {
    expect(parseEntryName('ch05/001.jpg')).toEqual({ dir: 'ch05', page: 1 });
    expect(parseEntryName('Berserk_012a.jpg')).toEqual({ dir: '', page: 12, extra: 'a' });
    expect(parseEntryName('page-12.png')).toEqual({ dir: '', page: 12 });
    expect(parseEntryName('Series v02 c010 p003.jpg')).toEqual({ dir: '', volume: 2, chapter: 10, page: 3 });
  });
});

describe('naturalCompare', () => {
  it('orders danke pages with extras between base page and next page', () => {
    const names = [
      'Berserk - 001 (v01) - p001 [Digital-HD] [danke-Empire].jpg',
      'Berserk - 001 (v01) - p000x2 [Digital-HD] [danke-Empire].jpg',
      'Berserk - 001 (v01) - p000 [Digital-HD] [danke-Empire].jpg',
      'Berserk - 001 (v01) - p000x1 [Digital-HD] [danke-Empire].png',
      'Berserk - 002 (v01) - p010 [Digital-HD] [danke-Empire].jpg',
    ];
    const sorted = [...names].sort(naturalCompare);
    expect(sorted.map((n) => n.split(' - ')[2].split(' ')[0])).toEqual(['p000', 'p000x1', 'p000x2', 'p001', 'p010']);
  });
  it('compares numbers numerically', () => {
    expect(['10.jpg', '2.jpg', '1.jpg'].sort(naturalCompare)).toEqual(['1.jpg', '2.jpg', '10.jpg']);
  });
});

describe('archiveSortKey', () => {
  it('puts volumes before loose chapters and sorts numerically', () => {
    const keys = [
      archiveSortKey({ chapter: 3 }, 'Series - 003.cbz'),
      archiveSortKey({ volume: 2 }, 'Series v02.cbz'),
      archiveSortKey({ volume: 10 }, 'Series v10.cbz'),
      archiveSortKey({ volume: 1 }, 'Series v01.cbz'),
    ];
    const sorted = [...keys].sort();
    expect(sorted).toEqual([keys[3], keys[1], keys[2], keys[0]]);
  });
});

describe('normalizeSeriesKey', () => {
  it('collapses punctuation and case', () => {
    expect(normalizeSeriesKey('  Berserk!  ')).toBe('berserk');
    expect(normalizeSeriesKey('One-Piece')).toBe(normalizeSeriesKey('one piece'));
  });
});
