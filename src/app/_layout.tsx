import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { APP_NAME } from '@/brand';
import { initDb } from '@/db';
import { useLibrary } from '@/store/library';
import { usePcSync } from '@/store/pcSync';
import { useSettings } from '@/store/settings';
import { colors } from '@/ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initDb();
        await useSettings.getState().hydrate();
        await useLibrary.getState().ensureDefaultSource(useSettings.getState().settings.libraryRoot);
        await useLibrary.getState().refresh();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setReady(true);
        SplashScreen.hideAsync().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reading progress follows you between this device and your PC, and while the app is open the
  // PC can see this library and get volumes from it (when paired and reachable).
  useEffect(() => {
    if (!ready || error) return;
    const pc = usePcSync.getState();
    void pc.backgroundSync();
    pc.startRemote();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void usePcSync.getState().backgroundSync();
        usePcSync.getState().startRemote();
      } else {
        usePcSync.getState().stopRemote();
        // After the reader's pending save lands: the PC should see where you stopped.
        setTimeout(() => void usePcSync.getState().backgroundSync(true), 700);
      }
    });
    return () => {
      sub.remove();
      usePcSync.getState().stopRemote();
    };
  }, [ready, error]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>{APP_NAME} could not start</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="series/[seriesId]" />
            <Stack.Screen name="sources" />
            <Stack.Screen name="pc" />
            <Stack.Screen name="reader/[archiveId]" options={{ animation: 'fade' }} />
          </Stack>
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  errorBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  errorTitle: { color: colors.text, fontSize: 18, fontWeight: '600' },
  errorText: { color: colors.danger, textAlign: 'center' },
});
