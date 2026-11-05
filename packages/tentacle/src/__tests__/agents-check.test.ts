import { describe, it, expect, vi } from 'vitest';
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

import { checkAgentCli } from '../checks.js';

describe('a broken agent install (K-128)', () => {
  it('checkAgentCli tells "installed but --version fails" apart from "not installed"', async () => {
    if (process.platform === 'win32') return;
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const bin = mkdtempSync(join(tmpdir(), 'kraki-broken-agent-'));
    const script = join(bin, 'kraki-broken-agent');
    writeFileSync(script, '#!/bin/sh\necho "Error: Cannot find module \'/usr/lib/node_modules/agent/cli.js\'" >&2\nexit 1\n');
    chmodSync(script, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const broken = checkAgentCli('kraki-broken-agent');
      expect(broken).toMatchObject({ found: true, error: expect.stringContaining('Cannot find module') });
      expect(checkAgentCli('kraki-no-such-agent-k128')).toEqual({ found: false });
    } finally {
      process.env.PATH = path;
    }
  });

  it('reports an installed agent whose CLI does not run as an error, not as "not installed"', async () => {
    const claude = SETUP_AGENTS.find((a) => a.id === 'claude')!;
    const createAdapter = vi.fn();
    const r = await checkAgent(claude, {
      checkCli: () => ({ found: true, error: "Error: Cannot find module 'cli.js'" }), createAdapter, timeoutMs: 1000,
    });
    expect(r).toMatchObject({ status: 'error', detail: expect.stringContaining('Cannot find module'), hint: expect.stringContaining('installed but') });
    expect(r.status).not.toBe('not_installed');
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

import { runAgentsCheckChild } from '../agents-check.js';

describe('the agents check child times out for real (K-346)', () => {
  it('finishes when the child ignores SIGTERM and a grandchild keeps its stdout open', async () => {
    if (process.platform === 'win32') return;
    // The child ignores SIGTERM and leaves a grandchild holding the stdout
    // pipe: 'close' never fires on its own.
    const script = [
      "process.on('SIGTERM', () => {});",
      "require('node:child_process').spawn('sleep', ['5'], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const started = Date.now();
    const results = await runAgentsCheckChild(() => {}, 200, {
      killGraceMs: 200,
      command: { file: process.execPath, args: ['-e', script] },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results).toHaveLength(SETUP_AGENTS.length);
    expect(results.every((r) => r.status === 'error')).toBe(true);
  }, 10_000);
});
