import { describe, expect, it } from 'vitest';
import { decidePairingLink, isOfficialRelay } from './pairing-link';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';

describe('pairing link (release review A10 / D5)', () => {
  it('recognizes Kraki relays only', () => {
    expect(isOfficialRelay('wss://relay.kraki.chat')).toBe(true);
    expect(isOfficialRelay('wss://cn.relay.kraki.chat')).toBe(true);
    expect(isOfficialRelay('wss://kraki.chat.evil.example')).toBe(false);
    expect(isOfficialRelay('wss://evil.example')).toBe(false);
    expect(isOfficialRelay('not a url')).toBe(false);
  });

  it('offers the app on iPhone without spending the token', () => {
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', IPHONE)).toEqual({ kind: 'offer-app' });
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1&web=1', IPHONE)).toEqual({ kind: 'proceed' });
  });

  it('keeps pairing the web client on Android', () => {
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', ANDROID)).toEqual({ kind: 'proceed' });
  });

  it('asks before connecting to a non-Kraki relay', () => {
    expect(decidePairingLink('?relay=wss://my.server:4000&token=pt_1', ANDROID)).toEqual({ kind: 'confirm-relay', host: 'my.server:4000' });
    expect(decidePairingLink('?relay=wss://my.server:4000&token=pt_1&confirmRelay=1', ANDROID)).toEqual({ kind: 'proceed' });
  });

  it('does nothing without a token', () => {
    expect(decidePairingLink('?channel=beta', IPHONE)).toEqual({ kind: 'none' });
  });
});
