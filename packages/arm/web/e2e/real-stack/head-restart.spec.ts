import { test, expect, type Page, type Browser, request } from '@playwright/test';

/**
 * REAL-STACK: a head restart must not leave a computer deaf to head control.
 *
 * Regression (kraki 2026-10-21): the head restores each device's Pulse
 * endpoint from a durable-only snapshot, whose sendSeq can be far behind what
 * the computer already received. Its RESET announced a seq it no longer had,
 * and the computer then held every later head frame as a hole — so after a
 * relay deploy it never heard device_joined / device_renamed / … again. It
 * showed for a computer that had reconnected (and kept receiving app traffic)
 * after its last snapshot write.
 *
 * Run from repo root (the orchestrator imports the tentacle's dist):
 *   pnpm --filter @kraki/tentacle... build
 *   pnpm exec playwright test -c packages/arm/web/playwright.realstack.config.ts head-restart
 */

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB_URL = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

async function control(path: string): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const res = await ctx.get(`${CONTROL}${path}`, { timeout: 60_000 });
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`control ${path} failed: ${JSON.stringify(body)}`);
  return body;
}

type Heard = Record<'t1' | 't2', Array<Record<string, unknown>>>;
async function heard(type: string): Promise<Heard> {
  const all = (await control('/headControl')) as Heard;
  return { t1: all.t1.filter((m) => m.type === type), t2: all.t2.filter((m) => m.type === type) };
}

async function pair(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  const { token, web } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page;
}

test('both computers hear head control after a head restart', async ({ browser }) => {
  await control('/tentacle2/connect');
  const a = await pair(browser);
  const b = await pair(browser);
  // Computer 2 drops and comes back (its endpoint snapshot is written on
  // connect), then keeps receiving app traffic the snapshot never sees.
  await control('/tentacle2/disconnect');
  await b.waitForTimeout(2_000);
  await control('/tentacle2/connect');
  await b.reload();
  await b.waitForTimeout(3_000);
  const gone = await pair(browser);
  await gone.goto(`${WEB_URL}/devices`);
  await gone.waitForTimeout(1_500);
  await gone.close();
  await a.waitForTimeout(1_500);

  const signIns = await heard('auth_ok');
  await control('/head/restart');
  await expect.poll(async () => {
    const now = await heard('auth_ok');
    return now.t1.length > signIns.t1.length && now.t2.length > signIns.t2.length;
  }, { timeout: 30_000 }).toBe(true);
  await a.waitForTimeout(2_000);

  // A browser pairs after the restart: the head tells both computers.
  const before = await heard('device_joined');
  const c = await pair(browser);
  try {
    await expect.poll(async () => {
      const now = await heard('device_joined');
      return [now.t1.length > before.t1.length, now.t2.length > before.t2.length];
    }, { timeout: 15_000, message: 'a computer never heard device_joined after the head restart' }).toEqual([true, true]);
  } finally {
    for (const p of [a, b, c]) await p.close();
  }
});
