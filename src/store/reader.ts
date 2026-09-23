import { create } from 'zustand';

interface ReaderPagesState {
  pageUris: Record<number, string>;
  errors: Record<number, string>;
  setUri: (i: number, uri: string) => void;
  setError: (i: number, message: string) => void;
  reset: () => void;
}

/** Per-page URIs published by the PageLoader; pages subscribe individually so only they re-render. */
export const useReaderPages = create<ReaderPagesState>((set) => ({
  pageUris: {},
  errors: {},
  setUri: (i, uri) =>
    set((s) => {
      const errors = { ...s.errors };
      delete errors[i];
      return { pageUris: { ...s.pageUris, [i]: uri }, errors };
    }),
  setError: (i, message) => set((s) => ({ errors: { ...s.errors, [i]: message } })),
  reset: () => set({ pageUris: {}, errors: {} }),
}));
