/**
 * Reproduce: an OPEN question (durable in pending-human-action.json) that the
 * user CANNOT see — neither the sidebar attention indicator nor the answerable
 * card in chat — after a Tentacle process restart (e.g. upgrade) restored it.
 *
 * Confirmed root cause under test: after restart, resumeDisconnectedSessions
 * marks the session `disconnected` (→ digest `state:'idle'`) EVEN THOUGH a
 * question is open, so getSessionStatus() short-circuits to 'idle' before it
 * can see `previewType === 'question'` — the "waiting" indicator never shows,
 * and the live question card may not render either.
 */
import { expect, type Browser, type BrowserContext, type Page, request, test } from '@playwright/test';

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const query = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${query ? `?${query}` : ''}`);
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}
type Debug = { enrichedSessions: Array<{ id: string; state: string; preview?: { text: string; type: string } }>; openQuestions: Record<string, string[]>; subscriptions: Record<string, string | null> };
async function debug(): Promise<Debug> { return (await control('/debug')) as Debug; }
async function enrichedFor(sid: string) { return (await debug()).enrichedSessions.find((s) => s.id === sid); }
async function openQ(sid: string) { return (await debug()).openQuestions[sid] ?? []; }

async function pair(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { token } = await control('/token');
  await page.goto(`${WEB}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  const deviceId = await page.evaluate(() => JSON.parse(localStorage.getItem('kraki_device') ?? '{}').deviceId as string);
  return { context, page, deviceId };
}

async function sidebarCardFor(page: Page, marker: string): Promise<string | null> {
  // Session cards are <button> containing the preview text.
  return await page.evaluate((m) => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(m));
    return btn ? (btn.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) : null;
  }, marker).catch(() => null);
}

test.describe.serial('reproduce: open question invisible after restart (sidebar + chat)', () => {
  let arm: { context: BrowserContext; page: Page; deviceId: string };
  const sid = `restart-q-${Date.now().toString(36)}`;
  const QTEXT = `RESTARTQ-${Date.now().toString(36)}`;

  test.beforeAll(async ({ browser }) => {
    await control('/createSession', { id: sid });
    await control('/idle', { sid });
    arm = await pair(browser);
  });
  test.afterAll(async () => { await arm?.context.close(); });

  test('fresh question: sidebar shows attention + chat shows answer card', async () => {
    await control('/question', { sid, id: 'q-r', text: QTEXT, choices: 'alpha|beta' });
    await expect.poll(async () => (await openQ(sid)).length, { timeout: 15_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 800));

    const e = await enrichedFor(sid);
    const card = await sidebarCardFor(arm.page, QTEXT);
    console.log(`FRESH digest=${JSON.stringify(e)} sidebarCard=${JSON.stringify(card)}`);
    // Sidebar card carries the question text.
    expect(card).toBeTruthy();
    expect(card!).toContain(QTEXT);

    // Open the session via the sidebar card (real user gesture), check chat.
    await arm.page.goto(WEB);
    await new Promise((r) => setTimeout(r, 500));
    await arm.page.locator('button').filter({ hasText: QTEXT }).first().click();
    await expect(arm.page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await debug()).subscriptions[arm.deviceId], { timeout: 15_000 }).toBe(sid);
    await new Promise((r) => setTimeout(r, 1200));
    console.log(`FRESH-CHAT url=${arm.page.url()}`);
    await expect(arm.page.getByText(QTEXT, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(arm.page.getByRole('button', { name: 'alpha' })).toBeVisible({ timeout: 15_000 });
  });

  test('after restart: open question still surfaces pending despite idle transport state', async () => {
    await control('/tentacle/restart');
    await expect.poll(async () => (await openQ(sid)).length, { timeout: 20_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 1000));
    const e = await enrichedFor(sid);
    console.log(`RESTART digest=${JSON.stringify(e)}`);
    // The question is restored into the digest (preview is authoritative).
    expect(e?.preview).toMatchObject({ type: 'question', text: QTEXT });
    // The transport state may legitimately be 'idle' after restart, but the
    // sidebar status must still read pending so "waiting" shows. We assert it
    // via the rendered sidebar card text below.
  });

  test('after restart: sidebar attention + chat answer card still work', async () => {
    await arm.page.goto(WEB);
    await new Promise((r) => setTimeout(r, 800));
    const card = await sidebarCardFor(arm.page, QTEXT);
    console.log(`RESTART-SIDEBAR card=${JSON.stringify(card)}`);
    expect(card).toBeTruthy();
    expect(card!).toContain(QTEXT);
    // The "waiting" indicator must show even though the transport state is
    // idle after restart — the open question forces pending status.
    expect(card!).toContain('waiting');

    // Open the session and confirm the answerable question card renders.
    await arm.page.locator('button').filter({ hasText: QTEXT }).first().click();
    await expect(arm.page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await debug()).subscriptions[arm.deviceId], { timeout: 15_000 }).toBe(sid);
    await new Promise((r) => setTimeout(r, 1200));
    console.log(`RESTART-CHAT url=${arm.page.url()}`);
    await expect(arm.page.getByText(QTEXT, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(arm.page.getByRole('button', { name: 'alpha' })).toBeVisible({ timeout: 15_000 });
  });
});
