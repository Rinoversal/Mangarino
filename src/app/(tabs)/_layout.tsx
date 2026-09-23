import { Tabs } from 'expo-router';
import React from 'react';
import { ColorValue, Text } from 'react-native';

import { colors } from '@/ui/theme';

function icon(symbol: string) {
  // eslint-disable-next-line react/display-name
  return ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{symbol}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Library', tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="bookmarks" options={{ title: 'Bookmarks', tabBarIcon: icon('❖') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
