import en from './locales/en';
import zhHans from './locales/zh-Hans';
import type { LanguageCode } from './languages';

/**
 * English is the source of truth: its shape defines the key types, and every
 * other locale must provide the same keys (checked in i18n.test.ts and by
 * `pnpm l10n:check`). Missing keys at runtime fall back to English.
 */
export type Resources = typeof en;
export type Namespace = keyof Resources;

/** Every translation must cover exactly the English keys (deeply). */
type DeepStringShape<T> = { [K in keyof T]: T[K] extends string ? string : DeepStringShape<T[K]> };
export type LocaleResources = DeepStringShape<Resources>;

export const resources: Record<LanguageCode, LocaleResources> = {
  en,
  'zh-Hans': zhHans,
};

export const NAMESPACES = Object.keys(en) as Namespace[];
