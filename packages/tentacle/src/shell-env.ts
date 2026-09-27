/**
 * Recover the user's login-shell environment for a launchd-started daemon.
 *
 * A job registered through SMAppService starts with launchd's minimal
 * environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin, no proxies, no version
 * manager shims). The agents Kraki drives — claude, codex, copilot, pi, gh,
 * node — are almost always installed somewhere only the user's shell profile
 * puts on PATH (Homebrew, nvm, volta, ~/.local/bin, …).
 *
 * The standalone CLI never had this problem because it copied the PATH of the
 * terminal that ran `kraki start` into its launchd plist. The Mac app's plist
 * is static and signed inside the bundle, so the daemon resolves the
 * environment itself at startup, the same way editors such as VS Code do: run
 * the user's shell as an interactive login shell once, print the environment
 * between markers, and merge it.
 *
 * Failure is never fatal: on timeout or a broken profile the daemon keeps the
 * launchd environment plus well-known tool directories.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const START = '__KRAKI_ENV_START__';
const END = '__KRAKI_ENV_END__';

/** Variables that describe the probe shell itself, not the user's setup. */
const IGNORED_KEYS = new Set([
  '_', 'PWD', 'OLDPWD', 'SHLVL', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT', 'RPROMPT',
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'COLORTERM',
  'ITERM_SESSION_ID', 'ITERM_PROFILE', 'TMUX', 'TMUX_PANE', 'STY', 'WINDOWID',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
  '__CFBundleIdentifier', 'XPC_SERVICE_NAME', 'XPC_FLAGS', 'LaunchInstanceID',
  'KRAKI_MANAGED_BY', 'KRAKI_HOME', 'NODE_ENV', 'LOG_LEVEL',
]);

/** Directories added even when the shell probe fails. */
export function wellKnownToolDirs(home = homedir()): string[] {
  return [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/opt/local/bin',
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

/** Parse NUL-separated `env -0` output found between the markers. */
export function parseMarkedEnv(output: string): Record<string, string> | null {
  const start = output.indexOf(START);
  const end = output.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return null;
  const body = output.slice(start + START.length, end);
  const env: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    const trimmed = entry.replace(/^\n+/, '');
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = trimmed.slice(eq + 1);
  }
  return env;
}

export function mergePath(...paths: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    for (const dir of (p ?? '').split(':')) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(':');
}

function resolveUserShell(env: NodeJS.ProcessEnv): string {
  const candidates = [env.SHELL];
  try { candidates.push(userInfo().shell ?? undefined); } catch { /* ignore */ }
  candidates.push('/bin/zsh', '/bin/bash');
  for (const c of candidates) {
    if (c && c.startsWith('/') && existsSync(c)) return c;
  }
  return '/bin/zsh';
}

export interface ShellEnvResult {
  source: 'shell' | 'fallback';
  shell: string;
  addedKeys: string[];
  error?: string;
}

/**
 * Merge the login-shell environment into `env` (mutated in place).
 *
 * Existing values win, except PATH, which becomes shell PATH + existing PATH +
 * well-known tool directories, de-duplicated in that order.
 */
export function hydrateLoginShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { timeoutMs?: number; run?: typeof spawnSync } = {},
): ShellEnvResult {
  const shell = resolveUserShell(env);
  const run = opts.run ?? spawnSync;
  let shellEnv: Record<string, string> | null = null;
  let error: string | undefined;

  try {
    // `-i -l`: many users configure PATH in .zshrc/.bashrc, which only an
    // interactive shell reads. stdin is closed so a profile that prompts
    // cannot block; the timeout bounds a profile that hangs anyway. The
    // script is valid in sh-compatible shells and fish alike.
    const script = `printf '%s' '${START}'; command env -0; printf '%s' '${END}'`;
    const result = run(shell, ['-i', '-l', '-c', script], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, HOME: env.HOME ?? homedir(), TERM: 'dumb' },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) {
      error = result.error.message;
    } else {
      shellEnv = parseMarkedEnv(String(result.stdout ?? ''));
      if (!shellEnv) error = `shell exited ${result.status ?? 'null'} without environment markers`;
    }
  } catch (err) {
    error = (err as Error).message;
  }

  const addedKeys: string[] = [];
  if (shellEnv) {
    for (const [key, value] of Object.entries(shellEnv)) {
      if (IGNORED_KEYS.has(key) || key === 'PATH') continue;
      if (env[key] !== undefined) continue;
      env[key] = value;
      addedKeys.push(key);
    }
  }
  env.PATH = mergePath(shellEnv?.PATH, env.PATH, wellKnownToolDirs(env.HOME ?? homedir()).join(':'));
  if (!env.SHELL) env.SHELL = shell;

  return { source: shellEnv ? 'shell' : 'fallback', shell, addedKeys, ...(error && { error }) };
}
