import { test, expect, type Page } from '@playwright/test';
import type { WebSocket } from 'ws';
import { webcrypto } from 'node:crypto';
import { MockRelayServer } from './helpers/mock-ws-server';

const SESSION = { id: 'sess-follow', deviceId: 'tentacle-1', deviceName: 'Mac', agent: 'pi', model: 'm', state: 'idle', messageCount: 0, title: 'Follow' };
const DEVICE = { id: 'tentacle-1', name: 'Mac', role: 'tentacle', kind: 'cli', online: true };
const list = (page: Page) => page.locator('[data-chat-scroll]');
const latest = (page: Page) => page.getByRole('button', { name: 'Jump to latest' });
const gap = (page: Page) => list(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

async function open(page: Page, server: MockRelayServer, count = 30) {
  await page.setViewportSize({ width: 1240, height: 720 });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?relay=${encodeURIComponent(server.url)}&token=scroll-follow-test`);
  const ws = await server.waitForConnection();
  await server.waitForMessage(ws);
  const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const encryptionKey = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  server.sendAuthOk(ws, { sessions: [SESSION], devices: [{ ...DEVICE, encryptionKey }] });
  await server.waitForMessage(ws);
  await page.getByText('Follow', { exact: true }).first().click();
  await expect(list(page)).toBeVisible();
  server.sendMessage(ws, {
    type: 'session_subscription_set',
    payload: {
      accepted: true, sessionId: SESSION.id,
      snapshot: { digest: { ...SESSION, mode: 'auto', lastSeq: 0, readSeq: 0, createdAt: new Date().toISOString() }, spineHeadSeq: 0, card: { draft: '', action: null } },
    },
  });
  server.resetSeq(1);
  for (let i = 1; i <= count; i++) {
    server.sendMessage(ws, { type: i % 2 ? 'user_message' : 'agent_message', sessionId: SESSION.id, payload: { content: `Reply ${i}: ${'lorem ipsum '.repeat(30)}` } });
  }
  await expect(page.getByText(`Reply ${count}:`)).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThan(2);
  // Finish entry settling / window trimming before testing motion.
  await page.waitForTimeout(750);
  return ws;
}

function delta(server: MockRelayServer, ws: WebSocket, content: string) {
  server.sendMessage(ws, { type: 'agent_message_delta', sessionId: SESSION.id, payload: { content } });
}

async function startStream(page: Page, server: MockRelayServer, ws: WebSocket) {
  server.sendMessage(ws, { type: 'user_message', sessionId: SESSION.id, payload: { content: 'Start a streaming turn' } });
  server.sendMessage(ws, { type: 'active', sessionId: SESSION.id, payload: {} });
  delta(server, ws, 'Streaming start.\n\n');
  await expect(page.locator('[data-scroll-key="__live__"]')).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThan(2);
}

async function moveToHistory(page: Page) {
  await list(page).hover({ position: { x: 400, y: 180 } });
  await page.mouse.wheel(0, -1800);
  await expect.poll(() => gap(page)).toBeGreaterThan(1200);
  await page.waitForTimeout(200);
}

// Record actual browser geometry AND detect the original competing owners:
// direct scrollTop writes while a native smooth scroll still owns the offset.
async function recordMotion(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-chat-scroll]')!;
    const state = { samples: [] as { time: number; top: number; tail: number }[], competingWrites: 0, native: false };
    Object.assign(window, { followMotion: state });
    const scrollTo = el.scrollTo.bind(el);
    el.scrollTo = ((options: ScrollToOptions) => {
      if (options.behavior === 'smooth') state.native = true;
      scrollTo(options);
    }) as typeof el.scrollTo;
    el.addEventListener('scrollend', () => { state.native = false; });
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(el, 'scrollTop', {
      get: () => descriptor.get!.call(el) as number,
      set: (value: number) => {
        if (state.native) state.competingWrites++;
        descriptor.set!.call(el, value);
      },
    });
    const start = performance.now();
    const sample = (now: number) => {
      state.samples.push({ time: now - start, top: el.scrollTop, tail: el.scrollHeight - el.clientHeight });
      if (now - start < 1200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

for (const action of ['down', 'send'] as const) {
  test(`F6: ${action} navigation has one owner and reaches the growing tail`, async ({ page }) => {
    const server = await MockRelayServer.create();
    try {
      const ws = await open(page, server);
      await startStream(page, server, ws);
      await moveToHistory(page);
      if (action === 'send') await page.getByRole('textbox').last().fill('Return to newest');
      await recordMotion(page);
      if (action === 'down') await latest(page).click();
      else await page.getByRole('textbox').last().press('Enter');
      for (let i = 0; i < 12; i++) {
        delta(server, ws, `Growing line ${i}.\n\n`);
        await page.waitForTimeout(35);
      }
      await expect.poll(() => gap(page)).toBeLessThan(2);
      await page.waitForTimeout(800);
      const motion = await page.evaluate(() => (window as unknown as {
        followMotion: { samples: { time: number; top: number; tail: number }[]; competingWrites: number };
      }).followMotion);
      expect(motion.competingWrites).toBe(0);
      const range = motion.samples.at(-1)!.top - motion.samples[0].top;
      expect(range).toBeGreaterThan(1200);
      const moving = motion.samples.filter((s) => s.top > motion.samples[0].top + 1 && s.top < s.tail - 4);
      expect(moving.length).toBeGreaterThan(3);
      for (let i = 1; i < motion.samples.length; i++) {
        const previous = motion.samples[i - 1];
        const current = motion.samples[i];
        expect(current.top).toBeGreaterThanOrEqual(previous.top - 1);
        // The animation's writer can run after this frame's sample: a slow
        // preceding frame then appears in the next sample's displacement.
        const elapsed = Math.max(current.time - previous.time, i > 1 ? previous.time - motion.samples[i - 2].time : 0);
        expect(current.top - previous.top).toBeLessThan(range * Math.min(1, elapsed / 60) + 2);
      }
    } finally {
      await server.close();
    }
  });
}

test('F6: manual older input cancels a bottom navigation during streaming', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    const ws = await open(page, server);
    await startStream(page, server, ws);
    await moveToHistory(page);
    await latest(page).click();
    await page.waitForTimeout(60);
    await list(page).hover({ position: { x: 400, y: 180 } });
    await list(page).evaluate((el) => {
      el.addEventListener('wheel', () => Object.assign(window, { cancelledAt: el.scrollTop }), { once: true });
    });
    await page.mouse.wheel(0, -30);
    await expect.poll(() => page.evaluate(() => {
      const cancelledAt = (window as unknown as { cancelledAt?: number }).cancelledAt;
      return cancelledAt === undefined ? 0 : cancelledAt - document.querySelector('[data-chat-scroll]')!.scrollTop;
    })).toBeGreaterThan(20);
    await page.waitForTimeout(100);
    const held = await list(page).evaluate((el) => el.scrollTop);
    for (let i = 0; i < 5; i++) {
      delta(server, ws, 'More streaming content.\n\n');
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);
    expect(Math.abs(await list(page).evaluate((el) => el.scrollTop) - held)).toBeLessThan(1);
    await expect(latest(page)).toHaveClass(/is-visible/);
  } finally {
    await server.close();
  }
});

test('F7: a two-pixel older movement disengages follow until newer intent returns to tail', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    const ws = await open(page, server);
    await startStream(page, server, ws);
    await list(page).hover({ position: { x: 400, y: 180 } });
    await page.mouse.wheel(0, -2);
    await expect.poll(() => gap(page)).toBeGreaterThan(1);
    expect(await gap(page)).toBeLessThanOrEqual(4);
    const held = await list(page).evaluate((el) => el.scrollTop);
    for (let i = 0; i < 5; i++) {
      delta(server, ws, 'A new streamed paragraph.\n\n');
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);
    expect(Math.abs(await list(page).evaluate((el) => el.scrollTop) - held)).toBeLessThan(1);
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await expect(latest(page)).not.toHaveClass(/is-visible/);
    delta(server, ws, 'Following again.\n\n');
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await expect(latest(page)).not.toHaveClass(/is-visible/);
  } finally {
    await server.close();
  }
});

test('F9: arrivals enter from their side after the rendered window is full', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    const ws = await open(page, server, 70);
    await expect(page.locator('[data-scroll-key]')).toHaveCount(60);
    await page.evaluate(() => {
      const entrances: string[] = [];
      Object.assign(window, { tailEntrances: entrances });
      document.addEventListener('animationstart', (event) => {
        const target = event.target as HTMLElement;
        if (target.matches('[data-scroll-key]')) entrances.push((event as AnimationEvent).animationName);
      });
    });
    server.sendMessage(ws, { type: 'user_message', sessionId: SESSION.id, payload: { content: 'New user arrival' } });
    await expect(list(page).getByText('New user arrival')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { tailEntrances: string[] }).tailEntrances)).toContain('kenter-right');
    server.sendMessage(ws, { type: 'active', sessionId: SESSION.id, payload: {} });
    delta(server, ws, 'New live arrival');
    await expect.poll(() => page.evaluate(() => (window as unknown as { tailEntrances: string[] }).tailEntrances)).toContain('kenter-left');
    await page.waitForTimeout(400);
    const beforeLanding = await page.evaluate(() => (window as unknown as { tailEntrances: string[] }).tailEntrances.length);
    server.sendMessage(ws, { type: 'agent_message', sessionId: SESSION.id, payload: { content: 'Landed reply' } });
    await expect(page.getByText('Landed reply')).toBeVisible();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as { tailEntrances: string[] }).tailEntrances.length)).toBe(beforeLanding);
  } finally {
    await server.close();
  }
});

test('F10: follow lag never exposes down or unseen, but a reader in history gets the dot', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    const ws = await open(page, server);
    await startStream(page, server, ws);
    await page.evaluate(() => {
      const state = { down: false, unseen: false, maxGap: 0 };
      Object.assign(window, { followControls: state });
      const check = () => {
        const down = document.querySelector('[aria-label="Jump to latest"]')!;
        state.down ||= down.classList.contains('is-visible');
        state.unseen ||= !!down.querySelector('[aria-label="New reply"]');
        const el = document.querySelector<HTMLElement>('[data-chat-scroll]')!;
        state.maxGap = Math.max(state.maxGap, el.scrollHeight - el.clientHeight - el.scrollTop);
      };
      new MutationObserver(check).observe(document.querySelector('.kchat')!, { subtree: true, attributes: true, childList: true });
    });
    for (let i = 0; i < 6; i++) {
      delta(server, ws, `Streaming paragraph ${i}.\n\n`);
      await page.waitForTimeout(35);
    }
    server.sendMessage(ws, { type: 'agent_message', sessionId: SESSION.id, payload: { content: 'Landed pinned reply.\n\n'.repeat(12) } });
    await expect(page.getByText('Landed pinned reply.').first()).toBeVisible();
    await expect.poll(() => gap(page)).toBeLessThan(2);
    const controls = await page.evaluate(() => (window as unknown as { followControls: { down: boolean; unseen: boolean; maxGap: number } }).followControls);
    expect(controls.maxGap).toBeGreaterThan(4);
    expect(controls.down).toBe(false);
    expect(controls.unseen).toBe(false);

    await moveToHistory(page);
    server.sendMessage(ws, { type: 'user_message', sessionId: SESSION.id, payload: { content: 'Another turn' } });
    server.sendMessage(ws, { type: 'agent_message', sessionId: SESSION.id, payload: { content: 'Actually unseen reply' } });
    await expect(latest(page)).toHaveClass(/is-visible/);
    await expect(latest(page).getByLabel('New reply')).toHaveCount(1);
    await latest(page).click();
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await expect(latest(page).getByLabel('New reply')).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test('overlay reach collapse preserves follow after covered tail was revealed', async ({ page }) => {
  const server = await MockRelayServer.create();
  try {
    const ws = await open(page, server);
    await startStream(page, server, ws);
    const field = page.getByRole('textbox').last();
    await field.fill(Array.from({ length: 8 }, (_, i) => `draft ${i}`).join('\n'));
    await page.waitForTimeout(200);
    await list(page).hover({ position: { x: 400, y: 180 } });
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await field.fill('');
    await page.waitForTimeout(250);
    delta(server, ws, 'Still following after composer collapse.\n\n');
    await expect.poll(() => gap(page)).toBeLessThan(2);
    await expect(latest(page)).not.toHaveClass(/is-visible/);
  } finally {
    await server.close();
  }
});
