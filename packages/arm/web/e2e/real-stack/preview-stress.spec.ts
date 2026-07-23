/**
 * High-intensity preview / attention stress matrix.
 *
 * Each scenario targets a specific boundary that the simple lifecycle spec
 * does NOT cover: cross-device resolution, turn abort, session deletion,
 * Tentacle reconnect rehydration, interleaved attention cycling, and
 * multi-Arm attention isolation. All driven against the REAL Head + REAL
 * Tentacle + REAL browser stack so the Pulse transport is exercised.
 */
import { expect, type Browser, type BrowserContext, type Page, request, test } from '@playwright/test';

const CONTROL = process.env.REALSTACK_CONTROL_URL ?? 'http://localhost:4710';
const RELAY = process.env.REALSTACK_RELAY_URL ?? 'ws://localhost:4700';
const WEB = process.env.REALSTACK_WEB_URL ?? 'http://localhost:3700';

type Debug = {
  sessions: Array<{ id: string; state: string; preview?: { text: string; type: string; timestamp: string } }>;
  enrichedSessions: Array<{ id: string; state: string; preview?: { text: string; type: string; timestamp: string } }>;
  openQuestions: Record<string, string[]>;
  openPermissions: Record<string, string[]>;
  subscriptions: Record<string, string | null>;
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
async function debug(): Promise<Debug> { return (await control('/debug')) as unknown as Debug; }
async function enrichedPreview(sid: string): Promise<{ type: string; text: string } | undefined> {
  const d = await debug();
  return d.enrichedSessions.find((s) => s.id === sid)?.preview as { type: string; text: string } | undefined;
}
async function openQ(sid: string): Promise<string[]> { return (await debug()).openQuestions[sid] ?? []; }
async function openP(sid: string): Promise<string[]> { return (await debug()).openPermissions[sid] ?? []; }

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

/** Read the sidebar session-card text for a session id, normalized. */
async function cardText(page: Page, marker: string): Promise<string | null> {
  const btn = page.getByRole('button').filter({ hasText: marker }).first();
  if (await btn.count() === 0) return null;
  return (await btn.innerText()).replace(/\s+/g, ' ').trim();
}

test.describe('preview high-intensity stress', () => {
  let arm: { context: BrowserContext; page: Page; deviceId: string };

  test.beforeAll(async ({ browser }) => { arm = await pair(browser); });
  test.afterAll(async () => { await arm?.context.close(); });

  // ── 1. Cross-device answer: a second Arm (not subscribed) answers a
  // question that a third device opened. Both the question preview and the
  // subscribed Arm's card must clear. Exercises the session_list digest
  // clearing the non-subscribed Arm's sidebar preview after resolution.
  test('cross-device answer clears preview on a non-subscribed Arm', async ({ browser }) => {
    const sid = `xdev-${Date.now().toString(36)}`;
    const q = `XDEVQ-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/question', { sid, id: 'q-xdev', text: q, choices: 'alpha|beta' });
    await expect(arm.page.getByText(q, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question' });
    expect((await cardText(arm.page, q)) ?? '').toContain('waiting');

    // A DIFFERENT Arm answers it directly over Pulse.
    const other = await pair(browser);
    try {
      await other.page.goto(`${WEB}/session/${sid}`);
      await expect.poll(async () => (await debug()).subscriptions[other.deviceId], { timeout: 15_000 }).toBe(sid);
      await expect(other.page.getByRole('button', { name: 'alpha' })).toBeVisible({ timeout: 15_000 });
      await other.page.getByRole('button', { name: 'alpha' }).click();
      await expect.poll(async () => {
        const x = await control('/answers');
        return (x.answers as Array<{ answer: string }>).some((a) => a.answer === 'alpha');
      }).toBe(true);
      await settle();

      // The first (non-subscribed) Arm's sidebar must drop the question badge.
      expect(await openQ(sid)).toEqual([]);
      expect(await enrichedPreview(sid)).toBeUndefined();
      expect((await cardText(arm.page, q)) ?? '').not.toContain('waiting');
    } finally {
      await other.context.close();
    }
  });

  // ── 2. Turn abort (user_abort) while a question is open: the question
  // preview must clear and the card must not be left frozen on "waiting".
  test('turn abort clears an open question preview (no phantom waiting)', async () => {
    const sid = `abort-${Date.now().toString(36)}`;
    const q = `ABORTQ-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/question', { sid, id: 'q-abort', text: q, choices: 'yes|no' });
    await expect(arm.page.getByText(q, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question' });

    // Abort the turn through the real Arm->Tentacle message path.
    await control('/armAbort', { sid });
    await settle();

    expect(await openQ(sid)).toEqual([]);
    // The abort is now a real turn boundary, so the digest preview reflects it
    // ("Turn aborted") instead of being undefined. What matters for "no phantom
    // waiting": no question-typed attention remains and the card doesn't read
    // waiting.
    const abortPreview = await enrichedPreview(sid);
    expect(abortPreview?.type).not.toBe('question');
    expect((await cardText(arm.page, q)) ?? '').not.toContain('waiting');
  });

  // ── 3. Question + permission interleaved, each resolved independently,
  // then a new question opens on a fresh turn. The sidebar must always track
  // the CURRENT attention, never a stale resolved one.
  test('interleaved Q->P->resolve P->resolve Q->new turn new Q tracks current attention', async () => {
    const sid = `interleave-${Date.now().toString(36)}`;
    const q1 = `IQQ1-${Date.now().toString(36)}`;
    const p1 = `IQP1-${Date.now().toString(36)}`;
    const q2 = `IQQ2-${Date.now().toString(36)}`;
    await createSession(sid);

    await control('/perm', { sid, id: 'p-inter', tool: 'bash', desc: p1 });
    await control('/question', { sid, id: 'q-inter-1', text: q1, choices: 'a|b' });
    await settle();
    // Newest attention wins: question is more recent.
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question', text: q1 });

    await control('/permissionAutoResolved', { sid, id: 'p-inter' });
    await settle();
    expect(await openP(sid)).toEqual([]);
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question', text: q1 });

    await control('/questionAutoResolved', { sid, id: 'q-inter-1' });
    await settle();
    expect(await openQ(sid)).toEqual([]);
    expect(await enrichedPreview(sid)).toBeUndefined();
    expect((await cardText(arm.page, q1)) ?? '').not.toContain('waiting');

    // New turn, new question: sidebar must reflect ONLY q2, not resurrect q1.
    await control('/active', { sid });
    await control('/question', { sid, id: 'q-inter-2', text: q2, choices: 'c|d' });
    await settle();
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question', text: q2 });
    expect((await cardText(arm.page, q2)) ?? '').toContain('waiting');
    expect((await cardText(arm.page, q1)) ?? '').not.toContain('waiting');
  });

  // ── 4. Tentacle disconnect/reconnect while a question is open: the
  // pending human action is rehydrated from durable storage and the digest
  // must re-advertise the question preview (no false clear, no loss).
  test('Tentacle reconnect rehydrates an open question preview', async () => {
    const sid = `reconnect-${Date.now().toString(36)}`;
    const q = `RCQ-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/question', { sid, id: 'q-rc', text: q, choices: 'y|n' });
    await expect(arm.page.getByText(q, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question' });

    await control('/tentacle/disconnect');
    await settle(1500);
    // While tentacle is offline the preview stays (we don't falsely clear).
    await control('/tentacle/connect');
    // Give the relay time to re-auth + re-broadcast session_list.
    await expect.poll(async () => (await debug()).openQuestions[sid]?.length ?? 0, { timeout: 20_000 }).toBe(1);
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question', text: q });
    // The sidebar status badge depends on session.state derivation, not just
    // the digest preview, so we assert the transport-level recovery (digest
    // preview) rather than a UI status string here.

    // Now resolve it; must clear cleanly post-reconnect.
    await control('/questionAutoResolved', { sid, id: 'q-rc' });
    await settle();
    expect(await openQ(sid)).toEqual([]);
    expect(await enrichedPreview(sid)).toBeUndefined();
    expect((await cardText(arm.page, q)) ?? '').not.toContain('waiting');
  });

  // ── 5. delete_session while a question is open: the session disappears
  // from the sidebar entirely; no phantom preview row lingers.
  test('delete_session removes the session and its open-question preview', async () => {
    const sid = `del-${Date.now().toString(36)}`;
    const q = `DELQ-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/question', { sid, id: 'q-del', text: q, choices: 'y|n' });
    await expect(arm.page.getByText(q, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question' });

    await control('/armDelete', { sid });
    await settle(1000);

    const d = await debug();
    expect(d.enrichedSessions.find((s) => s.id === sid)).toBeUndefined();
    // Sidebar card gone too.
    await expect(arm.page.getByText(q, { exact: false })).toHaveCount(0);
  });

  // ── 6. Permission abandoned on idle (agent finishes without resolving):
  // the idle turn-end must clear the permission attention, not strand it.
  test('permission abandoned on idle clears (no stranded permission badge)', async () => {
    const sid = `abandon-${Date.now().toString(36)}`;
    const p = `ABANDONP-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/perm', { sid, id: 'p-abandon', tool: 'bash', desc: p });
    await expect(arm.page.getByText(p, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'permission' });

    // Agent idles without the user ever approving/denying.
    await control('/idle', { sid });
    await settle();
    expect(await openP(sid)).toEqual([]);
    expect(await enrichedPreview(sid)).toBeUndefined();
    expect((await cardText(arm.page, p)) ?? '').not.toContain('PERMISSION');
  });

  // ── 7. Two sessions each with independent attention, resolved in opposite
  // order: clearing one must NOT touch the other.
  test('independent sessions resolve without cross-contamination', async () => {
    const sidA = `indep-a-${Date.now().toString(36)}`;
    const sidB = `indep-b-${Date.now().toString(36)}`;
    const qA = `INDEPA-${Date.now().toString(36)}`;
    const pB = `INDEPB-${Date.now().toString(36)}`;
    await createSession(sidA);
    await createSession(sidB);
    await control('/question', { sid: sidA, id: 'q-indep-a', text: qA, choices: 'y|n' });
    await control('/perm', { sid: sidB, id: 'p-indep-b', tool: 'bash', desc: pB });
    await settle();
    expect(await enrichedPreview(sidA)).toMatchObject({ type: 'question' });
    expect(await enrichedPreview(sidB)).toMatchObject({ type: 'permission' });

    // Resolve B first, then A. A must still be intact after B clears.
    await control('/permissionAutoResolved', { sid: sidB, id: 'p-indep-b' });
    await settle();
    expect(await enrichedPreview(sidB)).toBeUndefined();
    expect(await enrichedPreview(sidA)).toMatchObject({ type: 'question', text: qA });

    await control('/questionAutoResolved', { sid: sidA, id: 'q-indep-a' });
    await settle();
    expect(await enrichedPreview(sidA)).toBeUndefined();
    expect(await enrichedPreview(sidB)).toBeUndefined();
  });

  // ── 8. Rapid open/autoresolve churn: many question cycles collapse to a
  // clean final state with no leaked attention maps or stale previews.
  test('rapid open/autoresolve churn leaves a clean final state', async () => {
    const sid = `churn-${Date.now().toString(36)}`;
    await createSession(sid);
    for (let i = 0; i < 8; i++) {
      const id = `q-churn-${i}`;
      await control('/question', { sid, id, text: `CHURN-${i}`, choices: 'y|n' });
      await control('/questionAutoResolved', { sid, id });
    }
    await settle(1000);
    expect(await openQ(sid)).toEqual([]);
    expect(await enrichedPreview(sid)).toBeUndefined();
  });

  // ── 9. Non-attention (agent_message) preview survives a digest that has
  // no attention: the fix must only clear question/permission previews,
  // never strand a normal agent reply.
  test('agent_message preview survives a no-attention digest', async () => {
    const sid = `spine-${Date.now().toString(36)}`;
    const agentText = `SPINE-${Date.now().toString(36)}`;
    await createSession(sid);
    await control('/msg', { sid, text: agentText });
    await control('/idle', { sid });
    await expect(arm.page.getByText(agentText, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    // Open then auto-resolve a question; the agent preview must return.
    await control('/question', { sid, id: 'q-spine', text: 'QTEMP', choices: 'y|n' });
    await settle();
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'question' });
    await control('/questionAutoResolved', { sid, id: 'q-spine' });
    await settle();
    // Question resolved -> the digest reverts to the spine agent_message
    // preview (NOT undefined - the agent reply is the durable sidebar text).
    expect(await enrichedPreview(sid)).toMatchObject({ type: 'agent', text: agentText });
    // The agent_message preview should be back on the sidebar card.
    expect((await cardText(arm.page, agentText)) ?? '').toContain(agentText);
  });
});
