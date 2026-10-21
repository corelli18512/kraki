import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getLanguagePreference, setLanguagePreference, type LanguagePreference } from '.';

let listeners: Array<() => void> = [];
function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** Language preference for the Settings picker. */
export function useLanguagePreference() {
  useTranslation(); // re-render on language change
  const preference = useSyncExternalStore(subscribe, getLanguagePreference);
  const set = (pref: LanguagePreference) => {
    setLanguagePreference(pref);
    listeners.forEach((l) => l());
  };
  return { preference, setPreference: set };
}
