/**
 * Structured logging for Kraki tentacle.
 *
 * - Development: pretty-prints to stdout
 * - Production: writes to rotating log files under ~/.kraki/logs/
 */

import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.kraki', 'logs');

export function createLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    return pino({ name, level });
  }

  // Production: rotate log files via pino-roll
  mkdirSync(LOG_DIR, { recursive: true });

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: join(LOG_DIR, `${name}.log`),
      size: '5m',
      limit: { count: 5 },
    },
  });

  return pino({ name, level }, transport);
}
