/**
 * Scans the hub's pairing QR code with the camera inside the app (expo-camera's CameraView and
 * the ML Kit barcode model bundled with it). Google's separate code-scanner screen opened but
 * didn't read the code on a real tablet, and it can't say why.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_NAME, BRAND_HUB_PORT, HUB_NAME } from '../brand';
import { colors, radius, spacing } from '../ui/theme';

import { PairLink, parsePairLink } from './net';

export function QrScanModal({
  visible,
  onClose,
  onLink,
}: {
  visible: boolean;
  onClose: () => void;
  onLink: (link: PairLink) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const handled = useRef(false);
  const lastHint = useRef(0);

  useEffect(() => {
    if (!visible) return;
    handled.current = false;
    setHint(null);
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, permission?.granted]);

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (handled.current) return; // the camera reports the same code many times a second
      const link = parsePairLink(data, BRAND_HUB_PORT);
      if (link) {
        handled.current = true;
        onLink(link);
        return;
      }
      const now = Date.now();
      if (now - lastHint.current > 2000) {
        lastHint.current = now;
        setHint(`That QR code isn't from ${HUB_NAME}. Scan the one in ${HUB_NAME}.`);
      }
    },
    [onLink],
  );

  const granted = !!permission?.granted;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {visible && granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
        ) : null}

        <View style={[styles.overlay, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md }]}>
          <Text style={styles.title}>Scan the hub&apos;s QR code</Text>
          {granted ? (
            <>
              <View style={styles.frame} />
              <Text style={styles.text}>
                Point the camera at the QR code on your PC&apos;s screen, 20 to 30 cm away. Tilt a little if the screen
                glares.
              </Text>
            </>
          ) : permission && !permission.canAskAgain ? (
            <View style={styles.box}>
              <Text style={styles.text}>
                Camera access is off for {APP_NAME}. Turn it on in Settings, under Apps › {APP_NAME} › Permissions.
              </Text>
              <Pressable onPress={() => void Linking.openSettings()} style={[styles.button, styles.accent]}>
                <Text style={styles.accentText}>Open Settings</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.box}>
              <Text style={styles.text}>{APP_NAME} needs the camera to read the QR code. Nothing is recorded.</Text>
              <Pressable onPress={() => void requestPermission()} style={[styles.button, styles.accent]}>
                <Text style={styles.accentText}>Allow camera</Text>
              </Pressable>
            </View>
          )}
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
          <Pressable onPress={onClose} style={styles.button} hitSlop={8}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.md },
  frame: { width: 260, height: 260, borderWidth: 3, borderColor: colors.accent, borderRadius: radius.lg },
  text: { color: '#fff', fontSize: 15, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: spacing.sm, borderRadius: radius.md },
  hint: { color: '#ffd60a', fontSize: 14, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: spacing.sm, borderRadius: radius.md },
  box: { gap: spacing.md, alignItems: 'center', maxWidth: 420 },
  button: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.15)' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  accent: { backgroundColor: colors.accent },
  accentText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
});
