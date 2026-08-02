import { expect, request, test, type Page } from '@playwright/test';

/**
 * REAL-STACK attachment reliability regression.
 *
 * Covers the production network failure chain end-to-end:
 *   1. the first paced request_attachment receives no response at all;
 *   2. the chunk watchdog retries;
 *   3. every returned chunk is reassembled and checksum/size verified;
 *   4. the PNG decodes and a following attachment is not head-of-line blocked.
 * Corrupt IndexedDB records are covered separately by attachments.test.ts.
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

async function pairBrowser(page: Page): Promise<void> {
  const { token, web } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Session ready. Ask me anything.', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

test('one lost chunk self-heals without blocking the next image', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  let page = await context.newPage();
  const pageErrors: string[] = [];
  const capturePageErrors = (target: Page) => target.on('pageerror', (error) => pageErrors.push(error.message));
  capturePageErrors(page);
  await pairBrowser(page);

  const sessionId = 'realstack-1';
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
  await control('/idle', { sid: sessionId });

  // Open a real turn. Persisted turn artifacts attach to the turn's concluding
  // agent bubble, so a bare show_image call without a user_message is not a
  // valid production shape.
  const prompt = `recover-this-image-${Date.now().toString(36)}`;
  const input = page.getByPlaceholder('Send a message…');
  await input.fill(prompt);
  await input.press('Enter');
  await expect.poll(async () => {
    const received = await control('/received');
    return (received.messages as Array<{ sid: string; text: string }>).some(
      (message) => message.sid === sessionId && message.text === prompt,
    );
  }, { timeout: 15_000 }).toBe(true);

  // Leave the detail view before the artifact exists so no image component can
  // race ahead and populate a valid cache entry.
  await page.goto(WEB_URL);
  const firstReply = `RECOVERY-${Date.now().toString(36)}`;
  const first = await control('/imageRef', { sid: sessionId, reply: firstReply });
  const firstRef = {
    id: first.id as string,
    mimeType: first.mimeType as string,
    size: first.size as number,
  };
  await expect(page.getByText(firstReply, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  // The image has never mounted, so this is a cold cache. Swallow the first
  // paced request and prove the watchdog retries without deadlocking the queue.
  await control('/dropNextAttachmentRequest', { id: firstRef.id });
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]').getByText(firstReply, { exact: false }).first())
    .toBeVisible({ timeout: 20_000 });
  const recovered = page.locator('[data-chat-scroll] img[alt="gen.png"]').last();
  await expect(recovered).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => recovered.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
    timeout: 45_000,
    message: 'image did not recover after chunk timeout and retry',
  }).toBeGreaterThan(0);

  const reads = await control('/attachmentReads');
  expect(reads.dropped).toBe(1);
  expect((reads.reads as Array<{ id: string }>).filter((read) => read.id === firstRef.id))
    .toHaveLength(first.chunkCount as number);

  // A second image must still pass through the same global queue. This catches
  // the original permanent head-of-line deadlock even if the first image happened
  // to recover visually through another path.
  const secondPrompt = `show-follow-up-${Date.now().toString(36)}`;
  const secondInput = page.getByPlaceholder('Send a message…');
  await secondInput.fill(secondPrompt);
  await secondInput.press('Enter');
  await expect.poll(async () => {
    const received = await control('/received');
    return (received.messages as Array<{ sid: string; text: string }>).some(
      (message) => message.sid === sessionId && message.text === secondPrompt,
    );
  }, { timeout: 15_000 }).toBe(true);
  const secondReply = `FOLLOW-UP-${Date.now().toString(36)}`;
  await control('/imageRef', { sid: sessionId, reply: secondReply });
  await expect(page.locator('[data-chat-scroll]').getByText(secondReply, { exact: false }).first())
    .toBeVisible({ timeout: 20_000 });
  const images = page.locator('[data-chat-scroll] img[alt="gen.png"]');
  await expect(images).toHaveCount(2, { timeout: 30_000 });
  await expect.poll(() => images.nth(1).evaluate((el) => (el as HTMLImageElement).naturalWidth), {
    timeout: 30_000,
  }).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  await context.close();
});
