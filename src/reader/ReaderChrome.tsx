import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReaderMode } from '@/store/settings';
import { colors } from '@/ui/theme';

export interface ChapterMark {
  label: string;
  pageIndex: number;
}

export interface ReaderChromeProps {
  visible: boolean;
  title: string;
  subtitle: string;
  pageIndex: number;
  pageCount: number;
  panelInfo?: string;
  rtl: boolean;
  mode: ReaderMode;
  hasPanels: boolean;
  bookmarked: boolean;
  chapters: ChapterMark[];
  onClose: () => void;
  onToggleRtl: () => void;
  onSetMode: (mode: ReaderMode) => void;
  onBookmark: () => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: (pageIndex: number) => void;
}

function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} hitSlop={6}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function ReaderChrome(p: ReaderChromeProps) {
  const insets = useSafeAreaInsets();
  if (!p.visible) return null;
  const currentChapter = [...p.chapters].reverse().find((c) => c.pageIndex <= p.pageIndex);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={[styles.bar, styles.top, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={p.onClose} hitSlop={10} style={styles.iconButton}>
          <Text style={styles.icon}>‹</Text>
        </Pressable>
        <View style={styles.titles}>
          <Text numberOfLines={1} style={styles.title}>
            {p.title}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {p.subtitle}
          </Text>
        </View>
        <Chip label={p.rtl ? 'Manga' : 'Western'} onPress={p.onToggleRtl} />
        <Chip label="Page" active={p.mode === 'page'} onPress={() => p.onSetMode('page')} />
        {p.hasPanels ? <Chip label="Panels" active={p.mode === 'panel'} onPress={() => p.onSetMode('panel')} /> : null}
        <Pressable onPress={p.onBookmark} hitSlop={10} style={styles.iconButton}>
          <Text style={[styles.icon, p.bookmarked && styles.iconActive]}>{p.bookmarked ? '★' : '☆'}</Text>
        </Pressable>
      </View>

      <View style={[styles.bar, styles.bottom, { paddingBottom: insets.bottom + 8 }]}>
        {p.chapters.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chapters}>
            {p.chapters.map((c) => (
              <Chip key={c.pageIndex} label={c.label} active={c === currentChapter} onPress={() => p.onJump(c.pageIndex)} />
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.navRow}>
          <Pressable onPress={p.onPrev} hitSlop={10} style={styles.navButton}>
            <Text style={styles.navText}>{p.rtl ? '›' : '‹'} Prev</Text>
          </Pressable>
          <Text style={styles.counter}>
            {p.pageIndex + 1} / {p.pageCount}
            {p.panelInfo ? `  ·  ${p.panelInfo}` : ''}
          </Text>
          <Pressable onPress={p.onNext} hitSlop={10} style={styles.navButton}>
            <Text style={styles.navText}>Next {p.rtl ? '‹' : '›'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.overlay, paddingHorizontal: 12 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 10, gap: 8 },
  titles: { flex: 1 },
  title: { color: colors.text, fontWeight: '600', fontSize: 15 },
  subtitle: { color: colors.muted, fontSize: 12 },
  iconButton: { paddingHorizontal: 6 },
  icon: { color: colors.text, fontSize: 26, lineHeight: 30 },
  iconActive: { color: colors.accent },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: colors.accentText },
  chapters: { gap: 8, paddingVertical: 2 },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { paddingHorizontal: 12, paddingVertical: 8 },
  navText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  counter: { color: colors.muted, fontSize: 13 },
});
