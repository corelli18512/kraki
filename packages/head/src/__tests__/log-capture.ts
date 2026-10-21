import { Logger, setGlobalLogger, type LogLevel } from '../logger.js';

export interface CapturedLine {
  level: LogLevel;
  msg: string;
  data: Record<string, unknown>;
}

/** A global logger that keeps every line in memory (all levels). */
export class CapturingLogger extends Logger {
  readonly lines: CapturedLine[] = [];

  constructor() { super({ level: 'debug', stdout: false }); }

  override debug(msg: string, data?: Record<string, unknown>): void { this.lines.push({ level: 'debug', msg, data: data ?? {} }); }
  override info(msg: string, data?: Record<string, unknown>): void { this.lines.push({ level: 'info', msg, data: data ?? {} }); }
  override warn(msg: string, data?: Record<string, unknown>): void { this.lines.push({ level: 'warn', msg, data: data ?? {} }); }
  override error(msg: string, data?: Record<string, unknown>): void { this.lines.push({ level: 'error', msg, data: data ?? {} }); }

  find(msg: string): CapturedLine[] { return this.lines.filter((l) => l.msg === msg); }
}

export function captureLogs(): CapturingLogger {
  const logger = new CapturingLogger();
  setGlobalLogger(logger);
  return logger;
}

export function silenceLogs(): void {
  setGlobalLogger(new Logger({ level: 'error', stdout: false }));
}
