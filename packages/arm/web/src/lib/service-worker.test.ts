/**
 * public/sw.js runs in the service worker, outside the app bundle: load it
 * into a sandbox with a fake `self` and drive its push/click handlers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Win = { url: string; focused: boolean; visibilityState: 'visible' | 'hidden'; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
const SCOPE = 'https://app.kraki.chat/';

function win(path: string, focused = true, visibilityState: 'visible' | 'hidden' = 'visible'): Win {
  return { url: SCOPE + path.replace(/^\//, ''), focused, visibilityState, focus: vi.fn(async () => {}), postMessage: vi.fn() };
}

/** Load the worker with its decryptPreview replaced by a stub returning `preview`. */
function worker(windows: Win[], preview: Record<string, unknown> | null) {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')
    .replace('async function decryptPreview(', 'async function decryptPreviewReal(')
    + '\nasync function decryptPreview() { return PREVIEW; }\n';
  const handlers: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
    registration: { scope: SCOPE, showNotification: vi.fn(async (_title: string, _options: Record<string, unknown>) => {}) },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async (_url: string) => null) },
  };
  runInNewContext(source, { self, URL, console, PREVIEW: preview });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  return {
    self,
    push: () => fire('push', { data: { json: () => ({ kraki: { blob: 'b', key: 'k' } }) } }),
    click: (data: Record<string, unknown>) => fire('notificationclick', { notification: { data, close: vi.fn() } }),
  };
}

describe('service worker push (K-032)', () => {
  it('leaves out the Session the user is looking at', async () => {
    const w = worker([win('/session/s1')], { nid: 'n1', type: 'question', summary: 'Proceed?', sessionId: 's1' });
    await w.push();
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('notifies for another Session while a tab is focused', async () => {
    const w = worker([win('/session/s1')], { nid: 'n1', type: 'question', summary: 'Proceed?', sessionId: 's2' });
    await w.push();
    expect(w.self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it('notifies for the open Session when its tab is in the background or not focused', async () => {
    for (const tab of [win('/session/s1', false), win('/session/s1', true, 'hidden')]) {
      const w = worker([tab], { nid: 'n1', type: 'idle', summary: 'Done', sessionId: 's1' });
      await w.push();
      expect(w.self.registration.showNotification).toHaveBeenCalledOnce();
    }
  });
});

describe('service worker notifications (K-109)', () => {
  it('gives every preview its own notification, so a reply does not replace a question', async () => {
    const question = worker([], { nid: 'n1', type: 'question', summary: 'Proceed?', sessionId: 's1' });
    await question.push();
    const reply = worker([], { nid: 'n2', type: 'idle', summary: 'Done', sessionId: 's1' });
    await reply.push();
    const tagOf = (w: ReturnType<typeof worker>) => (w.self.registration.showNotification.mock.calls[0][1] as { tag?: string }).tag;
    expect(tagOf(question)).toBe('kraki-n1');
    expect(tagOf(reply)).toBe('kraki-n2');
  });

  it('a click opens the Session in the open tab, not just focuses it', async () => {
    const tab = win('/');
    const w = worker([tab], null);
    await w.click({ sessionId: 's1' });
    expect(tab.postMessage).toHaveBeenCalledWith({ type: 'kraki:open-session', sessionId: 's1' });
    expect(tab.focus).toHaveBeenCalled();
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a click with no tab open opens the Session in a new window', async () => {
    const w = worker([], null);
    await w.click({ sessionId: 's1' });
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(SCOPE + 'session/s1?from=notification');
  });
});
