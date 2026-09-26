/**
 * The app's name on screen: "Mangarino", or "Testarino" in the public test edition
 * (APP_VARIANT=testarino, see app.config.ts), and the port its PC hub listens on.
 */
import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { brand?: string; hubPort?: number };

export const APP_NAME: string = extra.brand ?? 'Mangarino';
export const HUB_NAME = `${APP_NAME} Hub`;
/** Mangarino Hub listens on 6264, Testarino Hub on 6265, so both can run on one PC. */
export const BRAND_HUB_PORT: number = extra.hubPort ?? 6264;
