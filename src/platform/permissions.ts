import * as Application from 'expo-application';
import { Directory, File } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

import { toFileUri } from './paths';

/**
 * All-files access has no JS query API; probe by creating the library root and
 * writing a throwaway file. Under scoped storage without the permission this throws.
 * Side effect: the Mangarino folder exists afterwards, ready for a USB copy.
 */
export function probeAllFilesAccess(rootPath: string): boolean {
  if (Platform.OS !== 'android') return true;
  try {
    const dir = new Directory(toFileUri(rootPath));
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const probe = new File(dir, '.mangarino-probe');
    probe.write('ok');
    probe.delete();
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
