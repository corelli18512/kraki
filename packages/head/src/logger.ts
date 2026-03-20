import { appendFileSync, mkdirSync, existsSync, renameSync, statSync } from 'fs';
import { dirname } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  /** Minimum log level to output. Default: 'info' */
  level?: LogLevel;
  /** Log file path. If not set, logs to stdout only. */
  filePath?: string;
  /** Max file size in bytes before rotation. Default: 10MB */
  maxFileSize?: number;
  /** Max number of rotated files to keep. Default: 5 */
  maxFiles?: number;
  /** Also log to stdout. Default: true */
  stdout?: boolean;
}

export class Logger {
  private level: number;
  private filePath?: string;
  private maxFileSize: number;
  private maxFiles: number;
  private stdout: boolean;
  private currentSize = 0;

  constructor(options: LoggerOptions = {}) {
    this.level = LEVEL_ORDER[options.level ?? 'info'];
    this.filePath = options.filePath;
    this.maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles ?? 5;
    this.stdout = options.stdout ?? true;

    if (this.filePath) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      try {
        if (existsSync(this.filePath)) {
          this.currentSize = statSync(this.filePath).size;
        }
      } catch {
        this.currentSize = 0;
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  close(): void {
    // No-op for sync writes, but keeps the interface consistent
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const entry = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...data,
    };

    const line = JSON.stringify(entry) + '\n';

    if (this.stdout) {
      const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'debug' ? '🔍' : '◈';
      process.stdout.write(`${prefix} [${entry.time}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`);
    }

    if (this.filePath) {
      appendFileSync(this.filePath, line);
      this.currentSize += Buffer.byteLength(line);
      if (this.currentSize >= this.maxFileSize) {
        this.rotate();
      }
    }
  }

  private rotate(): void {
    if (!this.filePath) return;

    // Shift existing rotated files: .4 → .5, .3 → .4, etc.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (existsSync(from)) {
        try { renameSync(from, to); } catch { /* best effort */ }
      }
    }

    // Current → .1
    try { renameSync(this.filePath, `${this.filePath}.1`); } catch { /* best effort */ }
    this.currentSize = 0;
  }
}

/** Global logger instance — set via createLogger() in index.ts */
let globalLogger: Logger = new Logger();

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

export function getLogger(): Logger {
  return globalLogger;
}
