/**
 * Vitest setup shared by every package: tests run against a throwaway HOME and
 * KRAKI_HOME, never the developer's real ones.
 *
 * Tests that built a real RelayClient or logger without their own KRAKI_HOME
 * wrote into the real ~/.kraki: they replaced the live daemon's
 * local-link.json discovery record (and deleted it again on stop, so Kraki for
 * Mac lost its local link until the daemon restarted), filled
 * ~/.kraki/logs/*.N.log with test output and resolved
 * ~/.kraki/copilot-config (log audit 2026-10-22).
 *
 * Suites that drive real agent CLIs need the user's credentials under HOME;
 * their config sets KRAKI_TEST_REAL_HOME=1 (`test.env`) and only KRAKI_HOME is
 * isolated.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'kraki-test-home-'));
if (process.env.KRAKI_TEST_REAL_HOME !== '1') {
  process.env.HOME = join(root, 'home');
  mkdirSync(process.env.HOME);
  if (process.platform === 'win32') process.env.USERPROFILE = process.env.HOME;
}
process.env.KRAKI_HOME = join(root, 'kraki');

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
