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

/**
 * Every translation must cover the English keys (deeply). Plural forms vary by
 * language (zh has only `_other`, Russian adds `_few`/`_many`), so plural
 * suffix keys are optional here; i18n.test.ts and `pnpm l10n:check` enforce
 * that each plural base key exists.
 */
type PluralKey = `${string}_${'zero' | 'one' | 'two' | 'few' | 'many'}`;
type DeepStringShape<T> = {
  [K in keyof T as K extends PluralKey ? never : K]: T[K] extends string ? string : DeepStringShape<T[K]>;
} & {
  [K in keyof T as K extends PluralKey ? K : never]?: string;
} & { [plural: PluralKey]: string };
export type LocaleResources = DeepStringShape<Resources>;

export const resources: Record<LanguageCode, LocaleResources> = {
  en,
  'zh-Hans': zhHans,
};

export const NAMESPACES = Object.keys(en) as Namespace[];
