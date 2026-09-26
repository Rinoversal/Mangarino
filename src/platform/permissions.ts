import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

import { createFreshFile, ensureDirectory } from './externalFs';

/**
 * All-files access has no JS query API; probe by creating the library root and a throwaway
 * file in it. Under scoped storage without the permission this throws.
 * expo-file-system only allows writes to paths that already exist, so the folder is created
 * level by level and the file with createFile (writing a brand-new File directly always fails).
 * Side effect: the Mangarino folder exists afterwards, ready for a copy.
 */
export function probeAllFilesAccess(rootPath: string): boolean {
  if (Platform.OS !== 'android') return true;
  try {
    const dir = ensureDirectory(rootPath);
    createFreshFile(dir, '.mangarino-probe', 'text/plain').delete();
    return true;
  } catch {
    return false;
  }
}

/** Open the system screen where the user grants "All files access" to this app. */
export async function requestAllFilesAccess(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const pkg = Application.applicationId;
  try {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
      { data: `package:${pkg}` },
    );
  } catch {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_ALL_FILES_ACCESS_PERMISSION);
  }
}
