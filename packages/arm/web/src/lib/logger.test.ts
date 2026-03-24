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
