/** status, logs, fda, permissions, doctor, relay-info: looking at what Kraki is doing. */

import { wsProxyOptions } from '../proxy.js';
import chalk from 'chalk';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { loadConfig, getKrakiHome, getLogVerbosity, getVersion } from '../config.js';
import { getCliLaunchdJobState, isDaemonRunning, getDaemonStatus } from '../daemon.js';
import { readStatusFile } from '../status-file.js';
import { loadManagedBy, ownerName } from '../managed.js';
import { gracefulExit } from './exit.js';

export function cmdStatus(jsonOutput = false): void {
  const status = getDaemonStatus();
  const config = loadConfig();
  const statusFile = readStatusFile();

  if (jsonOutput) {
    const managed = loadManagedBy();
    const cliJob = getCliLaunchdJobState();
    // Machine-readable for desktop apps (mac toolbar, etc.). Schema is
    // additive — only add fields, never remove, to keep older clients
    // working.
    const payload = {
      ok: true,
      version: getVersion(),
      daemon: {
        running: status.running,
        pid: status.pid,
        // Additive fields for Kraki for Mac's onboarding and ownership logic.
        owner: managed ? managed.by : (cliJob.plistExists ? 'cli' : null),
        supervisorPid: status.running ? (statusFile?.supervisorPid ?? null) : null,
        managedLabel: managed?.label ?? null,
        cliLaunchdJob: cliJob,
        relayState: status.running ? (statusFile?.relayState ?? null) : null,
        daemonVersion: status.running ? (statusFile?.version ?? null) : null,
        fda: status.running ? (statusFile?.fda ?? null) : null,
        fdaCheckedAt: status.running ? (statusFile?.fdaCheckedAt ?? null) : null,
      },
      config: config
        ? {
            exists: true,
            relay: config.relay,
            authMethod: config.authMethod,
            device: { name: config.device.name, id: config.device.id },
            agents: config.agents ?? null,
            region: statusFile?.region ?? null,
            logVerbosity: getLogVerbosity(config),
            remoteUpdate: config.remoteUpdate !== false,
          }
        : { exists: false },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  console.log('');
  console.log(`  ${chalk.hex('#2384d4').bold('Kraki')} ${chalk.dim(getVersion())}`);
  console.log('');

  const managedBy = loadManagedBy();
  const owner = managedBy ? `, managed by ${ownerName(managedBy.by)}` : '';
  if (status.running) {
    const relay = statusFile?.relayState;
    const link = relay === 'connected' ? chalk.green(', connected')
      : relay ? chalk.yellow(`, ${relay}`) : '';
    console.log(`  Status:  ${chalk.green('running')}${link} ${chalk.dim(`(PID ${status.pid}${owner})`)}`);
    const daemonVersion = statusFile?.version;
    if (daemonVersion && daemonVersion !== getVersion()) {
      console.log(chalk.yellow(`  Running: ${daemonVersion} (installed ${getVersion()}; run \`kraki restart\` to switch)`));
    }
  } else {
    console.log(`  Status:  ${chalk.yellow('stopped')}${owner}`);
  }

  if (config) {
    console.log(`  Relay:   ${chalk.cyan(config.relay)}`);
    console.log(`  Auth:    ${config.authMethod}`);
    console.log(`  Device:  ${config.device.name}`);
    if (statusFile?.region) {
      console.log(`  Region:  ${statusFile.region}`);
    }
    console.log(`  Logs:    ${getLogVerbosity(config)}`);
  } else {
    console.log(chalk.dim('  No config found. Run `kraki` to set up.'));
  }

  console.log('');
}

/** `tail -n 50 [-f] *.log` without `tail`: last lines of each log, then
 *  (with follow) print whatever is appended, polling once a second. */
export function tailLogsPortable(logDir: string, follow: boolean, lines = 50): void {
  const files = () => readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => join(logDir, f));
  const sizes = new Map<string, number>();
  for (const file of files().sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)) {
    const text = readFileSync(file, 'utf8');
    sizes.set(file, Buffer.byteLength(text));
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-lines);
    if (tail.length === 0) continue;
    console.log(chalk.dim(`==> ${file} <==`));
    console.log(tail.join('\n'));
  }
  if (!follow) return;
  let last: string | undefined;
  setInterval(() => {
    for (const file of files()) {
      let size: number;
      try { size = statSync(file).size; } catch { continue; }
      const prev = sizes.get(file) ?? 0;
      if (size === prev) continue;
      const buf = readFileSync(file);
      const chunk = buf.subarray(size < prev ? 0 : prev).toString('utf8');
      sizes.set(file, size);
      if (!chunk.trim()) continue;
      if (last !== file) { console.log(chalk.dim(`==> ${file} <==`)); last = file; }
      process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    }
  }, 1000);
}

export function cmdLogs(follow: boolean): void {
  const logDir = join(getKrakiHome(), 'logs');

  if (!existsSync(logDir)) {
    console.log(chalk.yellow(`No log directory found at ${logDir}`));
    return;
  }

  if (process.platform === 'win32') {
    // No `tail` on Windows.
    tailLogsPortable(logDir, follow);
    return;
  }

  // Expand the glob here instead of through a shell: KRAKI_HOME is a path
  // and must never be interpreted as shell syntax.
  const files = readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => join(logDir, f));
  if (files.length === 0) {
    console.log(chalk.yellow(`No log files in ${logDir}`));
    return;
  }
  const args = follow ? ['-f', ...files] : ['-n', '50', ...files];

  const child = spawn('tail', args, { stdio: 'inherit' });

  child.on('error', () => {
    console.log(chalk.red('Failed to tail logs.'));
  });
}

// ── kraki fda — macOS Full Disk Access status ───────────

export async function cmdFda(args: string[]): Promise<void> {
  const watch = args.includes('--watch');
  const { probeFda } = await import('../checks.js');

  if (process.platform !== 'darwin') {
    process.stdout.write(JSON.stringify({ ok: true, status: 'not_applicable', platform: process.platform }) + '\n');
    return;
  }

  if (watch) {
    // Stream NDJSON status updates until FDA is granted (or aborted).
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    process.on('SIGTERM', () => ac.abort());
    let last: string | undefined;
    while (!ac.signal.aborted) {
      const status = await probeFda();
      if (status !== last) {
        last = status;
        process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
      }
      if (status === 'granted') {
        process.stdout.write(JSON.stringify({ ok: true, status: 'granted', done: true }) + '\n');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    process.stdout.write(JSON.stringify({ ok: true, status: 'aborted', done: true }) + '\n');
    return;
  }

  const status = await probeFda();
  process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
}

// ── kraki permissions - macOS TCC status + deep-links ─────
//
// This is the user-facing entry point for the root-cause fix. It:
//   1. registers the installed .app bundle with Launch Services so TCC
//      tracks grants by bundle id (stable across updates) instead of
//      cdhash (invalidated every release), and
//   2. opens the exact System Settings panes the user must toggle, since
//      TCC.db is SIP-protected and cannot be flipped programmatically.

export async function cmdPermissions(args: string[]): Promise<void> {
  const {
    probeTccStatus, openAllTccPanes, TCC_SERVICES, ensureTccBundleRegistered, cleanupStaleBundleEntries,
  } = await import('../checks.js');

  const open = args.includes('--open');
  const json = args.includes('--json');
  const clean = args.includes('--clean');

  if (process.platform !== 'darwin') {
    process.stdout.write(JSON.stringify({ ok: true, status: 'not_applicable', platform: process.platform }) + '\n');
    return;
  }

  // Always (re)register the bundle. Idempotent and cheap; this is the
  // fix the recurring-FDA commits #123/#133/#138/#142 were all missing.
  // (probeTccStatus below also registers, so this is technically redundant,
  // but kept explicit so `--open` alone still registers without a full probe.)
  ensureTccBundleRegistered();
  // Purge zombie Launch Services entries (paths that no longer exist, or
  // throwaway /tmp extracts from prior updates). `--clean` reports them;
  // the sweep itself always runs as hygiene.
  const sweep = cleanupStaleBundleEntries();

  const status = await probeTccStatus();

  if (open) {
    openAllTccPanes();
    if (!json) {
      console.log(chalk.bold('  Opening the privacy panes in System Settings…'));
      console.log(chalk.dim('  macOS only lets you grant these yourself. Turn on Kraki:'));
      console.log('');
      for (const s of TCC_SERVICES) {
        console.log(`    ${chalk.bold(s.label)}`);
        console.log(chalk.dim(`      ${s.url}`));
        console.log(chalk.dim(`      needed to: ${s.reason}`));
      }
      console.log('');
      console.log(chalk.green('  Because Kraki.app is signed with a stable Developer ID and now'));
      console.log(chalk.green('  registered with Launch Services, these grants survive updates.'));
    }
  }

  if (clean && sweep.removed.length > 0 && !json) {
    console.log(chalk.dim(`  Cleaned ${sweep.removed.length} stale Launch Services entr${sweep.removed.length === 1 ? 'y' : 'ies'}:`));
    for (const p of sweep.removed.slice(0, 10)) console.log(chalk.dim(`    - ${p}`));
    if (sweep.removed.length > 10) console.log(chalk.dim(`    … and ${sweep.removed.length - 10} more`));
  }

  if (json || !open) {
    process.stdout.write(JSON.stringify({
      ok: true,
      bundled: status.bundled,
      registered: status.registered,
      notApplicable: status.notApplicable,
      services: status.services,
      launchServices: { staleRemoved: sweep.removed.length, kept: sweep.kept.length },
      servicesNeeded: TCC_SERVICES.map((s) => ({ id: s.id, label: s.label, reason: s.reason })),
    }, null, 2) + '\n');
  }
}

// ── kraki doctor — environment status as JSON ───────────

export async function cmdDoctor(): Promise<void> {
  const {
    checkGhAuth, checkCopilotCli, checkClaudeCli, checkCodexCli, checkAnthropicCreds, probeFda, getKrakiAppBundlePath,
    getDaemonTccIdentity,
  } = await import('../checks.js');
  const { loadDaemonPid, loadDaemonIdentity } = await import('../config.js');
  // `kraki doctor` must emit a single clean JSON line on stdout. The
  // multi-adapter logger (created at module load) defaults to info-level
  // stdout (dev) which would interleave pino lines into the output, so
  // force it silent before importing the module.
  const prevLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
  const { detectAvailableAgents } = await import('../adapters/multi.js');

  const config = loadConfig();
  const ghAuth = checkGhAuth();
  const copilot = checkCopilotCli();
  const claude = checkClaudeCli();
  const codex = checkCodexCli();
  const anthropic = checkAnthropicCreds();
  // doctor is a READ-ONLY status query (called frequently by the toolbar).
  // We do NOT mutate Launch Services here — only report current TCC identity
  // health so the UI can surface "re-grant needed". The actual registration
  // happens in `kraki permissions`, setup, the daemon start, and after updates.
  const tccBundled = getKrakiAppBundlePath() !== null;
  const fda = await probeFda();

  // SDK + CLI level "can actually start" detection (matches runtime).
  let available: string[] = [];
  try {
    available = await detectAvailableAgents();
  } catch { /* detection best-effort */ }
  if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLogLevel;

  const hasCopilotAuth = ghAuth.authenticated
    || !!process.env.GITHUB_TOKEN || !!process.env.GH_TOKEN || !!process.env.COPILOT_GITHUB_TOKEN;

  const result = {
    configExists: config !== null,
    daemonRunning: isDaemonRunning(),
    fda,
    // macOS TCC identity health. `tccRegistered=true` means permissions
    // granted in System Settings will survive future updates; false means
    // the user will be re-prompted after every release.
    tcc: {
      platform: process.platform,
      bundled: tccBundled,
      bundlePath: getKrakiAppBundlePath(),
      // Read-only hint: run `kraki permissions` to (re)register + clean.
      // We intentionally do NOT mutate LS from a status query.
      //
      // identity.healthy answers the question that actually predicts whether a
      // grant survives the next update: does the RUNNING daemon have a Launch
      // Services bundle identity? A bundled, registered, correctly signed app
      // still reports healthy:false when its daemon was started by absolute
      // path — that combination is what made this bug recur six times.
      identity: getDaemonTccIdentity(loadDaemonPid(), loadDaemonIdentity()),
    },
    ghAuth: ghAuth.authenticated,
    ghUser: ghAuth.username ?? null,
    // Legacy fields — kept so existing consumers keep working.
    copilotCli: copilot.found,
    copilotVersion: copilot.version ?? null,
    // Structured multi-agent view.
    agents: {
      codex: { cli: codex.found, version: codex.version ?? null },
      copilot: {
        cli: copilot.found,
        version: copilot.version ?? null,
        auth: hasCopilotAuth,
      },
      claude: {
        cli: claude.found,
        version: claude.version ?? null,
        creds: anthropic.configured,
        credsSource: anthropic.source,
      },
    },
    // Agents that can actually be started right now (SDK importable + CLI present).
    available,
    pinnedAgents: config?.agents ?? null,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── kraki relay-info — query relay capabilities ─────────

export async function cmdRelayInfo(args: string[]): Promise<void> {
  const url = args[1];
  if (!url) {
    process.stderr.write('error: relay URL is required\nusage: kraki relay-info <url>\n');
    gracefulExit(1);
    return;
  }
  if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    process.stderr.write('error: URL must start with wss:// or ws://\n');
    gracefulExit(1);
    return;
  }

  const { WebSocket } = await import('ws');

  const result = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timed out'));
    }, 5000);

    const ws = new WebSocket(url, wsProxyOptions(url));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth_info' }));
    });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_info_response') {
          clearTimeout(timer);
          ws.close();
          resolve(JSON.stringify({
            ok: true,
            methods: msg.methods ?? ['open'],
            githubClientId: msg.githubClientId ?? null,
          }));
        }
      } catch { /* ignore non-JSON */ }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  });

  process.stdout.write(result + '\n');
}
