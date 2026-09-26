import { CatalogSeries, copyPlan } from '../src/pc/copyPlan';

const vol = (id: number) => ({ id, file: `v${id}.cbz`, folder: 'S', key: `s/v${id}.cbz`, size: 1, pages: 10, kind: 'cbz' as const, cover: '' });
const series = (id: number, ids: number[]): CatalogSeries => ({ id, title: `Series ${id}`, volumes: ids.map(vol) });

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

describe('copyPlan', () => {
  const catalog = [series(1, [11, 12, 13, 14, 15, 16]), series(2, [21, 22, 23]), series(3, [31, 32])];

  it('keeps what is being read and the next two volumes', () => {
    const progress = [
      { archive_id: 11, completed: 1, updated_ms: NOW - 3 * DAY },
      { archive_id: 12, completed: 0, updated_ms: NOW - DAY },
    ];
    expect(copyPlan(catalog, progress, 'reading', NOW)).toEqual([12, 13, 14]);
  });

  it('skips series not read for two months', () => {
    const progress = [{ archive_id: 21, completed: 0, updated_ms: NOW - 90 * DAY }];
    expect(copyPlan(catalog, progress, 'reading', NOW)).toEqual([]);
  });

  it('copies everything, the series being read first', () => {
    const progress = [{ archive_id: 31, completed: 0, updated_ms: NOW - DAY }];
    expect(copyPlan(catalog, progress, 'all', NOW)).toEqual([31, 32, 11, 12, 13, 14, 15, 16, 21, 22, 23]);
  });

  it('copies nothing when off', () => {
    expect(copyPlan(catalog, [{ archive_id: 11, completed: 0, updated_ms: NOW }], 'off', NOW)).toEqual([]);
  });
});
