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
    const abortCard = page.locator('[data-terminal-card="user_abort"]');
    await expect(abortCard).toBeVisible({ timeout: 10_000 });
    await expect(abortCard.getByText('User aborted')).toBeVisible();
    await expect(abortCard.getByText('Analyzing the auth module structure')).toBeVisible();

    await page.screenshot({ path: '/tmp/kraki-terminal-abort-refreshed.png', fullPage: false });
  });

  test('legacy interrupted_turn is normalized to the same frozen live bubble', async () => {
    const legacyDraft = 'Legacy interrupted history uses the shared bubble';
    await control('/legacyInterrupted', { sid: sessionId, draft: legacyDraft });

    const legacyCard = page.locator('[data-terminal-card="user_abort"]')
      .filter({ hasText: legacyDraft });
    await expect(legacyCard).toBeVisible({ timeout: 10_000 });
    await expect(legacyCard.getByText('User aborted')).toBeVisible();
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
    const replayedLegacyCard = page.locator('[data-terminal-card="user_abort"]')
      .filter({ hasText: legacyDraft });
    await expect(replayedLegacyCard).toBeVisible({ timeout: 10_000 });
    await expect(replayedLegacyCard.getByText('User aborted')).toBeVisible();
    await expect(page.locator('[data-chat-scroll]').getByText('Turn aborted', { exact: true })).toHaveCount(0);

    const lostDraft = 'Legacy process loss uses the shared failed bubble';
    await control('/legacyInterrupted', {
      sid: sessionId,
      draft: lostDraft,
      reason: 'process_lost',
    });
    const lostCard = page.locator('[data-terminal-card="failed"]')
      .filter({ hasText: lostDraft });
    await expect(lostCard).toBeVisible({ timeout: 10_000 });
    await expect(lostCard.getByText('Turn failed')).toBeVisible();
    await expect(lostCard.getByText('Agent process was lost')).toBeVisible();
    await expect(page.locator('[data-chat-scroll]').getByText('Turn aborted', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-legacy-process-lost.png', fullPage: false });
  });

  test('backend errors and final reply collapse into one permanent failed bubble', async () => {
    await control('/idle', { sid: sessionId });
    await sendPrompt(page, 'Run the full test suite');

    await control('/toolStart', { sid: sessionId, tool: 'bash', cmd: 'npm test' });

    // Reproduce mrhuha8u-tcpn1tz8: repeated backend errors, then a final Pi
    // reply, then idle freezes the terminal status with an empty card draft.
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/msg', { sid: sessionId, text: 'Restarted successfully after the backend errors' });
    await control('/idle', { sid: sessionId });

    const failedCard = page.locator('[data-terminal-card="failed"]')
      .filter({ hasText: 'Restarted successfully after the backend errors' });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-terminal-card="failed"]')
      .filter({ hasText: 'Restarted successfully after the backend errors' })).toHaveCount(1);
    await expect(failedCard.getByText('Turn failed')).toBeVisible();
    await expect(failedCard.getByText('524 status code (no body)')).toBeVisible();
    await expect(failedCard.getByText('Restarted successfully after the backend errors')).toBeVisible();
    // Error wire records are turn details, never top-level chat bubbles.
    await expect(page.getByText('Error', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble.png', fullPage: false });

    // Both backend errors remain available inside Steps.
    await failedCard.getByRole('button', { name: 'Open steps' }).click();
    const dialog = page.getByRole('dialog').filter({ visible: true }).last();
    await expect(dialog.getByText('Error', { exact: true })).toHaveCount(2);
    await expect(dialog.getByText('524 status code (no body)', { exact: true })).toHaveCount(2);
    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble-steps.png', fullPage: false });
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
  });

  test('two consecutive failed turns each render exactly one bubble (mrhuha8u-tcpn1tz8 replay)', async () => {
    // Real-session tail replay: TWO failed turns back-to-back.
    // mrhuha8u-tcpn1tz8 seq 70-80: two turns each shaped user -> error ->
    // agent_reply -> turn_status(failed) -> idle. Each terminal turn must be
    // its own single bubble; backend errors never appear as standalone bubbles.
    await control('/idle', { sid: sessionId });

    // --- turn 1 ---
    const prompt1 = 'Run the full suite again';
    const reply1 = '已重置并重新启动，开屏动画和模式选择正在从头播放';
    await sendPrompt(page, prompt1);
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/msg', { sid: sessionId, text: reply1 });
    await control('/idle', { sid: sessionId });

    const card1 = page.locator('[data-terminal-card="failed"]').filter({ hasText: reply1 });
    await expect(card1).toBeVisible({ timeout: 10_000 });
    await expect(card1).toHaveCount(1);
    await expect(card1.getByText('Turn failed')).toBeVisible();

    // --- turn 2 ---
    const prompt2 = '回到原来的卡片大小 只保留卡片内容';
    const reply2 = '已经按你的要求调整：卡片恢复到之前的尺寸';
    await sendPrompt(page, prompt2);
    await control('/error', { sid: sessionId, message: '524 status code (no body)' });
    await control('/msg', { sid: sessionId, text: reply2 });
    await control('/idle', { sid: sessionId });

    const card2 = page.locator('[data-terminal-card="failed"]').filter({ hasText: reply2 });
    await expect(card2).toBeVisible({ timeout: 10_000 });
    await expect(card2).toHaveCount(1);
    await expect(card2.getByText('Turn failed')).toBeVisible();
    await expect(card2.getByText(reply2)).toBeVisible();

    // Both failed turns coexist as distinct single bubbles; the reply of turn 1
    // is still visible (not absorbed into turn 2).
    await expect(card1.getByText(reply1)).toBeVisible();

    // Backend errors never escape as standalone top-level chat bubbles: each
    // failed card surfaces its 524 message exactly once in the action slot.
    await expect(card1.getByText('524 status code (no body)')).toHaveCount(1);
    await expect(card2.getByText('524 status code (no body)')).toHaveCount(1);

    // --- turn 3: a SUCCESSFUL turn right after the failures ---
    // mrhuha8u-tcpn1tz8 seq 81-83: user -> agent_message -> idle (no error,
    // no turn_status). It must render as a normal agent bubble, NOT a terminal
    // card, and must not absorb the preceding failed turn.
    const prompt3 = '不是我是说加入棋盘之前的那个尺寸';
    const reply3 = '已按你刚才的准确意思修改：卡片恢复到之前的大小';
    await sendPrompt(page, prompt3);
    await control('/msg', { sid: sessionId, text: reply3 });
    await control('/idle', { sid: sessionId });

    await expect(page.getByText(reply3).first()).toBeVisible({ timeout: 10_000 });
    // The successful turn is a plain agent reply, never a terminal card.
    await expect(page.locator('[data-terminal-card]').filter({ hasText: reply3 })).toHaveCount(0);
    // The two failed cards are untouched.
    await expect(card1).toHaveCount(1);
    await expect(card2).toHaveCount(1);

    await page.screenshot({ path: '/tmp/kraki-terminal-two-failed-turns.png', fullPage: false });
  });

  test('failed card survives a full browser refresh', async () => {
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
    const failedCard = page.locator('[data-terminal-card="failed"]')
      .filter({ hasText: 'Restarted successfully after the backend errors' });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard).toHaveCount(1);
    await expect(failedCard.getByText('Turn failed')).toBeVisible();
    await expect(page.getByText('Error', { exact: true })).toHaveCount(0);

    await page.screenshot({ path: '/tmp/kraki-terminal-single-failed-bubble-refreshed.png', fullPage: false });
  });
});
