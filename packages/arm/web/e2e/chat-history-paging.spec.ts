import { test, expect, type Page } from '@playwright/test';
import type { WebSocket } from 'ws';
import { MockRelayServer } from './helpers/mock-ws-server';
import { RangePeer, type RangeRequest } from './helpers/range-peer';

const SID = 'history-session';
const DEVICE = { id: 'tentacle-1', name: 'Mac', role: 'tentacle', kind: 'cli', online: true };
const session = (id = SID) => ({ id, deviceId: DEVICE.id, deviceName: 'Mac', agent: 'pi', model: 'm', state: 'idle', messageCount: 0, title: id === SID ? 'History fixture' : 'Other fixture' });
const row = (seq: number, type = 'user_message', content = `Message ${seq}: ${'history text '.repeat(8)}`) => ({
  type, seq, sessionId: SID, deviceId: DEVICE.id, timestamp: '2026-01-01T00:00:00Z', payload: { content },
});
const range = (from: number, to: number, type = 'user_message') => Array.from({ length: to - from + 1 }, (_, i) => row(from + i, type));
const node = (page: Page, seq: number) => page.locator(`[data-scroll-key="${seq}"]`);
const list = (page: Page) => page.locator('[data-chat-scroll]');
const y = (page: Page, seq: number) => node(page, seq).evaluate((el) => el.getBoundingClientRect().top);
const top = (page: Page) => list(page).evaluate((el) => el.scrollTop);

function batch(server: MockRelayServer, ws: WebSocket, messages: Record<string, unknown>[], sessionId = SID) {
  server.sendMessage(ws, { type: 'session_messages_range_batch', payload: {
    sessionId, messages, firstSeq: messages[0]?.seq ?? 0, lastSeq: messages.at(-1)?.seq ?? 0, truncated: false,
  } });
}

function reconcileTail(server: MockRelayServer, ws: WebSocket) {
  server.sendMessage(ws, { type: 'session_list', payload: { sessions: [
    { ...session(), lastSeq: 200, readSeq: 200 }, { ...session('other-session'), lastSeq: 0, readSeq: 0 },
  ] } });
}

async function fixture(page: Page, initial: Record<string, unknown>[], boundary = 0) {
  const server = await MockRelayServer.create();
  await page.setViewportSize({ width: 1240, height: 720 });
  const connection = server.waitForConnection();
  await page.goto(`/?relay=${encodeURIComponent(server.url)}&token=history-test`);
  const ws = await connection;
  const auth = await server.waitForMessage(ws);
  expect((auth.device as { encryptionKey?: string })?.encryptionKey).toBeTruthy();
  const peer = await RangePeer.create(ws);
  peer.onRequest = (request) => batch(server, ws, initial.filter((message) =>
    Number(message.seq) >= request.fromSeq && Number(message.seq) <= request.toSeq,
  ));
  const lastSeq = boundary ? Number(initial.at(-1)?.seq) : 0;
  server.sendAuthOk(ws, { devices: [{ ...DEVICE, encryptionKey: peer.publicKey }], sessions: [
    { ...session(), lastSeq, readSeq: boundary }, session('other-session'),
  ] });
  peer.connect();
  await expect(page.getByText('History fixture').first()).toBeVisible();
  batch(server, ws, initial);
  // Let the store and its asynchronous IDB writes finish before entry capture.
  await page.waitForTimeout(250);
  await page.getByText('History fixture').first().click();
  await expect(list(page)).toBeVisible();
  await expect(node(page, Number(initial.at(-1)?.seq))).toBeAttached();
  await page.waitForTimeout(700);
  peer.requests.length = 0;
  return { server, ws, peer };
}

async function wheelOlder(page: Page, amount = -1200) {
  await list(page).hover({ position: { x: 600, y: 200 } });
  await page.mouse.wheel(0, amount);
  await page.waitForTimeout(250);
}

async function expectLanded(page: Page, seq: number) {
  await expect.poll(() => y(page, seq)).toBeCloseTo(72, 0);
}

test('F2: tail arrivals retain the oldest rendered tall row and its reading offset', async ({ page }) => {
  const initial = range(1, 60);
  initial[0] = row(1, 'user_message', Array.from({ length: 180 }, (_, i) => `Tall row line ${i}`).join('\n'));
  const { server, ws } = await fixture(page, initial);
  try {
    await wheelOlder(page, -100000);
    await list(page).evaluate((el) => { el.scrollTop = 1200; });
    await page.waitForTimeout(100);
    const before = await y(page, 1);
    expect(await top(page)).toBeGreaterThan(900);
    for (let seq = 61; seq <= 75; seq++) {
      batch(server, ws, [row(seq)]);
      await page.waitForTimeout(30);
      await expect(node(page, 1)).toBeAttached();
      expect(Math.abs(await y(page, 1) - before)).toBeLessThan(1);
    }
  } finally { await server.close(); }
});

test('F3: entry includes the actual cached first unread, retaining it through arrivals and folding', async ({ page }) => {
  // Observe the initial committed window, before programmatic scroll events
  // could accidentally reveal skipped cached rows and hide a wrong landing.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const keys = [...document.querySelectorAll<HTMLElement>('[data-scroll-key]')].map((el) => el.dataset.scrollKey);
      if (keys.length === 0) return;
      (window as unknown as { firstChatWindow: (string | undefined)[] }).firstChatWindow = keys;
      observer.disconnect();
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  const initial = range(1, 100);
  initial[10] = row(11, 'agent_message', 'Actual first unread reply');
  const { server, ws } = await fixture(page, initial, 10);
  try {
    expect(await page.evaluate(() => (window as unknown as { firstChatWindow: string[] }).firstChatWindow[0])).toBe('11');
    await expect(node(page, 11)).toBeAttached();
    await expectLanded(page, 11);
    batch(server, ws, range(101, 110));
    await expect(node(page, 110)).toBeAttached();
    await expectLanded(page, 11);
    // A final conclusion folds the former unread segment into Steps.
    batch(server, ws, [row(12, 'agent_message', 'Concluding unread reply')]);
    await expect(node(page, 11)).toHaveCount(0);
    await expectLanded(page, 12);
  } finally { await server.close(); }
});

test('F8: entry and programmatic navigation do not page; real older input still reveals history', async ({ page }) => {
  const { server, peer } = await fixture(page, range(61, 160), 100);
  try {
    // The unread row is at the first rendered position, within the top band.
    await expectLanded(page, 101);
    expect(await list(page).locator('[data-scroll-key]').count()).toBe(60);
    expect(peer.requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await page.waitForTimeout(1100);
    expect(await list(page).locator('[data-scroll-key]').count()).toBe(60);
    expect(peer.requests).toHaveLength(0);
    // An older gesture above the trigger band must not leave permission for
    // a later geometry-only correction to reveal history.
    await wheelOlder(page, -100);
    expect(await top(page)).toBeGreaterThan(900);
    expect(await list(page).locator('[data-scroll-key]').count()).toBe(60);
    // Geometry-only scroll (the same event path as anchor compensation) is
    // not older intent, even if it crosses the top band.
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);
    expect(await list(page).locator('[data-scroll-key]').count()).toBe(60);
    expect(peer.requests).toHaveLength(0);
    // Actual native older movement crossing the trigger band still pages.
    await list(page).evaluate((el) => { el.scrollTop = 1000; });
    await page.waitForTimeout(100);
    await wheelOlder(page, -300);
    await expect(node(page, 61)).toBeAttached();
  } finally { await server.close(); }
});

for (const arrival of ['loaded', 'during polling'] as const) {
  test(`F4: a ${arrival} preceding reply navigates without waiting for unrelated network history`, async ({ page }) => {
    const initial = range(101, 140);
    if (arrival === 'loaded') initial[19] = row(120, 'agent_message', 'Loaded preceding reply');
    const { server, ws, peer } = await fixture(page, initial);
    try {
      peer.onRequest = () => {};
      reconcileTail(server, ws);
      await expect.poll(() => peer.requests.length).toBe(1);
      expect(peer.requests[0]).toMatchObject({ fromSeq: 151, toSeq: 200 });
      await page.getByRole('button', { name: 'Previous reply' }).click();
      if (arrival === 'during polling') {
        await page.waitForTimeout(100);
        batch(server, ws, [row(120, 'agent_message', 'Reply discovered during polling')]);
      }
      await expect.poll(() => y(page, 120), { timeout: 2000 }).toBeCloseTo(72, 0);
      expect(peer.requests).toHaveLength(1);
      // The unrelated tail request is still unresolved throughout navigation.
    } finally { await server.close(); }
  });
}

test('F4: previous reply lands on an incremental truncated page while its continuation is pending', async ({ page }) => {
  const { server, ws, peer } = await fixture(page, range(121, 130));
  try {
    peer.onRequest = () => {};
    await page.getByRole('button', { name: 'Previous reply' }).click();
    await expect.poll(() => peer.requests.length).toBe(1);
    expect(peer.requests[0]).toMatchObject({ fromSeq: 61, toSeq: 120 });
    server.sendMessage(ws, { type: 'session_messages_range_batch', payload: {
      sessionId: SID, messages: [row(90, 'agent_message', 'Incrementally delivered preceding reply')],
      firstSeq: 90, lastSeq: 90, truncated: true,
    } });
    await expect.poll(() => peer.requests.length).toBe(2);
    expect(peer.requests[1]).toMatchObject({ fromSeq: 61, toSeq: 89 });
    await expect(node(page, 90)).toBeAttached();
    // Navigation must not wait for the withheld continuation's 10s timeout.
    await expect.poll(() => y(page, 90), { timeout: 2000 }).toBeCloseTo(72, 0);
    await expect(page.getByRole('button', { name: 'Loading history' })).toBeDisabled();
    expect(peer.requests).toHaveLength(2);
  } finally { await server.close(); }
});

test('F4: previous reply lands on an incremental IDB cache hit while network history is pending', async ({ page }) => {
  const { server, peer } = await fixture(page, range(121, 170));
  try {
    peer.onRequest = () => {};
    // Seed disk only, after session entry: the reply is absent from memory
    // until this click's real provider range read delivers its cached rows.
    await page.evaluate((message) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kraki-messages');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('messages', 'readwrite');
        transaction.objectStore('messages').put({ sessionId: message.sessionId, seq: message.seq, data: message });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }), row(90, 'agent_message', 'Cached preceding reply'));
    await expect(list(page).locator('[data-scroll-key]')).toHaveCount(50);
    await expect(node(page, 90)).toHaveCount(0);
    await page.getByRole('button', { name: 'Previous reply' }).click();
    await expect.poll(() => peer.requests.length).toBe(1);
    expect(peer.requests[0]).toMatchObject({ fromSeq: 61, toSeq: 120 });
    await expect(node(page, 90)).toBeAttached();
    await expect.poll(() => y(page, 90), { timeout: 2000 }).toBeCloseTo(72, 0);
    await expect(page.getByRole('button', { name: 'Loading history' })).toBeDisabled();
    expect(peer.requests).toHaveLength(1);
  } finally { await server.close(); }
});

test('F11: a late timed-out tail response cannot complete a different older range', async ({ page }) => {
  const { server, ws, peer } = await fixture(page, range(121, 140));
  try {
    peer.onRequest = () => {};
    reconcileTail(server, ws);
    await expect.poll(() => peer.requests.length).toBe(1);
    await page.waitForTimeout(10_100);
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await wheelOlder(page, -100);
    await expect.poll(() => peer.requests.length).toBe(2);
    expect(peer.requests[1]).toMatchObject({ fromSeq: 61, toSeq: 120 });
    batch(server, ws, range(151, 200));
    await page.waitForTimeout(200);
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await wheelOlder(page, -100);
    expect(peer.requests).toHaveLength(2);
    batch(server, ws, [row(120)]);
    await expect(node(page, 120)).toBeAttached();
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await wheelOlder(page, -100);
    await expect.poll(() => peer.requests.length).toBe(3);
    expect(peer.requests[2]).toMatchObject({ fromSeq: 1, toSeq: 60 });
  } finally { await server.close(); }
});

test('tail error and Retry survive explicit older paging until tail recovery', async ({ page }) => {
  const { server, ws, peer } = await fixture(page, range(121, 140));
  try {
    peer.onRequest = () => {};
    reconcileTail(server, ws);
    const status = page.getByRole('status', { name: 'Conversation history' });
    const retry = page.getByRole('button', { name: 'Retry history' });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(status).toContainText('timed out');
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await wheelOlder(page, -100);
    await expect.poll(() => peer.requests.length).toBe(2);
    expect(peer.requests[1]).toMatchObject({ fromSeq: 61, toSeq: 120 });
    await expect(retry).toBeVisible();
    batch(server, ws, [row(120)]);
    await expect(node(page, 120)).toBeAttached();
    await expect(status).toContainText('timed out');
    await expect(retry).toBeVisible();
    await page.waitForTimeout(200);
    expect(peer.requests).toHaveLength(2); // No automatic follow-up or retry.
    await retry.click();
    await expect.poll(() => peer.requests.length).toBe(3);
    expect(peer.requests[2]).toMatchObject({ fromSeq: 151, toSeq: 200 });
    batch(server, ws, range(151, 200));
    await expect.poll(() => peer.requests.length).toBe(4);
    expect(peer.requests[3]).toMatchObject({ fromSeq: 141, toSeq: 150 });
    batch(server, ws, range(141, 150));
    await expect(status).toHaveCount(0);
  } finally { await server.close(); }
});

test('F4: one previous-reply click waits through a delayed page without replies, then lands on the older AI reply', async ({ page }) => {
  const { server, ws, peer } = await fixture(page, range(121, 130));
  try {
    const requests: RangeRequest[] = [];
    peer.onRequest = (request) => { requests.push(request); };
    await page.getByRole('button', { name: 'Previous reply' }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ fromSeq: 61, toSeq: 120 });
    await page.waitForTimeout(300);
    batch(server, ws, range(61, 120));
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({ fromSeq: 1, toSeq: 60 });
    batch(server, ws, [row(59), row(60, 'agent_message', 'The preceding AI reply')]);
    await expectLanded(page, 60);
  } finally { await server.close(); }
});

test('F4: one previous-reply click also waits for an older page already in flight', async ({ page }) => {
  const { server, ws, peer } = await fixture(page, range(121, 130));
  try {
    peer.onRequest = () => {};
    await list(page).evaluate((el) => { el.scrollTop = 0; });
    await wheelOlder(page, -100);
    await expect.poll(() => peer.requests.length).toBe(1);
    await page.getByRole('button', { name: 'Previous reply' }).click();
    await page.waitForTimeout(300);
    batch(server, ws, [row(120, 'agent_message', 'Already requested preceding reply')]);
    await expectLanded(page, 120);
    expect(peer.requests).toHaveLength(1);
  } finally { await server.close(); }
});

for (const cancel of ['latest', 'manual', 'session'] as const) {
  test(`F4: pending previous-reply navigation is cancelled by ${cancel}`, async ({ page }) => {
    const { server, ws, peer } = await fixture(page, range(121, 130));
    try {
      peer.onRequest = () => {};
      // Disengage so ↓ is visible, without requesting history.
      await list(page).evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'Previous reply' }).click();
      await expect.poll(() => peer.requests.length).toBe(1);
      if (cancel === 'latest') await page.getByRole('button', { name: 'Jump to latest' }).click();
      if (cancel === 'manual') await wheelOlder(page, 100);
      if (cancel === 'session') {
        await page.getByText('Other fixture').first().click();
        await expect(page.locator('.kchat')).toHaveAttribute('data-session', 'other-session');
      }
      batch(server, ws, [row(120, 'agent_message', 'Cancelled older reply')]);
      await page.waitForTimeout(1200);
      expect(peer.requests).toHaveLength(1);
      if (cancel !== 'session') {
        await expect(node(page, 120)).toBeAttached();
        expect(Math.abs(await y(page, 120) - 72)).toBeGreaterThan(10);
      } else await expect(node(page, 120)).toHaveCount(0);
    } finally { await server.close(); }
  });
}

for (const kind of ['metadata', 'empty'] as const) {
  test(`F11: continuing older input crosses a ${kind} page at the clamped edge without automatic chaining`, async ({ page }) => {
    const { server, ws, peer } = await fixture(page, range(121, 130));
    try {
      peer.onRequest = () => {};
      await list(page).evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(100);
      await wheelOlder(page, -100);
      await expect.poll(() => peer.requests.length).toBe(1);
      expect(peer.requests[0]).toMatchObject({ fromSeq: 61, toSeq: 120 });
      batch(server, ws, kind === 'empty' ? [] : range(61, 120, 'idle'));
      await page.waitForTimeout(400);
      expect(await top(page)).toBe(0);
      expect(peer.requests).toHaveLength(1);
      await wheelOlder(page, -100);
      await expect.poll(() => peer.requests.length).toBe(2);
      expect(peer.requests[1]).toMatchObject({ fromSeq: 1, toSeq: 60 });
      batch(server, ws, [row(60, 'agent_message', 'Renderable history past the gap')]);
      await expect(node(page, 60)).toBeAttached();
      await wheelOlder(page, -10000);
      await wheelOlder(page, -100);
      expect(peer.requests).toHaveLength(2);
    } finally { await server.close(); }
  });
}
