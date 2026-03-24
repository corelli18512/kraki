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

function write(method: ConsoleMethod, scope: string, args: unknown[]): void {
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
