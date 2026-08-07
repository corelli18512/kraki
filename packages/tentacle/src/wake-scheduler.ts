import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CronExpressionParser } from 'cron-parser';

import { createLogger } from './logger.js';

const logger = createLogger('wake-scheduler');

const STORE_VERSION = 1;
const MAX_INSTRUCTION_LENGTH = 16_000;
const MAX_LABEL_LENGTH = 200;
const MAX_CRON_LENGTH = 256;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const RETRY_DELAY_MS = 1_000;
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i;

export type WakeSchedule =
  | { type: 'once'; at: string }
  | { type: 'cron'; expression: string; timezone: string };

export interface WakeTrigger {
  id: string;
  sessionId: string;
  label?: string;
  instruction: string;
  schedule: WakeSchedule;
  nextRunAt: string;
  createdAt: string;
  lastRunAt?: string;
  lastError?: string;
  status: 'active' | 'running' | 'completed' | 'paused' | 'failed';
}

export class WakeRejectedError extends Error {
  override readonly name = 'WakeRejectedError';
}

interface WakeStore {
  version: 1;
  triggers: WakeTrigger[];
}

export interface ScheduleWakeInput {
  sessionId: string;
  instruction: string;
  label?: string;
  at?: string;
  cron?: string;
  timezone?: string;
}

export interface WakeSchedulerOptions {
  storePath: string;
  onWake: (trigger: WakeTrigger, scheduledFor: string) => Promise<void>;
  now?: () => Date;
}

export class WakeScheduler {
  private readonly storePath: string;
  private readonly onWake: WakeSchedulerOptions['onWake'];
  private readonly now: () => Date;
  private triggers = new Map<string, WakeTrigger>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;

  constructor(options: WakeSchedulerOptions) {
    this.storePath = options.storePath;
    this.onWake = options.onWake;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.armTimer();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(input: ScheduleWakeInput): WakeTrigger {
    if (!input.sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('instruction must be a non-empty string');
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      throw new Error(`instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters`);
    }
    const label = input.label?.trim();
    if (label && label.length > MAX_LABEL_LENGTH) {
      throw new Error(`label exceeds ${MAX_LABEL_LENGTH} characters`);
    }
    if ((input.at ? 1 : 0) + (input.cron ? 1 : 0) !== 1) {
      throw new Error('provide exactly one of at or cron');
    }

    const now = this.now();
    let schedule: WakeSchedule;
    let nextRunAt: string;
    if (input.at) {
      const atInput = input.at.trim();
      if (!ISO_WITH_OFFSET_RE.test(atInput)) {
        throw new Error('at must be an ISO-8601 timestamp with Z or an explicit UTC offset');
      }
      const at = new Date(atInput);
      if (!Number.isFinite(at.getTime())) throw new Error('at must be a valid ISO-8601 timestamp');
      if (at.getTime() <= now.getTime()) throw new Error('at must be in the future');
      schedule = { type: 'once', at: at.toISOString() };
      nextRunAt = at.toISOString();
    } else {
      const expression = input.cron!.trim();
      if (!expression) throw new Error('cron must be a non-empty string');
      if (expression.length > MAX_CRON_LENGTH) {
        throw new Error(`cron exceeds ${MAX_CRON_LENGTH} characters`);
      }
      const timezone = input.timezone?.trim();
      if (!timezone) throw new Error('timezone is required for cron schedules');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now);
      } catch {
        throw new Error('timezone must be a valid IANA timezone');
      }
      const next = CronExpressionParser.parse(expression, { currentDate: now, tz: timezone }).next().toDate();
      schedule = { type: 'cron', expression, timezone };
      nextRunAt = next.toISOString();
    }

    const trigger: WakeTrigger = {
      id: `wake_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      sessionId: input.sessionId,
      ...(label && { label }),
      instruction,
      schedule,
      nextRunAt,
      createdAt: now.toISOString(),
      status: 'active',
    };
    this.triggers.set(trigger.id, trigger);
    this.persist();
    this.armTimer();
    logger.info({ triggerId: trigger.id, sessionId: trigger.sessionId, nextRunAt }, 'Scheduled agent wake');
    return { ...trigger };
  }

  list(sessionId?: string): WakeTrigger[] {
    return [...this.triggers.values()]
      .filter((trigger) => !sessionId || trigger.sessionId === sessionId)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .map((trigger) => ({ ...trigger }));
  }

  async runDue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    let retry = false;
    try {
      const nowMs = this.now().getTime();
      const due = [...this.triggers.values()]
        .filter((trigger) => trigger.status === 'active' && Date.parse(trigger.nextRunAt) <= nowMs)
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));

      for (const trigger of due) {
        const scheduledFor = trigger.nextRunAt;
        trigger.status = 'running';
        trigger.lastError = undefined;
        this.persist();
        try {
          await this.onWake({ ...trigger }, scheduledFor);
          trigger.lastRunAt = this.now().toISOString();
          if (trigger.schedule.type === 'once') {
            trigger.status = 'completed';
          } else {
            trigger.status = 'active';
            trigger.nextRunAt = CronExpressionParser.parse(trigger.schedule.expression, {
              currentDate: this.now(),
              tz: trigger.schedule.timezone,
            }).next().toDate().toISOString();
          }
          this.persist();
          logger.info({ triggerId: trigger.id, sessionId: trigger.sessionId }, 'Agent wake completed');
        } catch (err) {
          if (err instanceof WakeRejectedError) {
            trigger.status = 'failed';
            trigger.lastError = err.message;
            this.persist();
            logger.warn({ triggerId: trigger.id, err: err.message }, 'Agent wake rejected permanently');
            continue;
          }
          trigger.status = 'active';
          trigger.lastError = (err as Error).message;
          this.persist();
          logger.warn({ triggerId: trigger.id, err: trigger.lastError }, 'Agent wake deferred');
          retry = true;
          continue;
        }
      }
    } finally {
      this.processing = false;
      this.armTimer(retry ? RETRY_DELAY_MS : undefined);
    }
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const value = JSON.parse(readFileSync(this.storePath, 'utf8')) as WakeStore;
      if (value.version !== STORE_VERSION || !Array.isArray(value.triggers)) return;
      let recoveredInterruptedRun = false;
      for (const trigger of value.triggers) {
        if (!trigger?.id || !trigger.sessionId || !trigger.instruction) continue;
        if (trigger.status === 'running') {
          trigger.status = 'failed';
          trigger.lastError = 'Tentacle restarted during wake delivery; automatic retry is disabled to avoid duplicate actions.';
          recoveredInterruptedRun = true;
        }
        this.triggers.set(trigger.id, trigger);
      }
      if (recoveredInterruptedRun) this.persist();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Ignoring unreadable wake trigger store');
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    const store: WakeStore = { version: STORE_VERSION, triggers: [...this.triggers.values()] };
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  private armTimer(delayOverride?: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const nowMs = this.now().getTime();
    const nextMs = Math.min(
      ...[...this.triggers.values()]
        .filter((trigger) => trigger.status === 'active')
        .map((trigger) => Date.parse(trigger.nextRunAt)),
    );
    if (!Number.isFinite(nextMs)) {
      this.timer = null;
      return;
    }
    const delay = delayOverride ?? Math.max(0, Math.min(MAX_TIMER_DELAY_MS, nextMs - nowMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDue();
    }, delay);
    this.timer.unref?.();
  }
}
