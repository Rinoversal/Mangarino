import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  ArchiveWithProgress,
  SeriesRow,
  getSeries,
  getSeriesProgress,
  listArchives,
  renameSeries,
  setArchiveCompleted,
} from '@/db/repo';
import { archiveLabel } from '@/library/parse';
import { colors, radius, spacing } from '@/ui/theme';

function VolumeCard({
  item,
  width,
  onToggleRead,
}: {
  item: ArchiveWithProgress;
  width: number;
  onToggleRead: () => void;
}) {
  const total = item.page_count;
  const page = item.progress_page ?? null;
  const done = item.progress_completed === 1;
  const pct = done ? 100 : total > 0 && page !== null ? Math.round(((page + 1) / total) * 100) : 0;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/reader/[archiveId]', params: { archiveId: String(item.id) } })}
      onLongPress={onToggleRead}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.cardPressed]}>
      <View style={[styles.cover, { height: width * 1.42 }]}>
        {item.cover_uri ? (
          <Image source={{ uri: item.cover_uri }} style={styles.coverImage} contentFit="cover" transition={100} />
        ) : (
          <Text style={styles.coverPlaceholder}>{item.volume ?? item.chapter ?? '·'}</Text>
        )}
        {done ? (
          <View style={styles.doneBadge}>
            <Text style={styles.doneBadgeText}>✓</Text>
          </View>
        ) : null}
        {item.has_panels ? (
          <View style={styles.panelBadge}>
            <Text style={styles.panelBadgeText}>panels</Text>
          </View>
        ) : null}
        <View style={styles.barOverlay}>
          <View style={[styles.barFill, { width: `${pct}%` }, done && styles.barDone]} />
        </View>
      </View>
      <Text numberOfLines={1} style={styles.cardTitle}>
        {archiveLabel(item, item.file_name)}
      </Text>
      <Text numberOfLines={1} style={styles.cardMeta}>
        {item.error
          ? 'Error'
          : total > 0
            ? page !== null && !done
              ? `p. ${page + 1} / ${total}`
              : `${total} pages`
            : 'Not indexed'}
      </Text>
    </Pressable>
  );
}

export default function SeriesScreen() {
  const { seriesId: param } = useLocalSearchParams<{ seriesId: string }>();
  const seriesId = Number(param);
  const { width } = useWindowDimensions();
  const [series, setSeries] = useState<SeriesRow | null>(null);
  const [archives, setArchives] = useState<ArchiveWithProgress[]>([]);
  const [continueTarget, setContinueTarget] = useState<{ archive_id: number; page_index: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const columns = Math.max(3, Math.floor((width - spacing.md) / 150));
  const cardWidth = (width - spacing.md * (columns + 1)) / columns;

  const load = useCallback(async () => {
    const [s, a, p] = await Promise.all([getSeries(seriesId), listArchives(seriesId), getSeriesProgress(seriesId)]);
    setSeries(s);
    setArchives(a);
    setContinueTarget(p);
  }, [seriesId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const title = series ? (series.title_override ?? series.title) : '';
  const readCount = archives.filter((a) => a.progress_completed === 1).length;

  const toggleRead = async (a: ArchiveWithProgress) => {
    await setArchiveCompleted(a.id, a.progress_completed !== 1);
    await load();
  };

  const continueReading = () => {
    const target = continueTarget ?? (archives[0] ? { archive_id: archives[0].id, page_index: 0 } : null);
    if (!target) return;
    router.push({
      pathname: '/reader/[archiveId]',
      params: { archiveId: String(target.archive_id), page: String(target.page_index) },
    });
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <FlatList
        key={columns}
        data={archives}
        numColumns={columns}
        keyExtractor={(a) => String(a.id)}
        renderItem={({ item }) => (
          <VolumeCard item={item} width={cardWidth} onToggleRead={() => void toggleRead(item)} />
        )}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.back}>
              <Text style={styles.backText}>‹ Library</Text>
            </Pressable>
            <View style={styles.headerMain}>
              <View style={styles.heroCover}>
                {series?.cover_uri ? (
                  <Image source={{ uri: series.cover_uri }} style={styles.coverImage} contentFit="cover" />
                ) : null}
              </View>
              <View style={styles.headerText}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.meta}>
                  {archives.length} {archives.length === 1 ? 'volume' : 'volumes'}
                  {readCount > 0 ? ` · ${readCount} read` : ''}
                </Text>
                <View style={styles.headerButtons}>
                  <Pressable onPress={continueReading} style={[styles.button, styles.accentButton]}>
                    <Text style={styles.accentButtonText}>{continueTarget ? 'Continue' : 'Start reading'}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setDraft(title);
                      setRenaming(true);
                    }}
                    style={styles.button}>
                    <Text style={styles.buttonText}>Rename</Text>
                  </Pressable>
                </View>
              </View>
            </View>
            <Text style={styles.hint}>Tap a volume to read. Long-press to mark read or unread.</Text>
          </View>
        }
      />
      <Modal visible={renaming} transparent animationType="fade" onRequestClose={() => setRenaming(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Series name</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              style={styles.input}
              placeholder="Name this series"
              placeholderTextColor={colors.muted}
            />
            <View style={styles.modalButtons}>
              <Pressable onPress={() => setRenaming(false)} style={styles.button}>
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const t = draft.trim();
                  await renameSeries(seriesId, t.length ? t : null);
                  setRenaming(false);
                  await load();
                }}
                style={[styles.button, styles.accentButton]}>
                <Text style={styles.accentButtonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  row: { gap: spacing.md, marginBottom: spacing.md },
  header: { marginBottom: spacing.md },
  back: { paddingVertical: spacing.sm },
  backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  headerMain: { flexDirection: 'row', gap: spacing.md },
  heroCover: { width: 110, height: 156, borderRadius: radius.md, backgroundColor: colors.card, overflow: 'hidden' },
  coverImage: { width: '100%', height: '100%' },
  headerText: { flex: 1, justifyContent: 'center', gap: 6 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  meta: { color: colors.muted },
  headerButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, backgroundColor: colors.card },
  buttonText: { color: colors.text, fontWeight: '600' },
  accentButton: { backgroundColor: colors.accent },
  accentButtonText: { color: colors.accentText, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 12, marginTop: spacing.md },
  card: { borderRadius: radius.md },
  cardPressed: { opacity: 0.7 },
  cover: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverPlaceholder: { color: colors.muted, fontSize: 36, fontWeight: '700' },
  doneBadge: { position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
  doneBadgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  panelBadge: { position: 'absolute', top: 6, left: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.6)' },
  panelBadgeText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  barOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(0,0,0,0.5)' },
  barFill: { height: '100%', backgroundColor: colors.accent },
  barDone: { backgroundColor: colors.success },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '600', marginTop: 6 },
  cardMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  modal: { width: '100%', maxWidth: 420, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '600' },
  input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 16 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
});
