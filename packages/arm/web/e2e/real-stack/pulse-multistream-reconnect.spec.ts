import { expect, type Page, request, test } from '@playwright/test';

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

test('multi-stream reconnect resumes downlink and subsequent uplink', async ({ page }) => {
  const sessionId = await pairBrowser(page);
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
  await control('/idle', { sid: sessionId });

  await page.context().setOffline(true);
  const buffered = `buffered-live-${Date.now().toString(36)}`;
  await control('/msg', { sid: sessionId, text: buffered });
  await control('/idle', { sid: sessionId });
  await page.waitForTimeout(1_000);

  await page.context().setOffline(false);
  await expect(page.locator('[data-chat-scroll]').getByText(buffered, { exact: false }).first())
    .toBeVisible({ timeout: 25_000 });

  const prompt = `post-reconnect-uplink-${Date.now().toString(36)}`;
  const input = page.getByPlaceholder('Send a message…');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(prompt);
  await input.press('Enter');
  await expect.poll(async () => {
    const { messages } = await control('/received');
    return (messages as Array<{ text: string }>).some((message) => message.text === prompt);
  }, { timeout: 15_000, message: 'Arm uplink did not recover after multi-stream reconnect' }).toBe(true);
});
