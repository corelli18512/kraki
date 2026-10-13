/** The default command, start, stop and re-start: setup on first run, the daemon's life, managed installs. */

import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { select } from '@inquirer/prompts';
import { loadConfig, getKrakiHome, getVersion, type KrakiConfig } from '../config.js';
import { isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from '../daemon.js';
import { runSetup } from '../setup.js';
import { disableWindowsAutostart } from '../windows-autostart.js';
import { loadManagedBy, kickstartManagedDaemon, isManagedDaemonLoaded, ownerName, WINDOWS_APP_OWNER, type ManagedByMarker } from '../managed.js';

// ── Commands ────────────────────────────────────────────

// ── Ownership: Kraki for Mac vs. standalone CLI ─────────
//
// When Kraki for Mac supervises the daemon (managed-by.json, see managed.ts),
// this CLI must never install its own launchd job or signal the daemon: the
// app's job has KeepAlive, so a SIGTERM would just be followed by a respawn,
// and a second job would run two daemons with one device id.

/** True when this executable is the helper embedded inside Kraki for Mac. */
export function isEmbeddedMacHelper(execPath = process.execPath): boolean {
  return /\.app\/Contents\/Library\/Helpers\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(execPath);
}

export function printManagedNotice(managed: ManagedByMarker): void {
  const status = getDaemonStatus();
  const app = ownerName(managed.by);
  if (status.running) {
    console.log(chalk.green(`  🦑 Kraki is running${status.pid ? ` (PID ${status.pid})` : ''}, managed by ${app}.`));
  } else {
    console.log(chalk.yellow(`  Kraki is managed by ${app} and is not running right now.`));
  }
  if (managed.appPath) console.log(chalk.dim(`  App: ${managed.appPath}`));
}

export function refuseManaged(action: 'start' | 'stop' | 'update' | 'setup', managed: ManagedByMarker): void {
  printManagedNotice(managed);
  if (managed.by === WINDOWS_APP_OWNER) {
    const winHint: Record<typeof action, string> = {
      start: 'Open Kraki for Windows to start it (Settings → This PC).',
      stop: 'Stop it from Kraki for Windows (Settings → This PC).',
      update: 'Kraki for Windows updates its built-in Kraki together with the app.',
      setup: 'Reconfigure from Kraki for Windows, or turn off "Run agents on this PC" in its Settings → This PC first.',
    };
    console.log(chalk.dim(`  ${winHint[action]}`));
    process.exitCode = 1;
    return;
  }
  const hint: Record<typeof action, string> = {
    start: 'Open Kraki for Mac to start it (Settings → This Mac).',
    stop: 'Stop it from Kraki for Mac (Settings → This Mac) or turn Kraki off in System Settings → General → Login Items.',
    update: 'Kraki for Mac updates its built-in tentacle together with the app (Kraki → Check for Updates…).',
    setup: 'Reconfigure from Kraki for Mac, or switch it to "Use external CLI" in Settings → This Mac first.',
  };
  console.log(chalk.dim(`  ${hint[action]}`));
  process.exitCode = 1;
}

export function refuseEmbeddedHelper(): void {
  console.log(chalk.yellow('  This kraki binary is the tentacle built into Kraki for Mac.'));
  console.log(chalk.dim('  Open Kraki for Mac to set it up and run it in the background.'));
  process.exitCode = 1;
}

export async function restartManaged(managed: ManagedByMarker): Promise<void> {
  if (managed.by === WINDOWS_APP_OWNER) {
    // Kraki for Windows' supervisor restarts a worker that exits abnormally.
    const before = getDaemonStatus().pid;
    if (before === null || !killWorkerForRestart(before)) {
      refuseManaged('start', managed);
      return;
    }
    await waitForNewReady(before, 'Kraki for Windows');
    return;
  }
  if (!isManagedDaemonLoaded(managed.label)) {
    refuseManaged('start', managed);
    return;
  }
  const before = getDaemonStatus().pid;
  if (!kickstartManagedDaemon(managed.label)) {
    console.log(chalk.red('  Failed to restart the Kraki for Mac background service.'));
    process.exitCode = 1;
    return;
  }
  await waitForNewReady(before, 'Kraki for Mac');
}

/** Kill only the worker (not its supervisor): the supervisor restarts it. */
export function killWorkerForRestart(pid: number): boolean {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function waitForNewReady(before: number | null, app: string): Promise<void> {
  const { loadDaemonReady } = await import('../config.js');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = loadDaemonReady();
    if (ready !== null && ready !== before) {
      console.log(chalk.green(`  🦑 Kraki restarted (PID ${ready}), managed by ${app}.`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(chalk.yellow('  Restart requested; the daemon has not reported ready yet. Check `kraki logs`.'));
}

// ── kraki (default) — setup wizard + auto start ─────────

export async function cmdDefault(): Promise<void> {
  let config = loadConfig();

  const managed = loadManagedBy();
  if (managed) {
    printManagedNotice(managed);
    if (config && getDaemonStatus().running) {
      const { showPairingQr } = await import('../setup.js');
      await showPairingQr(config);
    }
    return;
  }
  if (isEmbeddedMacHelper()) {
    refuseEmbeddedHelper();
    return;
  }

  // Quick update check (blocks up to 2s, uses cache if available)
  const { checkForUpdate } = await import('../update.js');
  const currentVersion = getVersion();
  const updateAvailable = await checkForUpdate(currentVersion);
  if (updateAvailable) {
    console.log(chalk.cyan(`  ⬆  Update available: ${currentVersion} → ${updateAvailable}`) + chalk.dim('  (run `kraki update`)'));
    console.log();
  }

  if (config) {
    if (isDaemonRunning()) {
      const status = getDaemonStatus();
      console.log(chalk.green(`  🦑 Kraki is already running (PID ${status.pid})`));
      console.log();

      const action = await select({
        message: 'What do you want to do?',
        theme: {
          prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
          icon: { cursor: '  ❯' },
        },
        choices: [
          { name: '  Show pairing QR', value: 'qr' },
          { name: '  Check coding agents', value: 'agents' },
          { name: '  Stop', value: 'stop' },
          { name: '  Restart', value: 'restart' },
          { name: '  Reconfigure (sign in again)', value: 'reconfig' },
          { name: '  Delete all Kraki data…', value: 'delete' },
        ],
      });

      switch (action) {
        case 'qr': {
          const { showPairingQr } = await import('../setup.js');
          await showPairingQr(config);
          break;
        }
        case 'agents': {
          const { printAgentsCheck } = await import('../setup.js');
          await printAgentsCheck();
          break;
        }
        case 'stop':
          cmdStop();
          break;
        case 'restart':
          cmdStop();
          await silentStart(config);
          break;
        case 'reconfig':
          cmdStop();
          config = await reconfigure();
          await silentStart(config);
          break;
        case 'delete':
          if (await confirmDeleteAllData()) cmdStop();
          else return;
          moveKrakiHomeAside();
          break;
      }
      return;
    }

    // Config exists but daemon not running — ask what to do
    const action = await select({
      message: 'Found previous config. What do you want to do?',
      theme: {
        prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
        icon: { cursor: '  ❯' },
      },
      choices: [
        { name: '  Start with existing config', value: 'start' },
        { name: '  Reconfigure (sign in again)', value: 'reconfig' },
        { name: '  Delete all Kraki data…', value: 'delete' },
      ],
    });

    if (action === 'reconfig') {
      config = await reconfigure();
    } else if (action === 'delete') {
      if (await confirmDeleteAllData()) moveKrakiHomeAside();
      return;
    }
  } else {
    // No config — first time setup
    config = await runSetup();
  }

  // Start daemon
  await silentStart(config);
}

// ── Reconfigure / delete data ──────────────────────────

/**
 * Run setup again (sign in again, pick the relay) while keeping everything
 * else: sessions, attachments and this computer's identity, so phones stay
 * paired. It used to delete the whole Kraki folder.
 */
export async function reconfigure(): Promise<KrakiConfig> {
  const { clearGitHubToken } = await import('../config.js');
  clearGitHubToken();
  return runSetup();
}

/** What deleting the Kraki folder would remove, for the confirmation. */
export function describeKrakiData(): { sessions: number; bytes: number } {
  const home = getKrakiHome();
  let sessions = 0;
  try { sessions = readdirSync(join(home, 'sessions')).length; } catch { /* none */ }
  let bytes = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) walk(path, depth + 1); else bytes += st.size;
      } catch { /* vanished */ }
    }
  };
  walk(home, 0);
  return { sessions, bytes };
}

/** Explicit, typed confirmation before deleting all Kraki data. */
export async function confirmDeleteAllData(): Promise<boolean> {
  const { input } = await import('@inquirer/prompts');
  const { sessions, bytes } = describeKrakiData();
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log('');
  console.log(chalk.red('  This deletes everything Kraki keeps on this computer:'));
  console.log(`    • ${sessions} session${sessions === 1 ? '' : 's'} with their history and attachments (${mb} MB)`);
  console.log('    • this computer\'s identity — every phone and browser must pair again');
  console.log('    • Kraki\'s sign-in and settings');
  console.log(chalk.dim('  Your agents\' own files (Claude Code, Copilot, Codex, Pi) are not touched.'));
  console.log('');
  const answer = await input({ message: 'Type "delete" to confirm:', theme: { prefix: chalk.red('  !') } });
  if (answer.trim().toLowerCase() !== 'delete') {
    console.log(chalk.dim('  Nothing was deleted.'));
    return false;
  }
  return true;
}

/**
 * Move the Kraki folder out of the way rather than erasing it: into the
 * Trash on macOS, next to it elsewhere. A mistaken confirmation stays
 * recoverable.
 */
export function moveKrakiHomeAside(): void {
  const home = getKrakiHome();
  if (!existsSync(home)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trash = join(homedir(), '.Trash');
  const target = process.platform === 'darwin' && existsSync(trash)
    ? join(trash, `kraki-${stamp}`)
    : `${home}.deleted-${stamp}`;
  try {
    renameSync(home, target);
    console.log(chalk.green(`  ✔ Kraki data moved to ${target}`));
    console.log(chalk.dim('  Delete that folder to free the space for good. Run `kraki` to set up again.'));
  } catch (err) {
    console.log(chalk.red(`  Could not move ${home}: ${(err as Error).message}`));
  }
}

// ── kraki start — silent start from config ──────────────

export async function cmdStart(atLogin = false): Promise<void> {
  let config = loadConfig();

  // Windows login autostart: no prompts and no output, just start if needed.
  if (atLogin) {
    const { appendLoginLog, clearPidFromBeforeBoot } = await import('../login-start.js');
    // A PID recorded before this boot belongs to a process that no longer
    // exists — or to whatever reused the number. Checking it right after login
    // is slow (the process lookup can time out), and an inconclusive check is
    // treated as "running", so the daemon silently never came back after a
    // reboot (seen in a clean Windows 11 VM). Drop it first.
    if (clearPidFromBeforeBoot()) appendLoginLog('dropped a daemon.pid from before this boot');
    if (!config) { appendLoginLog('no config; not starting'); return; }
    { const m = loadManagedBy(); if (m) { appendLoginLog(`managed by ${ownerName(m.by)}; not starting`); return; } }
    if (isDaemonRunning()) { appendLoginLog('already running'); return; }
    try {
      const pid = await startDaemon(config);
      appendLoginLog(`started daemon pid=${pid}`);
    } catch (err) {
      appendLoginLog(`start failed: ${(err as Error).message}`);
      throw err;
    }
    return;
  }

  if (!config) {
    const { confirm } = await import('@inquirer/prompts');
    const setup = await confirm({ message: 'No config found. Set up now?', default: true });
    if (!setup) return;
    config = await runSetup();
  }

  // An app-managed Kraki says which app runs it (silentStart), even when it
  // is already running.
  if (isDaemonRunning() && !loadManagedBy()) {
    const status = getDaemonStatus();
    console.log(chalk.green(`  🦑 Kraki is already running (PID ${status.pid})`));
    return;
  }

  await silentStart(config);
}

// ── Shared start logic ──────────────────────────────────

export async function silentStart(config: KrakiConfig): Promise<void> {
  const managed = loadManagedBy();
  if (managed) {
    if (!getDaemonStatus().running) refuseManaged('start', managed);
    else printManagedNotice(managed);
    return;
  }
  if (isEmbeddedMacHelper()) {
    refuseEmbeddedHelper();
    return;
  }

  // In install mode, finish configuration but leave startup to the install
  // script's subsequent `kraki start`. That command uses the normal background
  // daemon manager and shows the pairing QR only after readiness succeeds.
  if (process.env.KRAKI_INSTALL === '1') {
    return;
  }

  const pid = await startDaemon(config);
  console.log('');
  console.log(`  ${chalk.green('✔')} ${chalk.bold('Kraki is running')} ${chalk.dim(`in the background (PID ${pid})${process.platform === 'darwin' ? ' and starts again when you log in' : ''}.`)}`);
  console.log('');
  console.log(`  ${chalk.hex('#2384d4').bold('Use it from your phone')}`);

  // Show pairing QR code
  const { showPairingQr } = await import('../setup.js');
  await showPairingQr(config);

  console.log(chalk.dim(`  ${chalk.bold('kraki status')} to check on it, ${chalk.bold('kraki agents')} to recheck agents, ${chalk.bold('kraki --help')} for more.`));
  console.log('');
}

export function cmdStop(): void {
  const managed = loadManagedBy();
  if (managed) {
    refuseManaged('stop', managed);
    return;
  }
  // Stopped on purpose: don't come back at the next Windows login either.
  disableWindowsAutostart();
  if (!isDaemonRunning()) {
    console.log(chalk.yellow('Kraki is not running.'));
    return;
  }

  const stopped = stopDaemon();
  if (stopped) {
    console.log(`  ${chalk.green('✔')} Kraki stopped.`);
  } else {
    console.log(chalk.red('Failed to stop.'));
  }
}

export async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function cmdRestart(): Promise<void> {
  const managed = loadManagedBy();
  if (managed) {
    await restartManaged(managed);
    return;
  }
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Cannot restart Kraki: no config found. Run `kraki` to set up first.'));
    return;
  }

  const status = getDaemonStatus();
  if (status.running && status.pid !== null) {
    stopDaemon();
    await waitForPidExit(status.pid);
  }
  await silentStart(config);
}
