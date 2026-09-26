/**
 * Reading progress sync with the PC hub, so reading on the PC (or another device) and on this
 * device carries on from the same page.
 *
 * Push: rows changed on this device since the last push, in small batches. Pull: rows the hub
 * changed since the revision last seen, applied when newer (the newest change wins, by the time
 * it was read). Cursors are kept per PC. When volumes were added since the last pull, everything
 * is pulled again, because the PC may already know where those volumes were left.
 * Volumes are matched by series folder + file name (progressKey), like the PC screen matches them.
 */
import { applySyncedProgress, getAllSettings, listAllArchives, listProgressChangedSince, setSetting } from '../db/repo';

import { PcLink, SyncedProgress, getProgress, postProgress } from './api';
import { progressKey, seriesFolderOf } from './match';

const PUSH_BATCH = 200;

export async function syncProgress(link: PcLink, rootPath: string): Promise<{ pushed: number; pulled: number }> {
  const all = await getAllSettings();
  const pushKey = `pcSyncPushMs:${link.serverId}`;
  const revKey = `pcSyncRev:${link.serverId}`;
  const countKey = `pcSyncVolumes:${link.serverId}`;
  let lastPush = Number(all[pushKey]) || 0;
  const lastRev = Number(all[revKey]) || 0;

  let pushed = 0;
  let pushError: unknown = null;
  try {
    const changed = (await listProgressChangedSince(lastPush)).sort((a, b) => a.updated_ms - b.updated_ms);
    for (let i = 0; i < changed.length; i += PUSH_BATCH) {
      const batch = changed.slice(i, i + PUSH_BATCH);
      const rows: SyncedProgress[] = batch.map((r) => ({
        key: progressKey(seriesFolderOf(r.uri, rootPath), r.file_name, r.kind),
        page: r.page_index,
        panel: r.panel_index,
        completed: r.completed === 1,
        updatedMs: r.updated_ms,
      }));
      pushed += (await postProgress(link, rows)).accepted;
      lastPush = Math.max(lastPush, ...batch.map((r) => r.updated_ms));
      await setSetting(pushKey, String(lastPush));
    }
  } catch (e) {
    pushError = e; // still pull: the PC's positions shouldn't wait on this device's upload
  }

  const archives = await listAllArchives();
  const since = String(archives.length) === all[countKey] ? lastRev : 0;
  let remote = await getProgress(link, since);
  if (since > 0 && remote.rev < lastRev) remote = await getProgress(link, 0); // the PC's history was reset
  let pulled = 0;
  if (remote.rows.length) {
    const byKey = new Map(archives.map((a) => [progressKey(seriesFolderOf(a.uri, rootPath), a.file_name, a.kind), a]));
    for (const row of remote.rows) {
      const a = byKey.get(row.key);
      if (!a) continue; // a volume this device doesn't have (a full pull picks it up once it arrives)
      if (await applySyncedProgress(a.id, a.series_id, row.page, row.panel, row.completed, row.updatedMs)) pulled++;
    }
  }
  await setSetting(revKey, String(remote.rev));
  await setSetting(countKey, String(archives.length));
  if (pushError) throw pushError;
  return { pushed, pulled };
}
