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
  const context = await request.newContext();
  const query = new URLSearchParams(params).toString();
  const response = await context.get(`${CONTROL}${path}${query ? `?${query}` : ''}`);
  const body = await response.json();
  await context.dispose();
  if (!response.ok()) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

async function debug(): Promise<Debug> {
  return await control('/debug') as unknown as Debug;
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

function digest(d: Debug, sid: string, enriched = true) {
  return (enriched ? d.enrichedSessions : d.sessions).find((s) => s.id === sid);
}

async function cardText(page: Page, marker: string): Promise<string | null> {
  // The session card (sidebar row) whose text has the marker. Its status is
  // a glyph now, so append it as a word ("waiting", "approval", …) from the
  // row's data-status. Read in one step: the row re-renders while the
  // preview changes, and a second lookup could wait for a row that is gone.
  return page.evaluate((m) => {
    const row = [...document.querySelectorAll('button.ksr')].find((b) => (b.textContent ?? '').includes(m));
    if (!row) return null;
    const text = ((row as HTMLElement).innerText ?? row.textContent ?? '').replace(/\s+/g, ' ').trim();
    const status = row.querySelector('.ksr-status-slot')?.getAttribute('data-status');
    return status ? `${text} [${status}]` : text;
  }, marker);
}

async function snapshot(page: Page, sid: string, marker: string, label: string) {
  const d = await debug();
  const value = {
    label,
    sid,
    raw: digest(d, sid, false),
    enriched: digest(d, sid, true),
    openQuestions: d.openQuestions[sid] ?? [],
    openPermissions: d.openPermissions[sid] ?? [],
    uiCard: await cardText(page, marker),
    markerCount: await page.getByText(marker, { exact: false }).count(),
  };
  console.log(`PREVIEW_STATE ${JSON.stringify(value)}`);
  return value;
}

test('preview lifecycle matrix: question, permission, resolution, failure cleanup, refresh', async ({ browser }) => {
  const arm = await pair(browser);
  const failures: string[] = [];
  try {
    // 1. Non-subscribed question: digest overlay should appear globally.
    const qSid = `preview-q-${Date.now().toString(36)}`;
    const qText = `QUESTION-${Date.now().toString(36)}`;
    await control('/createSession', { id: qSid });
    await control('/idle', { sid: qSid });
    await control('/question', { sid: qSid, id: 'q-auto', text: qText, choices: 'yes|no' });
    await expect(arm.page.getByText(qText, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    let state = await snapshot(arm.page, qSid, qText, 'question-open-unsubscribed');
    if (state.enriched?.preview?.type !== 'question') failures.push('question open: Tentacle digest is not question');
    if (!state.uiCard?.includes('waiting')) failures.push('question open: sidebar is not waiting');

    // Agent auto-cancels it while this Arm is not subscribed. The question
    // stays on the session's spine as an agent line (6180ce03/8789a89f), so
    // the digest previews it as one: Web must show it as such, not waiting.
    await control('/questionAutoResolved', { sid: qSid, id: 'q-auto' });
    await expect.poll(async () => (await debug()).openQuestions[qSid]?.length ?? 0).toBe(0);
    await arm.page.waitForTimeout(800);
    state = await snapshot(arm.page, qSid, qText, 'question-auto-resolved-unsubscribed');
    if (state.enriched?.preview?.type === 'question') failures.push('question auto-resolve: Tentacle still reports question');
    if (state.uiCard?.includes('waiting')) failures.push('question auto-resolve: Web retains false waiting');
    if (state.enriched?.preview?.type !== 'agent') failures.push('question auto-resolve: digest is not the agent line');
    // The turn goes on (status "active"); the card shows the line, no attention.
    if (!state.uiCard?.includes(qText) || /\[(waiting|approval)\]/.test(state.uiCard)) failures.push('question auto-resolve: Web card is not the plain line');

    // Refresh must not resurrect stale persisted question preview.
    await arm.page.reload();
    await expect(arm.page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
    await arm.page.waitForTimeout(800);
    state = await snapshot(arm.page, qSid, qText, 'question-resolved-after-refresh');
    if (state.uiCard?.includes('waiting')) failures.push('question refresh: false waiting resurrected');
    if (!state.uiCard?.includes(qText) || /\[(waiting|approval)\]/.test(state.uiCard)) failures.push('question refresh: card is not the plain line');

    // 2. Current-session question answered through the real UI. Optimistic
    // answer preview should clear waiting immediately, and authoritative digest
    // must no longer be a question.
    const answerSid = `preview-answer-${Date.now().toString(36)}`;
    const answerQuestion = `ANSWER-Q-${Date.now().toString(36)}`;
    await control('/createSession', { id: answerSid });
    await control('/idle', { sid: answerSid });
    await arm.page.goto(`${WEB}/session/${answerSid}`);
    await expect.poll(async () => (await debug()).subscriptions[arm.deviceId], { timeout: 15_000 }).toBe(answerSid);
    await control('/question', { sid: answerSid, id: 'q-click', text: answerQuestion, choices: 'choice-one|choice-two' });
    await expect(arm.page.getByRole('button', { name: 'Answer: choice-one', exact: true })).toBeVisible({ timeout: 15_000 });
    await arm.page.getByRole('button', { name: 'Answer: choice-one', exact: true }).click();
    await expect.poll(async () => (await control('/answers').then((x) => x.answers as Array<{ sid: string; answer: string }>)).some((x) => x.sid === answerSid && x.answer === 'choice-one')).toBe(true);
    await arm.page.waitForTimeout(500);
    state = await snapshot(arm.page, answerSid, 'choice-one', 'question-user-answered');
    if (state.enriched?.preview?.type === 'question') failures.push('question answer: Tentacle still reports question');
    if (state.uiCard?.includes('waiting')) failures.push('question answer: sidebar still waiting');

    // 3. Non-subscribed permission auto-resolution. Permission is a badge /
    // preview attention item, but should not display waiting (waiting is reserved
    // for blocking ask_user questions). It must disappear after resolution.
    await arm.page.goto(WEB);
    const pSid = `preview-perm-${Date.now().toString(36)}`;
    const pText = `PERMISSION-${Date.now().toString(36)}`;
    await control('/createSession', { id: pSid });
    await control('/idle', { sid: pSid });
    await control('/perm', { sid: pSid, id: 'perm-auto', tool: 'bash', desc: pText });
    await expect(arm.page.getByText(pText, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    state = await snapshot(arm.page, pSid, pText, 'permission-open-unsubscribed');
    if (state.enriched?.preview?.type !== 'permission') failures.push('permission open: Tentacle digest is not permission');
    if (state.uiCard?.includes('waiting')) failures.push('permission open: sidebar incorrectly says waiting');
    await control('/permissionAutoResolved', { sid: pSid, id: 'perm-auto' });
    await expect.poll(async () => (await debug()).openPermissions[pSid]?.length ?? 0).toBe(0);
    await arm.page.waitForTimeout(800);
    state = await snapshot(arm.page, pSid, pText, 'permission-auto-resolved-unsubscribed');
    if (state.enriched?.preview?.type === 'permission') failures.push('permission auto-resolve: Tentacle still reports permission');
    if (state.markerCount > 0) failures.push('permission auto-resolve: Web retains stale permission preview');

    // 4. Question + permission followed by terminal error/idle. Both attention
    // maps must clear. This catches boolean short-circuit cleanup.
    const mixedSid = `preview-mixed-${Date.now().toString(36)}`;
    const mixedQ = `MIXED-Q-${Date.now().toString(36)}`;
    const mixedP = `MIXED-P-${Date.now().toString(36)}`;
    await control('/createSession', { id: mixedSid });
    await control('/idle', { sid: mixedSid });
    await control('/perm', { sid: mixedSid, id: 'perm-mixed', tool: 'bash', desc: mixedP });
    await control('/question', { sid: mixedSid, id: 'q-mixed', text: mixedQ, choices: 'a|b' });
    await control('/error', { sid: mixedSid, message: 'terminal mixed failure' });
    await control('/idle', { sid: mixedSid });
    await arm.page.waitForTimeout(800);
    state = await snapshot(arm.page, mixedSid, mixedP, 'mixed-terminal-cleanup');
    if (state.openQuestions.length > 0) failures.push('mixed cleanup: question map retained');
    if (state.openPermissions.length > 0) failures.push('mixed cleanup: permission map retained');
    if (state.enriched?.preview?.type === 'question' || state.enriched?.preview?.type === 'permission') failures.push('mixed cleanup: attention digest retained');

    console.log(`PREVIEW_FAILURES ${JSON.stringify(failures)}`);
    expect(failures).toEqual([]);
  } finally {
    await arm.context.close();
  }
});
