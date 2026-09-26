/**
 * Creating folders and files on shared storage (/storage/emulated/0/...).
 *
 * expo-file-system only grants writes there to paths that already exist, so a brand-new
 * file can't be written directly. Instead: create each missing folder from its existing
 * parent (Directory.createDirectory), create files with Directory.createFile, and fill them
 * afterwards (for example with a download using `idempotent: true`).
 */
import { Directory, File } from 'expo-file-system';

import { fromFileUri, toFileUri } from './paths';

/** The folder at `path`, creating every missing level under the nearest existing parent. */
export function ensureDirectory(path: string): Directory {
  const parts = fromFileUri(path).replace(/\/+$/, '').split('/');
  let i = parts.length;
  let dir = new Directory(toFileUri(parts.join('/')));
  const missing: string[] = [];
  while (!dir.exists && i > 2) {
    missing.unshift(parts[i - 1]);
    i--;
    dir = new Directory(toFileUri(parts.slice(0, i).join('/')));
  }
  for (const name of missing) dir = dir.createDirectory(name);
  return dir;
}

/** An empty file `name` in `dir`, replacing any old one. */
export function createFreshFile(dir: Directory, name: string, mimeType = 'application/octet-stream'): File {
  const old = new File(dir, name);
  if (old.exists) old.delete();
  return dir.createFile(name, mimeType);
}
