/**
 * `kraki agents --json` — which coding agents on this machine can actually run
 * a Kraki session: installed, signed in, and able to list models.
 *
 * Used by Kraki for Mac's first-run setup ("Set up this Mac") before any
 * sign-in. Each agent is checked with the same adapter the daemon uses: start
 * it, ask for its models, stop it. Nothing is configured or written; Kraki only
 * relays, so an agent that is not ready is reported with a hint for the user to
 * fix it in that agent, never "fixed" by Kraki.
 *
 * NDJSON on stdout, one line per event, agents checked in parallel:
 *   {"event":"checking","id":"codex","name":"Codex"}
 *   {"event":"agent","id":"codex","name":"Codex","status":"ready","version":"0.157.1","models":7,"sampleModels":["gpt-6-luna",…]}
 *   {"event":"done","ready":["codex"]}
 *
 * status: ready | needs_login | not_installed | error
 */

import type { AgentId } from '@kraki/protocol';
import { SETUP_AGENTS, checkAgentCli } from './checks.js';
import { piHasShellOnWindows, GIT_FOR_WINDOWS_URL } from './windows-shell.js';
import type { AgentAdapter } from './adapters/base.js';

export type AgentCheckStatus = 'ready' | 'needs_login' | 'not_installed' | 'error';

export interface AgentCheckResult {
  id: AgentId;
  name: string;
  status: AgentCheckStatus;
  version?: string;
  models: number;
  sampleModels: string[];
  /** What the user can do about a non-ready agent (plain text). */
  hint?: string;
  installUrl: string;
  /** Underlying error, for logs/diagnostics. */
  detail?: string;
}

export type AgentsCheckEvent =
  | { event: 'checking'; id: AgentId; name: string }
  | ({ event: 'agent' } & AgentCheckResult)
  | { event: 'done'; ready: AgentId[] };

/** How to sign in to each agent (in that agent, not in Kraki). */
export const LOGIN_HINTS: Record<string, string> = {
  claude: 'Run `claude` in Terminal and sign in.',
  codex: 'Run `codex login` in Terminal.',
  copilot: 'Run `copilot` in Terminal and use /login.',
  pi: 'Run `pi` in Terminal and use /login, or add an API key.',
};

const LOGIN_ERROR = /log(ged)? ?in|login|auth|credential|api key|unauthori[sz]ed|401|403/i;

export interface AgentsCheckDeps {
  checkCli: (bin: string) => { found: boolean; version?: string };
  createAdapter: (id: AgentId) => Promise<AgentAdapter | null>;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  piHasShell?: () => boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function checkAgent(
  agent: (typeof SETUP_AGENTS)[number],
  deps: AgentsCheckDeps,
): Promise<AgentCheckResult> {
  const base = { id: agent.id as AgentId, name: agent.name, installUrl: agent.installUrl, models: 0, sampleModels: [] as string[] };
  const cli = deps.checkCli(agent.bin);
  if (!cli.found) {
    return { ...base, status: 'not_installed', hint: `Install ${agent.name}, then check again.` };
  }
  const version = cli.version;
  if (agent.id === 'pi' && (deps.platform ?? process.platform) === 'win32' && !(deps.piHasShell ?? piHasShellOnWindows)()) {
    return {
      ...base, version, status: 'error', detail: 'no_bash',
      hint: `Pi needs Git for Windows to run commands. Install it (${GIT_FOR_WINDOWS_URL}), then check again.`,
    };
  }
  let adapter: AgentAdapter | null = null;
  try {
    adapter = await deps.createAdapter(agent.id as AgentId);
    if (!adapter) return { ...base, version, status: 'not_installed', hint: `Install ${agent.name}, then check again.` };
    await withTimeout(adapter.start(), deps.timeoutMs, `${agent.name} start`);
    const models = await withTimeout(adapter.listModelDetails(), deps.timeoutMs, `${agent.name} model list`);
    const ids = models.map((m) => m.id);
    if (ids.length === 0) {
      const failure = adapter.modelListError?.();
      if (failure && !LOGIN_ERROR.test(failure)) throw new Error(failure);
      // Installed and running, but no model it can use: almost always a
      // missing sign-in or API key in that agent.
      return { ...base, version, status: 'needs_login', hint: LOGIN_HINTS[agent.id] };
    }
    return { ...base, version, status: 'ready', models: ids.length, sampleModels: ids.slice(0, 3) };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (LOGIN_ERROR.test(message)) {
      return { ...base, version, status: 'needs_login', hint: LOGIN_HINTS[agent.id], detail: message };
    }
    return { ...base, version, status: 'error', hint: `${agent.name} didn't start. Run it once in a terminal to check it works.`, detail: message };
  } finally {
    try { await adapter?.stop(); } catch { /* best effort */ }
  }
}

export async function runAgentsCheckWith(
  emit: (event: AgentsCheckEvent) => void,
  deps: AgentsCheckDeps,
  only?: string[],
): Promise<AgentCheckResult[]> {
  const agents = only?.length ? SETUP_AGENTS.filter((a) => only.includes(a.id)) : SETUP_AGENTS;
  for (const agent of agents) emit({ event: 'checking', id: agent.id as AgentId, name: agent.name });
  const results = await Promise.all(agents.map(async (agent) => {
    const result = await checkAgent(agent, deps);
    emit({ event: 'agent', ...result });
    return result;
  }));
  emit({ event: 'done', ready: results.filter((r) => r.status === 'ready').map((r) => r.id) });
  return results;
}

export async function runAgentsCheckJson(args: string[] = []): Promise<number> {
  // Spawned by the Mac app with LaunchServices' minimal environment: resolve
  // agents (nvm, homebrew, …) with the user's login-shell PATH, like the daemon.
  const { hydrateLoginShellEnv } = await import('./shell-env.js');
  hydrateLoginShellEnv();
  // Agents inherit our working directory and some scan it on start. Run from
  // an empty scratch folder so the check never touches the user's folders
  // (which would raise macOS Desktop/Documents/Downloads prompts before Full
  // Disk Access is granted).
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.chdir(mkdtempSync(join(tmpdir(), 'kraki-agents-')));
  const { createAgentAdapter } = await import('./adapters/multi.js');
  await runAgentsCheckWith(
    (event) => process.stdout.write(JSON.stringify(event) + '\n'),
    { checkCli: checkAgentCli, createAdapter: (id) => createAgentAdapter(id), timeoutMs: 45_000 },
    // `--only codex,pi`: check a subset (diagnostics).
    args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',') : undefined,
  );
  return 0;
}

/**
 * Run `kraki agents --json` as a child of this binary and collect the results.
 * Interactive setup uses this rather than starting adapters in its own
 * process: the check runs from a scratch folder (no cwd scanning of the
 * user's folders) and leaves no adapter handles behind in the setup process.
 */
export async function runAgentsCheckChild(
  onEvent: (event: AgentsCheckEvent) => void = () => {},
  timeoutMs = 90_000,
): Promise<AgentCheckResult[]> {
  const { spawn } = await import('node:child_process');
  const { isSea } = await import('node:sea');
  const args = isSea() ? ['agents', '--json'] : [process.argv[1], 'agents', '--json'];
  return new Promise((resolve) => {
    const results: AgentCheckResult[] = [];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'], env: process.env, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const event = JSON.parse(line) as AgentsCheckEvent;
          if (event.event === 'agent') {
            const { event: _e, ...result } = event;
            results.push(result);
          }
          onEvent(event);
        } catch { /* not an event line */ }
      }
    });
    // Agents the child never reported (timeout, crash) must not silently
    // vanish from the list or read as "not installed".
    const finish = () => {
      clearTimeout(timer);
      for (const agent of SETUP_AGENTS) {
        if (results.some((r) => r.id === agent.id)) continue;
        results.push({
          id: agent.id as AgentId, name: agent.name, installUrl: agent.installUrl, models: 0, sampleModels: [],
          status: 'error', hint: `Checking ${agent.name} took too long. Run \`kraki agents\` to try again.`,
        });
      }
      resolve(results);
    };
    child.on('close', finish);
    child.on('error', finish);
  });
}
