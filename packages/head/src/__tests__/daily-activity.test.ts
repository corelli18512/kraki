import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../storage.js';
import { connectDevice, createTestEnv } from './integration-helpers.js';

function rows(storage: Storage) {
  return storage.rawDb.prepare('SELECT day,user_id FROM daily_active_users ORDER BY day,user_id').all();
}
afterEach(() => vi.restoreAllMocks());

describe('daily foreground activity', () => {
  it('deduplicates an account, uses Beijing midnight, retains 35 days and deletes with the account', () => {
    const s = new Storage(':memory:');
    try {
      s.upsertUser('one', 'one', 'github');
      const before = Date.parse('2026-10-14T15:59:59Z');
      s.recordForegroundActivity('one', before);
      s.recordForegroundActivity('one', before);
      s.recordForegroundActivity('one', before + 1000);
      expect(rows(s)).toEqual([{ day: '2026-10-14', user_id: 'one' }, { day: '2026-10-15', user_id: 'one' }]);
      s.recordForegroundActivity('one', before + 37 * 86400000);
      expect(rows(s)).toHaveLength(1);
      s.deleteUser('one');
      expect(rows(s)).toHaveLength(0);
    } finally { s.close(); }
  });

  it('auth/background pings and agents do not count; two app devices count once; payload cannot spoof user/date', async () => {
    const env = await createTestEnv();
    try {
      const app = await connectDevice(env.port, 'phone', 'app');
      const mac = await connectDevice(env.port, 'mac', 'app');
      const agent = await connectDevice(env.port, 'agent', 'tentacle');
      expect(rows(env.storage)).toHaveLength(0);
      for (const device of [app, agent]) {
        device.send({ type: 'ping', foreground: device === agent });
        await device.waitFor('pong');
      }
      expect(rows(env.storage)).toHaveLength(0);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T15:59:59Z'));
      for (const device of [app, mac, app]) {
        device.send({ type: 'ping', foreground: true, userId: 'forged', day: '1900-01-01' });
        await device.waitFor('pong');
      }
      expect(rows(env.storage)).toEqual([{ day: '2026-10-14', user_id: (app.authOk.user as { id: string }).id }]);
      clock.mockReturnValue(Date.parse('2026-10-14T16:00:01Z'));
      app.send({ type: 'ping', foreground: true });
      await app.waitFor('pong');
      expect(rows(env.storage)).toHaveLength(2);
    } finally { await env.cleanup(); }
  });
});
