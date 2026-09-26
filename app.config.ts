import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json, plus the edition. APP_VARIANT=testarino builds Testarino, the public test edition:
 * its own name, Android app id, link scheme and PC hub port, so it installs next to Mangarino
 * and talks only to Testarino Hub. The name reaches the app through extra.brand (src/brand.ts).
 */
const EDITIONS = {
  mangarino: { name: 'Mangarino', slug: 'mangarino', scheme: 'mangarino', androidPackage: 'com.rinoversal.mangarino', hubPort: 6264 },
  testarino: { name: 'Testarino', slug: 'testarino', scheme: 'testarino', androidPackage: 'com.rinoversal.testarino', hubPort: 6265 },
} as const;

export default ({ config }: ConfigContext): ExpoConfig => {
  const key = (process.env.APP_VARIANT ?? 'mangarino').toLowerCase();
  const edition = EDITIONS[key as keyof typeof EDITIONS] ?? EDITIONS.mangarino;
  return {
    ...config,
    name: edition.name,
    slug: edition.slug,
    scheme: edition.scheme,
    android: { ...config.android, package: edition.androidPackage },
    extra: { ...config.extra, brand: edition.name, hubPort: edition.hubPort },
  };
};
