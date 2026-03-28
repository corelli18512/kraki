type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error';

type GlobalWithProcess = typeof globalThis & {
  process?: {
    env?: {
      NODE_ENV?: string;
    };
  };
};

interface LoggingEnv {
  viteDev: boolean | undefined;
  nodeEnv: string | undefined;
  hasWindow: boolean;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function shouldLogToConsole(env: LoggingEnv): boolean {
  if (typeof env.viteDev === 'boolean') {
    return env.viteDev;
  }
  if (typeof env.nodeEnv === 'string') {
    return env.nodeEnv !== 'production';
  }
  return !env.hasWindow;
}

function getLoggingEnv(): LoggingEnv {
  const viteMeta = import.meta as ImportMeta & { env?: Partial<ImportMetaEnv> };
  return {
    viteDev: viteMeta.env?.DEV,
    nodeEnv: (globalThis as GlobalWithProcess).process?.env?.NODE_ENV,
    hasWindow: typeof window !== 'undefined',
  };
}

// ── Remote log shipping (dev debugging) ─────────────────

interface LogEntry {
  ts: string;
  level: string;
  scope: string;
  message: string;
}

const LOG_BUFFER: LogEntry[] = [];
const FLUSH_INTERVAL = 5000;
const FLUSH_SIZE = 20;
const DEBUG_LOG_KEY = 'kraki_debug_logging';

let flushTimer: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((msg: Record<string, unknown>) => void) | null = null;

export function isDebugLoggingEnabled(): boolean {
  try { return localStorage.getItem(DEBUG_LOG_KEY) === '1'; } catch { return false; }
}

export function setDebugLogging(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(DEBUG_LOG_KEY, '1');
      startLogShipping();
    } else {
      localStorage.removeItem(DEBUG_LOG_KEY);
      stopLogShipping();
    }
  } catch { /* ignore */ }
}

export function setLogBroadcast(fn: (msg: Record<string, unknown>) => void): void {
  broadcastFn = fn;
  if (isDebugLoggingEnabled()) startLogShipping();
}

function shipLog(level: string, scope: string, args: unknown[]): void {
  if (!isDebugLoggingEnabled()) return;
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  LOG_BUFFER.push({ ts: new Date().toISOString(), level, scope, message });
  if (LOG_BUFFER.length >= FLUSH_SIZE) flushLogs();
}

function flushLogs(): void {
  if (LOG_BUFFER.length === 0 || !broadcastFn) return;
  const entries = LOG_BUFFER.splice(0);
  broadcastFn({ type: 'client_log', payload: { entries } });
}

function startLogShipping(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushLogs, FLUSH_INTERVAL);
}

function stopLogShipping(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  LOG_BUFFER.length = 0;
}

// ── Logger factory ──────────────────────────────────────

function write(method: ConsoleMethod, scope: string, args: unknown[]): void {
  // Always ship to remote if debug logging is on
  shipLog(method, scope, args);

  if (!shouldLogToConsole(getLoggingEnv())) {
    return;
  }

  const prefix = `[Kraki:${scope}]`;
  const consoleMethod = console[method] as (...params: unknown[]) => void;
  consoleMethod(prefix, ...args);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    log: (...args) => write('log', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
  };
}
