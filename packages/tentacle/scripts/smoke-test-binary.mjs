#!/usr/bin/env node

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const seaDir = join(packageRoot, 'dist', 'sea');

function findBuiltBinary() {
  const candidate = readdirSync(seaDir)
    .filter((name) => name.startsWith('kraki-'))
    .filter((name) => !name.endsWith('.blob'))
    .filter((name) => !name.endsWith('.cjs'))
    .filter((name) => !name.endsWith('.json'))
    .sort()[0];

  if (!candidate) {
    throw new Error(`No built binary found in ${seaDir}`);
  }

  return join(seaDir, candidate);
}

function runBinary(binaryPath, args, extraEnv = {}) {
  const result = spawnSync(binaryPath, args, {
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function assertSuccess(binaryPath, args, result, tempHome) {
  if (result.status === 0) {
    return;
  }

  const bootstrapLogPath = tempHome ? join(tempHome, 'logs', 'daemon-bootstrap.log') : undefined;
  const bootstrapLog =
    bootstrapLogPath && existsSync(bootstrapLogPath) ? readFileSync(bootstrapLogPath, 'utf8') : undefined;

  throw new Error(
    [
      `Command failed: ${binaryPath} ${args.join(' ')}`.trim(),
      `exit=${result.status ?? 'null'} signal=${result.signal ?? 'none'}`,
      result.stdout ? `stdout:\n${result.stdout}` : undefined,
      result.stderr ? `stderr:\n${result.stderr}` : undefined,
      bootstrapLog ? `bootstrap log:\n${bootstrapLog}` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

function assertOutput(result, expectedText, label) {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!combined.includes(expectedText)) {
    throw new Error(`Expected ${label} to include "${expectedText}", got:\n${combined}`);
  }
}

function assertOutputOneOf(result, expectedTexts, label) {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedTexts.some((text) => combined.includes(text))) {
    return;
  }

  throw new Error(`Expected ${label} to include one of ${expectedTexts.join(', ')}, got:\n${combined}`);
}

async function main() {
  const binaryPath = process.argv[2] ? resolve(process.argv[2]) : findBuiltBinary();
  const tempHome = mkdtempSync(join(tmpdir(), 'kraki-sea-smoke-'));

  try {
    writeFileSync(
      join(tempHome, 'config.json'),
      `${JSON.stringify(
        {
          relay: 'ws://127.0.0.1:1',
          authMethod: 'open',
          device: {
            name: 'release-smoke',
            id: 'release-smoke-device',
          },
          logging: {
            verbosity: 'normal',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const versionResult = runBinary(binaryPath, ['--version']);
    assertSuccess(binaryPath, ['--version'], versionResult);

    const helpResult = runBinary(binaryPath, ['--help']);
    assertSuccess(binaryPath, ['--help'], helpResult);
    assertOutput(helpResult, 'Usage:', '--help output');

    const startArgs = ['start'];
    const startResult = runBinary(binaryPath, startArgs, { KRAKI_HOME: tempHome });
    assertSuccess(binaryPath, startArgs, startResult, tempHome);
    assertOutput(startResult, 'Kraki started', 'start output');

    const statusResult = runBinary(binaryPath, ['status'], { KRAKI_HOME: tempHome });
    assertSuccess(binaryPath, ['status'], statusResult, tempHome);
    assertOutput(statusResult, 'Status:', 'status output');
    assertOutput(statusResult, 'Relay:', 'status output');

    const stopResult = runBinary(binaryPath, ['stop'], { KRAKI_HOME: tempHome });
    assertSuccess(binaryPath, ['stop'], stopResult, tempHome);
    assertOutputOneOf(stopResult, ['stopped', 'not running'], 'stop output');

    console.log(`✅ Binary smoke test passed: ${binaryPath}`);
  } finally {
    try {
      runBinary(binaryPath, ['stop'], { KRAKI_HOME: tempHome });
    } catch {
      // Ignore shutdown cleanup failures.
    }

    rmSync(tempHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`❌ Binary smoke test failed: ${err.message}`);
  process.exit(1);
});
