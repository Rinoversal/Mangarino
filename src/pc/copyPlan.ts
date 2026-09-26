/**
 * What this device tells the PC about its library, and which volumes to keep a copy of on the
 * PC so they can be read there while this device is off. Pure (tested in __tests__/copyPlan.test.ts).
 */

export interface CatalogVolume {
  id: number;
  file: string;
  /** Where it lands on the PC when sent: the same series folder as here. */
  folder: string;
  /** Its reading-progress key (as synced with the hub). */
  key: string;
  size: number;
  pages: number;
  kind: 'cbz' | 'dir';
  /** Changes when the cover image does. */
  cover: string;
}

export interface CatalogSeries {
  id: number;
  title: string;
  volumes: CatalogVolume[];
}

/** Reading progress of one volume on this device (a subset of the database's progress row). */
export interface VolumeProgress {
  archive_id: number;
  completed: number;
  updated_ms: number;
}

export type CopyMode = 'off' | 'reading' | 'all';

const RECENT_MS = 60 * 24 * 3600 * 1000;

/**
 * Which volumes to keep a copy of on the PC, most useful first.
 * - "reading": volumes started and not finished, and the next two after the furthest one read,
 *   in each series read in the last 60 days. Enough to carry on reading on the PC.
 * - "all": everything, starting with the series read most recently.
 */
export function copyPlan(catalog: CatalogSeries[], progress: VolumeProgress[], mode: CopyMode, now = Date.now()): number[] {
  if (mode === 'off') return [];
  const byArchive = new Map(progress.map((p) => [p.archive_id, p]));
  const lastRead = (s: CatalogSeries) => Math.max(0, ...s.volumes.map((v) => byArchive.get(v.id)?.updated_ms ?? 0));
  const ordered = [...catalog].sort((a, b) => lastRead(b) - lastRead(a));
  const out: number[] = [];
  for (const s of ordered) {
    if (mode === 'reading' && now - lastRead(s) > RECENT_MS) continue;
    let furthest = -1;
    s.volumes.forEach((v, i) => {
      if (byArchive.has(v.id)) furthest = i;
    });
    s.volumes.forEach((v, i) => {
      const p = byArchive.get(v.id);
      const reading = !!p && p.completed !== 1;
      const next = furthest >= 0 && i > furthest && i <= furthest + 2;
      if (mode === 'all' || reading || next) out.push(v.id);
    });
  }
  return out;
}
