import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { APP_NAME } from '@/brand';
import { ContinueItem, SeriesSummary } from '@/db/repo';
import { archiveLabel } from '@/library/parse';
import { useLibrary } from '@/store/library';
import { colors, radius, spacing } from '@/ui/theme';

function SeriesCard({ item, width }: { item: SeriesSummary; width: number }) {
  const title = item.title_override ?? item.title;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/series/[seriesId]', params: { seriesId: String(item.id) } })}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.cardPressed]}>
      <View style={[styles.cover, { height: width * 1.42 }]}>
        {item.cover_uri ? (
          <Image source={{ uri: item.cover_uri }} style={styles.coverImage} contentFit="cover" transition={100} />
        ) : (
          <Text style={styles.coverPlaceholder}>{title.slice(0, 1).toUpperCase()}</Text>
        )}
      </View>
      <Text numberOfLines={2} style={styles.cardTitle}>
        {title}
      </Text>
      <Text style={styles.cardMeta}>
        {item.archive_count} {item.archive_count === 1 ? 'volume' : 'volumes'}
        {item.read_count > 0 ? ` · ${item.read_count} read` : ''}
      </Text>
    </Pressable>
  );
}

function ContinueCard({ item, width }: { item: ContinueItem; width: number }) {
  const pct = item.page_count > 0 ? Math.round(((item.page_index + 1) / item.page_count) * 100) : 0;
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/reader/[archiveId]', params: { archiveId: String(item.archive_id) } })
      }
      style={({ pressed }) => [styles.continueCard, { width }, pressed && styles.cardPressed]}>
      <View style={styles.continueCover}>
        {item.cover_uri ? (
          <Image source={{ uri: item.cover_uri }} style={styles.coverImage} contentFit="cover" />
        ) : null}
      </View>
      <View style={styles.continueBody}>
        <Text numberOfLines={1} style={styles.cardTitle}>
          {item.series_title}
        </Text>
        <Text numberOfLines={1} style={styles.cardMeta}>
          {archiveLabel(item, item.file_name)} · p. {item.page_index + 1}/{item.page_count}
        </Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${pct}%` }]} />
        </View>
      </View>
    </Pressable>
  );
}

export default function LibraryScreen() {
  const { series, continueReading, scan, loaded, lastScanError, refresh, rescan } = useLibrary();
  const { width } = useWindowDimensions();
  const columns = Math.max(2, Math.floor((width - spacing.md) / 170));
  const cardWidth = (width - spacing.md * (columns + 1)) / columns;
  // 300 wide, but never wider than a small phone's screen.
  const continueWidth = Math.min(300, width - spacing.md * 2);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const header = (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.h1}>{APP_NAME}</Text>
        <View style={styles.headerButtons}>
          <Pressable onPress={() => router.push('/pc')} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>PC</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/sources')} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>Sources</Text>
          </Pressable>
          <Pressable onPress={() => void rescan()} disabled={!!scan} style={[styles.headerButton, styles.accentButton]}>
            <Text style={styles.accentButtonText}>{scan ? 'Scanning…' : 'Rescan'}</Text>
          </Pressable>
        </View>
      </View>
      {scan ? (
        <Text style={styles.scanText}>
          {scan.phase} {scan.total ? `${scan.current}/${scan.total}` : ''} {scan.label ? `· ${scan.label}` : ''}
        </Text>
      ) : null}
      {lastScanError ? <Text style={styles.errorText}>{lastScanError}</Text> : null}
      {continueReading.length > 0 ? (
        <View>
          <Text style={styles.h2}>Continue reading</Text>
          <FlatList
            horizontal
            data={continueReading}
            keyExtractor={(c) => String(c.series_id)}
            renderItem={({ item }) => <ContinueCard item={item} width={continueWidth} />}
            contentContainerStyle={styles.continueList}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ) : null}
      {series.length > 0 ? <Text style={styles.h2}>Library</Text> : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <FlatList
        key={columns}
        data={series}
        numColumns={columns}
        keyExtractor={(s) => String(s.id)}
        renderItem={({ item }) => <SeriesCard item={item} width={cardWidth} />}
        ListHeaderComponent={header}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loaded && !scan ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No manga yet</Text>
              <Text style={styles.emptyText}>
                Copy your CBZ files to Internal storage › {APP_NAME} › (series name) on this device, then tap Rescan.
                Sources lets you grant file access and import single files.
              </Text>
              <Pressable onPress={() => router.push('/sources')} style={[styles.headerButton, styles.accentButton]}>
                <Text style={styles.accentButtonText}>Open Sources</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  row: { gap: spacing.md, marginBottom: spacing.md },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  headerButtons: { flexDirection: 'row', gap: spacing.sm },
  h1: { color: colors.text, fontSize: 28, fontWeight: '700' },
  h2: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.md, marginBottom: spacing.sm },
  headerButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.card },
  headerButtonText: { color: colors.text, fontWeight: '600' },
  accentButton: { backgroundColor: colors.accent },
  accentButtonText: { color: colors.accentText, fontWeight: '600' },
  scanText: { color: colors.muted, marginBottom: spacing.sm },
  errorText: { color: colors.danger, marginBottom: spacing.sm },
  continueList: { gap: spacing.sm },
  continueCard: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  continueCover: { width: 70, height: 100, backgroundColor: colors.cardActive },
  continueBody: { flex: 1, padding: spacing.sm, justifyContent: 'center', gap: 4 },
  card: { borderRadius: radius.md, overflow: 'hidden' },
  cardPressed: { opacity: 0.7 },
  cover: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverImage: { width: '100%', height: '100%' },
  coverPlaceholder: { color: colors.muted, fontSize: 40, fontWeight: '700' },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 6 },
  cardMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  bar: { height: 4, backgroundColor: colors.border, borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.accent },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.md },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '600' },
  emptyText: { color: colors.muted, textAlign: 'center', lineHeight: 20 },
});
