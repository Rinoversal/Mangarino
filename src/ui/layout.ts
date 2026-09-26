import { useWindowDimensions } from 'react-native';

/**
 * Below this window width (dp) screens switch to their phone arrangement. Android draws the
 * phone/tablet line at the same 600 dp. It is measured on the current window, so a tablet in
 * split screen or a narrow Chromebook window gets the phone layout too.
 */
export const COMPACT_WIDTH = 600;

/**
 * Text-heavy screens (settings, sources, bookmarks) stop growing at this width and centre,
 * so rows stay easy to scan on big tablets, Chromebooks and desktop-size windows.
 */
export const READABLE_WIDTH = 760;

/** Current window size, plus whether it is phone-width. Re-renders on rotation and resize. */
export function useLayout() {
  const { width, height } = useWindowDimensions();
  return { width, height, compact: width < COMPACT_WIDTH };
}

/** Style for a screen's content container that fills the width up to READABLE_WIDTH, centred. */
export const readableColumn = { width: '100%', maxWidth: READABLE_WIDTH, alignSelf: 'center' } as const;
