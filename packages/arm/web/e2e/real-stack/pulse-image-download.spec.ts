import { readFile } from 'node:fs/promises';
import { test, expect, type Download, type Page, request } from '@playwright/test';

/**
 * REAL-STACK: an animated GIF shown by an agent reaches the browser as the
 * GIF itself (not a re-encoded still), and both Download actions (the image
 * menu and the viewer's button) save exactly those bytes as `party.gif`.
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

async function pairBrowser(page: Page): Promise<void> {
  const { token, web } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
}

async function savedBase64(download: Download): Promise<string> {
  const path = await download.path();
  return (await readFile(path)).toString('base64');
}

test('an agent GIF stays a GIF and downloads as the original file', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await pairBrowser(page);
  const sessionId = 'realstack-1';
  await page.goto(`${WEB_URL}/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
  await control('/idle', { sid: sessionId });

  // Images an agent shows belong to a turn: open one with a user message.
  const prompt = `show-me-a-gif-${Date.now().toString(36)}`;
  const input = page.getByPlaceholder('Send a message…');
  await input.fill(prompt);
  await input.press('Enter');
  await expect.poll(async () => {
    const { messages } = await control('/received');
    return (messages as Array<{ text: string }>).some((m) => m.text === prompt);
  }, { timeout: 15_000 }).toBe(true);

  const reply = `GIF-${Date.now().toString(36)}`;
  const gif = await control('/gifRef', { sid: sessionId, reply });
  const tile = page.locator('[data-chat-scroll] img[alt="party.gif"]').last();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => tile.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBe(24);

  // The tile shows the pulled bytes themselves: the GIF, every frame.
  const shown = await tile.evaluate(async (el) => {
    const blob = await (await fetch((el as HTMLImageElement).src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { type: blob.type, base64: btoa(binary) };
  });
  expect(shown).toEqual({ type: 'image/gif', base64: gif.base64 });

  // Right-click → Download Image.
  await tile.click({ button: 'right' });
  const fromMenu = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download Image' }).click();
  const menuDownload = await fromMenu;
  expect(menuDownload.suggestedFilename()).toBe('party.gif');
  expect(await savedBase64(menuDownload)).toBe(gif.base64);

  // Viewer → Download.
  await tile.click();
  await expect(page.getByRole('dialog', { name: 'Image preview' })).toBeVisible();
  const fromViewer = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download image' }).click();
  const viewerDownload = await fromViewer;
  expect(viewerDownload.suggestedFilename()).toBe('party.gif');
  expect(await savedBase64(viewerDownload)).toBe(gif.base64);

  expect(pageErrors).toEqual([]);
});
