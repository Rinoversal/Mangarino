/**
 * Vector icons: Material Symbols on Android (expo-symbols loads the icon font), SF Symbols on iOS.
 * One place to pick names, so screens stay consistent.
 */
import { type AndroidSymbol, type SFSymbol, SymbolView } from 'expo-symbols';
import React from 'react';
import { ColorValue, PixelRatio, Platform, StyleProp, ViewStyle } from 'react-native';

import { colors } from './theme';

const IOS: Partial<Record<AndroidSymbol, SFSymbol>> = {
  laptop_windows: 'laptopcomputer',
  tablet_android: 'ipad',
  phone_android: 'iphone',
  wifi: 'wifi',
  wifi_off: 'wifi.slash',
  download: 'arrow.down.circle',
  upload: 'arrow.up.circle',
  qr_code_scanner: 'qrcode.viewfinder',
  keyboard: 'keyboard',
  check_circle: 'checkmark.circle.fill',
  chevron_right: 'chevron.right',
  arrow_back: 'chevron.left',
  close: 'xmark',
  refresh: 'arrow.clockwise',
  public: 'globe',
  sync: 'arrow.triangle.2.circlepath',
  search: 'magnifyingglass',
};

export function Icon({
  name,
  size = 22,
  color = colors.text,
  style,
}: {
  name: AndroidSymbol;
  size?: number;
  color?: ColorValue;
  style?: StyleProp<ViewStyle>;
}) {
  // On Android the symbol is drawn as text, which grows with the system text size inside a box
  // that doesn't: undo that growth so the icon fills its box, as at the default text size.
  const scale = Platform.OS === 'android' ? PixelRatio.getFontScale() : 1;
  return (
    <SymbolView
      name={{ android: name, web: name, ios: IOS[name] }}
      size={size / scale}
      tintColor={color}
      style={[{ width: size, height: size }, style]}
    />
  );
}
