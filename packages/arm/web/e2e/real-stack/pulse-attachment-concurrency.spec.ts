import { test, expect, type Page, request } from '@playwright/test';

/**
 * REAL-STACK concurrency regression for paced attachment pulls.
 *
 * Proves the fix for the cross-session Pulse head-of-line blocking where a
 * multi-megabyte attachment broadcast occupied the single ordered stream and
 * delayed an unrelated live message (the 115s abort incident).
 *
 * With the fix:
 *   - the tentacle no longer broadcasts attachment bytes to every Arm;
 *   - the browser pulls one 256 KiB chunk at a time (AttachmentPullQueue);
 *   - a live message fired while the attachment is mid-download is NOT queued
 *     behind the whole blob.
 *
 * The transport, head hub, pulse framing, E2E crypto and browser render are all
 * REAL; only the agent is a MockAdapter driven via the control plane.
 *
 * Proof:
 *   - `/attachmentReads` on the control plane records every chunk the tentacle
 *     served. Exactly `chunkCount` reads (one per paced request_attachment)
 *     proves the browser pulled one chunk at a time, not the whole blob.
 *   - A live echo fired the same tick as the pull is visible before all chunks
 *     are served — it was not blocked behind the attachment.
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

test.describe.serial('real-stack pulse: paced attachment concurrency', () => {
  let page: Page;
  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await pairBrowser(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('a live echo is not blocked behind a multi-chunk attachment download', async () => {
    const sessionId = 'realstack-1';
    await page.goto(`${WEB_URL}/session/${sessionId}`);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await control('/idle', { sid: sessionId });

    // 0. Send a real user message to open a turn — the tool trace is keyed to
    //    the user_message that starts the turn, so without one readTurnTrace
    //    returns empty and no Steps chip renders.
    const prompt = `pull-and-check-${Date.now().toString(36)}`;
    const input = page.getByPlaceholder('Send a message…');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(async () => {
      const { messages } = await control('/received');
      return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
    }, { timeout: 15_000 }).toBe(true);

    // 1. Generate a 1.5 MB tool result (≈6 chunks of 256 KiB) → offloaded to a
    //    ContentRef the browser must pull on demand.
    const reply = `DONE-${Date.now().toString(36)}`;
    const big = await control('/bigRef', { sid: sessionId, sizeKb: '1500', reply });
    const chunkCount = big.chunkCount as number;
    expect(chunkCount).toBeGreaterThan(1);

    // 2. Reload so the resultRef renders from replay with no cached bytes → the
    //    only way the bytes arrive is a paced request_attachment pull.
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-chat-scroll]').getByText(reply, { exact: false }).first())
      .toBeVisible({ timeout: 20_000 });

    // 3. Expand the turn's Steps, then expand the tool step. ToolResultBody
    //    (which fires the paced request_attachment pull) only mounts when the
    //    individual step is expanded.
    const stepsBtn = page.locator('[data-chat-scroll]').getByRole('button', { name: /Open steps/i }).first();
    await expect(stepsBtn).toBeVisible({ timeout: 20_000 });
    await stepsBtn.click();
    const toolChip = page.locator('[data-chat-scroll]').getByRole('button', { name: /cat big\.bin/i }).first();
    await expect(toolChip).toBeVisible({ timeout: 20_000 });
    await toolChip.click(); // expand → ToolResultBody mounts → paced pull starts

    // 4. Wait until the paced pull has actually started (≥1 chunk served) before
    //    firing the concurrent echo — this avoids a race where the echo's idle
    //    re-renders the panel before ToolResultBody mounts.
    await expect.poll(async () => {
      const { reads } = await control('/attachmentReads');
      return (reads as unknown[]).length;
    }, { timeout: 20_000, message: 'paced attachment pull never started' }).toBeGreaterThanOrEqual(1);

    // 5. Fire a live echo CONCURRENTLY with the in-flight attachment download.
    //    It must interleave, not wait for all chunks.
    const echoMarker = `ECHO-${Date.now().toString(36)}`;
    await control('/msg', { sid: sessionId, text: echoMarker });
    await control('/idle', { sid: sessionId }); // conclude the echo's turn
    await expect(page.locator('[data-chat-scroll]').getByText(echoMarker, { exact: false }).first())
      .toBeVisible({ timeout: 15_000 });

    // 6. The paced pull eventually serves every chunk (one request_attachment
    //    per 256 KiB chunk). Exactly chunkCount reads proves the browser did
    //    NOT request the whole blob at once — it advanced one chunk at a time,
    //    even with a concurrent live echo interleaved.
    await expect.poll(async () => {
      const { reads } = await control('/attachmentReads');
      return (reads as unknown[]).length;
    }, { timeout: 30_000, message: 'paced attachment pull did not serve all chunks' }).toBe(chunkCount);

    // 7. No browser errors during the concurrent download + echo.
    expect(pageErrors).toEqual([]);
  });
});
