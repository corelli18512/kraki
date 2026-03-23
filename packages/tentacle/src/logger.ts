/**
 * Structured logging for Kraki tentacle.
 *
 * - Development: pretty-prints to stdout
 * - Production: writes to rotating log files under the current Kraki home
 */

import pino from 'pino';
import { join } from 'node:path';
import { getLogsDir } from './config.js';

export function createLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    return pino({ name, level });
  }

  // Production: rotate log files via pino-roll
  const logDir = getLogsDir();

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: join(logDir, `${name}.log`),
      size: '5m',
      limit: { count: 5 },
    },
  });

  return pino({ name, level }, transport);
}
