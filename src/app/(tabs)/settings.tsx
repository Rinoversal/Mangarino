import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { APP_NAME, HUB_NAME } from '@/brand';
import { clearPageCache, pageCacheSizeBytes } from '@/cache/pageCache';
import { PANEL_OUTLINE_SWATCHES, ReaderMode, ReadingDirection, useSettings } from '@/store/settings';
import { readableColumn, useLayout } from '@/ui/layout';
import { colors, radius, spacing } from '@/ui/theme';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/**
 * One settings row: label and hint on the left, control on the right. A `wide` control (button
 * groups, swatches) drops below the label on phone-width screens instead of squeezing it.
 */
function Row({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  const { compact } = useLayout();
  const stacked = wide && compact;
  return (
    <View style={[styles.row, stacked && styles.rowStacked]}>
      <View style={[styles.rowText, stacked && styles.rowTextStacked]}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={[styles.segment, o.value === value && styles.segmentActive]}>
          <Text style={[styles.segmentText, o.value === value && styles.segmentTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Swatches({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const { compact } = useLayout();
  return (
    <View style={[styles.swatches, !compact && styles.swatchesBeside]}>
      {options.map((o) => {
        const active = o.value.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: active }}
            style={[styles.swatchRing, active && styles.swatchRingActive]}>
            <View style={[styles.swatch, { backgroundColor: o.value }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const { settings, set } = useSettings();
  const [cacheMB, setCacheMB] = useState<number | null>(null);

  const refreshCache = useCallback(async () => {
    const bytes = await pageCacheSizeBytes();
    setCacheMB(Math.round(bytes / 1048576));
  }, []);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={[styles.content, readableColumn]}>
        <Text style={styles.h1}>Settings</Text>

        <Section title="Reading">
          <Row wide label="Reading direction" hint="Manga reads right to left, Western comics left to right. Swipes and tap zones follow this.">
            <Segmented<ReadingDirection>
              value={settings.readingDirection}
              options={[
                { value: 'rtl', label: 'Manga' },
                { value: 'ltr', label: 'Western' },
              ]}
              onChange={(v) => void set('readingDirection', v)}
            />
          </Row>
          <Row wide label="Default mode" hint={`Panels needs volumes that went through ${HUB_NAME} on your PC.`}>
            <Segmented<ReaderMode>
              value={settings.defaultMode === 'vertical' ? 'page' : settings.defaultMode}
              options={[
                { value: 'page', label: 'Page' },
                { value: 'panel', label: 'Panels' },
              ]}
              onChange={(v) => void set('defaultMode', v)}
            />
          </Row>
          <Row wide label="Panel outline" hint="Colour of the box drawn around the current panel in panel mode.">
            <Swatches value={settings.panelOutline} options={PANEL_OUTLINE_SWATCHES} onChange={(v) => void set('panelOutline', v)} />
          </Row>
          <Row label="Tap zones" hint="Tap the left or right third of the screen to turn pages. Centre shows the controls.">
            <Switch value={settings.tapZones} onValueChange={(v) => void set('tapZones', v)} trackColor={{ true: colors.accent }} />
          </Row>
          <Row label="Show page number">
            <Switch value={settings.showPageNumber} onValueChange={(v) => void set('showPageNumber', v)} trackColor={{ true: colors.accent }} />
          </Row>
          <Row label="Keep screen awake while reading">
            <Switch value={settings.keepAwake} onValueChange={(v) => void set('keepAwake', v)} trackColor={{ true: colors.accent }} />
          </Row>
        </Section>

        <Section title="Storage">
          <Row wide label="Page cache limit" hint="Extracted pages are kept on disk so re-reading is instant.">
            <Segmented<string>
              value={String(settings.cacheCapMB)}
              options={[
                { value: '100', label: '100 MB' },
                { value: '200', label: '200 MB' },
                { value: '500', label: '500 MB' },
                { value: '1000', label: '1 GB' },
              ]}
              onChange={(v) => void set('cacheCapMB', Number(v))}
            />
          </Row>
          <Row label="Clear page cache" hint={cacheMB === null ? '' : `${cacheMB} MB in use`}>
            <Pressable
              onPress={async () => {
                await clearPageCache();
                await refreshCache();
              }}
              style={styles.button}>
              <Text style={styles.buttonText}>Clear</Text>
            </Pressable>
          </Row>
          <Row label="Library folder" hint={settings.libraryRoot}>
            <Pressable onPress={() => router.push('/sources')} style={styles.button}>
              <Text style={styles.buttonText}>Sources</Text>
            </Pressable>
          </Row>
        </Section>

        <Section title="About">
          <Row
            label={APP_NAME}
            hint={`Reads CBZ and image folders in place. Panel detection by the ${APP_NAME} panelizer (YOLO26n model by Leandro Narosky, trained on Manga109-s). Made by Carterino, Rinoversal.`}
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  h1: { color: colors.text, fontSize: 28, fontWeight: '700' },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: spacing.sm },
  rowText: { flex: 1, gap: 2 },
  rowTextStacked: { flex: 0, alignSelf: 'stretch' },
  label: { color: colors.text, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.bg, borderRadius: radius.md, padding: 3 },
  segment: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  segmentTextActive: { color: colors.accentText },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatchesBeside: { width: 136, justifyContent: 'flex-end' },
  swatchRing: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  swatchRingActive: { borderColor: colors.text },
  swatch: { width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.bg },
  buttonText: { color: colors.text, fontWeight: '600' },
});
