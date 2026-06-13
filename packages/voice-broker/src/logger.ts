/**
 * Tiny structured logger.
 *
 * Format mirrors @kraki/head's style ("ts level component msg key=val ...") so
 * a sidecar deployment's logs interleave readably with the head's.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

function fmtFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s =
      typeof v === 'string'
        ? v.includes(' ') || v.includes('=')
          ? JSON.stringify(v)
          : v
        : v instanceof Error
          ? JSON.stringify(v.message)
          : JSON.stringify(v);
    out.push(`${k}=${s}`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

export function createLogger(component: string, level: LogLevel = 'info'): Logger {
  const threshold = LEVELS[level];
  const emit = (lvl: LogLevel, stream: 'log' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const ts = new Date().toISOString();
    console[stream](`${ts} ${lvl.padEnd(5)} ${component} ${msg}${fmtFields(fields)}`);
  };
  return {
    debug: (m, f) => emit('debug', 'log', m, f),
    info: (m, f) => emit('info', 'log', m, f),
    warn: (m, f) => emit('warn', 'warn', m, f),
    error: (m, f) => emit('error', 'error', m, f),
    child: (c) => createLogger(`${component}.${c}`, level),
  };
}

export function levelFromEnv(env: string | undefined): LogLevel {
  const v = (env ?? 'info').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'info';
}
