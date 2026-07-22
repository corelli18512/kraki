/**
 * Turn-boundary preview stability (real Head + real Tentacle + real browser).
 *
 * Locks in the two core fixes:
 *  1. Tentacle `getSessionPreview` is a turn-boundary scan — the user_message
 *     that began the turn is the anchor and is NOT displaced by tool activity,
 *     narration, or transient errors. It only advances to the agent outcome on
 *     turn-close.
 *  2. The sidebar preview is owned by the session_list digest. Tentacle now
 *     broadcasts on turn-close, so the browser sidebar advances to the agent
 *     reply without the removed client-side idle memory-scan.
 */
import { expect, type Browser, type BrowserContext, type Page, request, test } from '@playwright/test';

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

type Debug = {
  enrichedSessions: Array<{ id: string; preview?: { text: string; type: string; timestamp: string } }>;
};

async function control(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const ctx = await request.newContext();
  const query = new URLSearchParams(params).toString();
  const res = await ctx.get(`${CONTROL}${path}${query ? `?${query}` : ''}`);
  const body = await res.json();
  await ctx.dispose();
  if (!res.ok()) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}
async function enrichedPreview(sid: string): Promise<{ type: string; text: string } | undefined> {
  const d = (await control('/debug')) as unknown as Debug;
  return d.enrichedSessions.find((s) => s.id === sid)?.preview;
}
async function pair(browser: Browser): Promise<{ context: BrowserContext; page: Page; deviceId: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { token } = await control('/token');
  await page.goto(`${WEB}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  const deviceId = await page.evaluate(() => JSON.parse(localStorage.getItem('kraki_device') ?? '{}').deviceId as string);
  return { context, page, deviceId };
}
async function createSession(id: string): Promise<void> {
  await control('/createSession', { id });
  await control('/idle', { sid: id });
}
async function settle(ms = 600): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

/** Sidebar card text for the session whose card contains `marker`. */
async function cardText(page: Page, marker: string): Promise<string | null> {
  const btn = page.getByRole('button').filter({ hasText: marker }).first();
  if (await btn.count() === 0) return null;
  return (await btn.innerText()).replace(/\s+/g, ' ').trim();
}

/** Drive a real user turn from the Arm composer (user_message echo + active). */
async function sendUserMessage(page: Page, prompt: string): Promise<void> {
  const input = page.getByPlaceholder('Send a message…');
  await input.fill(prompt);
  await input.press('Enter');
}

/** Navigate to a freshly-created session and wait for the composer. The Arm
 *  learns about a new session from the session_list broadcast, so a bare goto
 *  can land on the empty state before the digest arrives — retry until the
 *  composer is reachable. */
async function openSession(page: Page, sid: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await page.goto(`${WEB}/session/${sid}`);
    try {
      await expect(page.getByPlaceholder('Send a message…')).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      await settle(400);
    }
  }
  throw new Error(`composer for session ${sid} never became visible`);
}

test.describe('preview turn-boundary stability', () => {
  let arm: { context: BrowserContext; page: Page; deviceId: string };

  test.beforeEach(async ({ browser }) => { arm = await pair(browser); });
  test.afterEach(async () => { await arm?.context.close(); });

  test('clean turn: preview anchors on user_message through tools, then advances to the agent reply', async () => {
    const sid = `clean-${Date.now().toString(36)}`;
    const prompt = 'Fix the database migration';
    await createSession(sid);
    await openSession(arm.page, sid);

    await sendUserMessage(arm.page, prompt);
    await settle();
    // Anchor = the user_message that started the turn.
    await expect.poll(async () => (await enrichedPreview(sid))?.type, { timeout: 15_000 }).toBe('user');
    expect((await enrichedPreview(sid))!.text).toContain(prompt);

    // A long multi-tool turn must NOT displace the anchor.
    await control('/active', { sid });
    for (let i = 0; i < 18; i++) {
      await control('/toolStart', { sid, tool: 'bash', cmd: `migration step ${i}` });
      await control('/toolComplete', { sid, tool: 'bash', result: 'applied' });
    }
    await settle();
    expect((await enrichedPreview(sid))?.type).toBe('user');
    expect((await enrichedPreview(sid))!.text).toContain(prompt);
    // Browser sidebar (digest-authoritative, no client idle scan) still shows it.
    expect((await cardText(arm.page, prompt)) ?? '').toContain(prompt);

    // Agent reply + turn close → preview advances to the agent outcome.
    const reply = 'Migration fixed and rollback tests added.';
    await control('/msg', { sid, text: reply });
    await control('/idle', { sid });
    await settle();
    await expect.poll(async () => (await enrichedPreview(sid))?.type, { timeout: 15_000 }).toBe('agent');
    expect((await enrichedPreview(sid))!.text).toContain('Migration fixed');
    // ...and the sidebar reflects it via the turn-close broadcast.
    await expect.poll(async () => (await cardText(arm.page, reply)) ?? '', { timeout: 15_000 }).toContain('Migration fixed');
  });

  test('failed turn: transient errors do not displace the anchor mid-turn; the failure shows on close', async () => {
    const sid = `fail-${Date.now().toString(36)}`;
    const prompt = 'Run the deploy script';
    await createSession(sid);
    await openSession(arm.page, sid);

    await sendUserMessage(arm.page, prompt);
    await settle();
    await expect.poll(async () => (await enrichedPreview(sid))?.type, { timeout: 15_000 }).toBe('user');

    // Transient 503s are infrastructure noise — they must NOT become the preview
    // while the turn is in flight (the old scan returned the error text here).
    await control('/active', { sid });
    await control('/error', { sid, message: '503 auth_unavailable' });
    await control('/error', { sid, message: '503 auth_unavailable' });
    await settle();
    expect((await enrichedPreview(sid))?.type).toBe('user');
    expect((await enrichedPreview(sid))!.text).toContain(prompt);

    // The staged error ends the turn as failed on idle. The terminal turn_status
    // is the new boundary — NOT the raw 503 text.
    await control('/idle', { sid });
    await settle();
    await expect.poll(async () => (await enrichedPreview(sid))?.type, { timeout: 15_000 }).toBe('error');
    expect((await enrichedPreview(sid))!.text).toBe('Turn failed');
  });
});
