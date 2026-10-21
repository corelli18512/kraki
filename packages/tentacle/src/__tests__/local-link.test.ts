/**
 * LocalLinkServer discovery record ownership (log audit 2026-10-22): another
 * process in the same KRAKI_HOME (a test RelayClient, a dev run) replaced the
 * live daemon's local-link.json and deleted it again when it stopped, so Kraki
 * for Mac had no local link until the daemon restarted.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLinkHost, LocalLinkServer } from '../local-link.js';

function host(tentacleId: string): LocalLinkHost {
  return {
    tentacleId: () => tentacleId,
    privateKeyPem: () => undefined,
    appSigningKey: () => undefined,
    onPeerUp: () => {},
    onPeerDown: () => {},
    onDelivered: () => {},
  };
}

const servers: LocalLinkServer[] = [];
const homes: string[] = [];
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kraki-local-link-'));
  homes.push(home);
  return home;
}
async function started(id: string, home: string): Promise<LocalLinkServer> {
  const server = new LocalLinkServer(host(id), home);
  servers.push(server);
  await server.start();
  return server;
}
const record = (s: LocalLinkServer) => JSON.parse(readFileSync(s.filePath, 'utf8'));

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('LocalLinkServer discovery record', () => {
  it('republishes its record after another listener replaced it and deleted it on stop', async () => {
    const home = newHome();
    const daemon = await started('daemon', home);
    const intruder = await started('test-client', home);
    expect(record(daemon).tentacleId).toBe('test-client');
    // The intruder is alive: its record is left alone.
    expect(daemon.ensureDiscoveryFile()).toBe('foreign');
    intruder.stop();
    expect(existsSync(daemon.filePath)).toBe(false);

    expect(daemon.ensureDiscoveryFile()).toBe('republished');
    expect(record(daemon).tentacleId).toBe('daemon');
    expect(daemon.ensureDiscoveryFile()).toBe('ours');
  });

  it('replaces a record left behind by a listener that died without stopping', async () => {
    const home = newHome();
    const daemon = await started('daemon', home);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(daemon.filePath, JSON.stringify({ v: 1, port: 1, tentacleId: 'gone', pid: deadPid, instance: 'x' }));

    expect(daemon.ensureDiscoveryFile()).toBe('republished');
    expect(record(daemon)).toMatchObject({ tentacleId: 'daemon', pid: process.pid });
  });

  it('only removes its own record on stop', async () => {
    const home = newHome();
    const older = await started('older', home);
    const newer = await started('newer', home);
    older.stop();
    expect(record(newer).tentacleId).toBe('newer');
    newer.stop();
    expect(existsSync(newer.filePath)).toBe(false);
  });
});
