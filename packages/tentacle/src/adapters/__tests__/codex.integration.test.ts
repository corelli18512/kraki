/**
 * Live CodexAdapter test against the REAL `codex app-server`.
 *
 * Requires a logged-in Codex (`codex login` or OPENAI_API_KEY). Skips itself
 * when Codex is missing or unauthenticated. Uses throwaway temp dirs for the
 * Kraki sessions store and the working directory.
 *
 * Defaults to gpt-6-luna / low effort (override CODEX_TEST_MODEL / CODEX_TEST_EFFORT).
 * Run: CODEX_BIN=$(which codex) pnpm --filter @kraki/tentacle test:integration -- codex
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../codex.js';

function resolveCodex(): string | undefined {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  try { return execSync('which codex', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined; } catch { return undefined; }
}

const codexBin = resolveCodex();
// Keep live runs cheap: small model + low effort unless overridden.
const MODEL = process.env.CODEX_TEST_MODEL ?? 'gpt-6-luna';
const EFFORT = (process.env.CODEX_TEST_EFFORT ?? 'low') as 'low';
const cfg = () => ({ cwd: root, model: MODEL, reasoningEffort: EFFORT });
const root = mkdtempSync(join(tmpdir(), 'kraki-codex-live-'));
const adapter = codexBin ? new CodexAdapter({ cliPath: codexBin, sessionsDir: join(root, 'sessions') }) : null;
let ready = false;

beforeAll(async () => {
  if (!adapter) return;
  try { await adapter.start(); ready = true; } catch (err) {
    console.warn(`[codex live] skipped: ${(err as Error).message}`);
  }
});

afterAll(async () => {
  await adapter?.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function waitIdle(a: CodexAdapter, sid: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for idle')), timeoutMs);
    const prev = a.onIdle;
    a.onIdle = (s, e) => { prev?.(s, e); if (s === sid) { clearTimeout(t); a.onIdle = prev; resolve(); } };
  });
}

describe('CodexAdapter (live codex app-server)', () => {
  it('lists models', async (ctx) => {
    if (!ready) return ctx.skip();
    expect((await adapter!.listModelDetails()).length).toBeGreaterThan(0);
  });

  it('answers a prompt with a final message', async (ctx) => {
    if (!ready) return ctx.skip();
    const messages: string[] = [];
    adapter!.onMessage = (_s, e) => messages.push(e.content);
    const { sessionId } = await adapter!.createSession(cfg());
    adapter!.setSessionMode(sessionId, 'execute');
    const idle = waitIdle(adapter!, sessionId);
    await adapter!.sendMessage(sessionId, 'Reply with exactly the text KRAKI_CODEX_OK and nothing else. Do not run any tools.');
    await idle;
    expect(messages.join('\n')).toContain('KRAKI_CODEX_OK');
  });

  it('safe mode raises a permission card for a file write; deny keeps the file absent', async (ctx) => {
    if (!ready) return ctx.skip();
    const perms: string[] = [];
    const { sessionId } = await adapter!.createSession(cfg());
    adapter!.setSessionMode(sessionId, 'safe');
    adapter!.onPermissionRequest = (sid, e) => {
      perms.push(e.description);
      void adapter!.respondToPermission(sid, e.id, 'deny');
    };
    const idle = waitIdle(adapter!, sessionId);
    await adapter!.sendMessage(sessionId, `Create a file named kraki-live.txt in ${root} containing "hi". If you are denied, stop and say DENIED.`);
    await idle;
    expect(perms.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'kraki-live.txt'))).toBe(false);
  });

  it('ask_user dynamic tool round-trips an answer', async (ctx) => {
    if (!ready) return ctx.skip();
    const messages: string[] = [];
    const { sessionId } = await adapter!.createSession(cfg());
    adapter!.setSessionMode(sessionId, 'execute');
    adapter!.onMessage = (_s, e) => messages.push(e.content);
    adapter!.onQuestionRequest = (sid, e) => { void adapter!.respondToQuestion(sid, e.id, 'purple', true); };
    const idle = waitIdle(adapter!, sessionId);
    await adapter!.sendMessage(sessionId, 'Use the ask_user tool to ask me for my favourite colour, then reply with exactly: COLOUR=<answer>.');
    await idle;
    expect(messages.join('\n')).toContain('COLOUR=purple');
  });
});
