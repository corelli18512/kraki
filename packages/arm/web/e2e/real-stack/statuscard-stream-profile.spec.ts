/**
 * Profile the status-card draft (text) delta rendering.
 *
 * Drives a sustained token stream into a session's live card and measures, in
 * the real browser, two things:
 *   1. render lag — how late the rendered draft text trails the Nth chunk's
 *      arrival (a direct proxy for "smoothness").
 *   2. dropped frames — long tasks / FPS dips during the stream, which is what
 *      makes the text feel janky (it jumps in bursts instead of flowing).
 *
 * Captured entirely in-page via PerformanceObserver + a custom WS tap so the
 * measurement is independent of the transport.
 */
import { expect, type Browser, type BrowserContext, type Page, request, test } from '@playwright/test';

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

async function pair(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  // Tap JSON.parse for agent_message_delta + long-task observer on EVERY nav.
  await context.addInitScript(() => {
    (window as unknown as { __deltas: Array<{ at: number; len: number }> }).__deltas = [];
    const parse = JSON.parse.bind(JSON);
    JSON.parse = function (text: string) {
      const v = parse(text);
      if (v && typeof v === 'object' && v.type === 'agent_message_delta') {
        (window as unknown as { __deltas: Array<{ at: number; len: number }> }).__deltas
          .push({ at: performance.now(), len: ((v.payload?.content ?? '') as string).length });
      }
      return v;
    } as typeof JSON.parse;
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (window as unknown as { __longTasks: number[] }).__longTasks.push(e.duration);
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unsupported */ }
    // rAF frame counter — counts actual painted frames so we can see FPS dips.
    (window as unknown as { __frames: number[] }).__frames = [];
    const tick = () => {
      (window as unknown as { __frames: number[] }).__frames.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const page = await context.newPage();
  const { token } = await control('/token');
  await page.goto(`${WEB}?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('RealStack Tentacle').first()).toBeVisible({ timeout: 20_000 });
  return { context, page };
}

test('profile: status-card draft delta smoothness', async ({ browser }) => {
  const sid = `stream-${Date.now().toString(36)}`;
  const marker = `STREAMMARK-${sid}`;
  await control('/createSession', { id: sid });
  await control('/msg', { sid, text: marker });
  await control('/idle', { sid });
  const arm = await pair(browser);
  try {
    // Wait for the session to appear in the sidebar, then click its card
    // (deep-linking before hydration falls back to the welcome screen).
    await expect.poll(async () => {
      const d = await control('/debug');
      return (d.enrichedSessions as Array<{ id: string }>).some((s) => s.id === sid);
    }, { timeout: 20_000 }).toBe(true);
    const card = arm.page.locator('button').filter({ hasText: marker }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(arm.page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 15_000 });

    // (The delta tap + long-task observer are installed via addInitScript on
    // every navigation, so they are already active.)

    // Observe the live draft DOM: record the timestamp of every text-content
    // change so we can see the actual on-screen update cadence (what the user
    // perceives as smooth vs janky).
    await arm.page.evaluate(() => {
      (window as unknown as { __draftUpdates: number[] }).__draftUpdates = [];
      const startPoll = () => {
        const el = document.querySelector('[data-live-bubble] .markdown-content') as HTMLElement | null;
        if (!el) { setTimeout(startPoll, 50); return; }
        const mo = new MutationObserver(() => {
          (window as unknown as { __draftUpdates: number[] }).__draftUpdates.push(performance.now());
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true });
      };
      startPoll();
    });

    // Wait for the live card's draft container to exist, then stream.
    // Drive 400 chunks at ~20ms with HEAVY markdown (code fences + lists) so
    // every render re-runs remark + rehype-highlight on growing structured
    // content — the real worst case for the status-card draft.
    const streamPromise = control('/deltaStream', { sid, chunks: '400', intervalMs: '20', size: '12', heavy: '1' });

    // MID-STREAM snapshot: while tokens are still arriving (~halfway), assert
    // markdown STRUCTURE is rendered — not raw `**` / ` ``` ` markers. This is
    // the regression target: the draft must show parsed markdown during
    // streaming. (Previously it degraded to raw text until the stream settled.)
    await arm.page.waitForTimeout(3000);
    const midStream = await arm.page.evaluate(() => {
      const root = document.querySelector('[data-live-bubble] .markdown-content') as HTMLElement | null;
      if (!root) return { hasDom: false };
      return {
        hasDom: true,
        hasCode: !!root.querySelector('code'),
        hasListItem: !!root.querySelector('li'),
        hasStrongOrEm: !!root.querySelector('strong, em'),
        rawMarkerVisible: /\*\*|```/.test(root.innerText),
        textLen: root.innerText.length,
      };
    });
    console.log(`MID_STREAM ${JSON.stringify(midStream)}`);

    await streamPromise;

    // Give the renderer + 40ms coalesce a moment to settle the tail.
    await arm.page.waitForTimeout(2000);

    const report = await arm.page.evaluate(() => {
      const deltas = (window as unknown as { __deltas: Array<{ at: number; len: number }> }).__deltas;
      const longTasks = (window as unknown as { __longTasks: number[] }).__longTasks;
      const draftEl = document.querySelector('[data-live-bubble] .markdown-content') as HTMLElement | null;
      const frames = (window as unknown as { __frames: number[] }).__frames ?? [];
      const span = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
      const expectedFrames = span > 0 ? Math.round(span / 16.67) : 0;
      const draftUpdates = (window as unknown as { __draftUpdates: number[] }).__draftUpdates ?? [];
      // inter-update gaps = how bursty the on-screen text growth is
      const gaps: number[] = [];
      for (let k = 1; k < draftUpdates.length; k++) gaps.push(draftUpdates[k] - draftUpdates[k - 1]);
      const gapsSorted = [...gaps].sort((a, b) => a - b);
      const pct = (p: number) => gapsSorted.length ? Math.round(gapsSorted[Math.min(gapsSorted.length - 1, Math.floor(gapsSorted.length * p))]) : 0;
      const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      return {
        deltaCount: deltas.length,
        deltaSpanMs: deltas.length > 1 ? Math.round(deltas[deltas.length - 1].at - deltas[0].at) : 0,
        longTaskCount: longTasks.length,
        longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
        longTaskSumMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
        longTasksOver50: longTasks.filter((d) => d > 50).length,
        longTasksOver100: longTasks.filter((d) => d > 100).length,
        finalDraftLen: draftEl?.innerText.length ?? 0,
        rafFrames: frames.length,
        rafSpanMs: Math.round(span),
        rafExpectedFrames: expectedFrames,
        rafFps: span > 0 ? Math.round((frames.length / span) * 1000) : 0,
        rafDroppedFrames: Math.max(0, expectedFrames - frames.length),
        draftUpdateCount: draftUpdates.length,
        draftGapMeanMs: Math.round(mean(gaps)),
        draftGapP50Ms: pct(0.5),
        draftGapP90Ms: pct(0.9),
        draftGapMaxMs: gapsSorted.length ? Math.round(gapsSorted[gapsSorted.length - 1]) : 0,
        draftGapsOver50: gaps.filter((g) => g > 50).length,
        draftGapsOver100: gaps.filter((g) => g > 100).length,
      };
    });

    console.log(`STREAM_PROFILE ${JSON.stringify(report)}`);
    // Sanity: deltas arrived and the draft rendered content.
    expect(report.deltaCount).toBeGreaterThan(50);
    expect(report.finalDraftLen).toBeGreaterThan(100);
    // CORE: markdown structure must render DURING streaming (sampled mid-stream
    // while tokens were still arriving), not raw markers.
    expect(midStream.hasDom).toBe(true);
    expect(midStream.hasCode || midStream.hasListItem || midStream.hasStrongOrEm).toBe(true);
    expect(midStream.rawMarkerVisible).toBe(false);
  } finally {
    await arm.context.close();
  }
});
