/**
 * Tests never touch the developer's real Kraki home (log audit 2026-10-22:
 * test RelayClients replaced and then deleted the live
 * ~/.kraki/local-link.json and wrote ~/.kraki/logs/*.N.log).
 */
import { describe, expect, it } from 'vitest';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const realHome = resolve(userInfo().homedir);

describe('vitest home isolation', () => {
  it('runs every test file with a throwaway HOME and KRAKI_HOME', async () => {
    expect(process.env.KRAKI_HOME).toBeTruthy();
    expect(resolve(process.env.KRAKI_HOME!).startsWith(join(realHome, '.kraki'))).toBe(false);
    expect(resolve(homedir())).not.toBe(realHome);
    const { getKrakiHome } = await import('../config.js');
    expect(getKrakiHome()).toBe(resolve(process.env.KRAKI_HOME!));
  });

  it('refuses the real Kraki home if a test bypasses the isolation', async () => {
    const saved = { HOME: process.env.HOME, KRAKI_HOME: process.env.KRAKI_HOME };
    try {
      process.env.HOME = realHome;
      delete process.env.KRAKI_HOME;
      const { getKrakiHome } = await import('../config.js');
      expect(() => getKrakiHome()).toThrow(/real Kraki home/);
    } finally {
      process.env.HOME = saved.HOME;
      process.env.KRAKI_HOME = saved.KRAKI_HOME;
    }
  });
});
