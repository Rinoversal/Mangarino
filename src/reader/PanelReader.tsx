import { Image, ImageLoadEventData } from 'expo-image';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Directions, Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { PageRow } from '@/db/repo';
import { PanelRect, parsePagePanels } from '@/library/panels';
import { useReaderPages } from '@/store/reader';
import { panelOutlineColor, useSettings } from '@/store/settings';

export interface PanelHandle {
  next: () => void;
  prev: () => void;
  toggleFullPage: () => void;
}

export interface PanelReaderProps {
  pages: PageRow[];
  initialPage: number;
  initialPanel: number;
  rtl: boolean;
  width: number;
  height: number;
  onPositionChange: (pageIndex: number, panelIndex: number) => void;
  onSingleTap: (xFrac: number, yFrac: number) => void;
  onVerticalSwipe?: () => void;
  onEndReached: () => void;
}

const FIT_MARGIN = 0.96;
const MAX_PAGE_FIT_MULTIPLE = 3;
const MOVE_MS = 280;
const FADE_MS = 140;

function fitTarget(rect: PanelRect, imgW: number, imgH: number, vw: number, vh: number) {
  let s = Math.min(vw / rect.w, vh / rect.h) * FIT_MARGIN;
  s = Math.min(s, MAX_PAGE_FIT_MULTIPLE * Math.min(vw / imgW, vh / imgH));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    s,
    tx: vw / 2 - imgW / 2 - (cx - imgW / 2) * s,
    ty: vh / 2 - imgH / 2 - (cy - imgH / 2) * s,
  };
}

/** Guided view: animates translate/scale so each precomputed panel fills the viewport. */
export const PanelReader = forwardRef<PanelHandle, PanelReaderProps>(function PanelReader(
  { pages, initialPage, initialPanel, rtl, width, height, onPositionChange, onSingleTap, onVerticalSwipe, onEndReached },
  ref,
) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [panelIndex, setPanelIndex] = useState(initialPanel);
  const [fullPage, setFullPage] = useState(false);
  const page = pages[pageIndex];
  const uri = useReaderPages((s) => s.pageUris[pageIndex]);
  const error = useReaderPages((s) => s.errors[pageIndex]);
  const panels = useMemo(() => parsePagePanels(page?.panels_json ?? null), [page]);
  const outlineColor = useSettings((s) => panelOutlineColor(s.settings.panelOutline));
  const [loadedDims, setLoadedDims] = useState<{ w: number; h: number; uri: string } | null>(null);
  const imgW = page?.width ?? (loadedDims?.uri === uri ? loadedDims.w : null);
  const imgH = page?.height ?? (loadedDims?.uri === uri ? loadedDims.h : null);

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  // Current panel rect in image pixels, animated alongside the stage so the dimming mask follows it.
  const rx = useSharedValue(0);
  const ry = useSharedValue(0);
  const rw = useSharedValue(1);
  const rh = useSharedValue(1);
  const pageChanged = useRef(false);

  const clampPanel = useCallback(
    (pi: number, count: number) => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, pi))),
    [],
  );

  const goToPage = useCallback(
    (nextPage: number, nextPanel: number) => {
      if (nextPage < 0 || nextPage >= pages.length) return;
      pageChanged.current = true;
      opacity.value = withTiming(0, { duration: FADE_MS });
      setFullPage(false);
      setPageIndex(nextPage);
      setPanelIndex(nextPanel);
    },
    [pages.length, opacity],
  );

  const next = useCallback(() => {
    if (fullPage) {
      setFullPage(false);
      return;
    }
    if (panelIndex + 1 < panels.length) {
      setPanelIndex(panelIndex + 1);
      return;
    }
    if (pageIndex + 1 >= pages.length) {
      onEndReached();
      return;
    }
    goToPage(pageIndex + 1, 0);
  }, [fullPage, panelIndex, panels.length, pageIndex, pages.length, goToPage, onEndReached]);

  const prev = useCallback(() => {
    if (fullPage) {
      setFullPage(false);
      return;
    }
    if (panelIndex > 0) {
      setPanelIndex(panelIndex - 1);
      return;
    }
    if (pageIndex === 0) return;
    const prevPanels = parsePagePanels(pages[pageIndex - 1]?.panels_json ?? null);
    goToPage(pageIndex - 1, Math.max(0, prevPanels.length - 1));
  }, [fullPage, panelIndex, pageIndex, pages, goToPage]);

  const toggleFullPage = useCallback(() => setFullPage((f) => !f), []);

  useImperativeHandle(ref, () => ({ next, prev, toggleFullPage }), [next, prev, toggleFullPage]);

  useEffect(() => {
    onPositionChange(pageIndex, clampPanel(panelIndex, panels.length));
  }, [pageIndex, panelIndex, panels.length, clampPanel, onPositionChange]);

  // Animate to the current panel whenever the target changes.
  useEffect(() => {
    if (!imgW || !imgH || !uri) return;
    const rect: PanelRect =
      fullPage || panels.length === 0 ? { x: 0, y: 0, w: imgW, h: imgH } : panels[clampPanel(panelIndex, panels.length)];
    const t = fitTarget(rect, imgW, imgH, width, height);
    if (pageChanged.current) {
      pageChanged.current = false;
      tx.value = t.tx;
      ty.value = t.ty;
      scale.value = t.s;
      rx.value = rect.x;
      ry.value = rect.y;
      rw.value = rect.w;
      rh.value = rect.h;
      opacity.value = withTiming(1, { duration: FADE_MS });
      return;
    }
    const cfg = { duration: MOVE_MS, easing: Easing.out(Easing.cubic) };
    tx.value = withTiming(t.tx, cfg);
    ty.value = withTiming(t.ty, cfg);
    scale.value = withTiming(t.s, cfg);
    rx.value = withTiming(rect.x, cfg);
    ry.value = withTiming(rect.y, cfg);
    rw.value = withTiming(rect.w, cfg);
    rh.value = withTiming(rect.h, cfg);
    opacity.value = withTiming(1, { duration: FADE_MS });
  }, [imgW, imgH, uri, fullPage, panels, panelIndex, width, height, clampPanel, tx, ty, scale, opacity, rx, ry, rw, rh]);

  const stageStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // Dimming mask: four rectangles around the current panel, in image coordinates inside the stage.
  const stageW = imgW ?? 1;
  const stageH = imgH ?? 1;
  const maskTop = useAnimatedStyle(() => ({ left: 0, top: 0, width: stageW, height: Math.max(0, ry.value) }));
  const maskBottom = useAnimatedStyle(() => ({
    left: 0,
    top: ry.value + rh.value,
    width: stageW,
    height: Math.max(0, stageH - (ry.value + rh.value)),
  }));
  const maskLeft = useAnimatedStyle(() => ({ left: 0, top: ry.value, width: Math.max(0, rx.value), height: rh.value }));
  const maskRight = useAnimatedStyle(() => ({
    left: rx.value + rw.value,
    top: ry.value,
    width: Math.max(0, stageW - (rx.value + rw.value)),
    height: rh.value,
  }));
  const outline = useAnimatedStyle(() => ({
    left: rx.value,
    top: ry.value,
    width: rw.value,
    height: rh.value,
    opacity: fullPage || panels.length === 0 ? 0 : 1,
  }));

  const tapCb = useCallback((x: number, y: number) => onSingleTap(x, y), [onSingleTap]);
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .onEnd((e) => {
      scheduleOnRN(tapCb, e.x / width, e.y / height);
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .onEnd(() => {
      scheduleOnRN(toggleFullPage);
    });
  const flingNext = Gesture.Fling()
    .direction(rtl ? Directions.RIGHT : Directions.LEFT)
    .onEnd(() => {
      scheduleOnRN(next);
    });
  const flingPrev = Gesture.Fling()
    .direction(rtl ? Directions.LEFT : Directions.RIGHT)
    .onEnd(() => {
      scheduleOnRN(prev);
    });
  const swipe = useCallback(() => {
    onVerticalSwipe?.();
  }, [onVerticalSwipe]);
  const flingVertical = Gesture.Fling()
    .direction(Directions.UP | Directions.DOWN)
    .onEnd(() => {
      scheduleOnRN(swipe);
    });
  const composed = Gesture.Race(flingNext, flingPrev, flingVertical, Gesture.Exclusive(doubleTap, singleTap));

  const onLoad = useCallback(
    (e: ImageLoadEventData) => {
      const s = e.source;
      if (s && s.width && s.height && uri) setLoadedDims({ w: s.width, h: s.height, uri });
    },
    [uri],
  );

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.viewport, { width, height }]}>
        {uri && imgW && imgH ? (
          <Animated.View style={[styles.stage, { width: imgW, height: imgH }, stageStyle]}>
            <Image
              source={{ uri }}
              style={{ width: imgW, height: imgH }}
              contentFit="fill"
              allowDownscaling={false}
              cachePolicy="none"
              transition={0}
              recyclingKey={uri}
              onLoad={onLoad}
            />
            <Animated.View pointerEvents="none" style={[styles.mask, maskTop]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskBottom]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskLeft]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskRight]} />
            <Animated.View pointerEvents="none" style={[styles.outline, { borderColor: outlineColor }, outline]} />
          </Animated.View>
        ) : uri ? (
          // Dimensions unknown: mount a hidden image to learn them.
          <Image source={{ uri }} style={styles.probe} onLoad={onLoad} cachePolicy="none" />
        ) : null}
        {!uri || !imgW || !imgH ? (
          <View style={styles.center} pointerEvents="none">
            {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color="#888" />}
            <Text style={styles.label}>Page {pageIndex + 1}</Text>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  viewport: { backgroundColor: '#000', overflow: 'hidden' },
  stage: { position: 'absolute', left: 0, top: 0 },
  mask: { position: 'absolute', backgroundColor: 'rgba(4,8,20,0.82)' },
  outline: { position: 'absolute', borderWidth: 6, borderRadius: 4 },
  probe: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  center: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  label: { color: '#666' },
  error: { color: '#e66', paddingHorizontal: 24, textAlign: 'center' },
});
