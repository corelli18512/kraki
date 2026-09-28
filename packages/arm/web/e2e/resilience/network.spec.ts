/**
 * Web client under network faults (docs/network-resilience-test-plan.md).
 * The real built web app runs in Chromium against a local Head + Tentacle
 * behind a fault-injection proxy. Nothing here touches production.
 */
import { expect, type Page, test } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

interface Stack { controlPort: number; appPort: number; tentacleId: string }
const stack = JSON.parse(readFileSync('/tmp/kraki-chaos/stack.json', 'utf8')) as Stack;
const CONTROL = `http://127.0.0.1:${stack.controlPort}`;
const RELAY = `ws://127.0.0.1:${stack.appPort}`;

async function control(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  return (await res.json()) as Record<string, unknown>;
}
const fault = (patch: Record<string, unknown>) => control('POST', '/fault', { link: 'app', ...patch });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function connections(): Promise<number> {
  return (((await control('GET', '/stats')).app as { total: number }).total);
}

/** Samples what the user sees, in the page, every 200 ms. */
function installSampler(): void {
  const w = window as unknown as { __k: { failedEver: boolean; reconnectingEver: boolean; blockedEver: boolean } };
  w.__k = { failedEver: false, reconnectingEver: false, blockedEver: false };
  setInterval(() => {
    if (document.querySelector('[aria-label="Not delivered. Retry or delete"]')) w.__k.failedEver = true;
    if (document.body.innerText.includes('Reconnecting')) w.__k.reconnectingEver = true;
    if (document.querySelector('[role="alertdialog"]')) w.__k.blockedEver = true;
  }, 200);
}

async function openSession(page: Page): Promise<string> {
  await control('POST', '/heal');
  const { sessionId } = await control('POST', '/session') as { sessionId: string };
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  const { token } = await control('POST', '/pairing-token') as { token: string };
  await page.goto(`/?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('Chaos Tentacle').first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await page.evaluate(installSampler);
  return sessionId;
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Send a message…' });
  await box.fill(text);
  await box.press('Enter');
}

type Metrics = Record<string, unknown>;
const results: Record<string, Metrics> = {};

/** Every text reaches the agent exactly once; the page shows no failure. */
async function expectDelivered(page: Page, sessionId: string, texts: string[], withinMs: number, m: Metrics): Promise<void> {
  const start = Date.now();
  let received: Record<string, number> = {};
  while (Date.now() - start < withinMs) {
    received = (await control('GET', `/ledger?sessionId=${sessionId}`)).received as Record<string, number>;
    const pending = await page.locator('.krow-user.is-sending').count();
    if (texts.every((t) => received[t]) && pending === 0) break;
    await pause(250);
  }
  m.settleMs = Date.now() - start;
  await pause(1_000);
  received = (await control('GET', `/ledger?sessionId=${sessionId}`)).received as Record<string, number>;
  const k = await page.evaluate(() => (window as unknown as { __k: Record<string, boolean> }).__k);
  Object.assign(m, k, {
    lost: texts.filter((t) => !received[t]),
    duplicated: texts.filter((t) => (received[t] ?? 0) > 1),
    stillSending: await page.locator('.krow-user.is-sending').count(),
  });
  expect(m.lost, 'G1: every input reaches the agent').toEqual([]);
  expect(m.duplicated, 'G2: exactly once').toEqual([]);
  expect(m.stillSending, 'G1/G4: all confirmed').toBe(0);
  expect(k.failedEver, 'G3: no "Not delivered" shown').toBe(false);
  expect(k.blockedEver, 'G4: the app is never blocked by a modal').toBe(false);
}

const uid = () => Math.random().toString(36).slice(2, 8);

test.describe('web network resilience', () => {
  test.afterEach(async ({}, info) => {
    await control('POST', '/heal');
    mkdirSync('/tmp/kraki-chaos/results', { recursive: true });
    writeFileSync(`/tmp/kraki-chaos/results/web_${info.title.split(' ')[0]}.json`, JSON.stringify(results[info.title] ?? {}, null, 2));
  });

  test('W0 healthy baseline', async ({ page }) => {
    const m: Metrics = (results['W0 healthy baseline'] = {});
    const sid = await openSession(page);
    const texts = [0, 1, 2].map((i) => `w0-${i}-${uid()}`);
    for (const t of texts) { await send(page, t); await pause(400); }
    await expectDelivered(page, sid, texts, 15_000, m);
  });

  test('W1 flash reset', async ({ page }) => {
    const m: Metrics = (results['W1 flash reset'] = {});
    const sid = await openSession(page);
    const before = await connections();
    const texts = [`w1-a-${uid()}`, `w1-b-${uid()}`];
    await send(page, texts[0]);
    await control('POST', '/reset', { link: 'app' });
    await send(page, texts[1]);
    await expectDelivered(page, sid, texts, 20_000, m);
    m.reconnects = (await connections()) - before;
    expect(m.reconnectingEver, 'G4: a sub-2 s blip shows no "Reconnecting"').toBe(false);
  });

  test('W2 outage 60s', async ({ page }) => {
    const m: Metrics = (results['W2 outage 60s'] = {});
    const sid = await openSession(page);
    await fault({ refuse: true });
    await control('POST', '/reset', { link: 'app' });
    const texts = [`w2-a-${uid()}`, `w2-b-${uid()}`];
    await pause(5_000); await send(page, texts[0]);
    await pause(30_000); await send(page, texts[1]);
    await pause(25_000);
    await control('POST', '/heal');
    await expectDelivered(page, sid, texts, 15_000, m);
  });

  test('W3 half-open', async ({ page }) => {
    const m: Metrics = (results['W3 half-open'] = {});
    const sid = await openSession(page);
    const before = await connections();
    await fault({ blackhole: 'both' });
    const texts = [`w3-${uid()}`];
    await send(page, texts[0]);
    const start = Date.now();
    while ((await connections()) === before && Date.now() - start < 90_000) await pause(250);
    m.deadLinkDetectMs = Date.now() - start;
    await control('POST', '/reset', { link: 'app' });
    await control('POST', '/heal');
    await expectDelivered(page, sid, texts, 20_000, m);
    expect(m.deadLinkDetectMs as number, 'G5: half-open detected within 30 s').toBeLessThanOrEqual(30_000);
  });

  test('W4 large message on a slow link', async ({ page }) => {
    const m: Metrics = (results['W4 large message on a slow link'] = {});
    const sid = await openSession(page);
    const before = await connections();
    await fault({ bytesPerSec: 40_000 }); // 0.32 Mbit/s
    await control('POST', '/agent/burst', { sessionId: sid, count: 1, bytes: 1_000_000, prefix: 'huge' });
    await pause(3_000);
    const texts = [`w4-${uid()}`];
    await send(page, texts[0]);
    await expectDelivered(page, sid, texts, 150_000, m);
    m.reconnects = (await connections()) - before;
    expect(m.reconnects, 'G6: a slow large message is not a dead link').toBe(0);
  });

  test('W5 reload with an unconfirmed input', async ({ page }) => {
    const m: Metrics = (results['W5 reload with an unconfirmed input'] = {});
    const sid = await openSession(page);
    await fault({ blackhole: 'both' });
    const texts = [`w5-${uid()}`];
    await send(page, texts[0]);
    await pause(1_000);
    await control('POST', '/reset', { link: 'app' });
    await control('POST', '/heal');
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(installSampler);
    await expectDelivered(page, sid, texts, 30_000, m);
  });
});
