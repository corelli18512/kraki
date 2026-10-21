/**
 * status.json during shutdown (log audit 2026-10-22): the stopping daemon's
 * relay disconnect rewrote status.json with its own, now outdated, version
 * after removing it. Kraki for Mac read that version next to the successor's
 * PID and restarted the successor mid-startup (remote update 2026-10-15,
 * offline 18.6 s instead of ~9.6 s).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusPath = () => join(process.env.KRAKI_HOME!, 'status.json');

describe('status file', () => {
  beforeEach(() => { vi.resetModules(); });

  it('is not recreated by late updates once the daemon cleared it', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(process.env.KRAKI_HOME!, { recursive: true });
    const status = await import('../status-file.js');
    status.initStatusFile('wss://relay.example', 'mac');
    status.updateDaemonIdentity({ version: '0.38.8', pid: 1234, managedBy: 'kraki-mac' });
    expect(JSON.parse(readFileSync(statusPath(), 'utf8')).version).toBe('0.38.8');

    status.clearStatusFile();
    status.updateRelayState('disconnected');
    status.updateFdaStatus('granted');
    expect(existsSync(statusPath())).toBe(false);

    // A daemon that starts again in this process publishes again.
    status.initStatusFile('wss://relay.example', 'mac');
    expect(existsSync(statusPath())).toBe(true);
  });
});
