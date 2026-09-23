import { create } from 'zustand';

import { getAllSettings, setSetting } from '@/db/repo';

export type ReadingDirection = 'rtl' | 'ltr';
export type ReaderMode = 'page' | 'panel' | 'vertical';

export interface Settings {
  readingDirection: ReadingDirection;
  tapZones: boolean;
  spreadsInLandscape: boolean;
  keepAwake: boolean;
  cacheCapMB: number;
  libraryRoot: string;
  showPageNumber: boolean;
  defaultMode: ReaderMode;
}

export const DEFAULT_SETTINGS: Settings = {
  readingDirection: 'rtl',
  tapZones: true,
  spreadsInLandscape: false,
  keepAwake: true,
  cacheCapMB: 200,
  libraryRoot: '/storage/emulated/0/Mangarino',
  showPageNumber: true,
  defaultMode: 'page',
};

interface SettingsState {
  settings: Settings;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  async hydrate() {
    const raw = await getAllSettings();
    const next: Settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = raw[key];
      if (v === undefined) continue;
      try {
        (next as unknown as Record<string, unknown>)[key] = JSON.parse(v);
      } catch {
        // ignore corrupt value, keep default
      }
    }
    set({ settings: next, hydrated: true });
  },
  async set(key, value) {
    set({ settings: { ...get().settings, [key]: value } });
    await setSetting(key, JSON.stringify(value));
  },
}));
