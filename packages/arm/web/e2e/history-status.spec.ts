import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';

const SESSION = { id: 'history-status', deviceId: 'tentacle-1', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0, title: 'History status' };
const DEVICE = { id: 'tentacle-1', name: 'Mac', role: 'tentacle', online: true };

const geometry = (page: Page) => page.evaluate(() => {
  const rect = (selector: string) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  };
  const button = document.querySelector<HTMLButtonElement>('.khistory-status button')!;
  const r = button.getBoundingClientRect();
  return {
    dock: rect('.kcomposer-dock'), strip: rect('.khistory-status'),
    padding: parseFloat(document.querySelector<HTMLElement>('.kchat-scroll-content')!.style.paddingBottom),
    actionable: [[r.x + r.width / 2, r.y + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]]
      .every(([x, y]) => button.contains(document.elementFromPoint(x, y))),
  };
});

for (const width of [1280, 390]) {
  test(`history retry clears draft, compaction and intrinsic dock growth (${width})`, async ({ page }) => {
    const server = await MockRelayServer.create();
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await page.evaluate(() => localStorage.clear());
      await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
      const ws = await server.waitForConnection();
      await server.waitForMessage(ws);
      server.sendAuthOk(ws, { sessions: [SESSION], devices: [DEVICE] });
      await server.waitForMessage(ws);
      await page.getByText('History status').first().click();
      await expect(page.locator('[data-chat-scroll]')).toBeVisible();
      for (let seq = 1; seq <= 10; seq++) server.sendMessage(ws, {
        type: 'user_message', sessionId: SESSION.id, seq, payload: { content: `Cached history ${seq}` },
      });
      await expect(page.getByRole('main').getByText('Cached history 10', { exact: true })).toBeVisible();
      server.sendMessage(ws, { type: 'session_list', payload: { sessions: [{ ...SESSION, lastSeq: 100, readSeq: 0, createdAt: '' }] } });
      const retry = page.getByRole('button', { name: 'Retry history' });
      await expect(retry).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('status', { name: 'Conversation history' })).toContainText('timed out');
      const editor = page.getByRole('textbox').last();
      const assertClearance = async () => {
        const measured = await geometry(page);
        expect(measured.strip.bottom).toBeLessThanOrEqual(measured.dock.top - 3);
        expect(measured.actionable).toBe(true);
        expect(measured.padding).toBeCloseTo(measured.dock.height + measured.strip.height + 8, 0);
        return measured;
      };
      const baseline = await assertClearance();
      await editor.fill('First line\nSecond line\nThird line\nFourth line');
      server.sendMessage(ws, { type: 'compacting', sessionId: SESSION.id, payload: { phase: 'start' } });
      await expect(page.getByRole('status', { name: 'Compacting context' })).toBeVisible();
      const grown = await assertClearance();
      expect(grown.dock.height).toBeGreaterThan(baseline.dock.height);
      await editor.fill('');
      const shrunk = await assertClearance();
      expect(shrunk.dock.height).toBeLessThan(grown.dock.height);
      // Uncapped wrapping: resize produces a genuine intrinsic height change.
      const wrappingDraft = 'Ordinary wrapping words for a width change. '.repeat(width === 1280 ? 2 : 3);
      await editor.fill(wrappingDraft);
      const beforeResize = await assertClearance();
      await page.setViewportSize({ width: width === 1280 ? 900 : 320, height: 844 });
      // Sample inside RAF after native ResizeObserver delivery, not in a later task.
      const afterResize = await page.evaluate(() => new Promise<{ dock: number; strip: number; padding: number }>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({ dock: document.querySelector('.kcomposer-dock')!.getBoundingClientRect().height,
            strip: document.querySelector('.khistory-status')!.getBoundingClientRect().height,
            padding: parseFloat(document.querySelector<HTMLElement>('.kchat-scroll-content')!.style.paddingBottom) });
        }));
      }));
      expect(afterResize.dock).not.toBe(beforeResize.dock.height);
      expect(afterResize.padding).toBeCloseTo(afterResize.dock + afterResize.strip + 8, 0);
      await assertClearance();
      await retry.click();
      await expect(page.getByRole('button', { name: 'Loading history' })).toBeDisabled();
      // Tail, then bounded bridge repair, both through the real range consumer.
      const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ type: 'user_message', sessionId: SESSION.id, deviceId: DEVICE.id, seq: from + i, timestamp: '', payload: { content: `Loaded history ${from + i}` } }));
      server.sendMessage(ws, { type: 'session_messages_range_batch', payload: { sessionId: SESSION.id, messages: rows(51, 100), firstSeq: 51, lastSeq: 100, truncated: false } });
      await expect(page.getByRole('main').getByText('Loaded history 100', { exact: true })).toBeVisible();
      server.sendMessage(ws, { type: 'session_messages_range_batch', payload: { sessionId: SESSION.id, messages: rows(11, 50), firstSeq: 11, lastSeq: 50, truncated: false } });
      await expect(page.getByRole('status', { name: 'Conversation history' })).toHaveCount(0);
      await expect(editor).toHaveValue(wrappingDraft);
    } finally { await server.close(); }
  });
}

test('a closing idle served from held history never shows the loading strip', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
    const ws = await server.waitForConnection();
    await server.waitForMessage(ws);
    server.sendAuthOk(ws, { sessions: [SESSION], devices: [DEVICE] });
    await server.waitForMessage(ws);
    await page.getByText('History status').first().click();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible();
    for (let seq = 1; seq <= 10; seq++) server.sendMessage(ws, {
      type: 'user_message', sessionId: SESSION.id, seq, payload: { content: `Held history ${seq}` },
    });
    await expect(page.getByRole('main').getByText('Held history 10', { exact: true })).toBeVisible();
    await expect(page.locator('.khistory-status')).toHaveCount(0);
    // Record every strip the DOM ever gets, even one removed before a paint.
    await page.evaluate(() => {
      const w = window as unknown as { stripSeen: number };
      w.stripSeen = 0;
      new MutationObserver(() => { if (document.querySelector('.khistory-status')) w.stripSeen++; })
        .observe(document.body, { childList: true, subtree: true });
    });
    for (let turn = 0; turn < 3; turn++) {
      const seq = 11 + turn * 2;
      server.sendMessage(ws, { type: 'agent_message', sessionId: SESSION.id, seq, payload: { content: `Reply ${turn}` } });
      server.sendMessage(ws, { type: 'idle', sessionId: SESSION.id, seq: seq + 1, payload: {} });
      await expect(page.getByRole('main').getByText(`Reply ${turn}`, { exact: true })).toBeVisible();
      await page.waitForTimeout(300);
    }
    expect(await page.evaluate(() => (window as unknown as { stripSeen: number }).stripSeen)).toBe(0);
  } finally { await server.close(); }
});
