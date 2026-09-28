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
  /** The page's image file is gone (Android cleared it): unpack it again. */
  onPageMissing?: (pageIndex: number) => void;
}

const FIT_MARGIN = 0.96;
const MAX_PAGE_FIT_MULTIPLE = 3;
const MOVE_MS = 280;
const FADE_MS = 140;
/** A page turn crossfades from the page being left to the new one, once the new one has loaded. */
const CROSSFADE_MS = 220;
const READY_TIMEOUT_MS = 1500; // show the new page anyway if its image never reports it loaded
const MAX_RELOADS = 3;

/** The page being left, frozen where it was, drawn under the new page until the crossfade ends. */
interface Outgoing {
  uri: string;
  w: number;
  h: number;
  t: { s: number; tx: number; ty: number };
  rect: PanelRect;
  masked: boolean;
}
/** Extra room kept around each panel, as a fraction of the page's shorter side, so art and
 * speech bubbles touching the panel border are not clipped or dimmed. Panels from 1.1.1's
 * panelizer (they have a frame) already grew over their balloons, so they need less, and more
 * would show slivers of the neighbouring panel's lettering. */
const FOCUS_PAD_FRAC = 0.02;
const FOCUS_PAD_FRAC_GROWN = 0.01;

function padRect(rect: PanelRect, imgW: number, imgH: number): PanelRect {
  const pad = (rect.frame ? FOCUS_PAD_FRAC_GROWN : FOCUS_PAD_FRAC) * Math.min(imgW, imgH);
  const x1 = Math.max(0, rect.x - pad);
  const y1 = Math.max(0, rect.y - pad);
  const x2 = Math.min(imgW, rect.x + rect.w + pad);
  const y2 = Math.min(imgH, rect.y + rect.h + pad);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

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
  { pages, initialPage, initialPanel, rtl, width, height, onPositionChange, onSingleTap, onVerticalSwipe, onEndReached, onPageMissing },
  ref,
) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [panelIndex, setPanelIndex] = useState(initialPanel);
  const [fullPage, setFullPage] = useState(false);
  const page = pages[pageIndex];
  const uri = useReaderPages((s) => s.pageUris[pageIndex]);
  const version = useReaderPages((s) => s.versions[pageIndex] ?? 0);
  const nextUri = useReaderPages((s) => s.pageUris[pageIndex + 1]);
  const error = useReaderPages((s) => s.errors[pageIndex]);
  // Re-sorted for the current direction: panel order in the archive is fixed at panelize time.
  const panels = useMemo(() => parsePagePanels(page?.panels_json ?? null, rtl), [page, rtl]);
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
  const lastView = useRef<{ t: Outgoing['t']; rect: PanelRect; masked: boolean } | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const outOpacity = useSharedValue(1);
  const outTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [forced, setForced] = useState<string | null>(null);
  const imageReady = !!uri && (loadedDims?.uri === uri || forced === uri);

  useEffect(() => {
    if (!uri) return;
    const id = setTimeout(() => setForced(uri), READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [uri]);
  useEffect(() => () => {
    if (outTimer.current) clearTimeout(outTimer.current);
  }, []);
  // Warm up the next page so turning to it is instant.
  useEffect(() => {
    if (nextUri) Image.prefetch(nextUri, 'memory').catch(() => {});
  }, [nextUri]);
  // The new page failed to unpack: stop holding the old one so the error shows.
  useEffect(() => {
    if (error) setOutgoing(null);
  }, [error]);

  const clampPanel = useCallback(
    (pi: number, count: number) => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, pi))),
    [],
  );

  const goToPage = useCallback(
    (nextPage: number, nextPanel: number) => {
      if (nextPage < 0 || nextPage >= pages.length) return;
      // Keep the page being left on screen (unless it never showed) until the new one is ready.
      if (!pageChanged.current && uri && imgW && imgH && lastView.current) {
        if (outTimer.current) clearTimeout(outTimer.current);
        setOutgoing({ uri, w: imgW, h: imgH, ...lastView.current });
        outOpacity.value = 1;
      }
      pageChanged.current = true;
      opacity.value = 0;
      setFullPage(false);
      setPageIndex(nextPage);
      setPanelIndex(nextPanel);
    },
    [pages.length, opacity, outOpacity, uri, imgW, imgH],
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

  // Animate to the current panel whenever the target changes. After a page turn the new page
  // waits until its image has loaded, then crossfades in over the page being left.
  useEffect(() => {
    if (!imgW || !imgH || !uri) return;
    const masked = !(fullPage || panels.length === 0);
    const rect: PanelRect = masked
      ? padRect(panels[clampPanel(panelIndex, panels.length)], imgW, imgH)
      : { x: 0, y: 0, w: imgW, h: imgH };
    const t = fitTarget(rect, imgW, imgH, width, height);
    if (pageChanged.current) {
      if (!imageReady) return;
      pageChanged.current = false;
      lastView.current = { t, rect, masked };
      tx.value = t.tx;
      ty.value = t.ty;
      scale.value = t.s;
      rx.value = rect.x;
      ry.value = rect.y;
      rw.value = rect.w;
      rh.value = rect.h;
      opacity.value = withTiming(1, { duration: CROSSFADE_MS });
      outOpacity.value = withTiming(0, { duration: CROSSFADE_MS });
      if (outTimer.current) clearTimeout(outTimer.current);
      outTimer.current = setTimeout(() => setOutgoing(null), CROSSFADE_MS + 60);
      return;
    }
    lastView.current = { t, rect, masked };
    const cfg = { duration: MOVE_MS, easing: Easing.out(Easing.cubic) };
    tx.value = withTiming(t.tx, cfg);
    ty.value = withTiming(t.ty, cfg);
    scale.value = withTiming(t.s, cfg);
    rx.value = withTiming(rect.x, cfg);
    ry.value = withTiming(rect.y, cfg);
    rw.value = withTiming(rect.w, cfg);
    rh.value = withTiming(rect.h, cfg);
    opacity.value = withTiming(1, { duration: FADE_MS });
  }, [imgW, imgH, uri, imageReady, fullPage, panels, panelIndex, width, height, clampPanel, tx, ty, scale, opacity, outOpacity, rx, ry, rw, rh]);

  const stageStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const outStyle = useAnimatedStyle(() => ({ opacity: outOpacity.value }));

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
  // The page file can vanish after it was written (Android clears app caches when storage runs
  // low): unpack it again (a few times at most) instead of showing black.
  const reloads = useRef(new Map<string, number>());
  const onImageError = useCallback(() => {
    if (!uri) return;
    const n = reloads.current.get(uri) ?? 0;
    if (n >= MAX_RELOADS) return;
    reloads.current.set(uri, n + 1);
    onPageMissing?.(pageIndex);
  }, [uri, pageIndex, onPageMissing]);

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.viewport, { width, height }]}>
        {outgoing ? <OutgoingPage page={outgoing} outlineColor={outlineColor} style={outStyle} /> : null}
        {uri && imgW && imgH ? (
          <Animated.View style={[styles.stage, { width: imgW, height: imgH }, stageStyle]}>
            <Image
              key={`${uri}#${version}`}
              source={{ uri }}
              style={{ width: imgW, height: imgH }}
              contentFit="fill"
              allowDownscaling={false}
              cachePolicy="memory"
              transition={0}
              recyclingKey={uri}
              onLoad={onLoad}
              onError={onImageError}
            />
            <Animated.View pointerEvents="none" style={[styles.mask, maskTop]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskBottom]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskLeft]} />
            <Animated.View pointerEvents="none" style={[styles.mask, maskRight]} />
            <Animated.View pointerEvents="none" style={[styles.outline, { borderColor: outlineColor }, outline]} />
          </Animated.View>
        ) : uri ? (
          // Dimensions unknown: mount a hidden image to learn them.
          <Image key={`${uri}#${version}`} source={{ uri }} style={styles.probe} onLoad={onLoad} onError={onImageError} cachePolicy="memory" />
        ) : null}
        {(!uri || !imgW || !imgH) && !outgoing ? (
          <View style={styles.center} pointerEvents="none">
            {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color="#888" />}
            <Text style={styles.label}>Page {pageIndex + 1}</Text>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
});

/** The page being left, frozen where it was (with its dimming), under the page turned to. */
function OutgoingPage({ page, outlineColor, style }: { page: Outgoing; outlineColor: string; style: object }) {
  const { w, h, t, rect } = page;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.stage,
        { width: w, height: h, transform: [{ translateX: t.tx }, { translateY: t.ty }, { scale: t.s }] },
        style,
      ]}>
      <Image source={{ uri: page.uri }} style={{ width: w, height: h }} contentFit="fill" allowDownscaling={false} cachePolicy="memory" transition={0} />
      {page.masked ? (
        <>
          <View style={[styles.mask, { left: 0, top: 0, width: w, height: Math.max(0, rect.y) }]} />
          <View style={[styles.mask, { left: 0, top: rect.y + rect.h, width: w, height: Math.max(0, h - rect.y - rect.h) }]} />
          <View style={[styles.mask, { left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }]} />
          <View style={[styles.mask, { left: rect.x + rect.w, top: rect.y, width: Math.max(0, w - rect.x - rect.w), height: rect.h }]} />
          <View style={[styles.outline, { borderColor: outlineColor, left: rect.x, top: rect.y, width: rect.w, height: rect.h }]} />
        </>
      ) : null}
    </Animated.View>
  );
}

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
