import { test, expect, type Page, request } from '@playwright/test';

/**
 * Send-time coalescing (pulse §12) — real-stack correctness under an offline
 * delta burst.
 *
 * The perf fix coalesces `agent_message_delta` / `card_action` by session so an
 * offline arm gets ONE current value per key on reconnect instead of a replayed
 * burst. Coalescing is LOSSY at the pulse layer (deltas are incremental), so the
 * guarantee that matters is: the DELIVERED, PERSISTED end-state is never
 * corrupted. A turn always ends with an `agent_message` (full content, NOT
 * coalesced, durable), which is the authoritative text the user keeps.
 *
 * This spec streams a burst of distinct deltas WHILE the browser is offline (so
 * they coalesce in the tentacle's pendingE2eQueue), then completes the turn with
 * the full reply, reconnects, and asserts the browser renders the complete final
 * message — proving coalescing the intermediate deltas never drops delivered
 * content.
 *
 * (Note: the transient mid-stream *draft* is not persisted and does not survive a
 * full reconnect even WITHOUT coalescing — verified by A/B — so this asserts the
 * durable end-state, which is what coalescing must never corrupt.)
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

async function pairBrowser(page: Page): Promise<string> {
  const { token, web, sessionId } = await control('/token');
  await page.goto(web as string);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${web}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return sessionId as string;
}

test.describe.serial('real-stack pulse: offline delta-burst coalescing preserves the final reply', () => {
  let page: Page;
  let sid: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    sid = await pairBrowser(page);
    await expect(page.getByRole('button', { name: /Mock-agent/ }).first())
      .toBeVisible({ timeout: 15_000 });
    await page.goto(`${WEB_URL}/session/${sid}`);
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('a coalesced offline delta burst does not corrupt the completed reply', async () => {
    await control('/idle', { sid });

    // Arm goes offline. Head stale-kills it → device_left → the tentacle queues
    // subsequent sends in pendingE2eQueue, where same-session deltas COALESCE.
    await page.context().setOffline(true);

    // Burst of 12 distinct incremental deltas (spaced past the 40 ms debounce so
    // each is a separate agent_message_delta) → these collapse to ~1 queued.
    for (let i = 0; i < 12; i++) {
      await control('/delta', { sid, text: `frag${i} ` });
      await page.waitForTimeout(70);
    }
    // Then the turn COMPLETES with the authoritative full reply (agent_message —
    // not coalesced, durable) and idle.
    const reply = 'FINAL: all twelve fragments were streamed and the reply is complete.';
    await control('/msg', { sid, text: reply });
    await control('/idle', { sid });

    // Let head register the disconnect + hold the durable message.
    await page.waitForTimeout(1_200);

    // Reconnect — pulse resume must deliver the completed reply intact, and the
    // coalesced delta burst must not have corrupted or blocked it.
    await page.context().setOffline(false);

    await expect(page.locator('[data-chat-scroll]').getByText('all twelve fragments', { exact: false }))
      .toBeVisible({ timeout: 25_000 });
    // The full sentence is present (not a truncated/garbled fragment).
    await expect(page.locator('[data-chat-scroll]').getByText(reply, { exact: false }))
      .toBeVisible({ timeout: 5_000 });
  });
});
