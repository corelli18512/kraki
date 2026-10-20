#!/usr/bin/env node

/**
 * Kraki CLI entry point.
 *
 * Usage:
 *   kraki              Start Kraki (runs setup first if needed)
 *   kraki stop          Stop Kraki
 *   kraki status        Show status
 *   kraki logs [-f]     Tail log files
 *   kraki config        Print current config
 *   kraki config reset  Delete config and re-run setup
 *   kraki --help        Show help
 *   kraki --version     Show version
 */

import { applyProcessProxy } from './proxy.js';
import chalk from 'chalk';
import { loadConfig, getConfigPath, getVersion } from './config.js';
import { INTERNAL_DAEMON_WORKER_COMMAND, INTERNAL_DAEMON_SMOKE_COMMAND, prepareDaemonWorkerBootstrap, runDaemonReleaseSmoke } from './daemon.js';
import { runSetup } from './setup.js';
import { printStaticBanner } from './banner.js';
import { hideChildWindowsByDefault } from './windows-hide.js';
import { ensureWindowsSystemPath } from './checks.js';
import { SELF_MANAGEMENT_DENIAL_REASON } from './self-management-guard.js';
import { loadManagedBy, WINDOWS_APP_OWNER } from './managed.js';
import { cmdConfig, cmdConfigRemoteUpdate, cmdConfigLog, cmdConfigReset, cmdConnect, cmdSetupHeadless, cmdResolveRelay, cmdAuth } from './cli/config.js';
import { cmdStatus, cmdLogs, cmdFda, cmdPermissions, cmdDoctor, cmdRelayInfo } from './cli/diagnostics.js';
import { _isSEA, gracefulExit } from './cli/exit.js';
import { isEmbeddedMacHelper, refuseManaged, refuseEmbeddedHelper, cmdDefault, cmdStart, silentStart, cmdStop, cmdRestart } from './cli/lifecycle.js';
export { tailLogsPortable } from './cli/diagnostics.js';
export { isEmbeddedMacHelper } from './cli/lifecycle.js';

// Self-heal PATH on Windows BEFORE any setup/check spawns a child
// process. If kraki is launched from a context with a minimal PATH
// (e.g. double-clicked SEA binary), tools like `gh`, `copilot`, and
// `powershell.exe` would otherwise be invisible. The daemon worker
// re-runs this on its side as a belt-and-suspenders for autostart
// paths that bypass the CLI entirely.
ensureWindowsSystemPath();

// ── Help ────────────────────────────────────────────────

function printHelp(): void {
  printStaticBanner();
  const cmd = (c: string, d: string) => `    ${chalk.bold(c.padEnd(20))} ${d}`;
  const head = (t: string) => `  ${chalk.hex('#2384d4').bold(t)}`;
  console.log([
    head('Get started'),
    cmd('kraki', 'Set up this computer and start Kraki'),
    cmd('kraki connect', 'Show a QR code to connect your phone'),
    cmd('kraki devices', 'Saved encryption connections (account login grants access)'),
    '',
    head('Everyday'),
    cmd('kraki status', 'Is Kraki running and connected?'),
    cmd('kraki agents', 'Check the coding agents on this computer'),
    cmd('kraki logs [-f]', 'Show logs (-f to follow)'),
    cmd('kraki start', 'Start Kraki in the background'),
    cmd('kraki stop', 'Stop Kraki'),
    cmd('kraki restart', 'Restart Kraki (e.g. after installing an agent)'),
    cmd('kraki update', 'Install the latest version'),
    cmd('kraki build-info', 'Build source, GitHub Run ID and provenance (--json)'),
    '',
    head('Settings'),
    cmd('kraki config', 'Print the current config'),
    cmd('kraki config log <normal|verbose>', ''),
    cmd('', 'Set log detail for the next start'),
    cmd('kraki config reset', 'Delete the config and set up again'),
    cmd('kraki permissions', 'macOS privacy status (--open to open the panes)'),
    '',
    `${chalk.dim('  For apps and scripts: setup --json | --headless [--agent …], connect --json | --url-only,')}`,
    `${chalk.dim('  status --json, agents --json, doctor, fda --json | --watch, resolve-relay --json')}`,
    '',
    ...(process.platform === 'darwin'
      ? [`${chalk.dim('  Prefer an app? Kraki for Mac does all this without the CLI:')}`,
        `${chalk.dim('  https://github.com/corelli18512/kraki/releases?q=mac-v')}`, '']
      : []),
  ].join('\n'));
}

// ── Arg parsing ─────────────────────────────────────────

async function main(): Promise<void> {
  // Windows: no console window for any child process (see windows-hide.ts).
  hideChildWindowsByDefault();
  // Networks that need a proxy (env or the macOS system proxy): see proxy.ts.
  applyProcessProxy();
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === INTERNAL_DAEMON_WORKER_COMMAND) {
    // Kraki for Mac's job: run as a supervisor of the real worker, which
    // restarts it after a crash without relying on launchd (see
    // daemon-supervisor.ts: launchd's KeepAlive is dead while the user's
    // domain is stuck in on-demand-only mode).
    const { isMacAppManagedWorker, isWindowsAppManagedWorker } = await import('./managed.js');
    const { SUPERVISED_ENV, SUPERVISE_ENV, runSupervisor } = await import('./daemon-supervisor.js');
    // Kraki for Windows' Run entry cannot set environment variables; it passes
    // the owner as a flag instead.
    if (args.includes(`--managed-by=${WINDOWS_APP_OWNER}`)) process.env.KRAKI_MANAGED_BY = WINDOWS_APP_OWNER;
    const appManaged = (process.platform === 'darwin' && isMacAppManagedWorker())
      || (process.platform === 'win32' && isWindowsAppManagedWorker());
    // `kraki start` asks for supervision too (Linux, Windows, npm on macOS):
    // a crashed daemon comes back by itself instead of staying offline.
    const cliSupervised = process.env[SUPERVISE_ENV] === '1';
    if ((appManaged || cliSupervised) && !process.env[SUPERVISED_ENV]) {
      const { getLogsDir, getDaemonSupervisorPidPath } = await import('./config.js');
      const { join } = await import('node:path');
      const code = await runSupervisor({
        command: process.execPath,
        args: _isSEA ? [cmd] : [...process.execArgv, process.argv[1], cmd],
        logFile: join(getLogsDir(), 'daemon-supervisor.log'),
        ...(cliSupervised && !appManaged && { pidFile: getDaemonSupervisorPidPath() }),
        // Kraki for Mac: an app update replaces this binary under us; restart
        // onto the new one or TCC starts denying protected folders.
        ...(process.platform === 'darwin' && isMacAppManagedWorker() && _isSEA && { watchExecutable: process.execPath }),
      });
      process.exit(code);
    }
    // Must run before importing daemon-worker/adapters: capture the initial
    // PID-bound Launch Services identity while it is still stable, then scrub
    // private LS bootstrap state from the child-process environment.
    await prepareDaemonWorkerBootstrap();
    const { startWorker } = await import('./daemon-worker.js');
    await startWorker();
    return;
  }

  if (cmd === '__apply-update') {
    const { runApplier } = await import('./remote-update.js');
    await runApplier(args.slice(1));
    return;
  }

  if (cmd === INTERNAL_DAEMON_SMOKE_COMMAND) {
    const config = loadConfig();
    if (!config) throw new Error(`No release smoke config found at ${getConfigPath()}`);
    const pid = await runDaemonReleaseSmoke(config);
    process.stdout.write(`daemon-release-smoke-ok pid=${pid}\n`);
    return;
  }

  if (cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'build-info') {
    const { getBuildInfo, formatBuildInfo } = await import('./build-info.js');
    const info = getBuildInfo();
    console.log(args.includes('--json') ? JSON.stringify(info, null, 2) : formatBuildInfo(info));
    return;
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log(getVersion());
    return;
  }

  if (process.env.KRAKI_META_FILE && (cmd === 'stop' || cmd === 'restart' || cmd === 'update')) {
    process.stderr.write(`${SELF_MANAGEMENT_DENIAL_REASON}\n`);
    gracefulExit(1);
    return;
  }

  if (cmd === 'stop') {
    cmdStop();
    return;
  }

  if (cmd === 'restart') {
    await cmdRestart();
    return;
  }

  if (cmd === 'update') {
    const managed = loadManagedBy();
    if (managed) {
      refuseManaged('update', managed);
      return;
    }
    if (isEmbeddedMacHelper()) {
      refuseEmbeddedHelper();
      return;
    }
    const { performUpdate } = await import('./update.js');
    await performUpdate(getVersion());
    return;
  }

  if (cmd === 'start') {
    await cmdStart(args.includes('--login'));
    return;
  }

  if (cmd === 'status') {
    cmdStatus(args.includes('--json'));
    return;
  }

  if (cmd === 'devices') {
    const { cmdDevices } = await import('./cli/devices.js');
    cmdDevices(args.slice(1));
    return;
  }

  if (cmd === 'connect') {
    const urlOnly = args.includes('--url-only');
    const jsonOutput = args.includes('--json');
    await cmdConnect(urlOnly, jsonOutput);
    return;
  }

  if (cmd === 'setup') {
    if (args.includes('--headless')) {
      await cmdSetupHeadless(args);
    } else if (args.includes('--json')) {
      const { runSetupJson } = await import('./setup-json.js');
      process.exitCode = await runSetupJson(args);
    } else {
      const managed = loadManagedBy();
      if (managed) {
        refuseManaged('setup', managed);
        return;
      }
      const config = await runSetup();
      await silentStart(config);
    }
    return;
  }

  if (cmd === 'doctor') {
    await cmdDoctor();
    return;
  }

  if (cmd === 'resolve-relay') {
    await cmdResolveRelay(args);
    return;
  }

  if (cmd === 'fda') {
    await cmdFda(args);
    return;
  }

  if (cmd === 'accessibility') {
    // Machine-readable for Kraki for Mac, which runs it as the helper app so
    // the answer (and the macOS prompt) is about Kraki.
    const { probeAccessibility } = await import('./checks.js');
    const status = process.platform === 'darwin' ? probeAccessibility(args.includes('--prompt')) : 'not_applicable';
    process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
    return;
  }

  if (cmd === 'agents' && !args.includes('--json')) {
    const { printAgentsCheck } = await import('./setup.js');
    await printAgentsCheck(args.includes('--all'));
    return;
  }

  if (cmd === 'agents') {
    const { runAgentsCheckJson } = await import('./agents-check.js');
    process.exitCode = await runAgentsCheckJson(args);
    // Adapters can leave child processes / timers behind; this is a one-shot probe.
    gracefulExit(process.exitCode ?? 0);
    return;
  }

  if (cmd === 'permissions') {
    await cmdPermissions(args);
    return;
  }

  if (cmd === 'relay-info') {
    await cmdRelayInfo(args);
    return;
  }

  if (cmd === 'auth') {
    await cmdAuth(args);
    return;
  }

  if (cmd === 'logs') {
    const follow = args.includes('-f') || args.includes('--follow');
    cmdLogs(follow);
    return;
  }

  if (cmd === 'config') {
    if (args[1] === 'reset') {
      await cmdConfigReset();
      return;
    }
    if (args[1] === 'log') {
      cmdConfigLog(args[2]);
      return;
    }
    if (args[1] === 'remote-update') {
      cmdConfigRemoteUpdate(args[2]);
      return;
    }
    cmdConfig();
    return;
  }

  // Default: setup wizard + start
  if (!cmd) {
    await cmdDefault();
    return;
  }

  console.log(chalk.red(`Unknown command: ${cmd}`));
  printHelp();
  gracefulExit(1);
}

main().catch((err) => {
  // User pressed Esc or Ctrl+C during a prompt — exit cleanly
  if (err?.name === 'ExitPromptError' || err?.message?.includes('User force closed')) {
    console.log(chalk.dim('\n  Cancelled.'));
    gracefulExit(0);
    return;
  }
  // Users see a one-line reason; the stack trace is only for KRAKI_DEBUG.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${chalk.red('✖')} ${message}`);
  if (process.env.KRAKI_DEBUG) console.error(err);
  gracefulExit(1);
});

