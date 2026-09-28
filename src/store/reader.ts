import { create } from 'zustand';

interface ReaderPagesState {
  pageUris: Record<number, string>;
  /** Bumped each time a page is (re)written, so its image reloads even at the same path. */
  versions: Record<number, number>;
  errors: Record<number, string>;
  setUri: (i: number, uri: string) => void;
  setError: (i: number, message: string) => void;
  reset: () => void;
}

/** Per-page URIs published by the PageLoader; pages subscribe individually so only they re-render. */
export const useReaderPages = create<ReaderPagesState>((set) => ({
  pageUris: {},
  versions: {},
  errors: {},
  setUri: (i, uri) =>
    set((s) => {
      const errors = { ...s.errors };
      delete errors[i];
      return { pageUris: { ...s.pageUris, [i]: uri }, versions: { ...s.versions, [i]: (s.versions[i] ?? 0) + 1 }, errors };
    }),
  setError: (i, message) => set((s) => ({ errors: { ...s.errors, [i]: message } })),
  reset: () => set({ pageUris: {}, versions: {}, errors: {} }),
}));
