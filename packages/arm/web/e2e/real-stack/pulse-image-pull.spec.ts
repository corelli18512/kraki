import { test, expect, type Browser, type Page, request } from '@playwright/test';

/**
 * REAL-STACK image regression for paced attachment pulls.
 *
 * Proves a REAL PNG image produced by show_image (image ContentRef) still
 * renders after the broadcast was removed — the browser pulls the bytes on
 * demand via paced request_attachment (one 256 KiB chunk at a time) and
 * reassembles them into a displayable blob.
 *
 * The image is > 256 KiB (noise pixels) so it spans multiple chunks, exercising
 * the full paced reassembly path.
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
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('kraki_pulse_trace', '1');
  });
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return sessionId as string;
}

async function newPairedPage(browser: Browser, pageErrors: string[]): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await pairBrowser(page);
  return { page, close: () => context.close() };
}

test.describe.serial('real-stack pulse: image rendering via paced pull', () => {
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

  test('a multi-chunk PNG image renders in the chat via paced request_attachment', async ({ browser }) => {
    const sessionId = 'realstack-1';
    await page.goto(`${WEB_URL}/session/${sessionId}`);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await control('/idle', { sid: sessionId });

    // 1. Open a turn with a real user message (trace is keyed to user_message).
    const prompt = `show-me-an-image-${Date.now().toString(36)}`;
    const input = page.getByPlaceholder('Send a message…');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(async () => {
      const { messages } = await control('/received');
      return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
    }, { timeout: 15_000 }).toBe(true);

    // 2. Produce a > 256 KiB PNG via show_image → image ContentRef (multi-chunk).
    const reply = `IMG-${Date.now().toString(36)}`;
    const img = await control('/imageRef', { sid: sessionId, reply });
    const chunkCount = img.chunkCount as number;
    expect(chunkCount).toBeGreaterThan(1);

    // 3. The durable idle ref is live too. Let the producer's initial pull
    //    settle, then open a completely fresh Arm identity with no attachment
    //    cache or Pulse repair state.
    const liveImg = page.locator('[data-chat-scroll] img[alt="gen.png"]');
    await expect(liveImg).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => liveImg.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 30_000,
    }).toBeGreaterThan(0);
    const readsBeforeRecovery = ((await control('/attachmentReads')).reads as unknown[]).length;

    // 4. A fresh browser learns the ContentRef only from durable spine replay,
    //    then pulls the bytes. TRACE must not be used for artifact discovery.
    const recovery = await newPairedPage(browser, pageErrors);
    const recoveryPage = recovery.page;
    await recoveryPage.goto(`${WEB_URL}/session/${sessionId}`);
    await expect(recoveryPage.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await expect(recoveryPage.locator('[data-chat-scroll]').getByText(reply, { exact: false }).first())
      .toBeVisible({ timeout: 20_000 });

    // 5. The PNG <img> loads successfully — naturalWidth > 0 proves the
    //    browser reassembled all chunks into a valid, displayable PNG blob.
    const imgEl = recoveryPage.locator('[data-chat-scroll] img[alt="gen.png"]');
    await expect(imgEl).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => imgEl.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 30_000,
      message: 'image never decoded (naturalWidth stayed 0)',
    }).toBeGreaterThan(0);

    // 6. Artifact discovery is spine-only: no automatic TRACE pull occurred,
    //    while the bytes still arrived through the attachment path.
    const sentTypes = await recoveryPage.evaluate(() => ((window as unknown as { _pulseTrace?: Array<{ evt?: string; type?: string }> })._pulseTrace ?? [])
      .filter((event) => event.evt === 'APP-SEND-ENCRYPTED')
      .map((event) => event.type));
    expect(sentTypes).not.toContain('request_turn_trace');
    expect(sentTypes).toContain('request_attachment');

    // 7. The cold recovery pull served every chunk beyond the producer's live
    //    pull baseline.
    await expect.poll(async () => {
      const { reads } = await control('/attachmentReads');
      return (reads as unknown[]).length - readsBeforeRecovery;
    }, { timeout: 30_000, message: 'paced image recovery did not serve all chunks' }).toBe(chunkCount);

    await recovery.close();

    // 8. No browser errors.
    expect(pageErrors).toEqual([]);
  });
});
