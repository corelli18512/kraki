#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binaryPath = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(binaryPath)) {
  throw new Error(`Usage: daemon-release-smoke.mjs <binary-or-app-executable>`);
}

const tempHome = mkdtempSync(join(tmpdir(), 'kraki-daemon-release-smoke-'));

try {
  writeFileSync(
    join(tempHome, 'config.json'),
    `${JSON.stringify(
      {
        relay: 'ws://127.0.0.1:1',
        authMethod: 'open',
        device: {
          name: 'release-daemon-smoke',
          id: 'release-daemon-smoke-device',
        },
        logging: { verbosity: 'normal' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = spawnSync(binaryPath, ['__daemon-release-smoke'], {
    env: {
      ...process.env,
      KRAKI_HOME: tempHome,
      KRAKI_RELEASE_SMOKE: '1',
      KRAKI_RELAY_URL: 'ws://127.0.0.1:1',
      // Reproduce the LaunchServices environment that caused child Node/Pi
      // processes to steal chat.kraki.cli in v0.31.10. The worker bootstrap
      // must delete this before any adapter child is spawned.
      __CFBundleIdentifier: process.platform === 'darwin' ? 'chat.kraki.cli' : undefined,
    },
    encoding: 'utf8',
    timeout: 90_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const bootstrapPath = join(tempHome, 'logs', 'daemon-bootstrap.log');
    const daemonLogPath = join(tempHome, 'logs', 'daemon.log');
    const bootstrap = existsSync(bootstrapPath) ? readFileSync(bootstrapPath, 'utf8') : '';
    const daemonLog = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '';
    throw new Error(
      [
        `daemon release smoke failed: exit=${result.status ?? 'null'} signal=${result.signal ?? 'none'}`,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
        bootstrap && `bootstrap:\n${bootstrap}`,
        daemonLog && `daemon:\n${daemonLog}`,
      ].filter(Boolean).join('\n\n'),
    );
  }

  if (!result.stdout.includes('daemon-release-smoke-ok')) {
    throw new Error(`daemon release smoke did not report success:\n${result.stdout}\n${result.stderr}`);
  }

  for (const stateFile of ['daemon.pid', 'daemon.ready', 'daemon.identity']) {
    if (existsSync(join(tempHome, stateFile))) {
      throw new Error(`daemon release smoke left stale ${stateFile}`);
    }
  }

  console.log(`✅ Daemon release smoke passed: ${binaryPath}`);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
