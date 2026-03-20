import { useEffect, useSyncExternalStore, useCallback } from 'react';

const STORAGE_KEY = 'kraki-theme';

type Theme = 'light' | 'dark' | 'system';

function getStored(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'system';
}

function resolveTheme(pref: Theme): boolean {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return pref === 'dark';
}

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

let listeners: Array<() => void> = [];
function emitChange() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): Theme {
  return getStored();
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(resolveTheme(theme));
  emitChange();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot);

  // Apply on mount and when system preference changes
  useEffect(() => {
    applyTheme(resolveTheme(theme));
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getStored() === 'system') applyTheme(mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const isDark = resolveTheme(theme);
  const toggleDark = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark');
  }, [isDark]);

  return { theme, isDark, toggleDark, setTheme };
}
