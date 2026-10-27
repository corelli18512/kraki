import { test, expect, type Page, type Browser, request } from '@playwright/test';

/**
 * REAL-STACK device rename: real head (SQLite on a temp dir, open auth), two
 * real tentacles and real browsers, nothing mocked between them.
 *
 * One app renames a device; every device of the account must hear it live
 * (`rename_device` → head → `device_renamed` to every online device), and the
 * name must stick: across the device's own re-auth (it reports its own name
 * every time), a browser reload, a fresh browser, and a head restart on the
 * same database. Clearing the name goes back to the device's own name
 * everywhere.
 *
 * Run from repo root (build the tentacle first, the orchestrator imports its dist):
 *   pnpm --filter @kraki/tentacle build
 *   pnpm exec playwright test -c packages/arm/web/playwright.realstack.config.ts device-rename
 */

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB_URL = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

const T1 = 'RealStack Tentacle';
const T2 = 'RealStack Tentacle 2';

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const qs = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${qs ? `?${qs}` : ''}`, { timeout: 60_000 });
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`control ${path} failed: ${JSON.stringify(body)}`);
  return body;
}

/** A new browser (own context = own device identity), paired to the relay,
 *  connected once `expectName` (the first tentacle's current name) shows. */
async function pair(browser: Browser, expectName: string): Promise<Page> {
  const page = await browser.newPage();
  const { token, web } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText(expectName, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page;
}

/** The Devices page lists every computer, online or not, by its current name. */
function deviceCard(page: Page, name: string) {
  // "RealStack Tentacle" must not also match "RealStack Tentacle 2".
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('button', { name: new RegExp(`^${esc}(?!\\s\\d)(\\s|$)`) });
}

async function openDevices(page: Page) {
  if (!page.url().endsWith('/devices')) await page.goto(`${WEB_URL}/devices`);
}

/** Rename through the UI: open the device, click its name, type, Enter. */
async function rename(page: Page, current: string, next: string) {
  await openDevices(page);
  const editor = page.getByRole('button', { name: `Rename ${current}`, exact: true });
  if (!(await editor.isVisible())) await deviceCard(page, current).first().click();
  await editor.click();
  const field = page.getByRole('textbox', { name: 'Device name' });
  await field.fill(next);
  await field.press('Enter');
}

async function heardByTentacles(type = 'device_renamed') {
  return (await control('/headControl', { type })) as { t1: Array<Record<string, unknown>>; t2: Array<Record<string, unknown>> };
}

test.describe.serial('real-stack: renaming a device syncs to every device', () => {
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    await control('/tentacle2/connect');
    a = await pair(browser, T1);
    b = await pair(browser, T1);
    await openDevices(a);
    await openDevices(b);
    await expect(deviceCard(a, T2).first()).toBeVisible({ timeout: 20_000 });
    await expect(deviceCard(b, T2).first()).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    // Leave the stack as other real-stack specs expect it (their own names).
    for (const [current, page] of [['Work laptop', a], ['Build box', a]] as const) {
      try { if (await deviceCard(page, current).count()) await rename(page, current, ''); } catch { /* best effort */ }
    }
    // Cleanup is best effort: never fail a passed spec on closing pages.
    await a?.close().catch(() => {});
    await b?.close().catch(() => {});
  });

  test('1. renaming an online computer shows on the other browser and reaches both computers', async () => {
    const before = (await heardByTentacles()).t1.length;
    await rename(a, T1, '  Work \n laptop ');

    // The sender and the other browser, live (no reload).
    await expect(deviceCard(a, 'Work laptop').first()).toBeVisible({ timeout: 15_000 });
    await expect(deviceCard(b, 'Work laptop').first()).toBeVisible({ timeout: 15_000 });
    await expect(deviceCard(b, T1)).toHaveCount(0);

    // Both computers heard it too (head → tentacle over pulse).
    await expect.poll(async () => (await heardByTentacles()).t1.length, { timeout: 15_000 }).toBe(before + 1);
    const heard = await heardByTentacles();
    for (const list of [heard.t1, heard.t2]) {
      expect(list.at(-1)).toMatchObject({ type: 'device_renamed', name: 'Work laptop', defaultName: T1 });
    }

    // The other browser's session list labels that computer's session with it.
    await b.goto(WEB_URL);
    await expect(b.locator('.ksr-machine', { hasText: 'Work laptop' }).first()).toBeVisible({ timeout: 15_000 });
    await openDevices(b);
  });

  test('2. renaming an offline computer works, and it keeps the name when it signs in again', async () => {
    await control('/tentacle2/disconnect');
    await rename(b, T2, 'Build box');
    await expect(deviceCard(a, 'Build box').first()).toBeVisible({ timeout: 15_000 });
    await expect(deviceCard(b, 'Build box').first()).toBeVisible({ timeout: 15_000 });

    // It signs in again reporting "RealStack Tentacle 2"; the custom name stays.
    await control('/tentacle2/connect');
    await expect.poll(async () => (await heardByTentacles('auth_ok')).t2.length, { timeout: 15_000 }).toBeGreaterThan(1);
    const authOk = (await heardByTentacles('auth_ok')).t2.at(-1)!;
    const listed = (authOk.devices as Array<{ name: string; defaultName?: string }>);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Build box', defaultName: T2 }),
      expect.objectContaining({ name: 'Work laptop', defaultName: T1 }),
    ]));
    await a.waitForTimeout(1_000);
    await expect(deviceCard(a, 'Build box').first()).toBeVisible();
    await expect(deviceCard(a, T2)).toHaveCount(0);
  });

  test('3. a reload and a brand-new browser get the names from the relay', async ({ browser }) => {
    await b.reload();
    await openDevices(b);
    await expect(deviceCard(b, 'Work laptop').first()).toBeVisible({ timeout: 20_000 });
    await expect(deviceCard(b, 'Build box').first()).toBeVisible({ timeout: 20_000 });

    const c = await pair(browser, 'Work laptop');
    try {
      await openDevices(c);
      await expect(deviceCard(c, 'Build box').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await c.close();
    }
  });

  test('4. the names survive a head restart on the same database', async ({ browser }) => {
    const signIns = await heardByTentacles('auth_ok');
    await control('/head/restart');
    // Both computers sign in again by themselves, and the head's device list
    // (read back from its database) carries the custom names.
    await expect.poll(async () => {
      const now = await heardByTentacles('auth_ok');
      return now.t1.length > signIns.t1.length && now.t2.length > signIns.t2.length;
    }, { timeout: 30_000 }).toBe(true);
    for (const list of Object.values(await heardByTentacles('auth_ok'))) {
      expect(list.at(-1)!.devices).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Work laptop', defaultName: T1 }),
        expect.objectContaining({ name: 'Build box', defaultName: T2 }),
      ]));
    }
    const c = await pair(browser, 'Work laptop');
    try {
      await openDevices(c);
      await expect(deviceCard(c, 'Build box').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await c.close();
    }
    // The already-open browsers reconnected by themselves and still show them.
    await expect(deviceCard(a, 'Work laptop').first()).toBeVisible({ timeout: 30_000 });
    await expect(deviceCard(b, 'Build box').first()).toBeVisible({ timeout: 30_000 });
  });

  test('5. after the restart, a rename still reaches everyone; clearing it goes back to the own name', async () => {
    await rename(b, 'Work laptop', '');
    for (const p of [a, b]) await expect(deviceCard(p, T1).first()).toBeVisible({ timeout: 20_000 });
    await expect(deviceCard(a, 'Work laptop')).toHaveCount(0);
    await expect.poll(async () => (await heardByTentacles()).t2.at(-1), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ type: 'device_renamed', name: T1 }));
    expect((await heardByTentacles()).t2.at(-1)).not.toHaveProperty('defaultName');

    await rename(a, 'Build box', T2);
    await expect(deviceCard(b, T2).first()).toBeVisible({ timeout: 20_000 });
  });
});
