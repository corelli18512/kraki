import { describe, it, expect, afterEach } from 'vitest';
import { Logger } from '../logger.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpLogPath(): string {
  const dir = join(tmpdir(), 'kraki-test-logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

function cleanupLog(path: string): void {
  // Remove main file and rotated files
  for (let i = 0; i <= 10; i++) {
    const f = i === 0 ? path : `${path}.${i}`;
    try { rmSync(f); } catch { /* ignore */ }
  }
}

describe('Logger', () => {
  let logPath: string;

  afterEach(() => {
    if (logPath) cleanupLog(logPath);
  });

  it('should write to file', () => {
    logPath = tmpLogPath();
    const logger = new Logger({ filePath: logPath, stdout: false });
    logger.info('hello world');
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('hello world');
    expect(entry.time).toBeTruthy();
  });

  it('should include data fields', () => {
    logPath = tmpLogPath();
    const logger = new Logger({ filePath: logPath, stdout: false });
    logger.warn('auth failed', { ip: '1.2.3.4', reason: 'bad token' });
    logger.close();

    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(entry.ip).toBe('1.2.3.4');
    expect(entry.reason).toBe('bad token');
  });

  it('should respect log level', () => {
    logPath = tmpLogPath();
    const logger = new Logger({ filePath: logPath, stdout: false, level: 'warn' });
    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');
    logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).level).toBe('error');
  });

  it('should rotate files when max size exceeded', () => {
    logPath = tmpLogPath();
    // maxFileSize very small to force rotation
    const logger = new Logger({ filePath: logPath, stdout: false, maxFileSize: 50, maxFiles: 3 });

    // Write enough to trigger at least one rotation
    for (let i = 0; i < 10; i++) {
      logger.info(`msg ${i} padding to exceed fifty bytes limit here`);
    }
    logger.close();

    // After rotation: current file exists, and .1 should exist
    // The current file may or may not exist depending on whether a write happened after last rotation
    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it('should work with stdout only (no file)', () => {
    const logger = new Logger({ stdout: false });
    // Should not throw
    logger.info('no file');
    logger.close();
  });
});
