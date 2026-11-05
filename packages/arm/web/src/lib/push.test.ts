import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPushSubscribed, unsubscribeFromPush } from './push';

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function installServiceWorker(registration: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    // `ready` never settles without a registration, as in a browser.
    value: { ready: new Promise(() => {}), getRegistration: vi.fn().mockResolvedValue(registration) },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
  Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default' } });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { PushManager?: unknown }).PushManager;
  delete (window as { Notification?: unknown }).Notification;
});

describe('push without a registered service worker (K-006 sign-out)', () => {
  it('settles instead of waiting forever', async () => {
    installServiceWorker(undefined);
    await expect(unsubscribeFromPush()).resolves.toBe(false);
    await expect(isPushSubscribed()).resolves.toBe(false);
  });

  it('unsubscribes the registration that has a subscription', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    installServiceWorker({ pushManager: { getSubscription: vi.fn().mockResolvedValue({ unsubscribe }) } });
    await expect(isPushSubscribed()).resolves.toBe(true);
    await expect(unsubscribeFromPush()).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalled();
  });
});
