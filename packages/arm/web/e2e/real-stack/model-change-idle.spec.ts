import { expect, type Browser, request, test } from '@playwright/test';

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const query = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${query ? `?${query}` : ''}`);
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

type Debug = { enrichedSessions: Array<{ id: string; state: string; model?: string }>; subscriptions: Record<string, string | null> };
async function debug(): Promise<Debug> { return (await control('/debug')) as Debug; }
async function digest(sid: string) { return (await debug()).enrichedSessions.find((s) => s.id === sid); }

async function pair(browser: Browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    (window as unknown as { __modelEvents: Array<{ type: string; sessionId?: string }> }).__modelEvents = [];
    const parse = JSON.parse.bind(JSON);
    JSON.parse = function(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
      const value = parse(text, reviver);
      if (value && typeof value === 'object' && 'type' in value) {
        const m = value as { type: string; sessionId?: string };
        if (m.type === 'active' || m.type === 'idle' || m.type === 'session_model_set') {
          (window as unknown as { __modelEvents: Array<{ type: string; sessionId?: string }> }).__modelEvents.push({ type: m.type, sessionId: m.sessionId });
        }
      }
      return value;
    } as typeof JSON.parse;
  });
  const page = await context.newPage();
  const { token } = await control('/token');
  await page.goto(`${WEB}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return { context, page };
}

test('changing model on an idle/disconnected session does not start a turn', async ({ browser }) => {
  const sid = `idle-model-${Date.now().toString(36)}`;
  await control('/createSession', { id: sid });
  await control('/idle', { sid });
  const arm = await pair(browser);
  try {
    await expect.poll(async () => (await digest(sid))?.state, { timeout: 15_000 }).toBe('idle');

    // Faithful daemon restart: rebuild RelayClient against the same on-disk
    // SessionManager, leaving the session disconnected (digest maps to idle).
    await control('/tentacle/restart');
    await expect.poll(async () => (await digest(sid))?.state, { timeout: 20_000 }).toBe('idle');

    // Clear any earlier lifecycle events, then perform ONLY a model change.
    await arm.page.evaluate(() => {
      (window as unknown as { __modelEvents: unknown[] }).__modelEvents = [];
    });
    await control('/armSetModel', { sid, model: 'mock-v2' });

    await expect.poll(async () => {
      const events = await arm.page.evaluate(() => (window as unknown as { __modelEvents: Array<{ type: string; sessionId?: string }> }).__modelEvents);
      return events.some((e) => e.type === 'session_model_set' && e.sessionId === sid);
    }, { timeout: 15_000 }).toBe(true);

    // Loading runtime state to apply configuration is not a turn start.
    expect(await digest(sid)).toMatchObject({ state: 'idle', model: 'mock-v2' });
    const events = await arm.page.evaluate(() => (window as unknown as { __modelEvents: Array<{ type: string; sessionId?: string }> }).__modelEvents);
    expect(events.filter((e) => e.sessionId === sid).map((e) => e.type)).toEqual(['session_model_set']);
  } finally {
    await arm.context.close();
  }
});
