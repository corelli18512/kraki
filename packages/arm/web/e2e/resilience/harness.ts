/**
 * Shared helpers for the web network-resilience specs: the local chaos stack's
 * control plane (packages/tests/src/chaos/stack.ts), an in-page sampler of
 * what the user sees, and exactly-once delivery checks.
 */
import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Stack { controlPort: number; appPort: number; tentaclePort: number; tentacleId: string }
export const stack = JSON.parse(readFileSync('/tmp/kraki-chaos/stack.json', 'utf8')) as Stack;
const CONTROL = `http://127.0.0.1:${stack.controlPort}`;
const RELAY = `ws://127.0.0.1:${stack.appPort}`;

export type Link = 'app' | 'tentacle';
export type Metrics = Record<string, unknown>;

export async function control(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  return (await res.json()) as Record<string, unknown>;
}
export const fault = (patch: Record<string, unknown>, link: Link = 'app') => control('POST', '/fault', { link, ...patch });
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 8);

export async function connections(link: Link = 'app'): Promise<number> {
  return (((await control('GET', '/stats'))[link] as { total: number }).total);
}

// ── Packet-level faults (Linux tc netem on loopback, CI only) ──────────────

export const NETEM = process.env.KRAKI_NETEM === '1';
// run-web.sh runs Playwright from packages/arm/web.
const NETEM_SCRIPT = resolve(process.cwd(), '../../../scripts/chaos/netem.sh');
const band: Record<Link, number> = { app: 4, tentacle: 5 };
const port = (link: Link) => (link === 'app' ? stack.appPort : stack.tentaclePort);

/** Apply a netem profile (e.g. `delay 80ms 40ms loss 3%`) to one link, both
 *  directions. Empty string = no impairment. */
export function netem(link: Link, spec: string): void {
  if (!NETEM) throw new Error('netem needs KRAKI_NETEM=1 (Linux CI)');
  execFileSync('sudo', ['bash', NETEM_SCRIPT, 'set', String(band[link]), String(port(link)), ...spec.split(' ').filter(Boolean)], { stdio: 'inherit' });
}
export function netemClear(): void {
  if (!NETEM) return;
  netem('app', '');
  netem('tentacle', '');
}

// ── What the user sees ──────────────────────────────────────────────────────

interface Sampled {
  failedEver: boolean;
  reconnectingEver: boolean;
  blockedEver: boolean;
  sentAt: Record<string, number>;
  confirmedAt: Record<string, number>;
  /** Text of each bubble first seen marked "Not delivered", and when. */
  failedAt: Record<string, number>;
}

/** Samples the page every 200 ms: failure marks, "Reconnecting", modals, and
 *  when each sent text became a confirmed (non-pending) bubble. */
export function installSampler(): void {
  const w = window as unknown as { __k: Sampled };
  w.__k = { failedEver: false, reconnectingEver: false, blockedEver: false, sentAt: {}, confirmedAt: {}, failedAt: {} };
  setInterval(() => {
    const k = w.__k;
    for (const mark of document.querySelectorAll('[aria-label="Not delivered. Retry or delete"]')) {
      k.failedEver = true;
      const text = mark.closest('.krow-user')?.textContent?.replace('!', '').trim() ?? '?';
      k.failedAt[text] ??= Date.now();
    }
    if (document.body.innerText.includes('Reconnecting')) k.reconnectingEver = true;
    if (document.querySelector('[role="alertdialog"]')) k.blockedEver = true;
    const pending = new Set<string>();
    for (const row of document.querySelectorAll('.krow-user.is-sending')) pending.add(row.textContent ?? '');
    const confirmed = [...document.querySelectorAll('.krow-user:not(.is-sending)')].map((row) => row.textContent ?? '');
    const now = Date.now();
    for (const text of Object.keys(k.sentAt)) {
      if (k.confirmedAt[text] || [...pending].some((p) => p.includes(text))) continue;
      if (confirmed.some((c) => c.includes(text))) k.confirmedAt[text] = now;
    }
  }, 200);
}

export async function openSession(page: Page): Promise<string> {
  await control('POST', '/heal');
  const { sessionId } = await control('POST', '/session') as { sessionId: string };
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  const { token } = await control('POST', '/pairing-token') as { token: string };
  await page.goto(`/?relay=${encodeURIComponent(RELAY)}&token=${token}`);
  await expect(page.getByText('Chaos Tentacle').first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await page.evaluate(installSampler);
  return sessionId;
}

/** Type into the composer and press Enter, whatever its mode: "Send a
 *  message…" when idle, "Steer the agent…" while a turn runs (the input then
 *  steers it). Bounded: a harness must never block on the UI while a fault it
 *  is supposed to heal keeps a turn from ending. */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.locator('.kcomposer textarea');
  await box.fill(text, { timeout: 15_000 });
  await box.press('Enter', { timeout: 5_000 });
  await page.evaluate((t) => { (window as unknown as { __k: Sampled }).__k.sentAt[t] = Date.now(); }, text);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Every text reaches the agent exactly once; the page shows no failure. */
export async function expectDelivered(page: Page, sessionId: string, texts: string[], withinMs: number, m: Metrics): Promise<void> {
  const start = Date.now();
  let received: Record<string, number> = {};
  while (Date.now() - start < withinMs) {
    received = (await control('GET', `/ledger?sessionId=${sessionId}`)).received as Record<string, number>;
    const pending = await page.locator('.krow-user.is-sending').count();
    if (texts.every((t) => received[t]) && pending === 0) break;
    await pause(250);
  }
  m.settleMs = Date.now() - start;
  await pause(1_000);
  received = (await control('GET', `/ledger?sessionId=${sessionId}`)).received as Record<string, number>;
  const k = await page.evaluate(() => (window as unknown as { __k: Sampled }).__k);
  const latencies = texts.flatMap((t) => (k.sentAt[t] && k.confirmedAt[t] ? [k.confirmedAt[t] - k.sentAt[t]] : []));
  Object.assign(m, {
    failedEver: k.failedEver, reconnectingEver: k.reconnectingEver, blockedEver: k.blockedEver,
    failedAt: Object.fromEntries(Object.entries(k.failedAt).map(([t, at]) => [t, { at, sinceSendMs: k.sentAt[t] ? at - k.sentAt[t] : null }])),
    confirmP50Ms: percentile(latencies, 50), confirmP95Ms: percentile(latencies, 95), confirmMaxMs: percentile(latencies, 100),
    lost: texts.filter((t) => !received[t]),
    duplicated: texts.filter((t) => (received[t] ?? 0) > 1),
    stillSending: await page.locator('.krow-user.is-sending').count(),
  });
  expect(m.lost, 'G1: every input reaches the agent').toEqual([]);
  expect(m.duplicated, 'G2: exactly once').toEqual([]);
  expect(m.stillSending, 'G1/G4: all confirmed').toBe(0);
  expect(k.failedEver, 'G3: no "Not delivered" shown').toBe(false);
  expect(k.blockedEver, 'G4: the app is never blocked by a modal').toBe(false);
}

export function writeResult(name: string, m: Metrics): void {
  mkdirSync('/tmp/kraki-chaos/results', { recursive: true });
  writeFileSync(`/tmp/kraki-chaos/results/web_${name}.json`, JSON.stringify(m, null, 2));
}
