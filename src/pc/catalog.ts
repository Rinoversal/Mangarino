/**
 * This device's library as the PC hub sees it (POST /api/catalog), so the PC can show it and
 * ask for volumes.
 */
import { ArchiveRow, listAllArchives, listSeries } from '../db/repo';
import { naturalCompare } from '../library/parse';

import { CatalogSeries } from './copyPlan';
import { sendFolder, volumeKey } from './match';

export interface Catalog {
  series: CatalogSeries[];
  /** Cover image of each volume, by archive id, for sending the ones the PC lacks. */
  covers: Map<number, string>;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}


export async function buildCatalog(rootPath: string): Promise<Catalog> {
  const [archives, series] = await Promise.all([listAllArchives(), listSeries()]);
  const titles = new Map<number, string>(series.map((s) => [s.id, s.title_override ?? s.title]));
  const bySeries = new Map<number, ArchiveRow[]>();
  for (const a of archives) bySeries.set(a.series_id, [...(bySeries.get(a.series_id) ?? []), a]);
  const covers = new Map<number, string>();
  const out: CatalogSeries[] = [];
  for (const [seriesId, list] of bySeries) {
    const title = titles.get(seriesId) ?? 'Untitled';
    list.sort((x, y) => naturalCompare(x.sort_key, y.sort_key));
    out.push({
      id: seriesId,
      title,
      volumes: list.map((a) => {
        if (a.cover_uri) covers.set(a.id, a.cover_uri);
        return {
          id: a.id,
          file: a.file_name,
          folder: sendFolder(a, title, rootPath),
          key: volumeKey(a, title, rootPath),
          size: a.size,
          pages: a.page_count,
          kind: a.kind,
          cover: a.cover_uri ? shortHash(a.cover_uri) : '',
        };
      }),
    });
  }
  out.sort((x, y) => naturalCompare(x.title, y.title));
  return { series: out, covers };
}
