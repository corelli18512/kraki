/**
 * Web client under network faults (docs/network-resilience-test-plan.md).
 * The real built web app runs in Chromium against a local Head + Tentacle
 * behind a fault-injection proxy. Nothing here touches production.
 */
import { expect, test } from '@playwright/test';
import {
  connections, control, expectDelivered, fault, installSampler, openSession, pause, send, uid, writeResult,
  type Metrics,
} from './harness';

const results: Record<string, Metrics> = {};

test.describe('web network resilience', () => {
  test.afterEach(async ({}, info) => {
    await control('POST', '/heal');
    writeResult(info.title.split(' ')[0], results[info.title] ?? {});
  });

  test('W0 healthy baseline', async ({ page }) => {
    const m: Metrics = (results['W0 healthy baseline'] = {});
    const sid = await openSession(page);
    const texts = [0, 1, 2].map((i) => `w0-${i}-${uid()}`);
    for (const t of texts) { await send(page, t); await pause(400); }
    await expectDelivered(page, sid, texts, 15_000, m);
  });

  test('W1 flash reset', async ({ page }) => {
    const m: Metrics = (results['W1 flash reset'] = {});
    const sid = await openSession(page);
    const before = await connections();
    const texts = [`w1-a-${uid()}`, `w1-b-${uid()}`];
    await send(page, texts[0]);
    await control('POST', '/reset', { link: 'app' });
    await send(page, texts[1]);
    await expectDelivered(page, sid, texts, 20_000, m);
    m.reconnects = (await connections()) - before;
    expect(m.reconnectingEver, 'G4: a sub-2 s blip shows no "Reconnecting"').toBe(false);
  });

  test('W2 outage 60s', async ({ page }) => {
    const m: Metrics = (results['W2 outage 60s'] = {});
    const sid = await openSession(page);
    await fault({ refuse: true });
    await control('POST', '/reset', { link: 'app' });
    const texts = [`w2-a-${uid()}`, `w2-b-${uid()}`];
    await pause(5_000); await send(page, texts[0]);
    await pause(30_000); await send(page, texts[1]);
    await pause(25_000);
    await control('POST', '/heal');
    await expectDelivered(page, sid, texts, 15_000, m);
  });

  test('W3 half-open', async ({ page }) => {
    const m: Metrics = (results['W3 half-open'] = {});
    const sid = await openSession(page);
    const before = await connections();
    await fault({ blackhole: 'both' });
    const texts = [`w3-${uid()}`];
    await send(page, texts[0]);
    const start = Date.now();
    while ((await connections()) === before && Date.now() - start < 90_000) await pause(250);
    m.deadLinkDetectMs = Date.now() - start;
    await control('POST', '/reset', { link: 'app' });
    await control('POST', '/heal');
    await expectDelivered(page, sid, texts, 20_000, m);
    expect(m.deadLinkDetectMs as number, 'G5: half-open detected within 30 s').toBeLessThanOrEqual(30_000);
  });

  test('W4 large message on a slow link', async ({ page }) => {
    const m: Metrics = (results['W4 large message on a slow link'] = {});
    const sid = await openSession(page);
    const before = await connections();
    await fault({ bytesPerSec: 40_000 }); // 0.32 Mbit/s
    await control('POST', '/agent/burst', { sessionId: sid, count: 1, bytes: 1_000_000, prefix: 'huge' });
    await pause(3_000);
    const texts = [`w4-${uid()}`];
    await send(page, texts[0]);
    await expectDelivered(page, sid, texts, 150_000, m);
    m.reconnects = (await connections()) - before;
    expect(m.reconnects, 'G6: a slow large message is not a dead link').toBe(0);
  });

  test('W5 reload with an unconfirmed input', async ({ page }) => {
    const m: Metrics = (results['W5 reload with an unconfirmed input'] = {});
    const sid = await openSession(page);
    await fault({ blackhole: 'both' });
    const texts = [`w5-${uid()}`];
    await send(page, texts[0]);
    await pause(1_000);
    await control('POST', '/reset', { link: 'app' });
    await control('POST', '/heal');
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(installSampler);
    await expectDelivered(page, sid, texts, 30_000, m);
  });

  test('W6 reload with an unconfirmed input, then the Tentacle reconnects', async ({ page }) => {
    // Soak seed 2003: the Tentacle's greeting after its own reconnect carried
    // no features, so the restored input was judged unsafe to resend and
    // left "Not delivered" — never delivered.
    const m: Metrics = (results['W6 reload with an unconfirmed input, then the Tentacle reconnects'] = {});
    const sid = await openSession(page);
    await fault({ refuse: true });
    await control('POST', '/reset', { link: 'app' });
    const texts = [`w6-${uid()}`];
    await send(page, texts[0]);
    await pause(2_000);
    await control('POST', '/heal');
    await page.reload();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(installSampler);
    await pause(3_000);
    await control('POST', '/reset', { link: 'tentacle' });
    await expectDelivered(page, sid, texts, 90_000, m);
  });

  test('W7 steer while the agent is replying', async ({ page }) => {
    // Nightly soak (30 min): inputs typed while a turn was running were
    // received by the agent but never confirmed on the page.
    const m: Metrics = (results['W7 steer while the agent is replying'] = {});
    const sid = await openSession(page);
    await control('POST', '/agent/options', { replyDelayMs: 150, deltas: 40, deltaIntervalMs: 250 });
    try {
      const texts = [`w7-a-${uid()}`, `w7-b-${uid()}`, `w7-c-${uid()}`];
      await send(page, texts[0]);
      await expect(page.getByRole('textbox', { name: 'Steer the agent…' })).toBeVisible({ timeout: 10_000 });
      await send(page, texts[1]);
      await pause(1_500);
      await send(page, texts[2]);
      await expectDelivered(page, sid, texts, 60_000, m);
    } finally {
      await control('POST', '/agent/options', { replyDelayMs: 150, deltas: 4, deltaIntervalMs: 80 });
    }
  });

  test('W8 inputs sent into a dead link while the Tentacle reconnects', async ({ page }) => {
    // Nightly soak (30 min, seed 4242, 340 s): sent during a blackhole; the
    // Tentacle reconnected before the app did. The agent got every input but
    // the page never confirmed them.
    const m: Metrics = (results['W8 inputs sent into a dead link while the Tentacle reconnects'] = {});
    const sid = await openSession(page);
    await fault({ blackhole: 'both' });
    const texts = [`w8-a-${uid()}`, `w8-b-${uid()}`, `w8-c-${uid()}`];
    for (const t of texts) { await send(page, t); await pause(3_000); }
    await pause(15_000);
    await control('POST', '/heal');
    await pause(14_000);
    await control('POST', '/reset', { link: 'tentacle' });
    await pause(13_000);
    await control('POST', '/reset', { link: 'app' });
    await expectDelivered(page, sid, texts, 90_000, m);
  });
});
