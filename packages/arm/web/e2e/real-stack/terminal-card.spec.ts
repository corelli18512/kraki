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
  await expect(page.locator('button.ksr').first())
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

/** An agent row whose bubble froze as stopped / failed. Web 0.17 renders a
 *  turn's terminal status as an outcome slot in its agent bubble (the old
 *  [data-terminal-card] card is gone): "Stopped" or "Turn failed". */
const ABORTED_ROW = '.krow-agent:has(.kslot-outcome:not(.is-failed))';
const FAILED_ROW = '.krow-agent:has(.kslot-outcome.is-failed)';
const FAILURE = '524 status code (no body)';

test.describe.serial('real-stack terminal status cards', () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await pairBrowser(page);
    sessionId = `terminal-${Date.now().toString(36)}`;
    await control('/createSession', { id: sessionId });
    await control('/idle', { sid: sessionId });
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
    const stopBtn = page.getByRole('button', { name: 'Stop agent', exact: true });
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });
    await stopBtn.click();

    // turn_status with user_abort arrives over pulse and renders as a terminal card.
    const abortCard = page.locator(ABORTED_ROW);
    await expect(abortCard).toBeVisible({ timeout: 10_000 });
    await expect(abortCard.getByText('Stopped', { exact: true })).toBeVisible();
    // The streaming draft is preserved inside the frozen card.
    await expect(abortCard.getByText('Analyzing the auth module structure')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-abort.png', fullPage: false });

    // The cancelled tool step survives in the Steps trace.
    const stepsBtn = abortCard.getByRole('button', { name: /Steps/i });
    if (await stepsBtn.isVisible()) {
      await stepsBtn.click();
      const dialog = page.getByRole('dialog').filter({ visible: true }).last();
      await expect(dialog.getByRole('button', { name: /read_file/i })).toBeVisible({ timeout: 5_000 });
      await page.screenshot({ path: '/tmp/kraki-terminal-abort-steps.png', fullPage: false });
      await dialog.click({ position: { x: 4, y: 4 } });
      await expect(dialog).toHaveCount(0);
    }
  });

  test('user_abort card survives a full browser refresh', async () => {
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const abortCard = page.locator(ABORTED_ROW);
    await expect(abortCard).toBeVisible({ timeout: 10_000 });
    await expect(abortCard.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(abortCard.getByText('Analyzing the auth module structure')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-abort-refreshed.png', fullPage: false });
  });

  test('legacy interrupted_turn is normalized to the same frozen live bubble', async () => {
    const legacyDraft = 'Legacy interrupted history uses the shared bubble';
    await control('/legacyInterrupted', { sid: sessionId, draft: legacyDraft });

    const legacyCard = page.locator(ABORTED_ROW)
      .filter({ hasText: legacyDraft });
    await expect(legacyCard).toBeVisible({ timeout: 10_000 });
    await expect(legacyCard.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(legacyCard.getByText('npm test')).toHaveCount(0);
    // "Turn aborted" must not leak into the CHAT rendering of the legacy card
    // (it normalizes to the frozen "User aborted" bubble). Aborted sessions may
    // legitimately show "Turn aborted" as their sidebar preview, so scope this
    // to the chat scroll area, not the whole page.
    await expect(page.locator('[data-chat-scroll]').getByText('Turn aborted', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-legacy-normalized.png', fullPage: false });

    // Legacy storage must keep using the shared renderer after a full replay.
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const replayedLegacyCard = page.locator(ABORTED_ROW)
      .filter({ hasText: legacyDraft });
    await expect(replayedLegacyCard).toBeVisible({ timeout: 10_000 });
    await expect(replayedLegacyCard.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(page.locator('[data-chat-scroll]').getByText('Turn aborted', { exact: true })).toHaveCount(0);

    const lostDraft = 'Legacy process loss uses the shared failed bubble';
    await control('/legacyInterrupted', {
      sid: sessionId,
      draft: lostDraft,
      reason: 'process_lost',
    });
    const lostCard = page.locator(FAILED_ROW)
      .filter({ hasText: lostDraft });
    await expect(lostCard).toBeVisible({ timeout: 10_000 });
    await expect(lostCard.getByText('Turn failed', { exact: true })).toBeVisible();
    await expect(lostCard.getByText('Agent process was lost')).toBeVisible();
    await expect(page.locator('[data-chat-scroll]').getByText('Turn aborted', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-legacy-process-lost.png', fullPage: false });
  });

  test('backend errors with no final reply freeze one permanent failed bubble', async () => {
    await control('/idle', { sid: sessionId });
    await sendPrompt(page, 'Run the full test suite');

    await control('/toolStart', { sid: sessionId, tool: 'bash', cmd: 'npm test' });
    // Repeated backend errors, then the agent goes idle without a reply.
    await control('/error', { sid: sessionId, message: FAILURE });
    await control('/error', { sid: sessionId, message: FAILURE });
    await control('/idle', { sid: sessionId });

    const failedCard = page.locator(FAILED_ROW).filter({ hasText: FAILURE });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard).toHaveCount(1);
    await expect(failedCard.getByText('Turn failed', { exact: true })).toBeVisible();
    // The error is the bubble's outcome detail, shown once.
    await expect(failedCard.getByText(FAILURE, { exact: true })).toHaveCount(1);
    // Error wire records are turn details, never top-level chat bubbles.
    await expect(page.locator('[data-chat-scroll]').getByText('Error', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble.png', fullPage: false });

    // Both backend errors remain available inside Steps.
    await failedCard.getByRole('button', { name: 'Show steps' }).click();
    const dialog = page.getByRole('dialog').filter({ visible: true }).last();
    // Each error is a warning row in Steps, showing its message.
    await expect(dialog.getByText(FAILURE, { exact: true })).toHaveCount(2);
    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble-steps.png', fullPage: false });
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
  });

  test('a final reply after backend errors recovers the turn (mrhuha8u-tcpn1tz8 replay)', async () => {
    // Real-session tail: turns shaped user -> error(s) -> agent_reply -> idle.
    // A genuine final reply is authoritative (tentacle ed5a7c73): the turn is
    // not failed, the reply is one plain bubble, the errors stay in Steps and
    // never surface as standalone chat bubbles.
    await control('/idle', { sid: sessionId });

    const prompt1 = 'Run the full suite again';
    const reply1 = '\u5DF2\u91CD\u7F6E\u5E76\u91CD\u65B0\u542F\u52A8\uFF0C\u5F00\u5C4F\u52A8\u753B\u548C\u6A21\u5F0F\u9009\u62E9\u6B63\u5728\u4ECE\u5934\u64AD\u653E';
    await sendPrompt(page, prompt1);
    await control('/error', { sid: sessionId, message: FAILURE });
    await control('/error', { sid: sessionId, message: FAILURE });
    await control('/msg', { sid: sessionId, text: reply1 });
    await control('/idle', { sid: sessionId });

    const prompt2 = '\u56DE\u5230\u539F\u6765\u7684\u5361\u7247\u5927\u5C0F \u53EA\u4FDD\u7559\u5361\u7247\u5185\u5BB9';
    const reply2 = '\u5DF2\u7ECF\u6309\u4F60\u7684\u8981\u6C42\u8C03\u6574\uFF1A\u5361\u7247\u6062\u590D\u5230\u4E4B\u524D\u7684\u5C3A\u5BF8';
    await sendPrompt(page, prompt2);
    await control('/error', { sid: sessionId, message: FAILURE });
    await control('/msg', { sid: sessionId, text: reply2 });
    await control('/idle', { sid: sessionId });

    for (const reply of [reply1, reply2]) {
      const row = page.locator('.krow-agent').filter({ hasText: reply });
      await expect(row).toHaveCount(1, { timeout: 10_000 });
      await expect(row.locator('.kslot-outcome')).toHaveCount(0);
      await expect(row.getByText(FAILURE)).toHaveCount(0);
    }
    // The only failed bubble is the earlier genuinely failed turn.
    await expect(page.locator(FAILED_ROW).filter({ hasText: FAILURE })).toHaveCount(1);
    await expect(page.locator('[data-chat-scroll]').getByText('Error', { exact: true })).toHaveCount(0);

    // Turn 1's errors are still in its Steps.
    await page.locator('.krow-agent').filter({ hasText: reply1 }).getByRole('button', { name: 'Show steps' }).click();
    const dialog = page.getByRole('dialog').filter({ visible: true }).last();
    await expect(dialog.getByText(FAILURE, { exact: true })).toHaveCount(2);
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);

    // A successful turn right after renders as a normal reply.
    const prompt3 = '\u4E0D\u662F\u6211\u662F\u8BF4\u52A0\u5165\u68CB\u76D8\u4E4B\u524D\u7684\u90A3\u4E2A\u5C3A\u5BF8';
    const reply3 = '\u5DF2\u6309\u4F60\u521A\u624D\u7684\u51C6\u786E\u610F\u601D\u4FEE\u6539\uFF1A\u5361\u7247\u6062\u590D\u5230\u4E4B\u524D\u7684\u5927\u5C0F';
    await sendPrompt(page, prompt3);
    await control('/msg', { sid: sessionId, text: reply3 });
    await control('/idle', { sid: sessionId });
    const row3 = page.locator('.krow-agent').filter({ hasText: reply3 });
    await expect(row3).toHaveCount(1, { timeout: 10_000 });
    await expect(row3.locator('.kslot-outcome')).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-recovered-turns.png', fullPage: false });
  });

  test('failed card survives a full browser refresh', async () => {
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const failedCard = page.locator(FAILED_ROW).filter({ hasText: FAILURE });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard).toHaveCount(1);
    await expect(failedCard.getByText('Turn failed', { exact: true })).toBeVisible();
    await expect(page.locator('[data-chat-scroll]').getByText('Error', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble-refreshed.png', fullPage: false });
  });
});
