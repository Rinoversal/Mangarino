import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BookmarkView, deleteBookmark, listBookmarks } from '@/db/repo';
import { archiveLabel } from '@/library/parse';
import { colors, radius, spacing } from '@/ui/theme';

export default function BookmarksScreen() {
  const [items, setItems] = useState<BookmarkView[]>([]);

  const load = useCallback(async () => {
    setItems(await listBookmarks());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const remove = (b: BookmarkView) => {
    Alert.alert('Remove bookmark?', `${b.series_title} · ${archiveLabel(b, b.file_name)} · page ${b.page_index + 1}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await deleteBookmark(b.id);
          await load();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <FlatList
        data={items}
        keyExtractor={(b) => String(b.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<Text style={styles.h1}>Bookmarks</Text>}
        ListEmptyComponent={
          <Text style={styles.empty}>No bookmarks yet. In the reader, tap the centre of the page and press ☆.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/reader/[archiveId]',
                params: {
                  archiveId: String(item.archive_id),
                  page: String(item.page_index),
                  ...(item.panel_index !== null ? { panel: String(item.panel_index), mode: 'panel' } : {}),
                },
              })
            }
            onLongPress={() => remove(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.rowBody}>
              <Text style={styles.title}>{item.series_title}</Text>
              <Text style={styles.meta}>
                {archiveLabel(item, item.file_name)} · page {item.page_index + 1}
                {item.panel_index !== null ? ` · panel ${item.panel_index + 1}` : ''}
              </Text>
              {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  h1: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.sm },
  empty: { color: colors.muted, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, gap: spacing.md },
  rowPressed: { backgroundColor: colors.cardActive },
  rowBody: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  note: { color: colors.text, fontSize: 13, marginTop: 4 },
  chevron: { color: colors.muted, fontSize: 24 },
});
