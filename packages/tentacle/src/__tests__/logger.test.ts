/**
 * Unit tests for logger.ts — pino logger factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsSea = vi.fn(() => false);
vi.mock('node:sea', () => ({
  isSea: (...args: unknown[]) => mockIsSea(...args),
}));

// Avoid actually writing to log files in production mode
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn() };
});

let createLogger: typeof import('../logger.js')['createLogger'];

describe('createLogger()', () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development'; // force dev mode (no file transport)
    mockIsSea.mockReset();
    mockIsSea.mockReturnValue(false);
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

  it('creates a logger with pino-roll transport in production mode', async () => {
    process.env.NODE_ENV = 'production';
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('prod-test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('creates a logger with a plain file destination in SEA production mode', async () => {
    process.env.NODE_ENV = 'production';
    mockIsSea.mockReturnValue(true);
    ({ createLogger } = await import('../logger.js'));
    const logger = createLogger('sea-test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
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
});
