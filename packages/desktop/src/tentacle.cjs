// The Kraki built into Kraki for Windows: the same tentacle binary as the CLI
// (`kraki.exe`, shipped in resources\kraki), driven through its machine
// interfaces exactly like Kraki for Mac drives its helper:
//   kraki setup --json [--oauth]   first-time GitHub sign-in + relay + config
//   kraki agents --json            which coding agents can run here
//   kraki status --json            daemon / owner / relay state
// The app owns the daemon (managed-by.json, by "kraki-windows"): it starts it
// now and at every login (HKCU Run, through conhost --headless so no console
// appears), and a separately installed CLI then defers to it.
const { execFile, spawn } = require('node:child_process');
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

/** The PATH value in `reg query … /v Path` output (REG_EXPAND_SZ expanded), or ''. */
function parseRegistryPath(out) {
  const m = /\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(String(out ?? ''));
  return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : '';
}

/** Join PATH lists, dropping blanks and repeats (case-insensitive, trailing \ ignored). */
function mergePath(...lists) {
  const seen = new Set();
  return lists.join(';').split(';').map((p) => p.trim()).filter(Boolean)
    .filter((p) => { const k = p.toLowerCase().replace(/\\+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .join(';');
}

/**
 * PATH as a new process would get it now: this process's PATH plus whatever
 * the system and user PATH in the registry gained since the app started
 * (an agent, Node or Git installed while Kraki is open). Windows' version of
 * Kraki for Mac reading the login shell's environment.
 *
 * Read asynchronously and cached: `reg query` used to run synchronously for
 * every child process (each status poll), blocking the app's main process and
 * with it the window, which then missed or delayed clicks.
 */
const SYSTEM_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENV_KEY = 'HKCU\\Environment';
const pathCache = { registry: '', at: 0, pending: null };
const PATH_CACHE_MS = 15_000;

function refreshRegistryPath() {
  if (process.platform !== 'win32') return Promise.resolve();
  if (!pathCache.pending) {
    pathCache.pending = Promise.all([reg(['query', SYSTEM_ENV_KEY, '/v', 'Path']), reg(['query', USER_ENV_KEY, '/v', 'Path'])])
      .then(([system, user]) => { pathCache.registry = mergePath(parseRegistryPath(system), parseRegistryPath(user)); pathCache.at = Date.now(); })
      .finally(() => { pathCache.pending = null; });
  }
  return pathCache.pending;
}

function currentPath(own) {
  if (process.platform !== 'win32') return own;
  if (Date.now() - pathCache.at > PATH_CACHE_MS) void refreshRegistryPath();
  return mergePath(own, pathCache.registry);
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

function readFileSafe(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
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

  async checkAgents(onEvent) {
    if (this.available()) await refreshRegistryPath();
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
    // Cancel at once; the PATH refresh is async and must not let an old
    // setup run on.
    this.cancelSetup();
    const attempt = this.setupAttempt;
    return refreshRegistryPath().then(() => new Promise((resolve) => {
      if (attempt !== this.setupAttempt) { resolve({ ok: false, code: -1, detail: 'cancelled' }); return; }
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
    }));
  }

  cancelSetup() {
    this.setupAttempt = (this.setupAttempt ?? 0) + 1;
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
    // At sign-in the app starts in the tray and brings the service up
    // ("online ⇒ visible", as Kraki for Mac does from the menu bar).
    if (process.platform === 'win32') await this.setLoginItem(true);
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
  async setLoginItem(on) {
    if (process.platform !== 'win32') return;
    if (on) await reg(['add', RUN_KEY, '/v', APP_RUN_VALUE, '/t', 'REG_SZ', '/d', `"${this.appPath}" --login`, '/f']);
    else await reg(['delete', RUN_KEY, '/v', APP_RUN_VALUE, '/f']);
  }

  /**
   * Cheap local read for the tray (no child process): owner marker, the
   * daemon's status file and whether its process is alive.
   */
  quickState() {
    const home = krakiHome();
    const marker = readJson(path.join(home, 'managed-by.json'));
    const status = readJson(path.join(home, 'status.json'));
    const pid = Number(readFileSafe(path.join(home, 'daemon.pid'))) || status?.pid || null;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    const owned = marker?.by === OWNER;
    return {
      available: this.available(),
      owned,
      running: alive,
      relayState: alive ? status?.relayState ?? null : null,
      cliDaemon: alive && !owned,
      configured: existsSync(path.join(home, 'config.json')),
    };
  }

  async disable({ keepOwnership = false } = {}) {
    if (process.platform === 'win32') await this.setLoginItem(false);
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

module.exports = { BuiltInKraki, OWNER, currentPath, mergePath, parseRegistryPath };
