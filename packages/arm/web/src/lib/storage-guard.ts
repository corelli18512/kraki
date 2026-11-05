/**
 * Web Storage that the browser refuses outright (site data blocked: reading
 * `window.localStorage` throws) used to leave a blank page, because many
 * modules read it while loading. Replace an unusable Storage with an in-memory
 * one for this page, so the app runs and simply forgets on reload (K-201).
 * Imported first by main.tsx, before any module that touches storage.
 */
export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(String(key)) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => { items.delete(String(key)); },
    setItem: (key: string, value: string) => { items.set(String(key), String(value)); },
  };
}

function usable(target: Window, name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const storage = target[name];
    storage.getItem('kraki-storage-probe');
    return true;
  } catch {
    return false;
  }
}

export function ensureUsableStorage(target: Window = window): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (usable(target, name)) continue;
    try {
      Object.defineProperty(target, name, { value: memoryStorage(), configurable: true });
      console.warn(`[Kraki] ${name} is unavailable; using memory for this page`);
    } catch {
      // Not replaceable: modules that guard their own storage access still work.
    }
  }
}

if (typeof window !== 'undefined') ensureUsableStorage();
