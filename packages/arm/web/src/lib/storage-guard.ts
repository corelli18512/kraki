/**
 * Web Storage that the browser refuses outright (site data blocked: reading
 * `window.localStorage` throws) used to leave a blank page, because many
 * modules read it while loading. Replace an unusable Storage with an in-memory
 * one for this page, so the app runs and simply forgets on reload (K-201).
 * Imported first by main.tsx, before any module that touches storage.
 */
const memoryBacked = new WeakSet<object>();

/** True for a replacement made here: it does not survive a reload, so code
 *  that relies on a value across reloads must treat it as no storage. */
export function isMemoryStorage(storage: object): boolean {
  return memoryBacked.has(storage);
}

export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(String(key)) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => { items.delete(String(key)); },
    setItem: (key: string, value: string) => { items.set(String(key), String(value)); },
  };
  memoryBacked.add(storage);
  return storage;
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
