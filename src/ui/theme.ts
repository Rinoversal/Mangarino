export const colors = {
  bg: '#08153b',
  card: '#142452',
  cardActive: '#1b2f66',
  border: '#26397a',
  text: '#f1f3ff',
  muted: '#9aa3c7',
  accent: '#ff2d95',
  accentText: '#ffffff',
  /** The logo's softer pink, for icons and small highlights. */
  accentSoft: '#f977a6',
  /** A faint pink wash behind highlighted cards. */
  accentWash: 'rgba(255,45,149,0.12)',
  success: '#3ddc97',
  danger: '#ff6b6b',
  /** Reader menu bars and toasts: see-through dark so the page shows behind them. */
  scrim: 'rgba(0,0,0,0.6)',
  /** Unselected chips sitting on the scrim. */
  scrimChip: 'rgba(255,255,255,0.14)',
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16 } as const;
