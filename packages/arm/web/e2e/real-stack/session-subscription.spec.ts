import { expect, type Browser, type BrowserContext, type Page, request, test } from '@playwright/test';

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

async function pairBrowser(browser: Browser): Promise<{ context: BrowserContext; page: Page; deviceId: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { token, web } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  const deviceId = await page.evaluate(() => JSON.parse(localStorage.getItem('kraki_device') ?? '{}').deviceId as string);
  expect(deviceId).toBeTruthy();
  return { context, page, deviceId };
}

async function createSession(id: string): Promise<void> {
  await control('/createSession', { id });
  await control('/idle', { sid: id });
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${WEB_URL}/session/${id}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
}

async function subscriptionFor(deviceId: string): Promise<string | null | undefined> {
  const debug = await control('/debug');
  return (debug.subscriptions as Record<string, string | null>)[deviceId];
}

async function expectSubscribed(deviceId: string, sessionId: string | null): Promise<void> {
  await expect.poll(() => subscriptionFor(deviceId), { timeout: 15_000 }).toBe(sessionId);
}

async function seedLiveCard(sessionId: string, marker: string): Promise<void> {
  await control('/active', { sid: sessionId });
  await control('/delta', { sid: sessionId, text: marker });
  await control('/toolStart', { sid: sessionId, tool: 'bash', cmd: `echo ${marker}` });
}

test.describe.serial('real-stack session subscription + opaque multicast', () => {
  let arm1: Awaited<ReturnType<typeof pairBrowser>>;
  let sessionA: string;
  let sessionB: string;
  let sessionC: string;

  test.beforeAll(async ({ browser }) => {
    sessionA = `sub-a-${Date.now().toString(36)}`;
    sessionB = `sub-b-${Date.now().toString(36)}`;
    sessionC = `sub-c-${Date.now().toString(36)}`;
    await createSession(sessionA);
    await createSession(sessionB);
    await createSession(sessionC);
    arm1 = await pairBrowser(browser);
  });

  test.afterAll(async () => {
    await arm1?.context.close();
  });

  test('subscription ACK snapshot seeds a card that was created before page open', async () => {
    const marker = `snapshot-${Date.now().toString(36)}`;
    await seedLiveCard(sessionA, marker);
    await openSession(arm1.page, sessionA);
    await expectSubscribed(arm1.deviceId, sessionA);
    await expect(arm1.page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(arm1.page.getByText(`echo ${marker}`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('non-subscribed session delta/card is not delivered to the current Arm', async () => {
    const hidden = `hidden-${Date.now().toString(36)}`;
    await seedLiveCard(sessionB, hidden);
    await arm1.page.waitForTimeout(250);
    await expect(arm1.page.getByText(hidden, { exact: false })).toHaveCount(0);
    await expectSubscribed(arm1.deviceId, sessionA);
  });

  test('same-tentacle A→B is an atomic replace and old A live frames stop applying', async () => {
    await openSession(arm1.page, sessionB);
    await expectSubscribed(arm1.deviceId, sessionB);
    await control('/active', { sid: sessionB });
    const visibleB = `visible-b-${Date.now().toString(36)}`;
    await control('/delta', { sid: sessionB, text: visibleB });
    await expect(arm1.page.getByText(visibleB, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

    const staleA = `stale-a-${Date.now().toString(36)}`;
    await control('/delta', { sid: sessionA, text: staleA });
    await arm1.page.waitForTimeout(250);
    await expect(arm1.page.getByText(staleA, { exact: false })).toHaveCount(0);
  });

  test('rapid A→B→C navigation coalesces to final C', async () => {
    await arm1.page.goto(`${WEB_URL}/session/${sessionA}`);
    await arm1.page.goto(`${WEB_URL}/session/${sessionB}`);
    await arm1.page.goto(`${WEB_URL}/session/${sessionC}`);
    await expect(arm1.page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });
    await expectSubscribed(arm1.deviceId, sessionC);
    await control('/active', { sid: sessionC });
    const marker = `only-c-${Date.now().toString(36)}`;
    await control('/delta', { sid: sessionC, text: marker });
    await expect(arm1.page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('refresh reasserts desired subscription after session_list barrier and restores current card snapshot', async () => {
    const before = `before-refresh-${Date.now().toString(36)}`;
    await seedLiveCard(sessionC, before);
    await expect(arm1.page.getByText(before, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await arm1.page.reload();
    await expect(arm1.page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 20_000 });
    await expectSubscribed(arm1.deviceId, sessionC);
    await expect(arm1.page.getByText(before, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    const after = `after-refresh-${Date.now().toString(36)}`;
    await control('/delta', { sid: sessionC, text: after });
    await expect(arm1.page.getByText(after, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('leaving the session page confirms null subscription', async () => {
    await arm1.page.goto(WEB_URL);
    await expectSubscribed(arm1.deviceId, null);
  });

  test('question attention updates the sidebar globally while the session is not subscribed', async () => {
    const question = `attention-${Date.now().toString(36)}`;
    await control('/question', { sid: sessionA, id: `q-${Date.now()}`, text: question, choices: 'yes|no' });
    await expect(arm1.page.getByText(question, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expectSubscribed(arm1.deviceId, null);
  });

  test('bulk history recovery does not block current live stream', async () => {
    await openSession(arm1.page, 'realstack-history');
    await expectSubscribed(arm1.deviceId, 'realstack-history');
    await control('/active', { sid: 'realstack-history' });
    const live = `live-during-history-${Date.now().toString(36)}`;
    await control('/delta', { sid: 'realstack-history', text: live });
    await expect(arm1.page.getByText(live, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect(arm1.page.getByText('history line 60 of 60', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('two Arms can subscribe to different sessions and receive only their own live multicast', async ({ browser }) => {
    const arm2 = await pairBrowser(browser);
    try {
      await openSession(arm1.page, sessionA);
      await openSession(arm2.page, sessionB);
      await expectSubscribed(arm1.deviceId, sessionA);
      await expectSubscribed(arm2.deviceId, sessionB);

      const markerA = `arm1-only-${Date.now().toString(36)}`;
      const markerB = `arm2-only-${Date.now().toString(36)}`;
      await control('/delta', { sid: sessionA, text: markerA });
      await control('/delta', { sid: sessionB, text: markerB });

      await expect(arm1.page.getByText(markerA, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
      await expect(arm2.page.getByText(markerB, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
      await expect(arm1.page.getByText(markerB, { exact: false })).toHaveCount(0);
      await expect(arm2.page.getByText(markerA, { exact: false })).toHaveCount(0);
    } finally {
      await arm2.context.close();
    }
  });
});
