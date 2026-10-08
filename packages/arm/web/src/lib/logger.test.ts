import { describe, expect, it } from 'vitest';
import { shouldLogToConsole } from './logger';

describe('logger', () => {
  it('logs in development browser builds', () => {
    expect(shouldLogToConsole({
      viteDev: true,
      nodeEnv: 'production',
      hasWindow: true,
    })).toBe(true);
  });

  it('suppresses logs in production browser builds', () => {
    expect(shouldLogToConsole({
      viteDev: false,
      nodeEnv: 'development',
      hasWindow: true,
    })).toBe(false);
  });

  it('logs for node-only tooling by default', () => {
    expect(shouldLogToConsole({
      viteDev: undefined,
      nodeEnv: undefined,
      hasWindow: false,
    })).toBe(true);
  });

  it('suppresses node-only tooling logs when explicitly in production', () => {
    expect(shouldLogToConsole({
      viteDev: undefined,
      nodeEnv: 'production',
      hasWindow: false,
    })).toBe(false);
  });
});

describe('formatLogArg', () => {
  it('keeps an Error’s name, message and top frames (JSON.stringify gives {})', async () => {
    const { formatLogArg } = await import('./logger');
    const text = formatLogArg(new TypeError('boom'));
    expect(text).toMatch(/^TypeError: boom/);
    expect(JSON.stringify(new TypeError('boom'))).toBe('{}');
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(typeof formatLogArg(cyclic)).toBe('string');
  });
});
