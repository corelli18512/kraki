// The Kraki built into Kraki for Windows: the same tentacle binary as the CLI
// (`kraki.exe`, shipped in resources\kraki), driven through its machine
// interfaces exactly like Kraki for Mac drives its helper:
//   kraki setup --json [--oauth]   first-time GitHub sign-in + relay + config
//   kraki agents --json            which coding agents can run here
//   kraki status --json            daemon / owner / relay state
// The app owns the daemon (managed-by.json, by "kraki-windows"): it starts it
// now and at every login (HKCU Run, through conhost --headless so no console
// appears), and a separately installed CLI then defers to it.
const { execFile, execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNER = 'kraki-windows';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** The CLI's own login entry (packages/tentacle/src/windows-autostart.ts). */
const CLI_RUN_VALUE = 'Kraki';
const APP_RUN_VALUE = 'Kraki Background';

function krakiHome() {
  return process.env.KRAKI_HOME || path.join(os.homedir(), '.kraki');
}

/** The bundled binary (packaged), or an override for development. */
function binaryPath(resourcesPath) {
  if (process.env.KRAKI_DESKTOP_TENTACLE) return process.env.KRAKI_DESKTOP_TENTACLE;
  const exe = process.platform === 'win32' ? 'kraki.exe' : 'kraki';
  return path.join(resourcesPath, 'kraki', exe);
}

/** One PATH value from the registry (REG_EXPAND_SZ expanded), or ''. */
function registryPath(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = /\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : '';
  } catch {
    return '';
  }
}

/**
 * PATH as a new process would get it now: this process's PATH plus whatever
 * the system and user PATH in the registry gained since the app started
 * (an agent, Node or Git installed while Kraki is open). Windows' version of
 * Kraki for Mac reading the login shell's environment.
 */
function currentPath(own) {
  if (process.platform !== 'win32') return own;
  const parts = [own,
    registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    registryPath('HKCU\\Environment')].join(';').split(';').map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  return parts.filter((p) => { const k = p.toLowerCase().replace(/\\+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; }).join(';');
}

/** Environment for every tentacle child: never inherit a supervisor's marks. */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.KRAKI_SUPERVISED;
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const value = currentPath(env[pathKey] ?? '');
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.Path = value;
  return env;
}

function runJson(bin, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: childEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
      const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
      try { resolve(line ? JSON.parse(line) : { ok: false, error: err?.message ?? 'no output' }); } catch {
        resolve({ ok: false, error: err?.message ?? 'bad output' });
      }
    });
  });
}

/** Run an NDJSON command, forwarding each event; returns the child. */
function streamNdjson(bin, args, onEvent, onExit) {
  const child = spawn(bin, args, { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* not an event */ }
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
  child.on('error', (err) => onExit(-1, err.message));
  child.on('close', (code) => onExit(code ?? -1, stderr));
  return child;
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

class BuiltInKraki {
  /** @param {{ resourcesPath: string, appPath: string, appVersion: string }} opts */
  constructor(opts) {
    this.bin = binaryPath(opts.resourcesPath);
    this.appPath = opts.appPath;
    this.appVersion = opts.appVersion;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.setupChild = null;
  }

  available() { return existsSync(this.bin); }

  home() { return krakiHome(); }

  marker() {
    const m = readJson(path.join(krakiHome(), 'managed-by.json'));
    return m && m.by === OWNER ? m : null;
  }

  /** Everything the onboarding / Settings → This PC need, in one call. */
  async state() {
    const home = krakiHome();
    const config = readJson(path.join(home, 'config.json'));
    const status = this.available() ? await runJson(this.bin, ['status', '--json']) : null;
    const cliLogin = process.platform === 'win32'
      ? !!(await reg(['query', RUN_KEY, '/v', CLI_RUN_VALUE]))
      : false;
    const daemon = status?.daemon ?? {};
    const owned = !!this.marker();
    return {
      available: this.available(),
      binary: this.bin,
      home,
      version: status?.version ?? null,
      configured: !!config,
      signedIn: existsSync(path.join(home, 'github-token')),
      deviceName: config?.device?.name ?? os.hostname(),
      deviceId: config?.device?.id ?? null,
      relay: config?.relay ?? null,
      owned,
      running: !!daemon.running,
      relayState: daemon.relayState ?? null,
      pid: daemon.pid ?? null,
      // A daemon this app does not own: the standalone CLI.
      cliDaemon: !!daemon.running && !owned,
      cliLogin,
    };
  }

  /** Credentials the app itself signs in with (same account as the daemon). */
  credentials() {
    const home = krakiHome();
    const config = readJson(path.join(home, 'config.json'));
    let token = null;
    try { token = readFileSync(path.join(home, 'github-token'), 'utf8').trim() || null; } catch { /* none */ }
    if (!config?.relay) return null;
    // A self-hosted relay without accounts (`--auth open`) needs no token.
    if (config.authMethod === 'open') return { relay: config.relay, token: null };
    return token ? { relay: config.relay, token } : null;
  }

  /** A pairing link for a phone (`kraki connect --json`), as Kraki for Mac does. */
  async connectPhone() {
    if (!this.available()) return { ok: false, error: 'not_available' };
    return runJson(this.bin, ['connect', '--json'], 30_000);
  }

  checkAgents(onEvent) {
    return new Promise((resolve) => {
      if (!this.available()) { resolve({ ok: false }); return; }
      streamNdjson(this.bin, ['agents', '--json'], onEvent, (code) => resolve({ ok: code === 0 }));
    });
  }

  /**
   * First-time setup. `openSignIn(url)` must resolve with the
   * kraki://auth/callback?… URL (or null when the user closed it).
   */
  setup({ deviceName, forceLogin, onEvent, openSignIn }) {
    return new Promise((resolve) => {
      this.cancelSetup();
      const args = ['setup', '--json', '--oauth'];
      if (deviceName) args.push('--device-name', deviceName);
      if (forceLogin) args.push('--force-login');
      let done = null;
      const child = streamNdjson(this.bin, args, async (event) => {
        onEvent(event);
        if (event.event === 'done') done = event;
        if (event.event === 'oauth_url') {
          const callback = await openSignIn(event.url);
          if (callback && child.stdin.writable) child.stdin.write(`${callback}\n`);
          else child.kill();
        }
      }, (code, stderr) => {
        if (this.setupChild === child) this.setupChild = null;
        resolve(done ? { ok: true, ...done } : { ok: false, code, detail: stderr.slice(-400) });
      });
      this.setupChild = child;
    });
  }

  cancelSetup() {
    if (this.setupChild) { try { this.setupChild.kill(); } catch { /* gone */ } this.setupChild = null; }
  }

  daemonCommand() {
    return [this.bin, '__daemon-worker', `--managed-by=${OWNER}`];
  }

  /** Take ownership and run the daemon now and at every login. */
  async enable() {
    if (!this.available()) throw new Error('The built-in Kraki is missing from this installation.');
    const home = krakiHome();
    mkdirSync(home, { recursive: true });
    // A standalone CLI daemon must stop first: one device id, one daemon.
    const before = await this.state();
    if (before.cliDaemon) await runJson(this.bin, ['stop']).catch(() => null);
    if (process.platform === 'win32') await reg(['delete', RUN_KEY, '/v', CLI_RUN_VALUE, '/f']);
    writeFileSync(path.join(home, 'managed-by.json'), JSON.stringify({
      by: OWNER, label: OWNER, appPath: this.appPath, appVersion: this.appVersion, updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
    if (process.platform === 'win32') {
      const [exe, ...rest] = this.daemonCommand();
      await reg(['add', RUN_KEY, '/v', APP_RUN_VALUE, '/t', 'REG_SZ', '/d', `conhost.exe --headless "${exe}" ${rest.join(' ')}`, '/f']);
    }
    await this.start();
  }

  /** Start the daemon if it is not running (it outlives the app). */
  async start() {
    const s = await this.state();
    if (s.running && s.owned) return;
    const [exe, ...args] = this.daemonCommand();
    const child = spawn(exe, args, {
      env: childEnv({ KRAKI_MANAGED_BY: OWNER }),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await this.state();
      if (now.running) return;
    }
    throw new Error('Kraki did not start. See the logs in ' + path.join(krakiHome(), 'logs'));
  }

  /** Stop for good: the supervisor (not just the worker) and the login entry. */
  async disable({ keepOwnership = false } = {}) {
    if (process.platform === 'win32') await reg(['delete', RUN_KEY, '/v', APP_RUN_VALUE, '/f']);
    const status = readJson(path.join(krakiHome(), 'status.json'));
    const pids = [status?.supervisorPid, status?.pid].filter((p) => Number.isInteger(p) && p > 0);
    for (const pid of pids) {
      await new Promise((r) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));
    }
    if (!keepOwnership) rmSync(path.join(krakiHome(), 'managed-by.json'), { force: true });
  }

  /** Restart after an agent was installed or an app update. */
  async restart() {
    await this.disable({ keepOwnership: true });
    await this.start();
  }
}

module.exports = { BuiltInKraki, OWNER, currentPath };
