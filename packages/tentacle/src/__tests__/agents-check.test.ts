import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAdapter } from '../adapters/pi.js';
import type { AgentId } from '@kraki/protocol';
import { runAgentsCheckWith, type AgentsCheckEvent, type AgentsCheckDeps } from '../agents-check.js';
import type { AgentAdapter } from '../adapters/base.js';

function fakeAdapter(opts: { start?: () => Promise<void>; models?: string[]; listError?: string }): AgentAdapter & { stopped: boolean } {
  const a = {
    stopped: false,
    modelListError: () => opts.listError,
    start: opts.start ?? (async () => {}),
    listModelDetails: async () => (opts.models ?? []).map((id) => ({ id, name: id })),
    stop: async () => { a.stopped = true; },
  };
  return a as unknown as AgentAdapter & { stopped: boolean };
}

async function run(installed: string[], adapters: Partial<Record<AgentId, ReturnType<typeof fakeAdapter>>>, timeoutMs = 1000) {
  const events: AgentsCheckEvent[] = [];
  const deps: AgentsCheckDeps = {
    checkCli: (bin) => installed.includes(bin) ? { found: true, version: '1.2.3' } : { found: false },
    createAdapter: vi.fn(async (id: AgentId) => adapters[id] ?? null),
    timeoutMs,
  };
  const results = await runAgentsCheckWith((e) => events.push(e), deps);
  return { events, results, deps };
}

describe('kraki agents --json', () => {
  it('reports each of the four agents: ready, needs sign-in, not installed', async () => {
    const codex = fakeAdapter({ models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.5'] });
    const claude = fakeAdapter({ start: async () => { throw new Error('Claude Code is not logged in. Run `claude`…'); } });
    const pi = fakeAdapter({ models: [] });
    const { events, results } = await run(['codex', 'claude', 'pi'], { codex, claude, pi });

    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.codex).toMatchObject({ status: 'ready', models: 4, sampleModels: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'], version: '1.2.3' });
    expect(byId.claude).toMatchObject({ status: 'needs_login', hint: expect.stringContaining('claude') });
    expect(byId.pi).toMatchObject({ status: 'needs_login', hint: expect.stringContaining('/login') });
    expect(byId.copilot).toMatchObject({ status: 'not_installed', installUrl: expect.stringContaining('github.com') });

    expect(events.filter((e) => e.event === 'checking')).toHaveLength(4);
    expect(events.at(-1)).toEqual({ event: 'done', ready: ['codex'] });
    // Every started adapter is stopped again: the check leaves nothing running.
    expect(codex.stopped && claude.stopped && pi.stopped).toBe(true);
  });

  it('never creates an adapter for an agent that is not installed', async () => {
    const { deps } = await run([], {});
    expect(deps.createAdapter).not.toHaveBeenCalled();
  });

  it('reports a hung agent as an error instead of blocking setup', async () => {
    const stuck = fakeAdapter({ start: () => new Promise<void>(() => {}) });
    const { results } = await run(['copilot'], { copilot: stuck }, 20);
    expect(results.find((r) => r.id === 'copilot')).toMatchObject({ status: 'error', detail: expect.stringContaining('timed out') });
    expect(stuck.stopped).toBe(true);
  });

  it('reports an agent that cannot even be launched as an error, not as signed out', async () => {
    const pi = fakeAdapter({ models: [], listError: 'spawn EINVAL' });
    const { results } = await run(['pi'], { pi });
    expect(results.find((r) => r.id === 'pi')).toMatchObject({ status: 'error', detail: 'spawn EINVAL' });
  });

  it('K-132: a signed-out Pi (empty model list, retried in the background) still reads as needs_login, not "didn\'t start"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-agents-check-pi-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    const cli = join(dir, 'pi');
    writeFileSync(cli, `#!/usr/bin/env node
      if (process.argv.includes('--list-models')) console.log('No models available. Use /login or set an API key environment variable.');
    `, 'utf8');
    chmodSync(cli, 0o755);
    try {
      const pi = new PiAdapter({ cliPath: cli, modelListRetryDelaysMs: [60_000] });
      const { results } = await run(['pi'], { pi: pi as unknown as ReturnType<typeof fakeAdapter> }, 10_000);
      expect(results.find((r) => r.id === 'pi')).toMatchObject({ status: 'needs_login', hint: expect.stringContaining('/login') });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { piHasShellOnWindows } from '../windows-shell.js';

describe('Pi on Windows needs a bash', () => {
  const deps = (o: Partial<Parameters<typeof piHasShellOnWindows>[0]>) => ({
    env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false, piSettings: () => undefined, whereBash: () => [], ...o,
  });
  it('finds Git Bash, a configured shellPath, or bash on PATH', () => {
    expect(piHasShellOnWindows(deps({}))).toBe(false);
    expect(piHasShellOnWindows(deps({ exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe' }))).toBe(true);
    expect(piHasShellOnWindows(deps({ piSettings: () => '{"shellPath":"D:/msys/bash.exe"}', exists: (p) => p === 'D:/msys/bash.exe' }))).toBe(true);
    expect(piHasShellOnWindows(deps({ whereBash: () => ['C:\\cygwin\\bin\\bash.exe'], exists: (p) => p.startsWith('C:\\cygwin') }))).toBe(true);
  });
});

import { checkAgent } from '../agents-check.js';
import { SETUP_AGENTS } from '../checks.js';

describe('kraki agents on Windows without bash', () => {
  it('reports Pi as needing Git for Windows instead of ready', async () => {
    const pi = SETUP_AGENTS.find((a) => a.id === 'pi')!;
    const createAdapter = vi.fn();
    const r = await checkAgent(pi, {
      checkCli: () => ({ found: true, version: '0.87.1' }), createAdapter, timeoutMs: 1000,
      platform: 'win32', piHasShell: () => false,
    });
    expect(r).toMatchObject({ status: 'error', detail: 'no_bash', hint: expect.stringContaining('Git for Windows') });
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
