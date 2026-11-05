/**
 * K-112: the service worker serves the app shell offline. public/sw.js is
 * plain worker JavaScript; it runs here against a stubbed worker global.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('public/sw.js', 'utf8');

function loadWorker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (req: string | { url: string }) => new URL(typeof req === 'string' ? req : req.url, 'https://kraki.chat').pathname;
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (req: string | { url: string }) => store.get(keyOf(req))?.clone(),
        put: async (req: string | { url: string }, res: Response) => { store.set(keyOf(req), res); },
        keys: async () => [...store.keys()].map((path) => ({ url: `https://kraki.chat${path}` })),
        delete: async (req: { url: string }) => store.delete(keyOf(req)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  let online = true;
  const fetch = vi.fn(async (req: { url: string }) => {
    if (!online) throw new TypeError('Failed to fetch');
    const path = keyOf(req);
    const contentType = path.endsWith('.js') ? 'text/javascript' : 'text/html';
    const res = new Response(`body of ${path}`, { status: 200, headers: { 'content-type': contentType } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  });
  const self = {
    location: { href: 'https://kraki.chat/sw.js?lang=en', origin: 'https://kraki.chat' },
    navigator: { languages: ['en'] },
    registration: {},
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
  };
  new Function('self', 'caches', 'fetch', source)(self, caches, fetch);
  async function request(url: string, mode = 'cors', method = 'GET'): Promise<Response | undefined> {
    let responded: Promise<Response> | undefined;
    handlers.get('fetch')!({ request: { url, mode, method }, respondWith: (p: Promise<Response>) => { responded = p; } });
    return responded ? await responded : undefined;
  }
  return { request, fetch, setOnline: (v: boolean) => { online = v; } };
}

describe('K-112: offline app shell', () => {
  it('serves the last page seen when offline, for any app route', async () => {
    const sw = loadWorker();
    expect(await (await sw.request('https://kraki.chat/', 'navigate'))!.text()).toBe('body of /');
    sw.setOnline(false);
    const offline = await sw.request('https://kraki.chat/session/abc', 'navigate');
    expect(await offline!.text()).toBe('body of /');
  });

  it('a static page seen online (the privacy policy) never becomes the offline shell', async () => {
    const sw = loadWorker();
    await sw.request('https://kraki.chat/', 'navigate');
    expect(await sw.request('https://kraki.chat/privacy/', 'navigate')).toBeUndefined();
    expect(await sw.request('https://kraki.chat/privacy', 'navigate')).toBeUndefined();
    sw.setOnline(false);
    expect(await (await sw.request('https://kraki.chat/session/x', 'navigate'))!.text()).toBe('body of /');
  });

  it('files opened in a tab (install.sh) are not taken over as pages', async () => {
    const sw = loadWorker();
    expect(await sw.request('https://kraki.chat/install.sh', 'navigate')).toBeUndefined();
    expect(await sw.request('https://kraki.chat/install.ps1', 'navigate')).toBeUndefined();
  });

  it('pages are network-first: online loads always get the current deploy', async () => {
    const sw = loadWorker();
    await sw.request('https://kraki.chat/', 'navigate');
    await sw.request('https://kraki.chat/', 'navigate');
    expect(sw.fetch).toHaveBeenCalledTimes(2);
  });

  it('hashed assets are cached once seen and served offline', async () => {
    const sw = loadWorker();
    await sw.request('https://kraki.chat/assets/boot-abc123.js');
    sw.setOnline(false);
    expect(await (await sw.request('https://kraki.chat/assets/boot-abc123.js'))!.text()).toBe('body of /assets/boot-abc123.js');
  });

  it('leaves other requests to the network (relay, other origins, POST)', async () => {
    const sw = loadWorker();
    expect(await sw.request('https://relay.kraki.chat/x')).toBeUndefined();
    expect(await sw.request('https://kraki.chat/install.sh')).toBeUndefined();
    expect(await sw.request('https://kraki.chat/', 'navigate', 'POST')).toBeUndefined();
  });
});

describe('K-112: the worker is installed at launch', () => {
  it('registers in a production web build only', async () => {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
    const { registerServiceWorker } = await import('./push');
    registerServiceWorker({ prod: false });
    expect(register).not.toHaveBeenCalled();
    registerServiceWorker({ prod: true });
    expect(register).toHaveBeenCalledWith('/sw.js?lang=en');
    (window as { krakiDesktop?: unknown }).krakiDesktop = {};
    registerServiceWorker({ prod: true });
    expect(register).toHaveBeenCalledTimes(1);
    delete (window as { krakiDesktop?: unknown }).krakiDesktop;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
});
