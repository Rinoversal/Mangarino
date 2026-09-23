import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, StyleSheet } from 'react-native';

import { PageRow } from '@/db/repo';
import { useReaderPages } from '@/store/reader';

import { ZoomablePage } from './ZoomablePage';

export interface PagerHandle {
  goTo: (pageIndex: number, animated?: boolean) => void;
}

export interface PagedReaderProps {
  pages: PageRow[];
  initialIndex: number;
  rtl: boolean;
  width: number;
  height: number;
  onIndexChange: (pageIndex: number) => void;
  onSingleTap: (xFrac: number, yFrac: number) => void;
  onRetry: (pageIndex: number) => void;
  onLoaded?: (pageIndex: number, w: number, h: number) => void;
}

function PageCell({
  index,
  width,
  height,
  onZoomChange,
  onSingleTap,
  onRetry,
  onLoaded,
}: {
  index: number;
  width: number;
  height: number;
  onZoomChange: (z: boolean) => void;
  onSingleTap: (x: number, y: number) => void;
  onRetry: (i: number) => void;
  onLoaded?: (i: number, w: number, h: number) => void;
}) {
  const uri = useReaderPages((s) => s.pageUris[index]);
  const error = useReaderPages((s) => s.errors[index]);
  const retry = useCallback(() => onRetry(index), [onRetry, index]);
  const loaded = useCallback((w: number, h: number) => onLoaded?.(index, w, h), [onLoaded, index]);
  return (
    <ZoomablePage
      uri={uri}
      error={error}
      width={width}
      height={height}
      label={`Page ${index + 1}`}
      onZoomChange={onZoomChange}
      onSingleTap={onSingleTap}
      onRetry={retry}
      onLoaded={loaded}
    />
  );
}

/**
 * Horizontal pager. RTL is done by reversing the data (not the `inverted` transform),
 * so list index = n-1-page in RTL and page 0 sits at the right end.
 */
export const PagedReader = forwardRef<PagerHandle, PagedReaderProps>(function PagedReader(
  { pages, initialIndex, rtl, width, height, onIndexChange, onSingleTap, onRetry, onLoaded },
  ref,
) {
  const listRef = useRef<FlatList<number>>(null);
  const [zoomed, setZoomed] = useState(false);
  const n = pages.length;
  const data = useMemo(() => {
    const idx = pages.map((_, i) => i);
    return rtl ? idx.reverse() : idx;
  }, [pages, rtl]);
  const toList = useCallback((page: number) => (rtl ? n - 1 - page : page), [rtl, n]);
  const fromList = useCallback((li: number) => (rtl ? n - 1 - li : li), [rtl, n]);

  useImperativeHandle(
    ref,
    () => ({
      goTo: (pageIndex, animated = true) => {
        if (pageIndex < 0 || pageIndex >= n) return;
        listRef.current?.scrollToIndex({ index: toList(pageIndex), animated });
      },
    }),
    [toList, n],
  );

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const li = Math.round(e.nativeEvent.contentOffset.x / width);
      const page = fromList(Math.max(0, Math.min(n - 1, li)));
      onIndexChange(page);
    },
    [width, fromList, n, onIndexChange],
  );

  return (
    <FlatList
      ref={listRef}
      key={`${width}x${height}x${rtl ? 'r' : 'l'}`}
      data={data}
      horizontal
      pagingEnabled
      scrollEnabled={!zoomed}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(i) => String(i)}
      initialScrollIndex={toList(Math.max(0, Math.min(n - 1, initialIndex)))}
      getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
      windowSize={3}
      initialNumToRender={1}
      maxToRenderPerBatch={2}
      removeClippedSubviews
      onMomentumScrollEnd={onMomentumEnd}
      onScrollToIndexFailed={() => {}}
      style={styles.list}
      renderItem={({ item }) => (
        <PageCell
          index={item}
          width={width}
          height={height}
          onZoomChange={setZoomed}
          onSingleTap={onSingleTap}
          onRetry={onRetry}
          onLoaded={onLoaded}
        />
      )}
    />
  );
});

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#000' },
});
