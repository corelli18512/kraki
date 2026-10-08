/**
 * Keep the computer awake while an agent turn is running.
 *
 * "Walk away and watch the agent from your phone" fails if the laptop idles
 * into sleep a few minutes later. While at least one session is active, hold
 * an idle-sleep assertion; release it when every session is idle. This only
 * prevents IDLE sleep — closing the lid still sleeps the machine.
 *
 *  - macOS:   `caffeinate -i -w <daemon pid>` (dies with the daemon)
 *  - Windows: a hidden PowerShell holding SetThreadExecutionState
 *             (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) until the daemon exits
 *  - Linux:   `systemd-inhibit --what=idle` when available
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';

const logger = createLogger('sleep-guard');

export interface SleepGuardDeps {
  platform: NodeJS.Platform;
  pid: number;
  spawn: typeof spawn;
  now: () => number;
}

/** A session that shows no activity for this long stops keeping the computer
 *  awake: a stuck "active" session (a lost turn) must not do so forever. Long
 *  tool runs report progress well within it. */
export const SLEEP_HOLD_IDLE_LIMIT_MS = 4 * 60 * 60 * 1000;

export function sleepInhibitCommand(platform: NodeJS.Platform, pid: number): [string, string[]] | null {
  switch (platform) {
    case 'darwin':
      return ['/usr/bin/caffeinate', ['-i', '-w', String(pid)]];
    case 'win32': {
      const script = [
        "$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
        "$k=Add-Type -MemberDefinition $sig -Name K -Namespace W -PassThru",
        "[void]$k::SetThreadExecutionState([uint32]'0x80000001')",
        `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
      ].join('; ');
      return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]];
    }
    case 'linux':
      return ['systemd-inhibit', ['--what=idle', '--who=Kraki', '--why=An agent turn is running', 'sleep', 'infinity']];
    default:
      return null;
  }
}

export class SleepGuard {
  /** Active sessions → time of their last activity. */
  private readonly active = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private child: ChildProcess | null = null;
  private readonly deps: SleepGuardDeps;
  private disabled = false;

  constructor(deps: Partial<SleepGuardDeps> = {}) {
    this.deps = { platform: process.platform, pid: process.pid, spawn, now: Date.now, ...deps };
    // Opt-out for users who want normal sleep; never spawn a real inhibitor
    // from unit tests that drive RelayClient.
    if (process.env.KRAKI_ALLOW_SLEEP === '1' || (process.env.VITEST && !deps.spawn)) this.disabled = true;
  }

  /** A session started (or continued) work. */
  hold(sessionId: string): void {
    this.active.set(sessionId, this.deps.now());
    this.sync();
  }

  /** The session did something (a reply, a step): it is still working. */
  touch(sessionId: string): void {
    if (this.active.has(sessionId)) this.active.set(sessionId, this.deps.now());
  }

  /** Drop sessions silent for longer than the limit. Runs periodically. */
  sweep(): void {
    const cutoff = this.deps.now() - SLEEP_HOLD_IDLE_LIMIT_MS;
    for (const [sessionId, last] of this.active) {
      if (last < cutoff) {
        logger.warn({ sessionId }, 'Session silent for hours; no longer keeping the computer awake for it');
        this.active.delete(sessionId);
      }
    }
    this.sync();
  }

  /** A session finished, aborted, ended or was evicted. */
  release(sessionId: string): void {
    this.active.delete(sessionId);
    this.sync();
  }

  get holding(): boolean {
    return this.child !== null;
  }

  stop(): void {
    this.active.clear();
    this.sync();
  }

  private sync(): void {
    if (this.active.size > 0 && !this.child && !this.disabled) this.start();
    else if (this.active.size === 0 && this.child) this.end();
    if (this.active.size > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), 10 * 60 * 1000);
      this.sweepTimer.unref?.();
    } else if (this.active.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private start(): void {
    const command = sleepInhibitCommand(this.deps.platform, this.deps.pid);
    if (!command) return;
    try {
      const child = this.deps.spawn(command[0], command[1], { stdio: 'ignore', windowsHide: true, detached: false });
      child.on('error', (err) => {
        logger.debug({ err: err.message }, 'sleep inhibitor unavailable');
        if (this.child === child) this.child = null;
        this.disabled = true; // e.g. no systemd-inhibit: stop retrying
      });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      child.unref?.();
      this.child = child;
      logger.info('Holding idle-sleep assertion while an agent turn runs');
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'could not start sleep inhibitor');
    }
  }

  private end(): void {
    const child = this.child;
    this.child = null;
    try { child?.kill(); } catch { /* already gone */ }
    logger.info('Released idle-sleep assertion');
  }
}
