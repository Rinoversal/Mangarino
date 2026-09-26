import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { NavigationBar } from 'expo-navigation-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { PageLoader } from '@/cache/pageLoader';
import {
  ArchiveRow,
  PageRow,
  SeriesRow,
  addBookmark,
  closeHistory,
  getArchive,
  getPages,
  getProgress,
  getSeries,
  getZipEntries,
  listArchiveBookmarks,
  listArchives,
  openHistory,
  removeBookmark,
  saveProgress,
} from '@/db/repo';
import { archiveLabel } from '@/library/parse';
import { PagedReader, PagerHandle } from '@/reader/PagedReader';
import { PanelHandle, PanelReader } from '@/reader/PanelReader';
import { ChapterMark, ReaderChrome } from '@/reader/ReaderChrome';
import { useReaderPages } from '@/store/reader';
import { usePcSync } from '@/store/pcSync';
import { ReaderMode, useSettings } from '@/store/settings';
import { colors } from '@/ui/theme';

const MB = 1024 * 1024;
const SAVE_DEBOUNCE_MS = 400;

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ archiveId: string; page?: string; panel?: string; mode?: string }>();
  const archiveId = Number(params.archiveId);
  const settings = useSettings((s) => s.settings);
  const { width, height } = useWindowDimensions();

  const [archive, setArchive] = useState<ArchiveRow | null>(null);
  const [series, setSeries] = useState<SeriesRow | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [current, setCurrent] = useState(0);
  const [currentPanel, setCurrentPanel] = useState(0);
  const [panelStart, setPanelStart] = useState(0);
  const [mode, setMode] = useState<ReaderMode>('page');
  const [rtl, setRtl] = useState(settings.readingDirection === 'rtl');
  const [chrome, setChrome] = useState(false);
  const [bookmarks, setBookmarks] = useState<Set<number>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loaderRef = useRef<PageLoader | null>(null);
  const pagerRef = useRef<PagerHandle>(null);
  const panelRef = useRef<PanelHandle>(null);
  const archiveRef = useRef<ArchiveRow | null>(null);
  const pagesRef = useRef<PageRow[]>([]);
  const modeRef = useRef<ReaderMode>('page');
  const historyRef = useRef<number | null>(null);
  const positionRef = useRef({ page: 0, panel: 0 });
  const openedRef = useRef({ page: 0, panel: 0 }); // where this volume opened
  const movedRef = useRef(false); // the reader has left that position: its saves are real reads
  const startRef = useRef(0);
  const lastPageRef = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  modeRef.current = mode;

  const flushProgress = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const a = archiveRef.current;
    if (!a) return;
    const { page, panel } = positionRef.current;
    const opened = openedRef.current;
    if (!movedRef.current && page === opened.page && (modeRef.current !== 'panel' || panel === opened.panel)) {
      return; // nothing read: don't overwrite a newer position (from the PC) with this one
    }
    movedRef.current = true;
    const completed = page >= pagesRef.current.length - 1;
    void saveProgress(a.series_id, a.id, page, modeRef.current === 'panel' ? panel : null, completed);
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushProgress, SAVE_DEBOUNCE_MS);
  }, [flushProgress]);

  // Load archive, pages, progress; open the page loader.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoadError(null);
    setNotice(null);
    useReaderPages.getState().reset();
    (async () => {
      try {
        const a = await getArchive(archiveId);
        if (!a) throw new Error('Archive not found');
        const [s, p, prog, bms] = await Promise.all([
          getSeries(a.series_id),
          getPages(archiveId),
          getProgress(archiveId),
          listArchiveBookmarks(archiveId),
        ]);
        const entries = a.kind === 'cbz' ? await getZipEntries(archiveId) : [];
        if (p.length === 0) {
          throw new Error(a.error ? `This archive could not be indexed: ${a.error}` : 'No pages found in this archive');
        }
        let start = params.page !== undefined ? Number(params.page) : prog ? prog.page_index : 0;
        if (params.page === undefined && prog?.completed && prog.page_index >= p.length - 1) start = 0;
        start = Math.max(0, Math.min(p.length - 1, Number.isFinite(start) ? start : 0));
        const panel = params.panel !== undefined ? Number(params.panel) : (prog?.panel_index ?? 0);
        const requested = params.mode as ReaderMode | undefined;
        let m: ReaderMode = requested ?? settings.defaultMode;
        if (m === 'panel' && !a.has_panels) m = 'page';
        if (m === 'vertical') m = 'page';

        const loader = new PageLoader(a, p, entries, settings.cacheCapMB * MB, {
          onPage: (i, uri) => useReaderPages.getState().setUri(i, uri),
          onError: (i, msg) => useReaderPages.getState().setError(i, msg),
        });
        await loader.open();
        if (cancelled) {
          loader.close();
          return;
        }
        loaderRef.current = loader;
        archiveRef.current = a;
        pagesRef.current = p;
        positionRef.current = { page: start, panel };
        openedRef.current = { page: start, panel };
        movedRef.current = false;
        startRef.current = start;
        lastPageRef.current = start;
        loader.setCursor(start, 1);
        historyRef.current = await openHistory(archiveId, start);

        setArchive(a);
        setSeries(s);
        setPages(p);
        setCurrent(start);
        setCurrentPanel(panel);
        setPanelStart(panel);
        setMode(m);
        setBookmarks(new Set(bms.filter((b) => b.panel_index === null).map((b) => b.page_index)));
        setReady(true);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      flushProgress();
      setTimeout(() => void usePcSync.getState().backgroundSync(true), 1500); // after the save lands
      const h = historyRef.current;
      if (h !== null) {
        void closeHistory(h, positionRef.current.page, Math.abs(positionRef.current.page - startRef.current));
        historyRef.current = null;
      }
      loaderRef.current?.close();
      loaderRef.current = null;
      archiveRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveId]);

  // Immersive system UI + keep awake while the reader is mounted.
  useEffect(() => {
    if (Platform.OS === 'android') {
      try {
        NavigationBar.setHidden(true);
      } catch {
        // edge-to-edge builds may not support this
      }
    }
    if (settings.keepAwake) activateKeepAwakeAsync('reader').catch(() => {});
    return () => {
      if (Platform.OS === 'android') {
        try {
          NavigationBar.setHidden(false);
        } catch {
          // ignore
        }
      }
      deactivateKeepAwake('reader').catch(() => {});
    };
  }, [settings.keepAwake]);

  const onIndexChange = useCallback(
    (i: number) => {
      const dir: 1 | -1 = i >= lastPageRef.current ? 1 : -1;
      lastPageRef.current = i;
      setCurrent(i);
      positionRef.current = { page: i, panel: 0 };
      loaderRef.current?.setCursor(i, dir);
      scheduleSave();
    },
    [scheduleSave],
  );

  const onPanelPosition = useCallback(
    (page: number, panel: number) => {
      const dir: 1 | -1 = page >= lastPageRef.current ? 1 : -1;
      lastPageRef.current = page;
      setCurrent(page);
      setCurrentPanel(panel);
      positionRef.current = { page, panel };
      loaderRef.current?.setCursor(page, dir);
      scheduleSave();
    },
    [scheduleSave],
  );

  const goToNextArchive = useCallback(async () => {
    const a = archiveRef.current;
    if (!a) return;
    const siblings = await listArchives(a.series_id);
    const idx = siblings.findIndex((x) => x.id === a.id);
    const next = idx >= 0 ? siblings[idx + 1] : undefined;
    positionRef.current = { page: pagesRef.current.length - 1, panel: positionRef.current.panel };
    flushProgress();
    if (next) {
      router.replace({ pathname: '/reader/[archiveId]', params: { archiveId: String(next.id), page: '0' } });
    } else {
      setNotice('End of series');
      setChrome(true);
    }
  }, [flushProgress]);

  const goNext = useCallback(() => {
    if (mode === 'panel') {
      panelRef.current?.next();
      return;
    }
    if (current + 1 < pages.length) pagerRef.current?.goTo(current + 1);
    else void goToNextArchive();
  }, [mode, current, pages.length, goToNextArchive]);

  const goPrev = useCallback(() => {
    if (mode === 'panel') {
      panelRef.current?.prev();
      return;
    }
    if (current > 0) pagerRef.current?.goTo(current - 1);
  }, [mode, current]);

  const onSingleTap = useCallback(
    (x: number) => {
      if (!settings.tapZones || (x > 0.3 && x < 0.7)) {
        setChrome((c) => !c);
        return;
      }
      const forward = rtl ? x < 0.3 : x > 0.7;
      if (forward) goNext();
      else goPrev();
    },
    [settings.tapZones, rtl, goNext, goPrev],
  );

  const onJump = useCallback(
    (pageIndex: number) => {
      if (mode === 'panel') {
        setPanelStart(0);
        setCurrent(pageIndex);
        setMode('page');
        setTimeout(() => setMode('panel'), 0);
        return;
      }
      pagerRef.current?.goTo(pageIndex, false);
      onIndexChange(pageIndex);
    },
    [mode, onIndexChange],
  );

  const toggleBookmark = useCallback(async () => {
    const a = archiveRef.current;
    if (!a) return;
    const has = bookmarks.has(current);
    if (has) await removeBookmark(a.id, current, null);
    else await addBookmark(a.id, current, null, null);
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (has) next.delete(current);
      else next.add(current);
      return next;
    });
    setNotice(has ? 'Bookmark removed' : 'Bookmarked');
  }, [bookmarks, current]);

  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const setModeFromChrome = useCallback((m: ReaderMode) => {
    setPanelStart(0);
    setMode(m);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 1500);
    return () => clearTimeout(t);
  }, [notice]);

  const chapters = useMemo<ChapterMark[]>(() => {
    const marks: ChapterMark[] = [];
    let last: number | null = null;
    pages.forEach((p, i) => {
      if (p.chapter !== null && p.chapter !== last) {
        marks.push({ label: `Ch. ${p.chapter}`, pageIndex: i });
        last = p.chapter;
      }
    });
    return marks;
  }, [pages]);

  const panelCount = useMemo(() => {
    const p = pages[current];
    if (!p?.panels_json) return 0;
    try {
      return (JSON.parse(p.panels_json) as unknown[]).length;
    } catch {
      return 0;
    }
  }, [pages, current]);

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable onPress={() => router.back()} style={styles.button}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    );
  }
  if (!ready || !archive) {
    return (
      <View style={styles.center}>
        <StatusBar hidden />
        <ActivityIndicator color="#888" size="large" />
      </View>
    );
  }

  const title = series ? (series.title_override ?? series.title) : '';
  const subtitle = archiveLabel(archive, archive.file_name);

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      {mode === 'panel' ? (
        <PanelReader
          key={`panel-${archiveId}`}
          ref={panelRef}
          pages={pages}
          initialPage={current}
          initialPanel={panelStart}
          rtl={rtl}
          width={width}
          height={height}
          onPositionChange={onPanelPosition}
          onSingleTap={onSingleTap}
          onVerticalSwipe={toggleChrome}
          onEndReached={() => void goToNextArchive()}
        />
      ) : (
        <PagedReader
          key={`page-${archiveId}`}
          ref={pagerRef}
          pages={pages}
          initialIndex={current}
          rtl={rtl}
          width={width}
          height={height}
          onIndexChange={onIndexChange}
          onSingleTap={onSingleTap}
          onVerticalSwipe={toggleChrome}
          onRetry={(i) => loaderRef.current?.retry(i)}
        />
      )}
      {settings.showPageNumber && !chrome ? (
        <Text style={styles.pageNumber} pointerEvents="none">
          {current + 1} / {pages.length}
          {mode === 'panel' && panelCount > 0 ? `  ·  ${currentPanel + 1}/${panelCount}` : ''}
        </Text>
      ) : null}
      {notice ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{notice}</Text>
        </View>
      ) : null}
      <ReaderChrome
        visible={chrome}
        title={title}
        subtitle={subtitle}
        pageIndex={current}
        pageCount={pages.length}
        panelInfo={mode === 'panel' && panelCount > 0 ? `panel ${currentPanel + 1}/${panelCount}` : undefined}
        rtl={rtl}
        mode={mode}
        hasPanels={archive.has_panels === 1}
        bookmarked={bookmarks.has(current)}
        chapters={chapters}
        onClose={() => router.back()}
        onToggleRtl={() => setRtl((r) => !r)}
        onSetMode={setModeFromChrome}
        onBookmark={() => void toggleBookmark()}
        onPrev={goPrev}
        onNext={goNext}
        onJump={onJump}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  error: { color: colors.danger, textAlign: 'center' },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.card },
  buttonText: { color: colors.text, fontWeight: '600' },
  pageNumber: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  toast: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: colors.scrim,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  toastText: { color: colors.text, fontWeight: '600' },
});
