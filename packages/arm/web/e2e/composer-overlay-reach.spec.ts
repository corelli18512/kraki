import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';

// Desktop: a growing composer overlays the newest bubbles; the list must not
// move, but the reader must be able to scroll the covered tail into view
// (docs/chat-composer-overlay.md; Mac composerOverlayInset).
const SESSION = { id: 'sess-overlay', deviceId: 'tentacle-1', deviceName: 'Mac', agent: 'pi', model: 'm', state: 'idle', messageCount: 0, title: 'Overlay' };
const DEVICE = { id: 'tentacle-1', name: 'Mac', role: 'tentacle', kind: 'cli', online: true };

async function open(page: Page, server: MockRelayServer) {
  await page.setViewportSize({ width: 1240, height: 720 });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  server.sendAuthOk(ws, { sessions: [SESSION], devices: [DEVICE] });
  await server.waitForMessage(ws);
  await page.getByText('Overlay').first().click();
  await expect(page.locator('[data-chat-scroll]')).toBeVisible();
  for (let i = 1; i <= 30; i++) {
    server.sendMessage(ws, { type: 'agent_message', sessionId: SESSION.id, payload: { content: `Line ${i}: ${'lorem ipsum '.repeat(8)}` } });
  }
  await expect(page.getByText('Line 30:')).toBeVisible();
  await page.waitForTimeout(400);
}

const geometry = (page: Page) => page.evaluate(() => {
  const list = document.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const last = [...document.querySelectorAll<HTMLElement>('[data-scroll-key]')].at(-1)!;
  const dock = document.querySelector<HTMLElement>('.kcomposer-dock')!;
  return {
    scrollTop: list.scrollTop,
    max: list.scrollHeight - list.clientHeight,
    lastBottom: last.getBoundingClientRect().bottom,
    dockTop: dock.getBoundingClientRect().top,
  };
});

test('expanded desktop composer: viewport stays, covered tail is reachable, collapse gives it back', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    await open(page, server);
    const rest = await geometry(page);
    expect(rest.lastBottom).toBeLessThanOrEqual(rest.dockTop + 1);

    const field = page.getByRole('textbox').last();
    await field.fill(Array.from({ length: 8 }, (_, i) => `draft line ${i}`).join('\n'));
    await page.waitForTimeout(300);
    const grown = await geometry(page);
    // Nothing moved; the glass now covers the tail …
    expect(Math.abs(grown.lastBottom - rest.lastBottom)).toBeLessThan(1);
    expect(grown.lastBottom).toBeGreaterThan(grown.dockTop);
    // … and there is extra reach to lift it out.
    expect(grown.max).toBeGreaterThan(rest.max + 40);

    await page.locator('[data-chat-scroll]').hover({ position: { x: 400, y: 200 } });
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(400);
    const revealed = await geometry(page);
    expect(revealed.lastBottom).toBeLessThanOrEqual(revealed.dockTop + 1);

    await field.fill('');
    await page.waitForTimeout(300);
    const collapsed = await geometry(page);
    expect(collapsed.scrollTop).toBeLessThanOrEqual(collapsed.max);
    expect(Math.abs(collapsed.max - rest.max)).toBeLessThan(2);
    expect(collapsed.lastBottom).toBeLessThanOrEqual(collapsed.dockTop + 1);
  } finally {
    await server.close();
  }
});
