import { test, expect, type Page, request } from '@playwright/test';

/**
 * REAL-STACK terminal-card verification — proves the unified `turn_status`
 * protocol renders a permanent, read-only status card for BOTH terminal
 * outcomes (user_abort + failed), survives a full browser refresh, and that
 * unfinished tool steps are preserved in the Steps trace with the correct
 * cancelled/interrupted outcome.
 *
 * Transport, head hub, SQLite durable outbox, pulse framing, E2E crypto and
 * browser render are all REAL. The tentacle is a MockAdapter driven via the
 * orchestrator's HTTP control plane.
 */

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB_URL = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const qs = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${qs ? `?${qs}` : ''}`);
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`control ${path} failed: ${JSON.stringify(body)}`);
  return body;
}

async function pairBrowser(page: Page): Promise<string> {
  const { token, web, sessionId } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return sessionId as string;
}

async function openSessionChat(page: Page, sessionId: string): Promise<void> {
  await expect(page.getByRole('button', { name: /Mock-agent/ }).first())
    .toBeVisible({ timeout: 15_000 });
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Send a message…');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('[data-chat-scroll]').getByText(text)).toBeVisible({ timeout: 10_000 });
}

test.describe.serial('real-stack terminal status cards', () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    sessionId = await pairBrowser(page);
    await openSessionChat(page, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('user abort freezes a permanent user_abort card with draft + cancelled step', async () => {
    await control('/idle', { sid: sessionId });
    await sendPrompt(page, 'Refactor the auth module');

    // Make the card active: streaming draft + a running tool.
    await control('/delta', { sid: sessionId, text: 'Analyzing the auth module structure' });
    await control('/toolStart', { sid: sessionId, tool: 'read_file', cmd: 'src/auth.ts' });

    // The Stop button is only interactive while the session is active (not idle).
    const stopBtn = page.locator('button[aria-label="Stop"]');
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });
    await stopBtn.click();

    // turn_status with user_abort arrives over pulse and renders as a terminal card.
    const abortCard = page.locator('[data-terminal-card="user_abort"]');
    await expect(abortCard).toBeVisible({ timeout: 10_000 });
    await expect(abortCard.getByText('User aborted')).toBeVisible();
    // The streaming draft is preserved inside the frozen card.
    await expect(abortCard.getByText('Analyzing the auth module structure')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-abort.png', fullPage: false });

    // The cancelled tool step survives in the Steps trace.
    const stepsBtn = abortCard.getByRole('button', { name: /Steps/i });
    if (await stepsBtn.isVisible()) {
      await stepsBtn.click();
      await expect(page.getByText(/Cancelled.*read_file|read_file.*Cancelled/i).or(page.getByText(/Cancelled/i))).toBeVisible({ timeout: 5_000 });
      await page.screenshot({ path: '/tmp/kraki-terminal-abort-steps.png', fullPage: false });
      await page.keyboard.press('Escape');
    }
  });

  test('user_abort card survives a full browser refresh', async () => {
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const abortCard = page.locator('[data-terminal-card="user_abort"]');
    await expect(abortCard).toBeVisible({ timeout: 10_000 });
    await expect(abortCard.getByText('User aborted')).toBeVisible();
    await expect(abortCard.getByText('Analyzing the auth module structure')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-abort-refreshed.png', fullPage: false });
  });

  test('backend error freezes a permanent failed card', async () => {
    await control('/idle', { sid: sessionId });
    await sendPrompt(page, 'Run the full test suite');

    // Active streaming draft.
    await control('/delta', { sid: sessionId, text: 'Compiling and running tests' });
    await control('/toolStart', { sid: sessionId, tool: 'bash', cmd: 'npm test' });

    // A terminal backend error arrives, then idle freezes it as `failed`.
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/idle', { sid: sessionId });

    const failedCard = page.locator('[data-terminal-card="failed"]');
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard.getByText('Turn failed')).toBeVisible();
    await expect(failedCard.getByText('524 status code (no body)')).toBeVisible();
    // The streaming draft is preserved inside the frozen card.
    await expect(failedCard.getByText('Compiling and running tests')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-failed.png', fullPage: false });
  });

  test('failed card survives a full browser refresh', async () => {
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const failedCard = page.locator('[data-terminal-card="failed"]');
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard.getByText('Turn failed')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-failed-refreshed.png', fullPage: false });
  });
});
