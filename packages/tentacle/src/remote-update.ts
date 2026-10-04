/**
 * POC: remote self-update of the background daemon.
 *
 * Not a product feature yet. Proves, per install method, that a running daemon
 * can update itself without anyone at the computer and come back online:
 *
 *   1. The daemon is asked (POC: a request file in KRAKI_HOME, polled) to update.
 *   2. While still online it stages the new version next to the install.
 *   3. It starts an *applier* that is detached from it (double spawn, so the
 *      applier is not in the daemon's process tree: on Windows `kraki stop`
 *      uses `taskkill /T`, which would kill it too).
 *   4. The applier stops the old daemon, swaps the install, starts the new one
 *      with the new version's own `start --login`, and waits until it reports
 *      connected with the expected version.
 *   5. If that does not happen within the deadline it puts the old install back
 *      and starts it again (rollback), so the computer is never left offline.
 *
 * Every step is logged to <KRAKI_HOME>/logs/remote-update.log and the outcome
 * to <KRAKI_HOME>/remote-update/result.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import { getKrakiHome, getLogsDir, getVersion } from './config.js';

export const APPLY_UPDATE_COMMAND = '__apply-update';
const REQUEST_FILE = 'remote-update-request.json';

export type InstallKind = 'binary' | 'app-bundle' | 'npm' | 'mac-app';

export interface UpdateRequest {
  /** Where the new version comes from: a URL or a local path (binary / .app.tar.gz), or an npm spec. */
  source: string;
  /** Version the new install must report once online. */
  expectVersion: string;
  /** Optional SHA256 of the downloaded artifact. */
  sha256?: string;
  /** Seconds to wait for the new daemon to come online (default 90). */
  deadlineSeconds?: number;
}

export interface UpdatePlan extends UpdateRequest {
  kind: InstallKind;
  /** What gets replaced: the binary, the .app bundle, or the npm package directory. */
  target: string;
  /** Staged new version (binary or .app); unused for npm. */
  staged?: string;
  /** Command that runs kraki (argv), resolved at the install path, so it is the NEW version after the swap. */
  cli: string[];
  fromVersion: string;
  home: string;
}

function dir(): string {
  const d = join(getKrakiHome(), 'remote-update');
  mkdirSync(d, { recursive: true });
  return d;
}

export function log(msg: string): void {
  try {
    mkdirSync(getLogsDir(), { recursive: true });
    appendFileSync(join(getLogsDir(), 'remote-update.log'), `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`);
  } catch { /* best effort */ }
}

function writeResult(result: Record<string, unknown>): void {
  writeFileSync(join(dir(), 'result.json'), `${JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)}\n`);
}

/** How this daemon was installed, and what an update replaces. */
export function detectInstall(): { kind: InstallKind; target: string; cli: string[] } | null {
  // Kraki for Mac's built-in helper: …/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki.
  // The whole signed app is the unit of update; the helper path stays the same.
  if (process.env.KRAKI_MANAGED_BY === 'kraki-mac') {
    const exe = realpathSync(process.execPath);
    const parts = exe.split('/');
    const idx = parts.lastIndexOf('Library');
    if (idx > 2 && parts[idx - 1] === 'Contents') {
      return { kind: 'mac-app', target: parts.slice(0, idx - 1).join('/'), cli: [exe] };
    }
    return null;
  }
  if (isSea()) {
    const exe = realpathSync(process.execPath);
    if (process.platform === 'darwin') {
      const macos = dirname(exe);
      const app = dirname(dirname(macos));
      if (basename(macos) === 'MacOS' && app.endsWith('.app')) {
        return { kind: 'app-bundle', target: app, cli: [exe] };
      }
    }
    return { kind: 'binary', target: exe, cli: [exe] };
  }
  const script = process.argv[1];
  if (!script) return null;
  let real = script;
  try { real = realpathSync(script); } catch { /* keep */ }
  // npm global install: …/node_modules/@kraki/tentacle/dist/cli.js
  let d = dirname(real);
  for (let i = 0; i < 4; i++) {
    const pkg = join(d, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name;
        if (name === '@kraki/tentacle' && d.includes('node_modules')) {
          return { kind: 'npm', target: d, cli: [process.execPath, real] };
        }
      } catch { /* keep looking */ }
    }
    d = dirname(d);
  }
  return null;
}

// ── Daemon side ─────────────────────────────────────────

let polling = false;

/** POC trigger: poll for a request file while the daemon runs. */
export function watchForUpdateRequests(intervalMs = 3000): void {
  if (polling) return;
  polling = true;
  const path = join(getKrakiHome(), REQUEST_FILE);
  let busy = false;
  const timer = setInterval(() => {
    if (busy || !existsSync(path)) return;
    busy = true;
    let req: UpdateRequest;
    try {
      req = JSON.parse(readFileSync(path, 'utf8')) as UpdateRequest;
      unlinkSync(path);
    } catch (err) {
      log(`bad request file: ${(err as Error).message}`);
      try { unlinkSync(path); } catch { /* gone */ }
      busy = false;
      return;
    }
    startRemoteUpdate(req).catch((err) => {
      log(`update not started: ${(err as Error).message}`);
      writeResult({ ok: false, phase: 'stage', error: (err as Error).message });
    }).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
}

async function fetchTo(source: string, dest: string): Promise<void> {
  if (/^https?:\/\//.test(source)) {
    const { downloadFile } = await import('./update.js');
    await downloadFile(source, dest, () => {});
  } else {
    copyFileSync(source, dest);
  }
}

export async function startRemoteUpdate(req: UpdateRequest): Promise<void> {
  const install = detectInstall();
  if (!install) throw new Error('unknown install method');
  log(`request: ${JSON.stringify(req)} install=${JSON.stringify(install)} from=${getVersion()}`);
  const work = dir();
  const plan: UpdatePlan = {
    ...req, ...install, fromVersion: getVersion(), home: getKrakiHome(),
  };

  // Stage while still online.
  if (install.kind !== 'npm') {
    const artifact = join(work, `download-${Date.now()}`);
    await fetchTo(req.source, artifact);
    if (req.sha256) {
      const { hashFile } = await import('./update.js');
      const got = hashFile(artifact);
      if (got !== req.sha256) throw new Error(`checksum mismatch: ${got}`);
    }
    if (install.kind === 'mac-app') {
      const out = `${install.target}.new`;
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      const r = spawnSync('ditto', ['-x', '-k', artifact, out], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr}`);
      const app = join(out, 'Kraki.app');
      if (!existsSync(app)) throw new Error('no Kraki.app in archive');
      const sig = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
      const gk = spawnSync('spctl', ['-a', '-t', 'exec', app], { encoding: 'utf8' });
      log(`  codesign=${sig.status} spctl=${gk.status} ${(gk.stderr ?? '').trim()}`);
      if (sig.status !== 0 || gk.status !== 0) throw new Error('new app is not validly signed/notarized');
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', app]);
      plan.staged = app;
    } else if (install.kind === 'binary') {
      plan.staged = `${install.target}.new`;
      copyFileSync(artifact, plan.staged);
      if (process.platform !== 'win32') chmodSync(plan.staged, 0o755);
    } else {
      // .app.tar.gz → <target>.new/Kraki.app, on the same volume as the target.
      const out = `${install.target}.new`;
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      const r = spawnSync('tar', ['-xzf', artifact, '-C', out]);
      if (r.status !== 0) throw new Error(`extract failed: ${r.stderr}`);
      const app = join(out, basename(install.target));
      const found = existsSync(app) ? app : join(out, 'Kraki.app');
      if (!existsSync(found)) throw new Error('no .app in archive');
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', found]);
      plan.staged = found;
    }
    rmSync(artifact, { force: true });
  }
  const planPath = join(work, 'plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeResult({ ok: null, phase: 'staged', from: plan.fromVersion, to: req.expectVersion });
  log(`staged; launching applier for ${install.kind}`);

  // Double spawn: the launcher starts the applier detached and exits at once,
  // so the applier's parent is gone and it is not in this daemon's tree.
  const self = isSea() ? [process.execPath] : [process.execPath, process.argv[1]];
  const env = { ...process.env };
  delete env.KRAKI_META_FILE;           // the self-management guard is for agents, not this
  delete env.KRAKI_SUPERVISED;
  const child = spawn(self[0], [...self.slice(1), APPLY_UPDATE_COMMAND, '--launch', planPath], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  child.unref();
}

// ── Applier side ────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cli: string[], args: string[], timeoutMs = 60_000): { code: number | null; out: string } {
  const env = { ...process.env };
  delete env.KRAKI_META_FILE;
  delete env.KRAKI_SUPERVISED;
  const r = spawnSync(cli[0], [...cli.slice(1), ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function status(cli: string[]): { running?: boolean; relayState?: string | null; daemonVersion?: string | null } {
  const r = run(cli, ['status', '--json'], 20_000);
  try {
    const j = JSON.parse(r.out) as { daemon?: { running?: boolean; relayState?: string; daemonVersion?: string } };
    return j.daemon ?? {};
  } catch { return {}; }
}

async function waitOnline(cli: string[], version: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const s = status(cli);
    const line = `running=${s.running} relay=${s.relayState} version=${s.daemonVersion}`;
    if (line !== last) { log(`  status ${line}`); last = line; }
    if (s.running && s.relayState === 'connected' && s.daemonVersion === version) return true;
    await sleep(2000);
  }
  return false;
}

function backupPath(plan: UpdatePlan): string {
  return `${plan.target}.old`;
}

function swapIn(plan: UpdatePlan): void {
  const old = backupPath(plan);
  rmSync(old, { recursive: true, force: true });
  if (plan.kind === 'npm') {
    // Keep a full copy of the package to restore; npm replaces it in place.
    cpSync(plan.target, old, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '-g', plan.source], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 300_000 });
    log(`  npm install -g ${plan.source} → ${r.status}\n${(r.stdout ?? '').slice(-800)}${(r.stderr ?? '').slice(-800)}`);
    if (r.status !== 0) throw new Error(`npm install failed (${r.status}): ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}`);
    return;
  }
  // Binary or .app: a running file can be renamed on every OS (Windows only
  // refuses overwrite/delete), so move the old one aside, then move in the new.
  renameSync(plan.target, old);
  renameSync(plan.staged as string, plan.target);
  if (plan.kind === 'app-bundle') {
    rmSync(dirname(plan.staged as string), { recursive: true, force: true });
  }
}

function swapBack(plan: UpdatePlan): void {
  const old = backupPath(plan);
  if (!existsSync(old)) throw new Error('no backup to restore');
  rmSync(plan.target, { recursive: true, force: true });
  if (plan.kind === 'npm') {
    cpSync(old, plan.target, { recursive: true });
    rmSync(old, { recursive: true, force: true });
  } else {
    renameSync(old, plan.target);
  }
}

export async function runApplier(args: string[]): Promise<void> {
  const i = args.indexOf('--launch');
  if (i >= 0) {
    // Stage 1: re-spawn detached and leave, breaking the parent link.
    const self = isSea() ? [process.execPath] : [process.execPath, process.argv[1]];
    const child = spawn(self[0], [...self.slice(1), APPLY_UPDATE_COMMAND, args[i + 1]], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.unref();
    log(`launcher: applier pid=${child.pid}`);
    return;
  }
  const planPath = args[0];
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as UpdatePlan;
  const deadline = plan.deadlineSeconds ?? 90;
  log(`applier start: ${plan.kind} ${plan.fromVersion} → ${plan.expectVersion} target=${plan.target}`);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  if (plan.kind === 'mac-app') return applyMacApp(plan, deadline, t0);
  let phase = 'stop';
  try {
    const stop = run(plan.cli, ['stop']);
    log(`  stop → ${stop.code} ${stop.out.split('\n').slice(-2).join(' | ')}`);
    // Give a slow shutdown a moment; then make sure nothing is left.
    for (let k = 0; k < 20 && status(plan.cli).running; k++) await sleep(500);
    const offlineAt = Date.now();
    phase = 'swap';
    swapIn(plan);
    log(`  swapped in (${elapsed()})`);
    phase = 'start';
    const start = run(plan.cli, ['start', '--login'], 120_000);
    log(`  start → ${start.code} ${start.out.split('\n').slice(-2).join(' | ')}`);
    phase = 'verify';
    if (await waitOnline(plan.cli, plan.expectVersion, deadline)) {
      const offline = ((Date.now() - offlineAt) / 1000).toFixed(1);
      log(`✔ updated to ${plan.expectVersion}; offline ${offline}s, total ${elapsed()}`);
      rmSync(backupPath(plan), { recursive: true, force: true });
      writeResult({ ok: true, from: plan.fromVersion, to: plan.expectVersion, kind: plan.kind, offlineSeconds: Number(offline) });
      return;
    }
    throw new Error(`new version not online within ${deadline}s`);
  } catch (err) {
    const reason = (err as Error).message;
    log(`✘ ${phase} failed: ${reason}; rolling back`);
    try {
      run(plan.cli, ['stop']);
      if (phase !== 'stop') swapBack(plan);
      const start = run(plan.cli, ['start', '--login'], 120_000);
      log(`  rollback start → ${start.code} ${start.out.split('\n').slice(-2).join(' | ')}`);
      const back = await waitOnline(plan.cli, plan.fromVersion, deadline);
      log(back ? `↺ rolled back to ${plan.fromVersion}, online (${elapsed()})` : '✘ rollback did not come online');
      writeResult({ ok: false, rolledBack: back, phase, error: reason, from: plan.fromVersion, kind: plan.kind });
    } catch (e2) {
      log(`✘ rollback failed: ${(e2 as Error).message}`);
      writeResult({ ok: false, rolledBack: false, phase, error: reason, rollbackError: (e2 as Error).message, kind: plan.kind });
    }
  }
}

// ── Kraki for Mac (built-in helper) ─────────────────────

function uid(): number { return process.getuid?.() ?? 501; }

function macAppRunning(): boolean {
  return spawnSync('pgrep', ['-x', 'Kraki']).status === 0;
}

function restartHelper(): void {
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid()}/chat.kraki.mac.tentacle`], { encoding: 'utf8' });
  log(`  kickstart -k → ${r.status} ${(r.stderr ?? '').trim()}`);
}

function openApp(target: string, wasRunning: boolean): void {
  // Hidden launch lets the app run its own checks (re-register the helper
  // after an update, restart it onto the version it ships).
  const r = spawnSync('open', wasRunning ? ['-g', target] : ['-g', '-j', target], { encoding: 'utf8' });
  log(`  open ${wasRunning ? '-g' : '-g -j'} → ${r.status} ${(r.stderr ?? '').trim()}`);
}

async function applyMacApp(plan: UpdatePlan, deadline: number, t0: number): Promise<void> {
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const old = `${plan.target}.old`;
  const wasRunning = macAppRunning();
  log(`  app running=${wasRunning}`);
  let phase = 'swap';
  try {
    if (wasRunning) { spawnSync('pkill', ['-x', 'Kraki']); for (let k = 0; k < 20 && macAppRunning(); k++) await sleep(250); }
    rmSync(old, { recursive: true, force: true });
    renameSync(plan.target, old);
    renameSync(plan.staged as string, plan.target);
    rmSync(dirname(plan.staged as string), { recursive: true, force: true });
    log(`  swapped app (${elapsed()})`);
    const offlineAt = Date.now();
    phase = 'start';
    restartHelper();            // ends this applier's old daemon; launchd starts the new helper
    await sleep(3000);
    openApp(plan.target, wasRunning);
    phase = 'verify';
    if (await waitOnline(plan.cli, plan.expectVersion, deadline)) {
      const offline = ((Date.now() - offlineAt) / 1000).toFixed(1);
      log(`✔ app updated; helper ${plan.expectVersion} online; offline ${offline}s, total ${elapsed()}`);
      rmSync(old, { recursive: true, force: true });
      writeResult({ ok: true, from: plan.fromVersion, to: plan.expectVersion, kind: plan.kind, offlineSeconds: Number(offline), appWasRunning: wasRunning });
      return;
    }
    throw new Error(`new helper not online within ${deadline}s`);
  } catch (err) {
    const reason = (err as Error).message;
    log(`✘ ${phase} failed: ${reason}; rolling back`);
    try {
      if (existsSync(old)) {
        if (macAppRunning()) spawnSync('pkill', ['-x', 'Kraki']);
        rmSync(plan.target, { recursive: true, force: true });
        renameSync(old, plan.target);
      }
      restartHelper();
      await sleep(3000);
      openApp(plan.target, wasRunning);
      const back = await waitOnline(plan.cli, plan.fromVersion, deadline);
      log(back ? `↺ rolled back to ${plan.fromVersion}, online (${elapsed()})` : '✘ rollback did not come online');
      writeResult({ ok: false, rolledBack: back, phase, error: reason, from: plan.fromVersion, kind: plan.kind });
    } catch (e2) {
      log(`✘ rollback failed: ${(e2 as Error).message}`);
      writeResult({ ok: false, rolledBack: false, phase, error: reason, rollbackError: (e2 as Error).message, kind: plan.kind });
    }
  }
}
