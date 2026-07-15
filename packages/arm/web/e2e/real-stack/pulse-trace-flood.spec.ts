import { expect, type Page, request, test } from '@playwright/test';

/**
 * Production regression: reconnecting a large session caused many
 * turn_trace_batch responses to queue on the only Pulse seq space. Live pong,
 * echo, abort and idle frames sat behind them until Head dropped the browser.
 *
 * This drives the real application path:
 *   user_message → hundreds of persisted tool trace entries → concluding bubble
 *   → reload → request_turn_trace → turn_trace_batch (bulk stream 1), while a
 *   concurrent agent message rides live stream 0.
 */
const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB_URL = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const context = await request.newContext();
  const query = new URLSearchParams(params).toString();
  const response = await context.get(`${CONTROL}${path}${query ? `?${query}` : ''}`);
  const body = await response.json();
  await context.dispose();
  if (!response.ok()) throw new Error(`control ${path} failed: ${JSON.stringify(body)}`);
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

test('live echo stays responsive while a large turn trace is pulled on bulk', async ({ page }) => {
  const sessionId = await pairBrowser(page);
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
  await control('/idle', { sid: sessionId });

  const prompt = `trace-flood-turn-${Date.now().toString(36)}`;
  const input = page.getByPlaceholder('Send a message…');
  await input.fill(prompt);
  await input.press('Enter');
  await expect.poll(async () => {
    const { messages } = await control('/received');
    return (messages as Array<{ text: string }>).some((message) => message.text === prompt);
  }, { timeout: 15_000 }).toBe(true);

  const reply = `trace-flood-done-${Date.now().toString(36)}`;
  const flood = await control('/traceFlood', {
    sid: sessionId,
    n: '400',
    reply,
  });
  expect(flood.entries).toBe(802);
  await expect(page.locator('[data-chat-scroll]').getByText(reply, { exact: false }).first())
    .toBeVisible({ timeout: 20_000 });

  // Reload clears in-memory trace state. Mounting the concluded bubble issues
  // request_turn_trace and the Tentacle returns all 800 entries on stream 1.
  await page.reload();
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
  const live = `live-during-trace-${Date.now().toString(36)}`;
  const started = Date.now();
  await control('/msg', { sid: sessionId, text: live });
  await control('/idle', { sid: sessionId });
  await expect(page.locator('[data-chat-scroll]').getByText(live, { exact: false }).first())
    .toBeVisible({ timeout: 10_000 });
  const liveLatencyMs = Date.now() - started;
  expect(liveLatencyMs).toBeLessThan(5_000);

  // The bulk response also completes: the concluded bubble's Steps affordance
  // remains usable after the live message arrived.
  const replyBubble = page.locator('[data-chat-scroll]').getByText(reply, { exact: false }).first()
    .locator('xpath=ancestor::*[.//button[@aria-label="Open steps"]][1]');
  const steps = replyBubble.getByRole('button', { name: /Open steps/i });
  await expect(steps).toBeVisible({ timeout: 20_000 });
  await steps.click();
  await expect(page.getByRole('dialog').getByText(/echo trace-/i).first())
    .toBeVisible({ timeout: 20_000 });
});
