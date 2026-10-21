/**
 * Web client localization (also used inside the Windows shell).
 *
 *   import { useTranslation } from 'react-i18next';
 *   const { t } = useTranslation('settings');
 *   t('general.title')
 *
 * Outside React: `import { t } from '../i18n'` (re-evaluates on language
 * change only where the caller re-renders/re-reads).
 *
 * Language = user preference (localStorage `kraki-language`) or, when it is
 * 'system', the first supported entry of navigator.languages. Not synced
 * across devices on purpose.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from './resources';
import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  resolveSystemLanguage,
  type LanguageCode,
  type LanguagePreference,
} from './languages';

export * from './languages';

const STORAGE_KEY = 'kraki-language';

// In-memory copy: the choice holds for this session even if storage throws.
let memoryPreference: LanguagePreference | undefined;

export function getLanguagePreference(): LanguagePreference {
  if (memoryPreference) return memoryPreference;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLanguageCode(stored)) return stored;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function systemTags(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export function resolveLanguage(pref: LanguagePreference = getLanguagePreference()): LanguageCode {
  return pref === 'system' ? resolveSystemLanguage(systemTags()) : pref;
}

type LanguageListener = (lang: LanguageCode) => void;
const languageListeners = new Set<LanguageListener>();
/** Notified after every language change (e.g. the Windows shell bridge). */
export function onLanguageChanged(listener: LanguageListener): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

function applyDocumentLanguage(lang: LanguageCode) {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

const initialLanguage = resolveLanguage();

void i18next.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: Object.keys(resources),
  defaultNS: 'common',
  ns: Object.keys(resources.en),
  // Resources are bundled, so init synchronously: the first render is already
  // in the right language.
  initAsync: false,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
  react: { useSuspense: false },
});
applyDocumentLanguage(initialLanguage);

i18next.on('languageChanged', (lng) => {
  if (!isLanguageCode(lng)) return;
  applyDocumentLanguage(lng);
  for (const l of languageListeners) l(lng);
});

export function setLanguagePreference(pref: LanguagePreference) {
  memoryPreference = pref;
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage unavailable: still switch for this session */
  }
  void i18next.changeLanguage(resolveLanguage(pref));
}

/** Follow OS/browser language changes while the preference is 'system'. */
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (getLanguagePreference() === 'system') void i18next.changeLanguage(resolveLanguage('system'));
  });
}

export function currentLanguage(): LanguageCode {
  const lng = i18next.resolvedLanguage ?? i18next.language;
  return isLanguageCode(lng) ? lng : DEFAULT_LANGUAGE;
}

export const t = i18next.t.bind(i18next);
export { i18next };
