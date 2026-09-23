import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SourceRow, addSource, removeSourceAndArchives } from '@/db/repo';
import { fromFileUri, toFileUri } from '@/platform/paths';
import { probeAllFilesAccess, requestAllFilesAccess } from '@/platform/permissions';
import { useLibrary } from '@/store/library';
import { useSettings } from '@/store/settings';
import { colors, radius, spacing } from '@/ui/theme';

const ARCHIVE_RE = /\.(cbz|zip)$/i;

export default function SourcesScreen() {
  const { settings, set } = useSettings();
  const { sources, scan, refresh, rescan } = useLibrary();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [rootDraft, setRootDraft] = useState(settings.libraryRoot);
  const [busy, setBusy] = useState<string | null>(null);

  const probe = useCallback(() => {
    setGranted(probeAllFilesAccess(settings.libraryRoot));
  }, [settings.libraryRoot]);

  useFocusEffect(
    useCallback(() => {
      probe();
      void refresh();
    }, [probe, refresh]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') probe();
    });
    return () => sub.remove();
  }, [probe]);

  const applyRoot = async () => {
    const path = rootDraft.trim().replace(/[\\/]+$/, '');
    if (!path) return;
    await set('libraryRoot', path);
    for (const s of sources) if (s.kind === 'folder') await removeSourceAndArchives(s.id);
    await addSource('folder', toFileUri(path), 'Mangarino folder');
    await refresh();
    setGranted(probeAllFilesAccess(path));
  };

  const importFiles = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    const picked = res.assets.filter((a) => ARCHIVE_RE.test(a.name));
    if (picked.length === 0) {
      Alert.alert('No archives selected', 'Pick .cbz or .zip files.');
      return;
    }
    setBusy(`Importing ${picked.length} file(s)…`);
    try {
      const importsDir = new Directory(Paths.document, 'imports');
      if (!importsDir.exists) importsDir.create({ intermediates: true, idempotent: true });
      for (const a of picked) {
        const dest = new File(importsDir, a.name);
        if (dest.exists) dest.delete();
        new File(a.uri).move(dest);
      }
      await addSource('imported', importsDir.uri, 'Imported files');
      await rescan();
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const removeSource = (s: SourceRow) => {
    Alert.alert('Remove source?', `${s.label ?? s.uri}\n\nThe files stay on disk; only the library entries are removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeSourceAndArchives(s.id);
          await refresh();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.h1}>Sources</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>All files access</Text>
          <Text style={styles.text}>
            Mangarino reads your archives where they are, without copying them. Android needs the &quot;All files access&quot;
            permission for that.
          </Text>
          <View style={styles.statusRow}>
            <Text style={[styles.status, granted ? styles.ok : styles.bad]}>
              {granted === null ? 'Checking…' : granted ? '● Granted' : '● Not granted'}
            </Text>
            {!granted ? (
              <Pressable onPress={() => void requestAllFilesAccess()} style={[styles.button, styles.accentButton]}>
                <Text style={styles.accentButtonText}>Grant access</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Library folder</Text>
          <Text style={styles.text}>
            Put each series in its own folder here, e.g. Mangarino › Berserk › the .cbz files. Copy them over USB, then
            Rescan.
          </Text>
          <TextInput
            value={rootDraft}
            onChangeText={setRootDraft}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="/storage/emulated/0/Mangarino"
            placeholderTextColor={colors.muted}
          />
          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => void applyRoot()}
              disabled={rootDraft.trim() === settings.libraryRoot}
              style={[styles.button, rootDraft.trim() === settings.libraryRoot && styles.disabled]}>
              <Text style={styles.buttonText}>Use this folder</Text>
            </Pressable>
            <Pressable onPress={() => void rescan()} disabled={!!scan} style={[styles.button, styles.accentButton]}>
              <Text style={styles.accentButtonText}>{scan ? 'Scanning…' : 'Rescan'}</Text>
            </Pressable>
          </View>
          {scan ? (
            <Text style={styles.hint}>
              {scan.phase} {scan.total ? `${scan.current}/${scan.total}` : ''} {scan.label ? `· ${scan.label}` : ''}
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import files</Text>
          <Text style={styles.text}>
            Pick .cbz files with the system picker. They are copied into Mangarino&apos;s private storage (a 450 MB volume
            takes a little while), so prefer the library folder for big collections.
          </Text>
          <Pressable onPress={() => void importFiles()} disabled={!!busy} style={[styles.button, styles.selfStart]}>
            <Text style={styles.buttonText}>{busy ?? 'Pick archives…'}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Current sources</Text>
          {sources.map((s) => (
            <View key={s.id} style={styles.sourceRow}>
              <View style={styles.sourceText}>
                <Text style={styles.label}>{s.label ?? s.kind}</Text>
                <Text style={styles.hint}>{fromFileUri(s.uri)}</Text>
              </View>
              <Pressable onPress={() => removeSource(s)} hitSlop={8}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          ))}
          {sources.length === 0 ? <Text style={styles.hint}>None. Set a library folder above.</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  back: { paddingVertical: spacing.xs },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  h1: { color: colors.text, fontSize: 28, fontWeight: '700' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  text: { color: colors.muted, lineHeight: 19 },
  hint: { color: colors.muted, fontSize: 12 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xs },
  status: { fontWeight: '600' },
  ok: { color: colors.success },
  bad: { color: colors.danger },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 10, fontSize: 14 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, backgroundColor: colors.bg },
  buttonText: { color: colors.text, fontWeight: '600' },
  accentButton: { backgroundColor: colors.accent },
  accentButtonText: { color: colors.accentText, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  selfStart: { alignSelf: 'flex-start' },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  sourceText: { flex: 1, gap: 2 },
  label: { color: colors.text, fontSize: 15 },
  remove: { color: colors.danger, fontWeight: '600' },
});
