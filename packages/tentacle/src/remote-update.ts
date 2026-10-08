/**
 * Remote update: an app asks this computer to update Kraki, with nobody at
 * the computer. Proven per install method in the POC (branch poc/remote-update).
 *
 *   1. While still online, the daemon downloads and verifies the new version
 *      (release checksum; for Kraki for Mac also code signature, notarization
 *      and the same Team ID as the installed app) and stages it next to the
 *      install. npm: `npm install -g --prefix <stage>`, so the slow part runs
 *      before anything stops.
 *   2. It starts the *applier*: a detached process outside the daemon's
 *      process tree (Windows `kraki stop` kills the whole tree), run from a
 *      copy of the binary (Windows can't delete a running .exe) with its cwd
 *      outside the install (Windows can't rename a directory a process sits in).
 *   3. The applier stops the daemon, moves the old install aside, moves the
 *      new one in, starts it with the new version's own `start --login` (or,
 *      for Kraki for Mac, `launchctl kickstart -k` and a hidden app launch),
 *      and waits until it reports connected at the expected version.
 *   4. If that doesn't happen in time it puts the old install back and starts
 *      it again, so the computer is never left offline.
 *   5. The applier writes the outcome to <KRAKI_HOME>/remote-update/result.json;
 *      the daemon that comes up next announces it to apps once.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync, appendFileSync, chmodSync, constants as fsConstants, copyFileSync, cpSync, existsSync,
  mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import { randomUUID } from 'node:crypto';
import type { DeviceUpdateInfo, DeviceUpdatePhase } from '@kraki/protocol';
import { getKrakiHome, getLogsDir, type KrakiConfig } from './config.js';
import type { InstallInfo } from './update-status.js';

export const APPLY_UPDATE_COMMAND = '__apply-update';
const GITHUB = 'https://github.com/corelli18512/kraki/releases/download';

export type RemoteBlock = NonNullable<DeviceUpdateInfo['remoteBlock']>;

export interface UpdateProgress {
  phase: DeviceUpdatePhase;
  requestId?: string;
  from?: string;
  to?: string;
  progress?: number;
  runningSessions?: number;
  error?: string;
}

export interface UpdatePlan {
  requestId: string;
  method: InstallInfo['method'];
  /** What gets replaced: binary, .app bundle, npm package dir, or the Mac app. */
  target: string;
  /** The verified new version, staged on the same volume when possible. */
  staged: string;
  /** Runs kraki at the install path — after the swap, the new version. */
  cli: string[];
  from: string;
  to: string;
  /** Tentacle version to expect online (differs from `to` for the Mac app). */
  expectTentacle?: string;
  deadlineSeconds: number;
}

export function workDir(): string {
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

// ── May this computer be updated remotely? ──────────────

function writable(p: string): boolean {
  try { accessSync(p, fsConstants.W_OK); return true; } catch { return false; }
}

export function remoteUpdateBlock(
  install: InstallInfo,
  config: Pick<KrakiConfig, 'remoteUpdate'> | null,
  canWrite: (p: string) => boolean = writable,
): RemoteBlock | null {
  if (config?.remoteUpdate === false) return 'disabled';
  if (install.method === 'unknown' || !install.target) return 'unsupported';
  if (install.method === 'mac-app' && !install.appVersion) return 'unsupported';
  // Moving the install aside needs its parent directory; replacing in place
  // needs the install itself.
  if (!canWrite(dirname(install.target)) || !canWrite(install.target)) return 'not_writable';
  return null;
}

// ── Staging (daemon side, still online) ─────────────────

export interface StageDeps {
  download: (url: string, dest: string, onProgress: (received: number, total: number) => void) => Promise<void>;
  fetchText: (url: string) => Promise<string>;
  hashFile: (path: string) => string;
  parseChecksum: (sums: string, asset: string) => string | null;
  run: (cmd: string, args: string[], opts?: { timeoutMs?: number; shell?: boolean }) => { code: number | null; out: string };
}

async function defaultStageDeps(): Promise<StageDeps> {
  const u = await import('./update.js');
  return {
    download: u.downloadFile, fetchText: u.fetchText, hashFile: u.hashFile, parseChecksum: u.parseChecksum,
    run: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts?.timeoutMs ?? 120_000, shell: opts?.shell, windowsHide: true });
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    },
  };
}

async function downloadVerified(
  d: StageDeps, tag: string, asset: string, dest: string, onProgress: (f: number) => void,
): Promise<void> {
  const sums = await d.fetchText(`${GITHUB}/${tag}/SHA256SUMS.txt`);
  const expected = d.parseChecksum(sums, asset);
  if (!expected) throw new Error(`no checksum for ${asset} in ${tag}`);
  await d.download(`${GITHUB}/${tag}/${asset}`, dest, (got, total) => { if (total > 0) onProgress(got / total); });
  const actual = d.hashFile(dest);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
}

function teamId(d: StageDeps, app: string): string | null {
  const r = d.run('codesign', ['-dv', '--verbose=2', app]);
  return r.out.match(/TeamIdentifier=(\S+)/)?.[1] ?? null;
}

export interface StageInput {
  install: InstallInfo;
  /** Newest tentacle (GitHub `v` release). */
  latestTentacle: string;
  /** Newest Kraki for Mac (appcast), for `mac-app`. */
  latestApp?: string;
  currentVersion: string;
  requestId: string;
  platformAsset: string;
  appBundleAsset: string;
}

export async function stageUpdate(
  input: StageInput, onProgress: (f: number) => void, deps?: StageDeps,
): Promise<UpdatePlan> {
  const d = deps ?? await defaultStageDeps();
  const { install } = input;
  const target = install.target;
  if (!target) throw new Error('unknown install location');
  const work = workDir();
  const tmp = join(work, `download-${Date.now()}`);
  const base: Omit<UpdatePlan, 'staged' | 'cli' | 'to'> = {
    requestId: input.requestId, method: install.method, target, from: input.currentVersion, deadlineSeconds: 120,
  };
  try {
    switch (install.method) {
      case 'binary': {
        await downloadVerified(d, `v${input.latestTentacle}`, input.platformAsset, tmp, onProgress);
        const staged = `${target}.new`;
        rmSync(staged, { force: true });
        moveOrCopy(tmp, staged);
        if (process.platform !== 'win32') chmodSync(staged, 0o755);
        if (process.platform === 'darwin') d.run('xattr', ['-c', staged]);
        return { ...base, staged, cli: [target], to: input.latestTentacle };
      }
      case 'app-bundle': {
        await downloadVerified(d, `v${input.latestTentacle}`, input.appBundleAsset, tmp, onProgress);
        const out = `${target}.new`;
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        const x = d.run('tar', ['-xzf', tmp, '-C', out]);
        if (x.code !== 0) throw new Error(`extract failed: ${x.out}`);
        const app = join(out, basename(target));
        const staged = existsSync(app) ? app : join(out, 'Kraki.app');
        if (!existsSync(staged)) throw new Error('no Kraki.app in the archive');
        d.run('xattr', ['-dr', 'com.apple.quarantine', staged]);
        return { ...base, staged, cli: [join(target, 'Contents', 'MacOS', 'kraki')], to: input.latestTentacle };
      }
      case 'mac-app': {
        const to = input.latestApp;
        if (!to) throw new Error('no newer Kraki for Mac');
        await downloadVerified(d, `mac-v${to}`, 'Kraki.app.zip', tmp, onProgress);
        const out = `${target}.new`;
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        const x = d.run('ditto', ['-x', '-k', tmp, out]);
        if (x.code !== 0) throw new Error(`unzip failed: ${x.out}`);
        const staged = join(out, 'Kraki.app');
        if (!existsSync(staged)) throw new Error('no Kraki.app in the archive');
        if (d.run('codesign', ['--verify', '--deep', '--strict', staged]).code !== 0) throw new Error('the new app is not validly signed');
        if (d.run('spctl', ['-a', '-t', 'exec', staged]).code !== 0) throw new Error('the new app is not notarized');
        const mine = teamId(d, target);
        if (!mine || teamId(d, staged) !== mine) throw new Error('the new app is signed by someone else');
        d.run('xattr', ['-dr', 'com.apple.quarantine', staged]);
        const helper = join(target, 'Contents', 'Library', 'Helpers', 'Kraki.app', 'Contents', 'MacOS', 'kraki');
        const { readPlistString } = await import('./update-status.js');
        const shipped = readPlistString(join(staged, 'Contents', 'Info.plist'), 'KrakiTentacleVersion');
        return { ...base, staged, cli: [helper], to, expectTentacle: shipped ?? input.latestTentacle };
      }
      case 'npm': {
        // A global install into a private prefix: same layout as the real
        // one (deps nested under the package), so the package directory can
        // simply be swapped in.
        onProgress(0);
        const prefix = join(work, `npm-${Date.now()}`);
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const r = d.run(npm, ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', `@kraki/tentacle@${input.latestTentacle}`],
          { timeoutMs: 600_000, shell: process.platform === 'win32' });
        if (r.code !== 0) throw new Error(`npm install failed: ${r.out.split('\n').slice(-3).join(' ')}`);
        const staged = process.platform === 'win32'
          ? join(prefix, 'node_modules', '@kraki', 'tentacle')
          : join(prefix, 'lib', 'node_modules', '@kraki', 'tentacle');
        const v = (JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as { version?: string }).version;
        if (v !== input.latestTentacle) throw new Error(`npm installed ${v}, expected ${input.latestTentacle}`);
        onProgress(1);
        return { ...base, staged, cli: [process.execPath, join(target, 'dist', 'cli.js')], to: input.latestTentacle };
      }
      default:
        throw new Error(`can't update a ${install.method} install remotely`);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function rmRetry(p: string): Promise<void> {
  for (let i = 1; ; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; } catch (err) {
      if (i >= 40) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Windows keeps a just-exited .exe (or a scanned file) locked for a moment:
 *  retry a rename that fails with EBUSY/EPERM/EACCES for up to ~20 s. */
export async function renameRetry(
  from: string, to: string, attempts = 40, delayMs = 500, rename: (a: string, b: string) => void = renameSync,
): Promise<void> {
  for (let i = 1; ; i++) {
    try { rename(from, to); return; } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw err;
      if (i === 1) log(`  ${code} renaming ${from}; retrying`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function moveOrCopy(from: string, to: string): void {
  try { renameSync(from, to); } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Start the applier detached from this daemon (see the file comment). */
export function launchApplier(plan: UpdatePlan): void {
  const work = workDir();
  const planPath = join(work, 'plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  // Windows can't delete a running .exe, so run the applier from a copy
  // there. Not on macOS: only Kraki's own signed binary (in place) may
  // replace Kraki in /Applications (App Management protection).
  let self: string[];
  if (isSea() && process.platform === 'win32') {
    const copy = join(work, process.platform === 'win32' ? 'applier.exe' : 'applier');
    rmSync(copy, { force: true });
    copyFileSync(process.execPath, copy);
    if (process.platform !== 'win32') chmodSync(copy, 0o755);
    self = [copy];
  } else {
    self = isSea() ? [process.execPath] : [process.execPath, process.argv[1]];
  }
  const child = spawn(self[0], [...self.slice(1), APPLY_UPDATE_COMMAND, '--launch', planPath], {
    detached: true, stdio: 'ignore', windowsHide: true, env: applierEnv(), cwd: tmpdir(),
  });
  child.unref();
  log(`launched applier for ${plan.method} ${plan.from} → ${plan.to}`);
}

function applierEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KRAKI_META_FILE;   // the self-management guard is for agents
  delete env.KRAKI_SUPERVISED;
  delete env.KRAKI_MANAGED_BY;  // the applier is not the Mac app's worker
  return env;
}

// ── Result handoff to the next daemon ───────────────────

export interface UpdateResult {
  requestId?: string;
  phase: 'updated' | 'rolled_back' | 'failed';
  from?: string;
  to?: string;
  error?: string;
  method?: string;
  offlineSeconds?: number;
  at: string;
  announced?: boolean;
}

function resultPath(): string { return join(workDir(), 'result.json'); }

export function writeResult(r: Omit<UpdateResult, 'at'>): void {
  writeFileSync(resultPath(), `${JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2)}\n`);
  // The update is over: a daemon starting from now on may clean up.
  try { rmSync(join(workDir(), 'plan.json'), { force: true }); } catch { /* ignore */ }
}

/** True while an applier may still need `<target>.old` (to roll back). A
 *  plan older than an hour belongs to an applier that died. */
export function updateInProgress(maxAgeMs = 60 * 60_000): boolean {
  try {
    const st = statSync(join(workDir(), 'plan.json'));
    return Date.now() - st.mtimeMs < maxAgeMs;
  } catch { return false; }
}

/** The outcome of the last update, once, if it is recent. */
export function takeUnannouncedResult(maxAgeMs = 30 * 60_000): UpdateResult | null {
  try {
    const r = JSON.parse(readFileSync(resultPath(), 'utf8')) as UpdateResult;
    if (r.announced || Date.now() - Date.parse(r.at) > maxAgeMs) return null;
    writeFileSync(resultPath(), `${JSON.stringify({ ...r, announced: true }, null, 2)}\n`);
    return r;
  } catch { return null; }
}

/** Remove leftovers of a finished update; a locked one is retried next start. */
export function cleanupAfterUpdate(target?: string, opts: { duringUpdate?: boolean } = {}): void {
  if (!target) return;
  // The new version's own daemon starts while its applier is still verifying
  // it; the backup must stay until the applier is done (it may roll back).
  if (!opts.duringUpdate && updateInProgress()) { log(`update in progress; keeping ${target}.old`); return; }
  for (const p of [`${target}.old`, `${target}.new`]) {
    if (!existsSync(p)) continue;
    try { rmSync(p, { recursive: true, force: true }); log(`removed ${p}`); }
    catch (err) { log(`could not remove ${p} yet: ${(err as Error).message}`); }
  }
  for (const n of ['applier', 'applier.exe']) {
    try { rmSync(join(workDir(), n), { force: true }); } catch { /* in use */ }
  }
}

// ── Applier ─────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runCli(cli: string[], args: string[], timeoutMs = 60_000): { code: number | null; out: string } {
  const r = spawnSync(cli[0], [...cli.slice(1), ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: applierEnv() });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function status(cli: string[]): { running?: boolean; relayState?: string | null; daemonVersion?: string | null } {
  try {
    const j = JSON.parse(runCli(cli, ['status', '--json'], 20_000).out) as { daemon?: Record<string, unknown> };
    return (j.daemon ?? {}) as { running?: boolean; relayState?: string; daemonVersion?: string };
  } catch { return {}; }
}

async function waitOnline(cli: string[], version: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const s = status(cli);
    const line = `running=${s.running} relay=${s.relayState} version=${s.daemonVersion}`;
    if (line !== last) { log(`  ${line}`); last = line; }
    if (s.running && s.relayState === 'connected' && s.daemonVersion === version) return true;
    await sleep(2000);
  }
  return false;
}

export async function runApplier(args: string[]): Promise<void> {
  const i = args.indexOf('--launch');
  if (i >= 0) {
    // Stage 1: re-spawn detached and leave, so the applier has no parent.
    const self = isSea() ? [process.execPath] : [process.execPath, process.argv[1]];
    const child = spawn(self[0], [...self.slice(1), APPLY_UPDATE_COMMAND, args[i + 1]], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env, cwd: tmpdir(),
    });
    child.unref();
    return;
  }
  try { process.chdir(tmpdir()); } catch { /* keep */ }
  let plan: UpdatePlan;
  try {
    plan = JSON.parse(readFileSync(args[0], 'utf8')) as UpdatePlan;
  } catch (err) {
    log(`applier: can't read the plan ${args[0]}: ${(err as Error).message}`);
    return;
  }
  if (plan.method === 'mac-app') return applyMacApp(plan);
  const expect = plan.to;
  const old = `${plan.target}.old`;
  const t0 = Date.now();
  let phase = 'stop';
  log(`applier: ${plan.method} ${plan.from} → ${plan.to} (${plan.target})`);
  try {
    const stop = runCli(plan.cli, ['stop']);
    log(`  stop → ${stop.code}`);
    for (let k = 0; k < 20 && status(plan.cli).running; k++) await sleep(500);
    const offlineAt = Date.now();
    phase = 'swap';
    rmSync(old, { recursive: true, force: true });
    await renameRetry(plan.target, old);
    try { moveOrCopy(plan.staged, plan.target); } catch (err) { await renameRetry(old, plan.target); throw err; }
    phase = 'start';
    const start = runCli(plan.cli, ['start', '--login'], 120_000);
    log(`  start → ${start.code}`);
    phase = 'verify';
    if (await waitOnline(plan.cli, expect, plan.deadlineSeconds)) {
      const offline = Math.round((Date.now() - offlineAt) / 100) / 10;
      log(`✔ updated to ${expect}; offline ${offline}s`);
      writeResult({ requestId: plan.requestId, phase: 'updated', from: plan.from, to: plan.to, method: plan.method, offlineSeconds: offline });
      cleanupAfterUpdate(plan.target, { duringUpdate: true });
      return;
    }
    throw new Error(`the new version didn't come online within ${plan.deadlineSeconds}s`);
  } catch (err) {
    const reason = (err as Error).message;
    log(`✘ ${phase}: ${reason}; restoring ${plan.from}`);
    let back = false;
    let running = plan.from;
    try {
      if (phase !== 'stop' && phase !== 'swap') {
        runCli(plan.cli, ['stop']);
        for (let k = 0; k < 20 && status(plan.cli).running; k++) await sleep(500);
        if (existsSync(old)) {
          await rmRetry(plan.target);
          await renameRetry(old, plan.target);
        } else {
          // Never leave the computer without Kraki: keep the new version and
          // start it again rather than deleting it with nothing to restore.
          log('  no backup to restore; keeping the installed version');
          running = plan.to;
        }
      }
      runCli(plan.cli, ['start', '--login'], 120_000);
      back = await waitOnline(plan.cli, running, plan.deadlineSeconds);
    } catch (e2) { log(`✘ restore failed: ${(e2 as Error).message}`); }
    log(back ? `↺ online on ${running} (${Math.round((Date.now() - t0) / 1000)}s)` : `✘ ${running} not online either`);
    const restored = running === plan.from && phase !== 'stop' && phase !== 'swap';
    writeResult({ requestId: plan.requestId, phase: restored ? 'rolled_back' : 'failed', from: plan.from, to: plan.to, method: plan.method, error: reason });
  }
}

// Kraki for Mac: the signed app is the unit of update.

function macAppRunning(appPath: string): boolean {
  return spawnSync('pgrep', ['-f', `${appPath}/Contents/MacOS/`]).status === 0;
}

function kickstartHelper(): void {
  const uid = process.getuid?.() ?? 501;
  const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/chat.kraki.mac.tentacle`], { encoding: 'utf8' });
  log(`  kickstart → ${r.status}`);
}

function openApp(app: string, wasRunning: boolean): void {
  // The app re-registers its helper after an update and restarts it onto the
  // version it ships; launch it hidden (and keep it hidden if it was closed).
  spawnSync('open', wasRunning ? ['-g', app] : ['-g', '-j', app]);
}

async function applyMacApp(plan: UpdatePlan): Promise<void> {
  const old = `${plan.target}.old`;
  const expect = plan.expectTentacle ?? '';
  const wasRunning = macAppRunning(plan.target);
  let swapped = false;
  log(`applier: mac-app ${plan.from} → ${plan.to}; app running=${wasRunning}`);
  try {
    if (wasRunning) {
      // Kraki for Mac skips its "take this Mac offline?" question while
      // plan.json exists; an older app may still ask, so never wait on it.
      spawnSync('osascript', ['-e', `quit app "${plan.target}"`], { timeout: 10_000 });
      for (let k = 0; k < 20 && macAppRunning(plan.target); k++) await sleep(250);
      if (macAppRunning(plan.target)) spawnSync('pkill', ['-f', `${plan.target}/Contents/MacOS/`]);
    }
    rmSync(old, { recursive: true, force: true });
    renameSync(plan.target, old);
    renameSync(plan.staged, plan.target);
    swapped = true;
    const offlineAt = Date.now();
    kickstartHelper();
    await sleep(3000);
    openApp(plan.target, wasRunning);
    if (await waitOnline(plan.cli, expect, plan.deadlineSeconds)) {
      const offline = Math.round((Date.now() - offlineAt) / 100) / 10;
      log(`✔ Kraki for Mac ${plan.to} (helper ${expect}) online; offline ${offline}s`);
      writeResult({ requestId: plan.requestId, phase: 'updated', from: plan.from, to: plan.to, method: 'mac-app', offlineSeconds: offline });
      cleanupAfterUpdate(plan.target, { duringUpdate: true });
      return;
    }
    throw new Error(`the new version didn't come online within ${plan.deadlineSeconds}s`);
  } catch (err) {
    const reason = (err as Error).message;
    log(`✘ ${reason}; restoring Kraki for Mac ${plan.from}`);
    try {
      if (swapped || existsSync(old)) {
        spawnSync('pkill', ['-f', `${plan.target}/Contents/MacOS/`]);
        if (existsSync(old)) { rmSync(plan.target, { recursive: true, force: true }); renameSync(old, plan.target); }
      }
      kickstartHelper();
      await sleep(3000);
      openApp(plan.target, wasRunning);
    } catch (e2) { log(`✘ restore failed: ${(e2 as Error).message}`); }
    writeResult({ requestId: plan.requestId, phase: swapped ? 'rolled_back' : 'failed', from: plan.from, to: plan.to, method: 'mac-app', error: reason });
  }
}

// ── Daemon-side coordinator ─────────────────────────────

export interface RemoteUpdaterOptions {
  install: InstallInfo;
  currentVersion: string;
  /** Latest check result (update-status.ts). */
  status: () => DeviceUpdateInfo | null;
  /** Check for the newest version now (before acting on a request). */
  refresh?: () => Promise<void>;
  /** Sessions with a turn running right now. */
  runningSessions: () => number;
  emit: (p: UpdateProgress) => void;
  stage?: typeof stageUpdate;
  launch?: typeof launchApplier;
  idlePollMs?: number;
  idleMaxMs?: number;
}

/** One update at a time; validates, waits for idle if asked, stages, hands off. */
export class RemoteUpdater {
  private busy = false;
  constructor(private readonly o: RemoteUpdaterOptions) {}

  get inProgress(): boolean { return this.busy; }

  async request(requestId: string, when?: 'now' | 'idle'): Promise<void> {
    // The periodic check may be hours old: install the newest release, not
    // whatever was newest then (a 0.2.75 answer installed 0.2.75 after 0.2.77
    // was out). A failed check keeps the previous answer.
    if (!this.busy) await this.o.refresh?.().catch(() => {});
    const s = this.o.status();
    const fail = (error: string) => { log(`request ${requestId}: ${error}`); this.o.emit({ phase: 'failed', requestId, error }); };
    if (this.busy) { fail('An update is already in progress.'); return; }
    if (!s?.remote) { fail('This computer can’t be updated remotely.'); return; }
    if (!s.latest) { fail('Already up to date.'); return; }
    const running = this.o.runningSessions();
    log(`request ${requestId}: ${s.current} → ${s.latest} (${when ?? 'ask'}, ${running} running)`);
    if (running > 0 && !when) { this.o.emit({ phase: 'busy', requestId, runningSessions: running, from: s.current, to: s.latest }); return; }
    this.busy = true;
    try {
      if (running > 0 && when === 'idle') {
        this.o.emit({ phase: 'waiting_idle', requestId, runningSessions: running, from: s.current, to: s.latest });
        const until = Date.now() + (this.o.idleMaxMs ?? 6 * 3600_000);
        while (this.o.runningSessions() > 0) {
          if (Date.now() > until) { fail('Sessions kept running; update cancelled.'); return; }
          await sleep(this.o.idlePollMs ?? 5000);
        }
      }
      this.o.emit({ phase: 'downloading', requestId, from: s.current, to: s.latest, progress: 0 });
      const { getPlatformAssetName, getAppBundleAssetName } = await import('./update.js');
      let last = 0;
      const plan = await (this.o.stage ?? stageUpdate)({
        install: this.o.install, latestTentacle: s.latestTentacle ?? s.latest, latestApp: s.latest,
        currentVersion: s.current, requestId: requestId || randomUUID(),
        platformAsset: getPlatformAssetName(), appBundleAsset: getAppBundleAssetName(),
      }, (f) => {
        if (f - last >= 0.1 || f >= 1) { last = f; this.o.emit({ phase: 'downloading', requestId, from: s.current, to: s.latest, progress: Math.min(1, f) }); }
      });
      this.o.emit({ phase: 'installing', requestId, from: s.current, to: s.latest });
      log(`staged ${plan.method} ${plan.from} → ${plan.to}`);
      (this.o.launch ?? launchApplier)(plan);
      // The applier stops this daemon shortly; stay busy until then.
    } catch (err) {
      this.busy = false;
      log(`not updated: ${(err as Error).message}`);
      fail((err as Error).message);
    }
  }
}
