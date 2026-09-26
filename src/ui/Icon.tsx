/**
 * Vector icons: Material Symbols on Android (expo-symbols loads the icon font), SF Symbols on iOS.
 * One place to pick names, so screens stay consistent.
 */
import { type AndroidSymbol, type SFSymbol, SymbolView } from 'expo-symbols';
import React from 'react';
import { ColorValue, StyleProp, ViewStyle } from 'react-native';

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
  return <SymbolView name={{ android: name, web: name, ios: IOS[name] }} size={size} tintColor={color} style={style} />;
}
