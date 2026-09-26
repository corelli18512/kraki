/** Opt-in protocol audit: real installed Pi RPC + real Kraki adapter/extension,
 * deterministic loopback OpenAI-compatible server (no credentials or paid API).
 * Run: PI087_CLI=/absolute/path/to/pi pnpm exec vitest run --config vitest.pi087.config.ts
 * Deliberately assert desired behavior, including known failures: do not weaken
 * assertions to make incompatible protocol assumptions appear supported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PiAdapter } from '../adapters/pi.js';
import { AttachmentStore } from '../attachment-store.js';

const cli = process.env.PI087_CLI;
const run = cli ? describe : describe.skip;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
type Step = { text?: string; tool?: string; args?: Record<string, unknown>; finish?: string; error?: number; hold?: boolean; input?: number };
let pixel: string;
interface RequestBody { model: string; tools?: unknown[]; messages: Array<{ role: string; content?: unknown }> }
interface WireMessage { role: string; toolName?: string; content: Array<{ type: string; text?: string }>; isError?: boolean }
interface WireEvent { type: string; message?: WireMessage; willRetry?: boolean; assistantMessageEvent?: { type: string; partial?: unknown } }
interface CallbackEvent { id: string; content: string; toolName: string; success: boolean; phase: string; turnId: string; choices?: string[]; attachments: Array<{ mimeType: string }> }
type Callback = (id: string, event: CallbackEvent) => void;
interface RpcState { model: { id: string }; thinkingLevel: string; sessionFile: string; isStreaming: boolean; pendingMessageCount: number; summary?: string }
interface AuditProcess { request: (type: string, payload?: Record<string, unknown>) => Promise<RpcState>; kill: () => void; onEvent: ((e: WireEvent) => void) | null }
interface AuditSession { proc: AuditProcess; finalizing: boolean; pendingQuestions: Map<string, string>; pendingPerms: Map<string, string> }
interface AuditTimeline { type: string; event?: string; message?: WireMessage; willRetry?: boolean; args?: [string, CallbackEvent]; state?: RpcState }
let root: string, server: Server, adapter: PiAdapter, steps: Step[], requests: RequestBody[], wire: WireEvent[], timeline: AuditTimeline[], savedEnv: Record<string, string | undefined>;
let callbacks: Record<string, ReturnType<typeof vi.fn<Callback>>>;
const sid = 'audit';
let seq = 0;
let summaryGate: Promise<void> | undefined;
const wait = (f: () => void) => vi.waitFor(f, { timeout: 8000, interval: 20 });
function session(id = sid): AuditSession { return (adapter as unknown as { sessions: Map<string, AuditSession> }).sessions.get(id)!; }
function proc(id = sid): AuditProcess { return session(id).proc; }
function capture(id = sid) {
  const p = proc(id), old = p.onEvent;
  p.onEvent = (e: WireEvent) => { wire.push(e); timeline.push({ type: 'wire', event: e.type, message: e.message, willRetry: e.willRetry }); return old?.(e); };
}
async function create(id = sid, model = 'audit/model-a') {
  await adapter.createSession({ sessionId: id, cwd: root, model, reasoningEffort: 'low' });
  capture(id);
  return proc(id).request('get_state');
}
async function turn(text = 'audit prompt', id = sid) {
  const before = callbacks.onIdle.mock.calls.filter(c => c[0] === id).length;
  await adapter.sendMessage(id, text);
  await wait(() => expect(callbacks.onIdle.mock.calls.filter(c => c[0] === id).length).toBe(before + 1));
  await wait(() => expect(wire.at(-1)?.type === 'agent_settled' || !session(id).finalizing).toBe(true));
}
function lastReply() { return callbacks.onMessage.mock.calls.at(-1)?.[1]?.content; }
function toolResult(name: string) { return wire.filter(e => e.type === 'message_end' && e.message?.role === 'toolResult' && e.message.toolName === name).at(-1)?.message; }
async function sse(res: ServerResponse, step: Step, model: string) {
  if (step.error) {
    res.writeHead(step.error, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: step.error === 400 ? 'context_length_exceeded: maximum context length exceeded' : '503 service unavailable', type: step.error === 400 ? 'context_length_exceeded' : 'server_error' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta: unknown, finish_reason: string | null = null, usage?: Record<string, number>) => {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ id: 'chat-audit', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }], ...(usage && { usage }) })}\n\n`);
  };
  emit({ role: 'assistant', content: '' });
  if (step.hold) return;
  if (step.text !== undefined) {
    for (const part of step.text.match(/.{1,9}/gs) ?? []) { emit({ content: part }); await delay(3); }
  }
  if (step.tool) {
    const args = JSON.stringify(step.args ?? {}), id = `call_${++seq}`;
    emit({ tool_calls: [{ index: 0, id, type: 'function', function: { name: step.tool, arguments: '' } }] });
    for (const part of args.match(/.{1,8}/gs) ?? []) { emit({ tool_calls: [{ index: 0, function: { arguments: part } }] }); await delay(8); }
  }
  emit({}, step.finish ?? (step.tool ? 'tool_calls' : 'stop'), { prompt_tokens: step.input ?? 100, completion_tokens: 8, total_tokens: (step.input ?? 100) + 8 });
  res.end('data: [DONE]\n\n');
}

run('Pi 0.87 live RPC compatibility', () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kraki-pi087-audit-'));
    const home = join(root, 'home'), agent = join(root, 'agent'), kraki = join(root, 'kraki');
    for (const p of [home, agent, kraki]) mkdirSync(p, { recursive: true });
    savedEnv = {};
    for (const [k, v] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', KRAKI_HOME: kraki })) {
      savedEnv[k] = process.env[k]; process.env[k] = v;
    }
    pixel = (await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()).toString('base64');
    steps = []; requests = []; wire = []; timeline = []; seq = 0; summaryGate = undefined;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', b => body += b);
      req.on('end', () => {
        const request = JSON.parse(body) as RequestBody; requests.push(request);
        // Summary calls have no tools. They are real Pi compaction calls but
        // use deterministic synthetic content, so no external model is needed.
        const summary = !request.tools?.length && request.messages.some(m => typeof m.content === 'string' && /summari[sz]|context checkpoint/i.test(m.content));
        const step = summary ? { text: 'Summary: synthetic audit conversation; continue the pending user request.' } : steps.shift() ?? { text: 'AUDIT_DEFAULT' };
        if (summary && summaryGate) void summaryGate.then(() => sse(res, step, request.model));
        else void sse(res, step, request.model);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { audit: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'not-a-secret-test-key',
      models: ['model-a', 'model-b', 'org/model-c'].map(id => ({ id, reasoning: true, input: ['text', 'image'], contextWindow: 100000, maxTokens: 4096, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })),
    } } }));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'audit', defaultModel: 'model-a', compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 32 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, enableInstallTelemetry: false }));
    adapter = new PiAdapter({ cliPath: cli!, attachmentStore: new AttachmentStore(join(kraki, 'sessions')) });
    callbacks = {};
    for (const name of ['onMessage', 'onMessageDelta', 'onFinalizeDelta', 'onIdle', 'onError', 'onToolStart', 'onToolComplete', 'onQuestionRequest', 'onPermissionRequest', 'onCompaction', 'onUsageUpdate', 'onAttachmentBytes', 'onSessionEvicted', 'onSystemMessage']) {
      const cb = vi.fn<Callback>((...args) => { timeline.push({ type: name, args }); });
      callbacks[name] = cb; (adapter as unknown as Record<string, Callback>)[name] = cb;
    }
  });
  afterEach(async (ctx) => {
    if (process.env.PI087_EVIDENCE_DIR) {
      const out = process.env.PI087_EVIDENCE_DIR;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 110) + '.json'), JSON.stringify({ test: ctx.task.name, requests, wire, timeline }, null, 2));
    }
    await adapter?.stop();
    server?.closeAllConnections();
    if (server) await new Promise<void>(r => server.close(() => r()));
    for (const [k, v] of Object.entries(savedEnv ?? {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // Give Pi's signal cleanup a moment to finish writing only the test folder.
    await delay(100);
    rmSync(root, { recursive: true, force: true });
  });

  it('executes actual installed 0.87.x and discovers models/thinking levels', async () => {
    expect(execFileSync(cli!, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^0\.87\./);
    expect(await adapter.listModels()).toContain('audit/model-a');
    const detail = (await adapter.listModelDetails()).find(m => m.id === 'audit/model-a');
    expect(detail?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('streams text including Unicode separators, acknowledges before completion, and settles once', async () => {
    await create(); steps.push({ text: 'hello\u2028world\u2029你好' });
    await turn();
    expect(lastReply()).toBe('hello\u2028world\u2029你好');
    expect(callbacks.onMessageDelta.mock.calls.map(c => c[1].content).join('')).toBe(lastReply());
    expect(callbacks.onIdle).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(wire.some(e => e.type === 'agent_settled')).toBe(true);
    expect((await proc().request('get_state')).isStreaming).toBe(false);
  });

  it('streams ordinary text, keeps the turn identity, and acknowledges without waiting for completion', async () => {
    await create(); adapter.setTurnIdentity(sid, 'turn-audit-1'); steps.push({ hold: true });
    await adapter.sendMessage(sid, 'ack test');
    await wait(() => expect(requests).toHaveLength(1));
    expect((await proc().request('get_state')).isStreaming).toBe(true);
    expect(callbacks.onIdle).not.toHaveBeenCalled();
    await adapter.abortSession(sid);
    adapter.setTurnIdentity(sid, 'turn-audit-2'); steps.push({ text: '你好 STREAM_OK' }); await turn();
    expect(lastReply()).toBe('你好 STREAM_OK');
    expect(callbacks.onMessageDelta.mock.calls.map(c => c[1].content).join('')).toBe('你好 STREAM_OK');
    expect(callbacks.onMessage.mock.calls[0][1].turnId).toBe('turn-audit-2');
    expect(callbacks.onIdle.mock.calls[0][1].turnId).toBe('turn-audit-2');
  });

  it('preserves Kraki tool prompt guidelines as complete sentences', async () => {
    await create(); steps.push({ text: 'GUIDELINES_OK' }); await turn();
    const system = requests[0].messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n');
    expect(system).toContain('Use ask_user whenever you need a decision, clarification, or missing information from the user.');
    expect(system).not.toContain('\n- U\n- s\n- e\n');
  });

  it('switches model and thinking while alive', async () => {
    await create(); await adapter.setSessionModel(sid, 'audit/model-b', 'max');
    const state = await proc().request('get_state');
    expect(state.model.id).toBe('model-b'); expect(state.thinkingLevel).toBe('max');
    steps.push({ text: 'SWITCHED' }); await turn(); expect(requests.at(-1).model).toBe('model-b');
  });

  it('runs read/write/edit/bash and maps usage from real RPC', async () => {
    await create(); adapter.setSessionMode(sid, 'execute');
    steps.push({ tool: 'write', args: { path: 'scratch.txt', content: 'before' } }, { tool: 'edit', args: { path: 'scratch.txt', oldText: 'before', newText: 'after' } }, { tool: 'read', args: { path: 'scratch.txt' } }, { tool: 'bash', args: { command: 'printf AUDIT_SHELL' } }, { text: 'TOOLS_OK' });
    await turn(); expect(readFileSync(join(root, 'scratch.txt'), 'utf8')).toBe('after');
    expect(callbacks.onToolComplete.mock.calls.map(c => c[1].toolName)).toEqual(['write', 'edit', 'read', 'bash']);
    expect(callbacks.onToolComplete.mock.calls.every(c => c[1].success)).toBe(true);
    await wait(() => expect(adapter.getSessionUsage(sid)?.inputTokens).toBeGreaterThan(0));
    expect(adapter.getSessionUsage(sid)?.totalCost).toBeGreaterThan(0);
  });

  it.each(['approve', 'deny'] as const)('gates a discuss-mode write with %s', async decision => {
    await create(); steps.push({ tool: 'write', args: { path: 'approval.txt', content: 'approved' } }, { text: 'PERMISSION_DONE' });
    await adapter.sendMessage(sid, 'permission audit');
    await wait(() => expect(callbacks.onPermissionRequest).toHaveBeenCalledTimes(1));
    expect(existsSync(join(root, 'approval.txt'))).toBe(false); expect(callbacks.onIdle).not.toHaveBeenCalled();
    await adapter.respondToPermission(sid, callbacks.onPermissionRequest.mock.calls[0][1].id, decision);
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
    expect(existsSync(join(root, 'approval.txt'))).toBe(decision === 'approve');
    expect(toolResult('write').isError).toBe(decision === 'deny');
  });

  it('changes permission mode without respawning and exposes kraki_get_mode', async () => {
    await create(); const original = proc(); adapter.setSessionMode(sid, 'safe');
    steps.push({ tool: 'read', args: { path: 'mode.txt' } }, { tool: 'kraki_get_mode', args: { query: 'current' } }, { text: 'MODE_OK' });
    writeFileSync(join(root, 'mode.txt'), 'test'); await adapter.sendMessage(sid, 'mode audit');
    await wait(() => expect(callbacks.onPermissionRequest).toHaveBeenCalledTimes(1));
    adapter.setSessionMode(sid, 'execute');
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
    expect(proc()).toBe(original); expect(toolResult('kraki_get_mode').content[0].text).toBe('execute');
  });

  it.each([false, true])('round-trips ask_user (choices=%s)', async choices => {
    await create(); steps.push({ tool: 'ask_user', args: { question: 'Choose?', ...(choices && { choices: ['A', 'B'] }) } }, { text: 'ANSWERED' });
    await adapter.sendMessage(sid, 'question audit');
    await wait(() => expect(callbacks.onQuestionRequest).toHaveBeenCalledTimes(1));
    const q = callbacks.onQuestionRequest.mock.calls[0][1]; expect(q.choices).toEqual(choices ? ['A', 'B'] : undefined);
    expect(await adapter.respondToQuestion(sid, q.id, choices ? 'B' : 'freeform', !choices)).toBe('accepted');
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
    expect(toolResult('ask_user').content[0].text).toBe(choices ? 'B' : 'freeform');
  });

  it('sends an image input and a question image answer through real Pi normalization', async () => {
    await create(); steps.push({ tool: 'ask_user', args: { question: 'Image?' } }, { text: 'IMAGE_OK' });
    const image = { type: 'image' as const, data: pixel, mimeType: 'image/png' };
    await adapter.sendMessage(sid, 'image audit', [image]);
    await wait(() => expect(callbacks.onQuestionRequest).toHaveBeenCalledTimes(1));
    const q = callbacks.onQuestionRequest.mock.calls[0][1];
    await adapter.respondToQuestion(sid, q.id, { text: 'image answer', attachments: [image] }, true);
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(requests[0].messages)).toContain('data:image/');
    expect(toolResult('ask_user').content.some(c => c.type === 'image')).toBe(true);
  });

  it('maps show_image and show_html results to persisted attachment refs', async () => {
    await create(); writeFileSync(join(root, 'pixel.png'), Buffer.from(pixel, 'base64')); writeFileSync(join(root, 'report.html'), '<!doctype html><title>Audit</title>OK');
    steps.push({ tool: 'show_image', args: { path: 'pixel.png', caption: 'fixture' } }, { tool: 'show_html', args: { path: 'report.html', title: 'Audit' } }, { text: 'ARTIFACTS_OK' });
    await turn();
    const completed = callbacks.onToolComplete.mock.calls.map(c => c[1]);
    expect(completed.find(c => c.toolName === 'show_image').attachments[0].mimeType).toBe('image/png');
    expect(completed.find(c => c.toolName === 'show_html').attachments[0].mimeType).toBe('text/html');
    expect(callbacks.onAttachmentBytes).toHaveBeenCalledTimes(2);
  });

  it.each(['show_image', 'show_html'])('marks a failed %s as an error rather than a successful artifact', async tool => {
    await create(); steps.push({ tool, args: { path: tool === 'show_image' ? 'does-not-exist.png' : 'does-not-exist.html' } }, { text: 'HANDLED_ARTIFACT_ERROR' });
    await turn();
    expect(toolResult(tool).isError).toBe(true);
    expect(callbacks.onToolComplete.mock.calls.find(c => c[1].toolName === tool)?.[1].success).toBe(false);
    expect(callbacks.onAttachmentBytes).not.toHaveBeenCalled();
  });

  it('finalizes an ends-on-tool turn without losing the final reply', async () => {
    await create(); steps.push({ tool: 'kraki_get_mode', args: { query: 'current' } }, { text: '' }, { tool: 'finalize_reply', args: { resummarize: true, text: 'FINALIZED' } }, { text: '' });
    await turn(); expect(lastReply()).toBe('FINALIZED'); expect(callbacks.onIdle).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolStart.mock.calls.map(c => c[1].toolName)).not.toContain('finalize_reply');
  });

  it('streams finalize_reply argument text with Pi 0.87 delta-only records', async () => {
    await create(); steps.push({ tool: 'kraki_get_mode', args: { query: 'current' } }, { text: '' }, { tool: 'finalize_reply', args: { resummarize: true, text: 'FINAL_STREAMED_TEXT' } }, { text: '' });
    await turn(); expect(lastReply()).toBe('FINAL_STREAMED_TEXT');
    expect(wire.some(e => e.assistantMessageEvent?.type === 'toolcall_delta')).toBe(true);
    expect(wire.filter(e => e.type === 'message_update').every(e => !e.assistantMessageEvent.partial)).toBe(true);
    expect(callbacks.onFinalizeDelta.mock.calls.map(c => c[1].content).join('')).toBe('FINAL_STREAMED_TEXT');
  });

  it('aborts an active stream and accepts the next prompt', async () => {
    await create(); steps.push({ hold: true }); await adapter.sendMessage(sid, 'held request');
    await wait(() => expect(requests.length).toBe(1)); await adapter.abortSession(sid);
    expect((await proc().request('get_state')).isStreaming).toBe(false);
    expect(callbacks.onIdle).not.toHaveBeenCalled(); // Relay owns aborted idle.
    steps.push({ text: 'AFTER_ABORT' }); await turn(); expect(lastReply()).toBe('AFTER_ABORT');
  });

  it('aborts while waiting for a human answer without dangling UI', async () => {
    await create(); steps.push({ tool: 'ask_user', args: { question: 'Waiting?' } });
    await adapter.sendMessage(sid, 'pending question'); await wait(() => expect(callbacks.onQuestionRequest).toHaveBeenCalledTimes(1));
    await adapter.abortSession(sid); expect(session().pendingQuestions.size).toBe(0);
    expect((await proc().request('get_state')).isStreaming).toBe(false);
    steps.push({ text: 'AFTER_QUESTION_ABORT' }); await turn(); expect(lastReply()).toBe('AFTER_QUESTION_ABORT');
  });

  it('aborts a running bash process and prevents its deferred file write', async () => {
    await create(); adapter.setSessionMode(sid, 'execute');
    steps.push({ tool: 'bash', args: { command: 'sleep 1; printf unwanted > late-write.txt' } });
    await adapter.sendMessage(sid, 'abort bash');
    await wait(() => expect(callbacks.onToolStart).toHaveBeenCalledTimes(1));
    await adapter.abortSession(sid); await delay(1200);
    expect(existsSync(join(root, 'late-write.txt'))).toBe(false);
    expect((await proc().request('get_state')).isStreaming).toBe(false);
    steps.push({ text: 'BASH_ABORTED' }); await turn(); expect(lastReply()).toBe('BASH_ABORTED');
  });

  it('aborts a pending permission without executing the denied write', async () => {
    await create(); steps.push({ tool: 'write', args: { path: 'never-written.txt', content: 'no' } });
    await adapter.sendMessage(sid, 'pending approval');
    await wait(() => expect(callbacks.onPermissionRequest).toHaveBeenCalledTimes(1));
    await adapter.abortSession(sid);
    expect(existsSync(join(root, 'never-written.txt'))).toBe(false);
    expect(session().pendingPerms.size).toBe(0);
    steps.push({ text: 'PERMISSION_ABORTED' }); await turn(); expect(lastReply()).toBe('PERMISSION_ABORTED');
  });

  it('queues a steer during a tool call without a duplicate idle', async () => {
    await create(); adapter.setSessionMode(sid, 'execute'); steps.push({ tool: 'bash', args: { command: 'sleep 0.3; printf TOOL_DONE' } }, { text: 'STEERED' });
    await adapter.sendMessage(sid, 'start tool'); await wait(() => expect(callbacks.onToolStart).toHaveBeenCalledTimes(1));
    await adapter.sendMessage(sid, 'STEER_MARKER', undefined, { delivery: 'steer' });
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(requests.at(-1).messages)).toContain('STEER_MARKER'); expect(lastReply()).toBe('STEERED');
  });

  it('clears queued follow-up messages on explicit abort', async () => {
    await create(); steps.push({ hold: true }, { text: 'QUEUED_RAN_AFTER_ABORT' });
    await adapter.sendMessage(sid, 'held request'); await wait(() => expect(requests.length).toBe(1));
    await adapter.sendMessage(sid, 'QUEUED_MARKER', undefined, { delivery: 'follow_up' });
    await adapter.abortSession(sid); await delay(150);
    expect(requests).toHaveLength(1);
    const state = await proc().request('get_state');
    timeline.push({ type: 'stateAfterAbort', state });
    expect(state.pendingMessageCount).toBe(0);
  });

  it('survives process eviction/lazy resume with context and exact session file', async () => {
    await create(); steps.push({ text: 'PERSISTED_REPLY' }); await turn('PERSISTED_MARKER');
    const file = (await proc().request('get_state')).sessionFile; expect(file.startsWith(root)).toBe(true);
    proc().kill(); await delay(100); steps.push({ text: 'RESUMED' });
    await adapter.sendMessage(sid, 'resume');
    await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(requests.at(-1).messages)).toContain('PERSISTED_MARKER');
    expect((await proc().request('get_state')).sessionFile).toBe(file);
  });

  it('forks without changing the original transcript', async () => {
    await create(); steps.push({ text: 'ORIGINAL' }); await turn('FORK_MARKER');
    const file = (await proc().request('get_state')).sessionFile, original = readFileSync(file, 'utf8');
    await adapter.forkSession(sid, 'fork'); capture('fork'); await proc('fork').request('get_state');
    steps.push({ text: 'FORKED' }); await turn('fork-only-message', 'fork');
    expect(readFileSync(file, 'utf8')).toBe(original); expect(JSON.stringify(requests.at(-1).messages)).toContain('FORK_MARKER');
  });

  it('switches model after eviction and persists thinking level', async () => {
    await create(); steps.push({ text: 'FIRST' }); await turn(); proc().kill(); await delay(100);
    await adapter.setSessionModel(sid, 'audit/model-b', 'high');
    const state = await proc().request('get_state'); expect(state.model.id).toBe('model-b'); expect(state.thinkingLevel).toBe('high');
    steps.push({ text: 'SECOND' }); await turn(); expect(requests.at(-1).model).toBe('model-b');
  });

  it('accepts slash-containing model IDs returned by the same catalog', async () => {
    expect(await adapter.listModels()).toContain('audit/org/model-c');
    await create(); await adapter.setSessionModel(sid, 'audit/org/model-c', 'low');
    expect((await proc().request('get_state')).model.id).toBe('org/model-c');
    steps.push({ text: 'NAMESPACED' }); await turn();
    proc().kill(); await delay(100); await adapter.resumeSession(sid);
    expect((await proc().request('get_state')).model.id).toBe('org/model-c');
  });

  it('retries a transient provider failure without premature error or idle', async () => {
    await create(); steps.push({ error: 503 }, { text: 'RETRIED' }); await turn();
    expect(lastReply()).toBe('RETRIED'); expect(callbacks.onError).not.toHaveBeenCalled(); expect(callbacks.onIdle).toHaveBeenCalledTimes(1);
    expect(wire.some(e => e.type === 'auto_retry_start')).toBe(true);
  });

  it('reports exhausted retry once and still accepts a later prompt', async () => {
    await create(); steps.push({ error: 503 }, { error: 503 }); await turn();
    expect(callbacks.onError).toHaveBeenCalledTimes(1); expect(callbacks.onIdle).toHaveBeenCalledTimes(1);
    steps.push({ text: 'RECOVERED_LATER' }); await turn(); expect(lastReply()).toBe('RECOVERED_LATER');
  });

  async function seedHistory() {
    for (let i = 0; i < 3; i++) { steps.push({ text: 'Synthetic history '.repeat(20) }); await turn('Synthetic previous turn '.repeat(20)); }
    callbacks.onIdle.mockClear(); callbacks.onMessage.mockClear(); callbacks.onCompaction.mockClear(); timeline = []; wire = [];
  }

  it('compacts manually and resumes without leaking summaries into chat', async () => {
    await create(); await seedHistory();
    const result = await proc().request('compact'); expect(result.summary).toContain('synthetic');
    expect(callbacks.onCompaction.mock.calls.map(c => c[1].phase)).toEqual(['start', 'end']);
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    steps.push({ text: 'AFTER_COMPACT' }); await turn(); expect(lastReply()).toBe('AFTER_COMPACT');
  });

  it('queues a new turn during background compaction and preserves turn identities', async () => {
    await create(); await seedHistory();
    let release!: () => void; summaryGate = new Promise<void>(r => { release = r; });
    try {
      adapter.setTurnIdentity(sid, 'before-maintenance');
      steps.push({ text: 'ANSWER_BEFORE_MAINTENANCE', input: 99500 });
      await adapter.sendMessage(sid, 'trigger threshold');
      await wait(() => expect(callbacks.onCompaction.mock.calls[0]?.[1].phase).toBe('start'));
      await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(1));
      expect(callbacks.onIdle.mock.calls[0][1].turnId).toBe('before-maintenance');
      adapter.setTurnIdentity(sid, 'after-maintenance'); steps.push({ text: 'ANSWER_AFTER_MAINTENANCE' });
      await adapter.sendMessage(sid, 'QUEUED_DURING_MAINTENANCE', undefined, { delivery: 'follow_up' });
      expect((await proc().request('get_state')).pendingMessageCount).toBeGreaterThan(0);
      release(); summaryGate = undefined;
      await wait(() => expect(callbacks.onIdle).toHaveBeenCalledTimes(2));
      expect(callbacks.onIdle.mock.calls[1][1].turnId).toBe('after-maintenance');
      expect(lastReply()).toBe('ANSWER_AFTER_MAINTENANCE'); expect(callbacks.onError).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('waits for overflow compaction/retry before settling the turn', async () => {
    await create(); await seedHistory(); steps.push({ error: 400 }, { text: 'OVERFLOW_RECOVERED' });
    await turn(); expect(lastReply()).toBe('OVERFLOW_RECOVERED'); expect(callbacks.onIdle).toHaveBeenCalledTimes(1); expect(callbacks.onError).not.toHaveBeenCalled();
    const retryEnd = timeline.findIndex(e => e.type === 'wire' && e.event === 'compaction_end' && e.willRetry);
    expect(retryEnd).toBeGreaterThan(-1); expect(timeline.findIndex(e => e.type === 'onIdle')).toBeGreaterThan(retryEnd);
  });

  it('does not settle a truncated length response before its recovery continuation', async () => {
    await create(); await seedHistory(); steps.push({ text: 'TRUNCATED_NOT_FINAL', finish: 'length' }, { text: 'LENGTH_RECOVERED' });
    await adapter.sendMessage(sid, 'recover truncated response');
    await wait(() => expect(wire.filter(e => e.type === 'agent_settled').length).toBe(1));
    expect(callbacks.onMessage.mock.calls.map(c => c[1].content)).toEqual(['LENGTH_RECOVERED']);
    expect(callbacks.onIdle).toHaveBeenCalledTimes(1);
  });
});
