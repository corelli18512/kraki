/**
 * Unit tests for logger.ts — pino logger factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsSea = vi.fn(() => false);
vi.mock('node:sea', () => ({
  isSea: (...args: any[]) => mockIsSea(...args),
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
      expect(typeof (logger as any)[method]).toBe('function');
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
    expect((logger as any).bindings().name).toBe('my-component');
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
