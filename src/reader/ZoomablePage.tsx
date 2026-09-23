import { Image, ImageLoadEventData } from 'expo-image';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Directions, Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withDecay, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

export interface ZoomablePageProps {
  uri?: string;
  error?: string;
  width: number;
  height: number;
  label?: string;
  doubleTapScale?: number;
  maxScale?: number;
  onZoomChange?: (zoomed: boolean) => void;
  onSingleTap?: (xFrac: number, yFrac: number) => void;
  /** Vertical swipe (up or down) while not zoomed; used to toggle the reader menu. */
  onVerticalSwipe?: () => void;
  onRetry?: () => void;
  onLoaded?: (w: number, h: number) => void;
}

function clampT(v: number, scale: number, size: number): number {
  'worklet';
  const max = (size * (scale - 1)) / 2;
  if (max <= 0) return 0;
  return Math.min(max, Math.max(-max, v));
}

/** One page: pinch/pan/double-tap zoom, single-tap callback. Pan is enabled only while zoomed so the pager scrolls otherwise. */
export function ZoomablePage({
  uri,
  error,
  width,
  height,
  label,
  doubleTapScale = 2.5,
  maxScale = 5,
  onZoomChange,
  onSingleTap,
  onVerticalSwipe,
  onRetry,
  onLoaded,
}: ZoomablePageProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const [zoomed, setZoomedState] = useState(false);

  const setZoomed = useCallback(
    (z: boolean) => {
      setZoomedState(z);
      onZoomChange?.(z);
    },
    [onZoomChange],
  );

  const tap = useCallback(
    (x: number, y: number) => {
      onSingleTap?.(x, y);
    },
    [onSingleTap],
  );

  useEffect(() => {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    setZoomedState(false);
    onZoomChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, width, height]);

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      focalX.value = e.focalX - width / 2;
      focalY.value = e.focalY - height / 2;
    })
    .onUpdate((e) => {
      const s = Math.min(maxScale, Math.max(1, savedScale.value * e.scale));
      scale.value = s;
      const k = s / savedScale.value;
      tx.value = focalX.value - (focalX.value - savedTx.value) * k;
      ty.value = focalY.value - (focalY.value - savedTy.value) * k;
    })
    .onEnd(() => {
      if (scale.value < 1.05) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        scheduleOnRN(setZoomed, false);
      } else {
        tx.value = withTiming(clampT(tx.value, scale.value, width));
        ty.value = withTiming(clampT(ty.value, scale.value, height));
        scheduleOnRN(setZoomed, true);
      }
    });

  const pan = Gesture.Pan()
    .enabled(zoomed)
    .minPointers(1)
    .maxPointers(2)
    .onStart(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    })
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      tx.value = clampT(savedTx.value + e.translationX, scale.value, width);
      ty.value = clampT(savedTy.value + e.translationY, scale.value, height);
    })
    .onEnd((e) => {
      if (scale.value <= 1) return;
      const maxX = (width * (scale.value - 1)) / 2;
      const maxY = (height * (scale.value - 1)) / 2;
      tx.value = withDecay({ velocity: e.velocityX, clamp: [-maxX, maxX] });
      ty.value = withDecay({ velocity: e.velocityY, clamp: [-maxY, maxY] });
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .onEnd((e) => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        scheduleOnRN(setZoomed, false);
      } else {
        const s = doubleTapScale;
        const fx = e.x - width / 2;
        const fy = e.y - height / 2;
        scale.value = withTiming(s);
        tx.value = withTiming(clampT(fx - fx * s, s, width));
        ty.value = withTiming(clampT(fy - fy * s, s, height));
        scheduleOnRN(setZoomed, true);
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .onEnd((e) => {
      scheduleOnRN(tap, e.x / width, e.y / height);
    });

  const swipe = useCallback(() => {
    onVerticalSwipe?.();
  }, [onVerticalSwipe]);

  const verticalFling = Gesture.Fling()
    .enabled(!zoomed)
    .direction(Directions.UP | Directions.DOWN)
    .onEnd(() => {
      scheduleOnRN(swipe);
    });

  const composed = Gesture.Race(
    Gesture.Simultaneous(pinch, pan),
    verticalFling,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const handleLoad = useCallback(
    (e: ImageLoadEventData) => {
      const src = e.source;
      if (src && src.width && src.height) onLoaded?.(src.width, src.height);
    },
    [onLoaded],
  );

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[{ width, height }, styles.page, animatedStyle]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.fill}
            contentFit="contain"
            recyclingKey={uri}
            cachePolicy="none"
            transition={0}
            onLoad={handleLoad}
          />
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>{error}</Text>
            {onRetry ? (
              <Pressable onPress={onRetry} style={styles.retry}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color="#888" />
            {label ? <Text style={styles.label}>{label}</Text> : null}
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#000', overflow: 'hidden' },
  fill: { width: '100%', height: '100%' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  label: { color: '#666', fontSize: 14 },
  errorText: { color: '#e66', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retry: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#222' },
  retryText: { color: '#fff' },
});
