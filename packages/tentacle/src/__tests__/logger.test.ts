/**
 * Unit tests for logger.ts — pino logger factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Production-mode loggers write under the isolated test KRAKI_HOME.

let createLogger: typeof import('../logger.js')['createLogger'];

describe('createLogger()', () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development'; // force dev mode (no file transport)
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns a pino logger instance', async () => {
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('test-logger');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('logger has expected methods', async () => {
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('test-logger');
    for (const method of ['info', 'warn', 'error', 'debug', 'trace', 'fatal']) {
      expect(typeof (logger as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('uses LOG_LEVEL env var for level', async () => {
    process.env.LOG_LEVEL = 'debug';
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('dbg');
    expect(logger.level).toBe('debug');
  });

  it('defaults to info level when LOG_LEVEL is not set', async () => {
    delete process.env.LOG_LEVEL;
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('def');
    expect(logger.level).toBe('info');
  });

  it('returns logger with the given name', async () => {
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('my-component');
    // pino stores name in bindings
    expect((logger as unknown as { bindings: () => { name: string } }).bindings().name).toBe('my-component');
  });

  it('writes <name>.log under the Kraki home in production mode on an npm install too (one naming scheme)', async () => {
    process.env.NODE_ENV = 'production';
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('prod-test', { sync: true });
    logger.info('hello');
    expect(existsSync(join(process.env.KRAKI_HOME!, 'logs', 'prod-test.log'))).toBe(true);
  });
});

describe('rotateLogFile (release review F3)', () => {
  it('rotates past the size limit and keeps a bounded number of files', async () => {
    const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rotateLogFile } = await import('../logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-logrot-'));
    const file = join(dir, 'relay-client.log');
    writeFileSync(file, 'small');
    expect(rotateLogFile(file, 100, 3)).toBe(false);
    for (let round = 1; round <= 5; round++) {
      writeFileSync(file, `round-${round}`.padEnd(200, '.'));
      expect(rotateLogFile(file, 100, 3)).toBe(true);
    }
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, 'utf8').startsWith('round-5')).toBe(true);
    expect(readFileSync(`${file}.3`, 'utf8').startsWith('round-3')).toBe(true);
    expect(existsSync(`${file}.4`)).toBe(false);
  });

  it('rotates a small log once its oldest entry is a week old (daemon.log kept six months, log audit 2026-10-22)', async () => {
    const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rotateLogFile, LOG_ROTATE_MAX_AGE_MS } = await import('../logger.js');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-logage-'));
    const file = join(dir, 'daemon.log');
    const now = Date.parse('2026-10-21T00:00:00Z');
    const line = (time: number) => `${JSON.stringify({ level: 30, time, msg: 'x' })}\n`;

    writeFileSync(file, line(now - LOG_ROTATE_MAX_AGE_MS + 60_000) + line(now));
    expect(rotateLogFile(file, 10 * 1024 * 1024, 5, LOG_ROTATE_MAX_AGE_MS, now)).toBe(false);

    writeFileSync(file, line(Date.parse('2026-04-18T00:00:00Z')) + line(now));
    expect(rotateLogFile(file, 10 * 1024 * 1024, 5, LOG_ROTATE_MAX_AGE_MS, now)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('"msg":"x"');
  });
});
