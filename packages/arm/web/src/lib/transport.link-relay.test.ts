import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiTransport, STORAGE_KEY } from './transport';
import { useStore } from '../hooks/useStore';

const callbacks = { onOpen: vi.fn(async () => {}), onParsedMessage: vi.fn() };

// K-001: a link's ?relay= must not move a signed-in browser to another server.
describe('transport: ?relay= from a link', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.getState().reset();
    window.history.replaceState({}, '', '/');
  });

  it('keeps the stored relay when a signed-in browser opens ?relay= without a token', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'dev_1' }));
    window.history.replaceState({}, '', '/?relay=wss://evil.example');
    const transport = new KrakiTransport(callbacks);
    expect(transport.url).toBe('wss://relay.kraki.chat');
    expect(transport.storedDeviceId).toBe('dev_1');
  });

  it('follows ?relay= together with a pairing token (confirmed before the app loads)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'dev_1' }));
    window.history.replaceState({}, '', '/?relay=wss://my.server:4000&token=pt_1');
    const transport = new KrakiTransport(callbacks);
    expect(transport.url).toBe('wss://my.server:4000');
    expect(transport.pairingToken).toBe('pt_1');
  });

  it('follows ?relay= before this browser is signed in', () => {
    window.history.replaceState({}, '', '/?relay=ws://localhost:4000');
    expect(new KrakiTransport(callbacks).url).toBe('ws://localhost:4000');
  });
});
