import { test, expect } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';

const SESSION_ID = 'session-viewport-lock';
const DEVICE_ID = 'tentacle-viewport-lock';

test('locks the document viewport while keeping chat independently scrollable', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const connection = server.waitForConnection();
    const navigation = page.goto(`/?relay=${encodeURIComponent(server.url)}`);
    const ws = await connection;
    const authMessage = server.waitForMessage(ws);
    await navigation;
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--kraki-safe-area-top', '47px');
    });

    await authMessage;
    server.sendAuthOk(ws, {
      devices: [{
        id: DEVICE_ID,
        name: 'Viewport Tentacle',
        role: 'tentacle',
        kind: 'cli',
        online: true,
      }],
      sessions: [{
        id: SESSION_ID,
        deviceId: DEVICE_ID,
        deviceName: 'Viewport Tentacle',
        agent: 'copilot',
        state: 'active',
        messageCount: 80,
        preview: {
          text: 'Viewport regression session',
          type: 'agent',
          timestamp: new Date().toISOString(),
        },
      }],
    });

    const card = page.locator('button').filter({ hasText: 'Viewport regression session' }).filter({ visible: true }).first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.click();

    for (let i = 0; i < 80; i++) {
      server.sendMessage(ws, {
        type: i % 2 === 0 ? 'user_message' : 'agent_message',
        sessionId: SESSION_ID,
        seq: i + 1,
        payload: { content: `Viewport line ${i}: ${'content '.repeat(12)}` },
      });
    }

    const chat = page.locator('[data-chat-scroll]');
    await expect(chat).toBeVisible();
    await expect(page.getByText('Viewport line 79:', { exact: false })).toBeVisible();

    const viewport = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      htmlClientHeight: document.documentElement.clientHeight,
      htmlScrollHeight: document.documentElement.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      rootClientHeight: document.getElementById('root')!.clientHeight,
      rootScrollHeight: document.getElementById('root')!.scrollHeight,
      appClientHeight: document.querySelector<HTMLElement>('.app-viewport')!.clientHeight,
      appScrollHeight: document.querySelector<HTMLElement>('.app-viewport')!.scrollHeight,
      bodyPosition: getComputedStyle(document.body).position,
      appPaddingTop: getComputedStyle(document.querySelector<HTMLElement>('.app-viewport')!).paddingTop,
    }));

    expect(viewport.bodyPosition).toBe('fixed');
    expect(viewport.appPaddingTop).toBe('47px');
    expect(viewport.htmlClientHeight).toBe(viewport.innerHeight);
    expect(viewport.htmlScrollHeight).toBe(viewport.htmlClientHeight);
    expect(viewport.bodyScrollHeight).toBe(viewport.bodyClientHeight);
    expect(viewport.rootScrollHeight).toBe(viewport.rootClientHeight);
    expect(viewport.appScrollHeight).toBe(viewport.appClientHeight);
    expect(viewport.appClientHeight).toBe(viewport.innerHeight);

    await page.evaluate(() => window.scrollTo(0, 500));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const before = await chat.evaluate((el) => ({
      top: el.scrollTop,
      height: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(before.scrollHeight).toBeGreaterThan(before.height);

    await chat.evaluate((el) => { el.scrollTop = 0; });
    await chat.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => chat.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Approximate the visual viewport shrinking when the iOS keyboard opens.
    await page.setViewportSize({ width: 390, height: 500 });
    const resized = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      htmlScrollHeight: document.documentElement.scrollHeight,
      htmlClientHeight: document.documentElement.clientHeight,
      appClientHeight: document.querySelector<HTMLElement>('.app-viewport')!.clientHeight,
      rootScrollHeight: document.getElementById('root')!.scrollHeight,
      rootClientHeight: document.getElementById('root')!.clientHeight,
    }));
    expect(resized.appClientHeight).toBe(resized.innerHeight);
    expect(resized.htmlScrollHeight).toBe(resized.htmlClientHeight);
    expect(resized.rootScrollHeight).toBe(resized.rootClientHeight);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator('textarea')).toBeInViewport();
  } finally {
    await server.close();
  }
});
