import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';

const originalKrakiHome = process.env.KRAKI_HOME;

afterEach(() => {
  if (originalKrakiHome === undefined) delete process.env.KRAKI_HOME;
  else process.env.KRAKI_HOME = originalKrakiHome;
});

describe('Pi preflight compaction abort integration', () => {
  it('terminates the unacknowledged prompt process and lazy-resumes the next input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kraki-pi-preflight-abort-'));
    const fakePi = join(root, 'fake-pi.cjs');
    const startsFile = join(root, 'starts.txt');
    process.env.KRAKI_HOME = join(root, 'kraki-home');

    writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const startsFile = ${JSON.stringify(startsFile)};
let starts = 0;
try { starts = Number(fs.readFileSync(startsFile, 'utf8')) || 0; } catch {}
starts += 1;
fs.writeFileSync(startsFile, String(starts));
const firstProcess = starts === 1;
let compacting = false;
const rl = readline.createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  const success = (data = {}) => write({ type: 'response', id: command.id, success: true, data });
  if (command.type === 'prompt') {
    if (firstProcess) {
      compacting = true;
      write({ type: 'compaction_start', reason: 'threshold' });
      return; // Exact Pi behavior: prompt response waits for preflight compaction.
    }
    success();
    return;
  }
  if (command.type === 'get_state') {
    success({ isCompacting: compacting, isStreaming: false });
    return;
  }
  if (command.type === 'abort') {
    success(); // Generic Pi abort does not cancel compaction or the prompt above.
    return;
  }
  success();
});
`, 'utf8');
    chmodSync(fakePi, 0o755);

    const adapter = new PiAdapter({
      cliPath: fakePi,
      promptWatchdog: { ackGraceMs: 5, intervalMs: 5, idleStallMs: 100 },
    });
    const onCompaction = vi.fn();
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onCompaction = onCompaction;
    adapter.onError = onError;
    adapter.onIdle = onIdle;

    try {
      const sessionId = 'isolated-preflight-abort';
      await adapter.createSession({ sessionId, cwd: root, model: 'fake/model' });
      const firstSend = adapter.sendMessage(sessionId, 'first prompt');
      await vi.waitFor(() => expect(onCompaction).toHaveBeenCalledWith(
        sessionId, expect.objectContaining({ phase: 'start', reason: 'threshold' }),
      ));

      await adapter.abortSession(sessionId);
      await expect(firstSend).resolves.toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      expect(onIdle).not.toHaveBeenCalled();

      await adapter.sendMessage(sessionId, 'next prompt');
      await vi.waitFor(() => expect(readFileSync(startsFile, 'utf8')).toBe('2'));
    } finally {
      await adapter.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
