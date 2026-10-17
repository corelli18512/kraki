import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationsEnabled, setNotificationsEnabled } from './notification-prefs';
import { DesktopNotificationPresenter } from './desktop-notifications';

const PREF_KEY = 'kraki:notifications.enabled';
const IDS_KEY = 'kraki-desktop.notifications.recentIds';
const preview = (nid: string) => JSON.stringify({ nid, sessionId: 'not-watched', type: 'question', summary: 'Test only' });

// Converted from notification-prefs.repro.test.ts in the phase-1 shell reproduction.
describe('S2 real preference setter → desktop presenter contract', () => {
  beforeEach(() => localStorage.clear());

  it('suppresses disabled=0, claims the id, and only posts a distinct id after re-enable', () => {
    const post = vi.fn();
    const watching = vi.fn(() => false);
    const presenter = new DesktopNotificationPresenter(localStorage, watching, post);
    setNotificationsEnabled(false);
    expect(notificationsEnabled()).toBe(false);
    expect(localStorage.getItem(PREF_KEY)).toBe('0');
    presenter.present(preview('off'));
    expect(post).not.toHaveBeenCalled();
    expect(watching).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(IDS_KEY)!)).toEqual(['off']);
    setNotificationsEnabled(true);
    presenter.present(preview('off'));
    expect(post).not.toHaveBeenCalled();
    presenter.present(preview('on'));
    expect(post).toHaveBeenCalledExactlyOnceWith({
      title: 'Kraki', body: 'Question: Test only', sessionId: 'not-watched',
    });
  });

  it.each(['0', 'false'])('preserves stored opt-out %s and suppressed-id claims across presenter reloads', (stored) => {
    const post = vi.fn();
    localStorage.setItem(PREF_KEY, stored);
    const presenter = new DesktopNotificationPresenter(localStorage, () => false, post);
    expect(notificationsEnabled()).toBe(false);
    presenter.present(preview('suppressed'));
    expect(post).not.toHaveBeenCalled();
    const reloaded = new DesktopNotificationPresenter(localStorage, () => false, post);
    reloaded.present(preview('still-off'));
    expect(post).not.toHaveBeenCalled();
    expect(localStorage.getItem(PREF_KEY)).toBe(stored);
    setNotificationsEnabled(true);
    const enabled = new DesktopNotificationPresenter(localStorage, () => false, post);
    enabled.present(preview('suppressed'));
    enabled.present(preview('still-off'));
    expect(post).not.toHaveBeenCalled();
    enabled.present(preview('fresh'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(['0', 'false'])('uses injected presenter storage for opt-out %s, not ambient localStorage', (stored) => {
    const post = vi.fn();
    const saved = new Map<string, string>([[PREF_KEY, stored]]);
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    };
    setNotificationsEnabled(true);
    new DesktopNotificationPresenter(storage, () => false, post).present(preview('injected'));
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(saved.get(IDS_KEY)!)).toEqual(['injected']);
    expect(localStorage.getItem(IDS_KEY)).toBeNull();
    saved.set(PREF_KEY, '1');
    setNotificationsEnabled(false);
    const enabled = new DesktopNotificationPresenter(storage, () => false, post);
    enabled.present(preview('injected'));
    expect(post).not.toHaveBeenCalled();
    enabled.present(preview('fresh'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('bounds suppressed-id persistence to 512 and retains claims after reload', () => {
    const post = vi.fn();
    setNotificationsEnabled(false);
    const presenter = new DesktopNotificationPresenter(localStorage, () => false, post);
    for (let i = 0; i < 513; i++) presenter.present(preview(String(i)));
    expect(post).not.toHaveBeenCalled();
    const ids = JSON.parse(localStorage.getItem(IDS_KEY)!);
    expect(ids).toHaveLength(512);
    expect(ids[0]).toBe('1');
    expect(ids[511]).toBe('512');
    setNotificationsEnabled(true);
    const reloaded = new DesktopNotificationPresenter(localStorage, () => false, post);
    reloaded.present(preview('512'));
    expect(post).not.toHaveBeenCalled();
    reloaded.present(preview('0'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('claims watched previews before suppression and rejects malformed or missing-session payloads', () => {
    const post = vi.fn();
    const watching = vi.fn(() => true);
    setNotificationsEnabled(true);
    const presenter = new DesktopNotificationPresenter(localStorage, watching, post);
    presenter.present(preview('watched'));
    watching.mockReturnValue(false);
    presenter.present(preview('watched'));
    presenter.present('invalid json');
    presenter.present('null');
    presenter.present('42');
    presenter.present(JSON.stringify({ nid: 'no-session', type: 'question' }));
    presenter.present(preview('no-session'));
    expect(post).not.toHaveBeenCalled();
    presenter.present(preview('valid'));
    expect(post).toHaveBeenCalledTimes(1);
  });
});
