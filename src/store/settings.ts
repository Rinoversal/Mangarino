import { create } from 'zustand';

import { getAllSettings, setSetting } from '@/db/repo';

export type ReadingDirection = 'rtl' | 'ltr';
export type ReaderMode = 'page' | 'panel' | 'vertical';

/** Colours offered for the box drawn around the current panel in panel mode. */
export const PANEL_OUTLINE_SWATCHES: { value: string; label: string }[] = [
  { value: '#000000', label: 'Black' },
  { value: '#ffffff', label: 'White' },
  { value: '#ff2d95', label: 'Pink' },
  { value: '#ff3b30', label: 'Red' },
  { value: '#ff9500', label: 'Orange' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#3ddc97', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
];

export const DEFAULT_PANEL_OUTLINE = '#000000';

/** The stored outline colour, or the default when the value is not a #rrggbb hex. */
export function panelOutlineColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_PANEL_OUTLINE;
}

export interface Settings {
  readingDirection: ReadingDirection;
  tapZones: boolean;
  spreadsInLandscape: boolean;
  keepAwake: boolean;
  cacheCapMB: number;
  libraryRoot: string;
  showPageNumber: boolean;
  defaultMode: ReaderMode;
  /** #rrggbb colour of the outline around the current panel in panel mode. */
  panelOutline: string;
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
  panelOutline: DEFAULT_PANEL_OUTLINE,
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
