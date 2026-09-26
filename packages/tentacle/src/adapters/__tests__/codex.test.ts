/**
 * CodexAdapter against a real child process speaking the codex app-server
 * stdio protocol (fixtures/fake-codex-app-server.mjs, shapes captured from
 * codex-cli 0.157.1). Covers session lifecycle, streaming, Kraki permission
 * modes, dynamic tools (ask_user / show_image / kraki_get_mode), turn
 * boundaries (fail / interrupt / steer / queue), resume and crash recovery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, codexShouldAutoApprove, mapCodexModels, unwrapShellCommand } from '../codex.js';
import { AttachmentStore } from '../../attachment-store.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-app-server.mjs');
// 1×1 transparent PNG
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

type Ev = { type: string; sid?: string; [k: string]: unknown };

class Harness {
  events: Ev[] = [];
  adapter: CodexAdapter;
  constructor(readonly dir: string, env: Record<string, string> = {}, attachmentStore?: AttachmentStore) {
    this.adapter = new CodexAdapter({
      cliPath: process.execPath,
      cliArgs: [FAKE],
      sessionsDir: join(dir, 'sessions'),
      attachmentStore,
      env: { ...process.env, FAKE_CODEX_LOG: join(dir, 'wire.jsonl'), ...env },
      requestTimeoutMs: 5000,
    });
    const a = this.adapter;
    const push = (type: string) => (sid: string, e?: unknown) => this.events.push({ type, sid, ...(e as object) });
    a.onSessionCreated = (e) => this.events.push({ type: 'created', ...e });
    a.onMessage = push('message');
    a.onMessageDelta = push('delta');
    a.onNarration = push('narration');
    a.onNarrationTrace = push('narration_trace');
    a.onPermissionRequest = push('permission');
    a.onPermissionAutoResolved = (sid, id, resolution) => this.events.push({ type: 'perm_auto', sid, id, resolution });
    a.onQuestionRequest = push('question');
    a.onQuestionAutoResolved = (sid, id) => this.events.push({ type: 'q_auto', sid, id });
    a.onToolStart = push('tool_start');
    a.onToolComplete = push('tool_complete');
    a.onAttachmentBytes = push('attachment_bytes');
    a.onIdle = push('idle');
    a.onError = push('error');
    a.onCompaction = push('compaction');
    a.onTitleChanged = (sid, title) => this.events.push({ type: 'title', sid, title });
    a.onUsageUpdate = (sid, usage) => this.events.push({ type: 'usage', sid, usage });
    a.onSessionEnded = push('ended');
  }
  of(type: string): Ev[] { return this.events.filter((e) => e.type === type); }
  async waitFor(pred: (e: Ev) => boolean, label = 'event', timeoutMs = 4000): Promise<Ev> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}; got ${this.events.map((e) => e.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async idleCount(n: number): Promise<void> {
    await this.waitFor(() => this.of('idle').length >= n, `${n} idle`);
  }
  wire(): Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }> {
    const p = join(this.dir, 'wire.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  sent(method: string) { return this.wire().filter((m) => m.method === method); }
  /** Client responses to server requests (no method, has result). */
  replies() { return this.wire().filter((m) => !m.method && m.result); }
}

let dir: string;
let h: Harness;
const extra: Harness[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kraki-codex-'));
});

afterEach(async () => {
  for (const x of [h, ...extra.splice(0)]) await x?.adapter.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function started(env: Record<string, string> = {}, store?: AttachmentStore): Promise<Harness> {
  h = new Harness(dir, env, store);
  await h.adapter.start();
  return h;
}

async function session(mode?: 'safe' | 'discuss' | 'execute' | 'delegate'): Promise<string> {
  const { sessionId } = await h.adapter.createSession({ cwd: '/repo', model: 'gpt-6-astra', reasoningEffort: 'high' });
  if (mode) h.adapter.setSessionMode(sessionId, mode);
  return sessionId;
}

async function settled(sid: string): Promise<void> {
  const end = Date.now() + 4000;
  while (!h.adapter.isTurnSettled(sid)) {
    if (Date.now() > end) throw new Error('turn never settled');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function turn(sid: string, text: string, turnId: string, delivery?: 'prompt' | 'steer' | 'follow_up') {
  h.adapter.setTurnIdentity(sid, turnId);
  await h.adapter.sendMessage(sid, text, undefined, delivery ? { delivery } : undefined);
}

describe('pure helpers', () => {
  it('permission policy mirrors Kraki modes', () => {
    expect(codexShouldAutoApprove('execute', 'write', ['/a'])).toBe(true);
    expect(codexShouldAutoApprove('delegate', 'shell', [])).toBe(true);
    expect(codexShouldAutoApprove('discuss', 'shell', [])).toBe(true);
    expect(codexShouldAutoApprove('discuss', 'write', ['/r/src/a.ts'])).toBe(false);
    expect(codexShouldAutoApprove('discuss', 'write', ['/r/plan.md'])).toBe(true);
    expect(codexShouldAutoApprove('discuss', 'write', ['/r/plan.md', '/r/x.ts'])).toBe(false);
    expect(codexShouldAutoApprove('discuss', 'write', [])).toBe(false);
    expect(codexShouldAutoApprove('safe', 'shell', [])).toBe(false);
  });

  it('unwraps Codex login-shell wrappers only when exact', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'python3 test_stats.py'")).toBe('python3 test_stats.py');
    expect(unwrapShellCommand(`/bin/zsh -lc "sed -n '1,240p' stats.py && ls"`)).toBe("sed -n '1,240p' stats.py && ls");
    expect(unwrapShellCommand("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShellCommand('/bin/bash -c "echo \\"x\\""')).toBe('echo "x"');
    // Not a single quoted argument → untouched.
    expect(unwrapShellCommand("/bin/zsh -lc 'a' 'b'")).toBe("/bin/zsh -lc 'a' 'b'");
    expect(unwrapShellCommand('rm -rf build')).toBe('rm -rf build');
  });

  it('maps models, dropping hidden models and non-Kraki efforts', () => {
    const models = mapCodexModels([
      { id: 'm', displayName: 'M', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
      { id: 'h', hidden: true, supportedReasoningEfforts: [] },
    ]);
    expect(models).toEqual([{ id: 'm', name: 'M', supportsReasoningEffort: true, supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' }]);
  });
});

describe('CodexAdapter (fake app-server child process)', () => {
  it('handshakes with experimentalApi and lists models', async () => {
    await started();
    const init = h.sent('initialize')[0];
    expect(init.params).toMatchObject({ clientInfo: { name: 'kraki' }, capabilities: { experimentalApi: true } });
    expect(h.sent('initialized')).toHaveLength(1);
    expect(await h.adapter.listModelDetails()).toEqual([{
      id: 'gpt-6-astra', name: 'GPT-6-Astra', supportsReasoningEffort: true,
      supportedReasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high',
    }]);
  });

  it('refuses to start when Codex is not logged in', async () => {
    h = new Harness(dir, { FAKE_CODEX_LOGGED_OUT: '1' });
    await expect(h.adapter.start()).rejects.toThrow(/codex login/);
  });

  it('creates a thread with Kraki gating + dynamic tools and streams a turn', async () => {
    await started();
    const sid = await session();
    expect(h.of('created')[0]).toMatchObject({ sessionId: sid, agent: 'codex', model: 'gpt-6-astra' });
    const start = h.sent('thread/start')[0].params!;
    expect(start).toMatchObject({ cwd: '/repo', model: 'gpt-6-astra', approvalPolicy: 'untrusted' });
    expect(start.sandbox).toBeUndefined(); // the user's own sandbox config applies
    expect((start.dynamicTools as Array<{ name: string }>).map((t) => t.name)).toEqual(['ask_user', 'show_image', 'kraki_get_mode']);
    expect(String(start.developerInstructions)).toContain('Kraki');

    await turn(sid, 'hello there', 'rt-1');
    await h.idleCount(1);
    expect(h.sent('turn/start')[0].params).toMatchObject({ effort: 'high', model: 'gpt-6-astra', approvalPolicy: 'untrusted' });
    expect(h.of('delta').map((e) => e.content).join('')).toBe('echo: hello there');
    expect(h.of('message')).toEqual([{ type: 'message', sid, content: 'echo: hello there', turnId: 'rt-1' }]);
    expect(h.of('idle')[0]).toMatchObject({ sid, turnId: 'rt-1' });
    expect(h.of('title')[0]).toMatchObject({ title: 'Echo test' });
    expect(h.of('usage').at(-1)!.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, contextTokens: 100, totalDurationMs: 1234 });
    expect(h.adapter.isTurnSettled(sid)).toBe(true);
  });

  it('discuss mode auto-approves shell and graduates prose before a tool to narration', async () => {
    await started();
    const sid = await session('discuss');
    await turn(sid, 'SHELL', 'rt-1');
    await h.idleCount(1);
    expect(h.of('permission')).toHaveLength(0);
    expect(h.replies().some((r) => r.result!.decision === 'accept')).toBe(true);
    const order = h.events.filter((e) => ['narration', 'tool_start', 'tool_complete', 'message'].includes(e.type)).map((e) => e.type);
    expect(order).toEqual(['narration', 'tool_start', 'tool_complete', 'message']);
    expect(h.of('narration')[0].content).toBe('Let me clean the build.');
    expect(h.of('tool_start')[0]).toMatchObject({ toolName: 'shell', args: { command: 'rm -rf build', cwd: '/tmp' } });
    expect(h.of('tool_complete')[0]).toMatchObject({ toolName: 'shell', result: 'removed', success: true });
    expect(h.of('message')[0].content).toBe('shell decision: accept');
  });

  it('safe mode raises a shell permission card; deny declines', async () => {
    await started();
    const sid = await session('safe');
    await turn(sid, 'SHELL', 'rt-1');
    const perm = await h.waitFor((e) => e.type === 'permission', 'permission');
    expect(perm).toMatchObject({ toolArgs: { toolName: 'shell', args: { command: 'rm -rf build' } }, description: 'Run: rm -rf build', turnId: 'rt-1' });
    await h.adapter.respondToPermission(sid, perm.id as string, 'deny');
    await h.idleCount(1);
    expect(h.of('message')[0].content).toBe('shell decision: decline');
    expect(h.of('tool_complete')[0]).toMatchObject({ success: false });
  });

  it('always_allow grants the tool kind for later calls; switching to safe revokes it', async () => {
    await started();
    const sid = await session('safe');
    await turn(sid, 'SHELL', 'rt-1');
    const perm = await h.waitFor((e) => e.type === 'permission', 'permission');
    await h.adapter.respondToPermission(sid, perm.id as string, 'always_allow');
    await h.idleCount(1);
    await turn(sid, 'SHELL again', 'rt-2');
    await h.idleCount(2);
    expect(h.of('permission')).toHaveLength(1);
    expect(h.of('message')[1].content).toBe('shell decision: accept');

    h.adapter.setSessionMode(sid, 'discuss');
    h.adapter.setSessionMode(sid, 'safe');
    await turn(sid, 'SHELL third', 'rt-3');
    await h.waitFor(() => h.of('permission').length === 2, 'second permission');
  });

  it('blocks tentacle self-management commands even in execute mode', async () => {
    await started();
    const sid = await session('execute');
    await turn(sid, 'SHELL KRAKISTOP', 'rt-1');
    await h.idleCount(1);
    expect(h.of('permission')).toHaveLength(0);
    expect(h.of('message')[0].content).toBe('shell decision: decline');
  });

  it('discuss mode gates file edits except plan.md', async () => {
    await started();
    const sid = await session('discuss');
    await turn(sid, 'WRITE', 'rt-1');
    const perm = await h.waitFor((e) => e.type === 'permission', 'permission');
    expect(perm).toMatchObject({ toolArgs: { toolName: 'write_file', args: { path: '/repo/src/app.ts' } } });
    expect(String(perm.description)).toContain('/repo/src/app.ts');
    expect(h.of('tool_start')[0]).toMatchObject({ toolName: 'edit', args: { path: '/repo/src/app.ts' } });
    await h.adapter.respondToPermission(sid, perm.id as string, 'approve');
    await h.idleCount(1);
    expect(h.of('message')[0].content).toBe('write decision: accept');

    await turn(sid, 'WRITE PLAN', 'rt-2');
    await h.idleCount(2);
    expect(h.of('permission')).toHaveLength(1);
    expect(h.of('message')[1].content).toBe('write decision: accept');
  });

  it('ask_user dynamic tool becomes a question card and returns the answer', async () => {
    await started();
    const sid = await session('execute');
    await turn(sid, 'ASK', 'rt-1');
    const q = await h.waitFor((e) => e.type === 'question', 'question');
    expect(q).toMatchObject({ question: 'Which DB?', choices: ['sqlite', 'postgres'], turnId: 'rt-1' });
    expect(h.of('narration')[0].content).toBe('I need to check something.');
    expect(await h.adapter.respondToQuestion(sid, 'nope', 'x', false)).toBe('not_found');
    expect(await h.adapter.respondToQuestion(sid, q.id as string, 'postgres', false)).toBe('accepted');
    await h.idleCount(1);
    expect(h.of('message')[0].content).toBe('answer: postgres');
    // Kraki's own tools never render as generic tool cards.
    expect(h.of('tool_start')).toHaveLength(0);
  });

  it('delegate mode auto-answers ask_user', async () => {
    await started();
    const sid = await session('delegate');
    await turn(sid, 'ASK', 'rt-1');
    await h.idleCount(1);
    expect(h.of('question')).toHaveLength(0);
    expect(h.of('message')[0].content).toBe('answer: proceed with your best judgment');
  });

  it('kraki_get_mode reports the live mode and mode changes are signalled once', async () => {
    await started();
    const sid = await session();
    h.adapter.setSessionMode(sid, 'execute');
    await turn(sid, 'MODE', 'rt-1');
    await h.idleCount(1);
    expect(h.of('message')[0].content).toBe('mode: execute');
    await turn(sid, 'plain', 'rt-2');
    await h.idleCount(2);
    const texts = h.sent('turn/start').map((m) => (m.params!.input as Array<{ text: string }>)[0].text);
    expect(texts[0]).toBe('[kraki: mode changed to execute]\n\nMODE');
    expect(texts[1]).toBe('plain');
  });

  it('native request_user_input questions are asked one card at a time', async () => {
    await started();
    const sid = await session('execute');
    await turn(sid, 'NATIVEQ', 'rt-1');
    const q1 = await h.waitFor((e) => e.type === 'question', 'q1');
    expect(q1).toMatchObject({ question: 'Language?', choices: ['TS', 'Rust'] });
    await h.adapter.respondToQuestion(sid, q1.id as string, 'Rust', false);
    const q2 = await h.waitFor(() => h.of('question').length === 2, 'q2').then(() => h.of('question')[1]);
    expect(q2.question).toBe('Project name?');
    expect(q2.choices).toBeUndefined();
    await h.adapter.respondToQuestion(sid, q2.id as string, { text: 'kraken' }, true);
    await h.idleCount(1);
    expect(h.of('message')[0].content).toBe('native: {"q1":{"answers":["Rust"]},"q2":{"answers":["kraken"]}}');
  });

  it('show_image stores the image and broadcasts its bytes', async () => {
    const store = new AttachmentStore(join(dir, 'sessions'));
    await started({}, store);
    const sid = await session('execute');
    const png = join(dir, 'chart.png');
    writeFileSync(png, PNG_1PX);
    await turn(sid, `IMAGE:${png}`, 'rt-1');
    await h.idleCount(1);
    expect(h.of('tool_start')[0]).toMatchObject({ toolName: 'show_image', args: { path: png } });
    const done = h.of('tool_complete')[0];
    expect(done).toMatchObject({ toolName: 'show_image', success: true });
    const refs = done.attachments as Array<{ type: string; id: string; caption?: string }>;
    expect(refs[0]).toMatchObject({ type: 'content_ref', caption: 'chart' });
    expect(store.has(sid, refs[0].id)).toBe(true);
    expect(h.of('attachment_bytes')).toHaveLength(1);
    expect(h.of('message')[0].content).toBe('image: true');
  });

  it('a failed turn reports only the final error, then idles', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'FAIL', 'rt-1');
    await h.idleCount(1);
    expect(h.of('error')).toEqual([{ type: 'error', sid, message: 'unexpected status 401 Unauthorized', turnId: 'rt-1' }]);
    expect(h.of('message')).toHaveLength(0);
    const errIdx = h.events.findIndex((e) => e.type === 'error');
    expect(errIdx).toBeLessThan(h.events.findIndex((e) => e.type === 'idle'));
  });

  it('abort interrupts the active turn and settles it', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'SLOW', 'rt-1');
    expect(h.adapter.isTurnSettled(sid)).toBe(false);
    await h.adapter.abortSession(sid);
    await settled(sid);
    expect(h.sent('turn/interrupt')[0].params).toMatchObject({ threadId: expect.any(String), turnId: expect.any(String) });
    // RelayClient owns a user abort's terminal boundary: the adapter emits no
    // idle and no conclusion for the aborted turn (its 'partial' is dropped).
    expect(h.of('idle')).toHaveLength(0);
    // Wait out the fake's late 'ghost' event from the settled turn.
    await new Promise((r) => setTimeout(r, 80));
    // Next turn works normally and never sees the straggler.
    await turn(sid, 'after', 'rt-2');
    await h.idleCount(1);
    expect(h.of('message').map((m) => m.content)).toEqual(['echo: after']);
    expect(h.events.some((e) => e.content === 'ghost')).toBe(false);
  });

  it('abort terminates commands the aborted turn left running, but not earlier ones', async () => {
    await started();
    const sid = await session('execute');
    await turn(sid, 'SLOW BGCMD', 'rt-1');
    await h.waitFor((e) => e.type === 'tool_start', 'command start');
    expect(h.of('tool_start')[0]).toMatchObject({ toolName: 'shell', args: { command: 'sleep 120' } });
    await h.adapter.abortSession(sid);
    await settled(sid);
    expect(h.sent('thread/backgroundTerminals/list')).toHaveLength(1);
    expect(h.sent('thread/backgroundTerminals/terminate').map((m) => m.params!.processId)).toEqual(['proc-sleep']);
  });

  it('abort issued while turn/start is still in flight interrupts once the turn id is known', async () => {
    await started();
    const sid = await session();
    h.adapter.setTurnIdentity(sid, 'rt-1');
    const sending = h.adapter.sendMessage(sid, 'DELAYSTART');
    await new Promise((r) => setTimeout(r, 30));
    await h.adapter.abortSession(sid);
    await sending;
    await settled(sid);
    expect(h.sent('turn/interrupt')).toHaveLength(1);
    expect(h.of('idle')).toHaveLength(0);
    expect(h.adapter.isTurnSettled(sid)).toBe(true);
  });

  it('abort cancels an open permission card', async () => {
    await started();
    const sid = await session('safe');
    await turn(sid, 'SHELL', 'rt-1');
    const perm = await h.waitFor((e) => e.type === 'permission', 'permission');
    await h.adapter.abortSession(sid);
    expect(h.of('perm_auto')).toEqual([{ type: 'perm_auto', sid, id: perm.id, resolution: 'cancelled' }]);
    expect(h.replies().some((r) => r.result!.decision === 'cancel')).toBe(true);
  });

  it('steer goes into the active turn via turn/steer', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'STEERME', 'rt-1');
    await h.waitFor((e) => e.type === 'delta', 'first delta');
    await turn(sid, 'use tabs', 'rt-1', 'steer');
    await h.idleCount(1);
    expect(h.sent('turn/steer')[0].params).toMatchObject({ expectedTurnId: expect.any(String) });
    expect(h.of('message')[0].content).toBe('steered: use tabs');
    expect(h.sent('turn/start')).toHaveLength(1);
  });

  it('a prompt sent while busy is queued and runs after the active turn', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'SLOW', 'rt-1');
    await turn(sid, 'queued one', 'rt-2', 'follow_up');
    expect(h.sent('turn/start')).toHaveLength(1);
    await h.adapter.abortSession(sid);
    await settled(sid);
    // abort clears the queue — nothing else runs
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sent('turn/start')).toHaveLength(1);

    await turn(sid, 'STEERME', 'rt-3');
    await h.waitFor((e) => e.type === 'delta', 'delta');
    await turn(sid, 'next prompt', 'rt-4', 'prompt');
    await turn(sid, 'x', 'rt-3', 'steer');
    await h.idleCount(2);
    expect(h.of('message').map((m) => [m.content, m.turnId])).toEqual([
      ['steered: x', 'rt-3'],
      ['echo: next prompt', 'rt-4'],
    ]);
  });

  it('compaction items drive the compaction status', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'COMPACT', 'rt-1');
    await h.idleCount(1);
    expect(h.of('compaction').map((e) => e.phase)).toEqual(['start', 'end']);
  });

  it('resumes a persisted session in a fresh adapter via thread/resume', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'first', 'rt-1');
    await h.idleCount(1);
    const originalThread = h.sent('turn/start')[0].params!.threadId;
    await h.adapter.stop();

    const dir2 = mkdtempSync(join(tmpdir(), 'kraki-codex-2-'));
    const h2 = new Harness(dir2);
    // Same Kraki sessions dir so the sidecar is found.
    (h2.adapter as unknown as { opts: { sessionsDir: string } }).opts.sessionsDir = join(dir, 'sessions');
    extra.push(h2);
    await h2.adapter.start();
    await h2.adapter.resumeSession(sid);
    h2.adapter.setTurnIdentity(sid, 'rt-2');
    await h2.adapter.sendMessage(sid, 'again');
    await h2.waitFor((e) => e.type === 'idle', 'idle');
    expect(h2.sent('thread/resume')[0].params).toMatchObject({ threadId: originalThread, approvalPolicy: 'untrusted', excludeTurns: true });
    expect(h2.of('message')[0].content).toBe('echo: again');
    rmSync(dir2, { recursive: true, force: true });
  });

  it('recovers from an app-server crash: settles the turn, respawns, resumes the thread', async () => {
    await started();
    const sid = await session();
    await turn(sid, 'CRASH', 'rt-1');
    await h.idleCount(1);
    expect(h.of('error')[0]).toMatchObject({ message: /exited unexpectedly/, turnId: 'rt-1' });
    await turn(sid, 'back', 'rt-2');
    await h.idleCount(2);
    expect(h.of('message').at(-1)).toMatchObject({ content: 'echo: back', turnId: 'rt-2' });
    expect(h.sent('initialize')).toHaveLength(2);
    expect(h.sent('thread/resume')).toHaveLength(1);
  });

  it('forks into a new thread and kill ends the session', async () => {
    await started();
    const sid = await session();
    const { sessionId: forked } = await h.adapter.forkSession(sid, 'codex-fork-1');
    expect(forked).toBe('codex-fork-1');
    expect(h.sent('thread/fork')).toHaveLength(1);
    await turn(forked, 'in fork', 'rt-f');
    await h.idleCount(1);
    expect(h.of('message')[0]).toMatchObject({ sid: forked, content: 'echo: in fork' });
    await h.adapter.killSession(forked);
    expect(h.of('ended')[0]).toMatchObject({ sid: forked, reason: 'killed' });
    await expect(h.adapter.sendMessage(forked, 'x')).rejects.toThrow(/not found/);
  });

  it('sends image attachments as localImage inputs', async () => {
    await started();
    const sid = await session();
    h.adapter.setTurnIdentity(sid, 'rt-1');
    await h.adapter.sendMessage(sid, 'look', [{ type: 'image', mimeType: 'image/png', data: PNG_1PX.toString('base64') }]);
    await h.idleCount(1);
    const input = h.sent('turn/start')[0].params!.input as Array<{ type: string; path?: string }>;
    expect(input.map((i) => i.type)).toEqual(['text', 'localImage']);
    expect(readFileSync(input[1].path!)).toEqual(PNG_1PX);
  });
});
