/**
 * Packet-level faults (tc netem: loss, jitter, reordering, duplication) and a
 * long randomized soak, for the web client against the local chaos stack.
 *
 *   N1–N4  need KRAKI_NETEM=1 (Linux CI with sudo; scripts/chaos/netem.sh)
 *   S1     needs KRAKI_SOAK_MINUTES; uses netem too when KRAKI_NETEM=1,
 *          otherwise proxy-level faults only. Seeded by CHAOS_SEED.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  NETEM, connections, control, expectDelivered, fault, installSampler, netem, netemClear, openSession, pause, send,
  uid, writeResult, type Metrics,
} from './harness';

const results: Record<string, Metrics> = {};

test.describe('web under packet loss (netem)', () => {
  test.skip(!NETEM, 'needs KRAKI_NETEM=1 (Linux CI)');

  test.afterEach(async ({}, info) => {
    netemClear();
    await control('POST', '/heal');
    writeResult(info.title.split(' ')[0], results[info.title] ?? {});
  });

  /** Chat at a human pace for `count` messages while the agent replies. */
  async function chat(page: Page, prefix: string, count: number, gapMs: [number, number]): Promise<string[]> {
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = `${prefix}-${i}-${uid()}`;
      texts.push(text);
      await send(page, text);
      await pause(gapMs[0] + Math.random() * (gapMs[1] - gapMs[0]));
    }
    return texts;
  }

  test('N1 mobile network: 3% loss, jitter, reordering', async ({ page }) => {
    const m: Metrics = (results['N1 mobile network: 3% loss, jitter, reordering'] = {});
    const sid = await openSession(page);
    const before = await connections();
    netem('app', 'delay 60ms 30ms distribution normal loss 3% reorder 5% 50% duplicate 1%');
    const texts = await chat(page, 'n1', 15, [1_000, 2_500]);
    await expectDelivered(page, sid, texts, 60_000, m);
    m.reconnects = (await connections()) - before;
    expect(m.reconnects as number, 'G6: steady loss is not a dead link').toBeLessThanOrEqual(1);
    expect(m.confirmP95Ms as number, 'G7: confirmation stays interactive').toBeLessThan(8_000);
  });

  test('N2 loss burst: 30% for 40 s', async ({ page }) => {
    const m: Metrics = (results['N2 loss burst: 30% for 40 s'] = {});
    const sid = await openSession(page);
    const texts = await chat(page, 'n2-pre', 3, [500, 1_000]);
    netem('app', 'delay 50ms 20ms loss 30%');
    texts.push(...await chat(page, 'n2-burst', 5, [6_000, 9_000]));
    netem('app', '');
    await expectDelivered(page, sid, texts, 90_000, m);
  });

  test('N3 both links lossy, with a large agent message', async ({ page }) => {
    const m: Metrics = (results['N3 both links lossy, with a large agent message'] = {});
    const sid = await openSession(page);
    const before = { app: await connections('app'), tentacle: await connections('tentacle') };
    netem('app', 'delay 100ms 50ms distribution normal loss 2% reorder 3% 50%');
    netem('tentacle', 'delay 150ms 50ms distribution normal loss 2%');
    await control('POST', '/agent/burst', { sessionId: sid, count: 1, bytes: 300_000, prefix: 'big' });
    const texts = await chat(page, 'n3', 10, [1_500, 3_000]);
    await expectDelivered(page, sid, texts, 120_000, m);
    m.reconnectsApp = (await connections('app')) - before.app;
    m.reconnectsTentacle = (await connections('tentacle')) - before.tentacle;
    expect(m.reconnectsApp as number).toBeLessThanOrEqual(1);
    expect(m.reconnectsTentacle as number).toBeLessThanOrEqual(1);
  });

  test('N4 very bad link: 10% loss, 300 ms delay', async ({ page }) => {
    const m: Metrics = (results['N4 very bad link: 10% loss, 300 ms delay'] = {});
    const sid = await openSession(page);
    const before = await connections();
    netem('app', 'delay 300ms 100ms distribution normal loss 10%');
    const texts = await chat(page, 'n4', 6, [3_000, 5_000]);
    await expectDelivered(page, sid, texts, 150_000, m);
    m.reconnects = (await connections()) - before;
  });
});

// ── Soak ────────────────────────────────────────────────────────────────────

const SOAK_MINUTES = Number(process.env.KRAKI_SOAK_MINUTES ?? 0);

/** Deterministic PRNG (mulberry32) so a failing soak can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Carried { failedEver: boolean; blockedEver: boolean; sentAt: Record<string, number> }

async function harvest(page: Page): Promise<Carried> {
  return page.evaluate(() => {
    const k = (window as unknown as { __k: Carried }).__k;
    return { failedEver: k.failedEver, blockedEver: k.blockedEver, sentAt: k.sentAt };
  });
}

async function heapMb(page: Page): Promise<number> {
  return page.evaluate(() => {
    (window as unknown as { gc?: () => void }).gc?.();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? Math.round(mem.usedJSHeapSize / 1e5) / 10 : -1;
  });
}

test.describe('web soak', () => {
  test.skip(!SOAK_MINUTES, 'needs KRAKI_SOAK_MINUTES');

  test('S1 randomized soak', async ({ page }) => {
    test.setTimeout(SOAK_MINUTES * 60_000 + 6 * 60_000);
    const seed = Number(process.env.CHAOS_SEED ?? Date.now() % 100_000);
    const random = rng(seed);
    const m: Metrics = (results.S1 = { seed, minutes: SOAK_MINUTES, actions: {} as Record<string, number> });
    const count = (a: string) => { (m.actions as Record<string, number>)[a] = ((m.actions as Record<string, number>)[a] ?? 0) + 1; };
    const sid = await openSession(page);
    await pause(3_000);
    m.heapStartMb = await heapMb(page);

    const texts: string[] = [];
    const carried: Carried = { failedEver: false, blockedEver: false, sentAt: {} };
    let healAt = 0;
    const end = Date.now() + SOAK_MINUTES * 60_000;
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    const between = (lo: number, hi: number) => lo + random() * (hi - lo);

    try {
      while (Date.now() < end) {
        if (healAt && Date.now() >= healAt) {
          netemClear();
          await control('POST', '/heal');
          healAt = 0;
          count('heal');
        }
        const roll = random();
        const faultFree = healAt === 0;
        if (roll < 0.45) {
          const text = `s1-${texts.length}-${uid()}`;
          texts.push(text);
          await send(page, text);
          count('send');
        } else if (roll < 0.50) {
          await control('POST', '/reset', { link: pick(['app', 'tentacle']) });
          count('reset');
        } else if (roll < 0.55 && faultFree) {
          await fault({ blackhole: 'both' });
          healAt = Date.now() + between(5_000, 35_000);
          count('blackhole');
        } else if (roll < 0.60 && faultFree) {
          await fault({ refuse: true });
          await control('POST', '/reset', { link: 'app' });
          healAt = Date.now() + between(5_000, 60_000);
          count('outage');
        } else if (roll < 0.65 && faultFree) {
          await fault({ bytesPerSec: Math.round(between(40_000, 200_000)) });
          healAt = Date.now() + between(20_000, 60_000);
          count('slow');
        } else if (roll < 0.78 && faultFree && NETEM) {
          netem(pick(['app', 'tentacle']), pick([
            'delay 60ms 30ms distribution normal loss 3% reorder 5% 50%',
            'delay 200ms 80ms distribution normal loss 5%',
            'delay 30ms 10ms loss 15%',
            'delay 100ms duplicate 3% reorder 10% 50%',
          ]));
          healAt = Date.now() + between(20_000, 90_000);
          count('netem');
        } else if (roll < 0.80) {
          // A large agent output now and then (report, long diff).
          await control('POST', '/agent/burst', { sessionId: sid, count: 1, bytes: Math.round(between(20_000, 300_000)), prefix: 'soak' });
          count('burst');
        } else if (roll < 0.88 && faultFree) {
          const k = await harvest(page);
          carried.failedEver ||= k.failedEver;
          carried.blockedEver ||= k.blockedEver;
          Object.assign(carried.sentAt, k.sentAt);
          await page.reload();
          await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 60_000 });
          await page.evaluate(installSampler);
          count('reload');
        }
        await pause(between(800, 3_000));
      }
    } finally {
      netemClear();
      await control('POST', '/heal');
    }

    // Quiet period, then everything must be there exactly once.
    await expectDelivered(page, sid, texts, 240_000, m);
    expect(carried.failedEver, 'G3: no "Not delivered" before any reload').toBe(false);
    expect(carried.blockedEver, 'G4: never blocked before any reload').toBe(false);
    m.messages = texts.length;
    m.heapEndMb = await heapMb(page);
    m.stats = await control('GET', '/stats');
    // Bounded memory: chat content is small; a leak across hundreds of
    // reconnects would show up as tens of MB.
    expect((m.heapEndMb as number) - (m.heapStartMb as number), 'JS heap growth (MB)').toBeLessThan(64);
  });

  test.afterEach(() => writeResult('S1', results.S1 ?? {}));
});
