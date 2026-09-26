/**
 * Which volumes the PC and this device have in common. Pure (tested in __tests__/pcMatch.test.ts).
 *
 * A volume is identified by its file name, compared case-insensitively after Unicode
 * normalisation (Android storage is case-insensitive; macOS copies can use decomposed
 * accents). Same name and size anywhere on the device: already here. Same name, different
 * size, same series folder: the PC has a newer copy (for example with panels added). Generic
 * names like "Vol 01.cbz" repeat across series, so a changed copy is only matched inside the
 * same series folder.
 */
import { fromFileUri } from '../platform/paths';

export interface PcVolume {
  id: string;
  file: string;
  kind: 'file' | 'folder';
  size: number;
  version: string;
  panels: string; // none | old | ready | working | failed
}

export interface PcSeries {
  id: string;
  folder: string;
  title: string;
  volumes: PcVolume[];
}

export interface DeviceVolume {
  archiveId: number;
  seriesId: number;
  uri: string;
  folder: string; // series folder under the library root ('' for loose files and imports)
  file: string;
  size: number;
  hasPanels: boolean;
  kind: 'cbz' | 'dir';
  underRoot?: boolean; // inside the library folder (false for imported files)
}

export type PcVolumeState = 'onDevice' | 'changed' | 'missing';

export interface MatchedVolume extends PcVolume {
  state: PcVolumeState;
  device?: DeviceVolume;
}

export const normName = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * How the hub, the PC reader and every device name a volume for progress sync:
 * "<series folder>/<file name>", normalised and lower case. A folder of images on the device is
 * named like the hub names folder volumes: "<label>.cbz".
 */
export function progressKey(folder: string, file: string, kind: 'cbz' | 'dir' = 'cbz'): string {
  return normName(`${folder}/${kind === 'dir' ? `${file}.cbz` : file}`);
}

/** A Windows-safe folder name for a series title (imported files have no folder of their own). */
export function safeFolderName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  return cleaned.slice(0, 100) || 'Imported';
}

/** The series folder of a file under `rootPath`: the first folder level, '' when loose or outside the root. */
export function seriesFolderOf(uri: string, rootPath: string): string {
  const path = fromFileUri(uri).replace(/\\/g, '/');
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  if (!normName(path).startsWith(normName(root))) return '';
  const rest = path.slice(root.length).split('/');
  return rest.length >= 2 ? rest[0] : '';
}

export function matchPcSeries(series: PcSeries, device: DeviceVolume[]): MatchedVolume[] {
  const folder = normName(series.folder);
  return series.volumes.map((v) => {
    const name = normName(v.file);
    const same = device.filter((d) => normName(d.file) === name);
    const exact = same.find((d) => d.size === v.size);
    if (exact) return { ...v, state: 'onDevice', device: exact };
    const changed = same.find((d) => normName(d.folder) === folder);
    if (changed) return { ...v, state: 'changed', device: changed };
    return { ...v, state: 'missing' };
  });
}

/**
 * Device archives the PC doesn't have, for "Send to PC" and copies. A volume in the library folder
 * counts as on the PC when the PC has the same series folder and file name (generic names like
 * "Vol 01.cbz" repeat across series); an imported file, when the PC has the same name and size.
 * Folder volumes stay put.
 */
export function deviceOnly(series: PcSeries[], device: DeviceVolume[]): DeviceVolume[] {
  const byPath = new Set(series.flatMap((s) => s.volumes.map((v) => normName(`${s.folder}/${v.file}`))));
  const byNameSize = new Set(series.flatMap((s) => s.volumes.map((v) => `${normName(v.file)}|${v.size}`)));
  return device.filter((d) => {
    if (d.kind !== 'cbz') return false;
    if (d.underRoot === false) return !byNameSize.has(`${normName(d.file)}|${d.size}`);
    return !byPath.has(normName(`${d.folder}/${d.file}`));
  });
}

/**
 * The device folder a PC series downloads into: an existing folder with the same name in any
 * letter case (so "berserk" on the device is reused for "Berserk" on the PC), else the PC's name.
 */
export function destinationFolder(pcFolder: string, deviceFolders: string[]): string {
  const want = normName(pcFolder);
  return deviceFolders.find((f) => normName(f) === want) ?? pcFolder;
}

/** Why a PC copy is worth taking again, for the "Update" label. */
export function updateReason(v: MatchedVolume): string {
  if (v.state !== 'changed' || !v.device) return '';
  if (v.panels === 'ready' && !v.device.hasPanels) return 'adds panels';
  if (v.panels === 'ready') return 'better panels';
  return 'newer copy';
}
