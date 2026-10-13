import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from '../hooks/useStore';
import { KrakiWSClient } from './ws-client';
import { desktop } from './desktop';

vi.mock('./desktop', () => ({ desktop: { notify: vi.fn() }, desktopCredentials: () => null, setDesktopSignedOut: vi.fn() }));
const decrypt = vi.hoisted(() => vi.fn(async (p: { blob: string }) => p.blob));
vi.mock('./e2e', () => ({ createAppKeyStore: () => ({ isReady: () => true, decryptFromBlob: decrypt, init: async () => {} }) }));

beforeEach(() => { useStore.getState().reset(); localStorage.clear(); vi.mocked(desktop!.notify).mockClear(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const auth = { type: 'auth_ok', deviceId: 'desktop-test', devices: [] };
function seams(client: KrakiWSClient) {
  return client as unknown as { handleMessage: (msg: unknown) => void; dispatchInner: (msg: unknown) => void; sendToHead: (msg: unknown) => void };
}
it('registers the desktop device with provider local on each authenticated epoch', () => {
  const client = new KrakiWSClient('ws://localhost:9999');
  const send = vi.spyOn(seams(client), 'sendToHead').mockImplementation(() => {});
  seams(client).handleMessage(auth);
  expect(send).toHaveBeenCalledWith({ type: 'register_push_token', payload: { provider: 'local', token: 'desktop-test' } });
  client.disconnect();
});
it.each(['head-first', 'link-first'])('decrypts Head and local previews, then dedupes %s without a session subscription', async (order) => {
  const client = new KrakiWSClient('ws://localhost:9999');
  useStore.getState().setAuth('desktop-test');
  const preview = JSON.stringify({ nid: order, type: 'permission', title: 'Named Session', summary: ' bash\ntrue ', sessionId: 'unsubscribed' });
  const head = () => seams(client).handleMessage({ type: 'notification_preview', payload: { blob: preview, key: 'wrapped' } });
  const link = () => seams(client).dispatchInner({ type: 'local_notification', payload: { preview } });
  if (order === 'head-first') { head(); await Promise.resolve(); link(); } else { link(); head(); await Promise.resolve(); }
  expect(decrypt).toHaveBeenCalledWith({ blob: preview, keys: { 'desktop-test': 'wrapped' } }, 'desktop-test');
  expect(desktop!.notify).toHaveBeenCalledTimes(1);
  expect(desktop!.notify).toHaveBeenCalledWith({ sessionId: 'unsubscribed', title: 'Named Session', body: 'Needs approval: bash true' });
  client.disconnect();
});
