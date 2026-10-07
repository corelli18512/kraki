// Fake `codex app-server` for CodexAdapter tests. Speaks the real stdio wire
// format (one JSON object per line, no "jsonrpc" field) with message shapes
// copied from codex-cli 0.157.1 captures. Behaviour is chosen by keywords in
// the user's turn text. Every client→server message is appended to
// $FAKE_CODEX_LOG (JSONL) so tests can assert what the adapter sent.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const LOG = process.env.FAKE_CODEX_LOG;
const LOGGED_OUT = process.env.FAKE_CODEX_LOGGED_OUT === '1';
let seq = 0;
const uid = (p) => `${p}-${process.pid}-${++seq}`;
const threads = new Map(); // threadId -> { activeTurn }
const waiting = new Map(); // our server-request id -> resolve(result)
let nextServerReqId = 1000;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method, params) { send({ method, params, emittedAtMs: Date.now() }); }
function ask(method, params) {
  const id = nextServerReqId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thread = (id, extra = {}) => ({ id, sessionId: id, preview: '', status: { type: 'idle' }, path: `/tmp/fake/${id}.jsonl`, ...extra });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (LOG) appendFileSync(LOG, JSON.stringify(msg) + '\n');
  if (msg.id !== undefined && !msg.method) {
    const r = waiting.get(msg.id);
    waiting.delete(msg.id);
    r?.(msg.error ? { __error: msg.error } : msg.result);
    return;
  }
  if (!msg.method || msg.id === undefined) return; // client notification
  handle(msg).catch((e) => send({ id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } }));
});

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return send({ id, result: { userAgent: 'fake/0.157.1', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' } });
    case 'account/read':
      return send({ id, result: LOGGED_OUT ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: 't@example.com' }, requiresOpenaiAuth: true } });
    case 'model/list':
      return send({ id, result: { nextCursor: null, data: [
        { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }],
          defaultReasoningEffort: 'high' },
        { id: 'secret-internal', model: 'secret-internal', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
      ] } });
    case 'thread/start': {
      const tid = uid('thread');
      threads.set(tid, {});
      notify('thread/started', { thread: thread(tid) });
      return send({ id, result: { thread: thread(tid), model: params.model ?? 'gpt-6-astra', modelProvider: 'openai' } });
    }
    case 'thread/resume':
      threads.set(params.threadId, {});
      return send({ id, result: { thread: thread(params.threadId), model: 'gpt-6-astra' } });
    case 'thread/fork': {
      const tid = uid('fork');
      threads.set(tid, {});
      return send({ id, result: { thread: thread(tid, { forkedFromId: params.threadId }) } });
    }
    case 'thread/unsubscribe':
      return send({ id, result: {} });
    case 'thread/backgroundTerminals/list':
      return send({ id, result: { nextCursor: null, data: (threads.get(params.threadId)?.terminals ?? []) } });
    case 'thread/backgroundTerminals/terminate': {
      const t = threads.get(params.threadId);
      const before = t?.terminals?.length ?? 0;
      if (t?.terminals) t.terminals = t.terminals.filter((x) => x.processId !== params.processId);
      return send({ id, result: { terminated: (t?.terminals?.length ?? 0) < before } });
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId);
      send({ id, result: {} });
      t?.interrupt?.();
      return;
    }
    case 'turn/steer': {
      const t = threads.get(params.threadId);
      if (!t?.activeTurn || t.activeTurn !== params.expectedTurnId) {
        return send({ id, error: { code: -32600, message: 'no active turn to steer' } });
      }
      t.steered = params.input;
      return send({ id, result: { turnId: t.activeTurn } });
    }
    case 'turn/start': {
      const t = threads.get(params.threadId);
      if (!t) return send({ id, error: { code: -32600, message: `thread not loaded: ${params.threadId}` } });
      if (t.activeTurn) return send({ id, error: { code: -32600, message: 'turn already in progress' } });
      const turnId = uid('turn');
      t.activeTurn = turnId;
      if (JSON.stringify(params.input).includes('DELAYSTART')) await sleep(150);
      send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      runTurn(params.threadId, t, turnId, params.input).catch((e) => process.stderr.write(String(e) + '\n'));
      return;
    }
    default:
      return send({ id, error: { code: -32601, message: `fake: unsupported ${method}` } });
  }
}

async function runTurn(threadId, t, turnId, input) {
  const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const base = { threadId, turnId };
  const item = (type, fields) => ({ type, id: uid('item'), ...fields });
  const started = (it) => notify('item/started', { ...base, item: it, startedAtMs: Date.now() });
  const completed = (it) => notify('item/completed', { ...base, item: it, completedAtMs: Date.now() });
  const say = async (msg, phase = 'final_answer') => {
    const it = item('agentMessage', { text: '', phase });
    started(it);
    for (const chunk of msg.match(/.{1,6}/gs) ?? []) notify('item/agentMessage/delta', { ...base, itemId: it.id, delta: chunk });
    completed({ ...it, text: msg });
  };
  const finish = (status = 'completed', error = null) => {
    t.activeTurn = undefined;
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error, durationMs: 1234 } });
  };

  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  const user = item('userMessage', { content: input });
  started(user); completed(user);

  if (text.startsWith('Generate a title')) {
    if (text.includes('TRYTOOL')) {
      // A title thread that tries to run a command must be declined.
      const cmd = item('commandExecution', { command: 'rm -rf /', cwd: '/tmp', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
      started(cmd);
      const res = await ask('item/commandExecution/requestApproval', { ...base, itemId: cmd.id, command: 'rm -rf /', cwd: '/tmp', startedAtMs: Date.now() });
      completed({ ...cmd, status: 'declined' });
      await say(`Title after ${res?.decision}`);
      return finish();
    }
    await say('Fix flaky stats tests.');
    return finish();
  }

  if (text.includes('CRASH')) { await sleep(20); process.exit(3); }

  if (text.includes('FAIL')) {
    notify('error', { ...base, willRetry: true, error: { message: 'Reconnecting... 1/5' } });
    notify('error', { ...base, willRetry: false, error: { message: 'unexpected status 401 Unauthorized' } });
    return finish('failed', { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'other' });
  }

  if (text.includes('SLOW') || text.includes('DELAYSTART')) {
    if (text.includes('BGCMD')) {
      // A command still running when the turn is interrupted, plus a server
      // an EARLIER turn left running on purpose.
      const cmd = item('commandExecution', { command: "/bin/zsh -lc 'sleep 120'", cwd: '/tmp', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
      started(cmd);
      t.terminals = [
        { itemId: 'item-from-earlier-turn', processId: 'proc-dev-server', command: 'npm run dev', cwd: '/tmp', osPid: 1, cpuPercent: null, rssKb: null },
        { itemId: cmd.id, processId: 'proc-sleep', command: 'sleep 120', cwd: '/tmp', osPid: 2, cpuPercent: null, rssKb: null },
      ];
    }
    await new Promise((resolve) => { t.interrupt = resolve; });
    await say('partial');
    finish('interrupted');
    // A straggler from the settled turn (must never leak into the next turn).
    await sleep(30);
    const ghost = item('agentMessage', { text: 'ghost', phase: 'final_answer' });
    notify('item/agentMessage/delta', { ...base, itemId: ghost.id, delta: 'ghost' });
    completed(ghost);
    return;
  }

  if (text.includes('STEERME')) {
    await say('working', 'commentary');
    for (let i = 0; i < 100 && !t.steered; i++) await sleep(10);
    const steered = (t.steered ?? []).map((i) => i.text).join(' ');
    t.steered = undefined;
    await say(`steered: ${steered}`);
    return finish();
  }

  // Subagent delegation, shaped from a live codex-cli 0.157.1 trace: the child
  // runs on its own thread; its approvals and messages carry the CHILD threadId.
  if (text.includes('SUBAGENT')) {
    await say('Delegating to a subagent.', 'commentary');
    const childThread = uid('thread');
    const childTurn = uid('turn');
    const cbase = { threadId: childThread, turnId: childTurn };
    const act = (kind, agentThreadId, agentPath, b = base) => {
      const it = { type: 'subAgentActivity', id: uid('call'), kind, agentThreadId, agentPath };
      notify('item/started', { ...b, item: it }); notify('item/completed', { ...b, item: it });
    };
    act('started', childThread, '/root/find_codeword');
    notify('thread/status/changed', { threadId: childThread, status: { type: 'active', activeFlags: [] } });
    notify('turn/started', { threadId: childThread, turn: { id: childTurn, items: [], status: 'inProgress', error: null } });
    const wait = item('collabAgentToolCall', { tool: 'wait', status: 'inProgress', senderThreadId: threadId, receiverThreadIds: [] });
    started(wait);
    const cmd = item('commandExecution', { command: "rg -n CODEWORD .", cwd: '/tmp', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
    notify('item/started', { ...cbase, item: cmd });
    let decision;
    if (text.includes('WITHDRAW')) {
      const reqId = nextServerReqId;
      void ask('item/commandExecution/requestApproval', { ...cbase, itemId: cmd.id, command: cmd.command, cwd: '/tmp', startedAtMs: Date.now() });
      await sleep(150);
      waiting.delete(reqId);
      notify('serverRequest/resolved', { threadId: childThread, requestId: reqId });
      decision = 'withdrawn';
    } else {
      const res = await ask('item/commandExecution/requestApproval', { ...cbase, itemId: cmd.id, command: cmd.command, cwd: '/tmp', startedAtMs: Date.now() });
      notify('serverRequest/resolved', { threadId: childThread, requestId: nextServerReqId - 1 });
      decision = res?.decision;
    }
    const ok = decision === 'accept' || decision === 'acceptForSession';
    notify('item/completed', { ...cbase, item: { ...cmd, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'src/deep/config.ts:1:// CODEWORD: purple-otter-42' : null, exitCode: ok ? 0 : null } });
    act('interacted', threadId, '/root', cbase);
    completed({ ...wait, status: 'completed' });
    const childMsg = { type: 'agentMessage', id: uid('item'), text: '', phase: 'final_answer' };
    notify('item/started', { ...cbase, item: childMsg });
    notify('item/agentMessage/delta', { ...cbase, itemId: childMsg.id, delta: 'CHILD REPORT' });
    notify('item/completed', { ...cbase, item: { ...childMsg, text: `CHILD REPORT (${decision})` } });
    act('completed', childThread, '/root/find_codeword');
    notify('thread/status/changed', { threadId: childThread, status: { type: 'idle' } });
    notify('turn/completed', { threadId: childThread, turn: { id: childTurn, items: [], status: 'completed', error: null, durationMs: 10 } });
    await sleep(30);
    await say(`subagent decision: ${decision}`);
    return finish();
  }

  if (text.includes('SHELL')) {
    const cmd = text.includes('KRAKISTOP') ? 'kraki stop' : 'rm -rf build';
    await say('Let me clean the build.', 'commentary');
    const it = item('commandExecution', { command: cmd, cwd: '/tmp', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
    started(it);
    const res = await ask('item/commandExecution/requestApproval', { ...base, itemId: it.id, command: cmd, cwd: '/tmp', startedAtMs: Date.now() });
    const ok = res?.decision === 'accept' || res?.decision === 'acceptForSession';
    completed({ ...it, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'removed' : null, exitCode: ok ? 0 : null });
    await say(`shell decision: ${res?.decision}`);
    return finish();
  }

  if (text.includes('WRITE')) {
    const path = text.includes('PLAN') ? '/repo/plan.md' : '/repo/src/app.ts';
    const it = item('fileChange', { changes: [{ path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' }], status: 'inProgress' });
    started(it);
    const res = await ask('item/fileChange/requestApproval', { ...base, itemId: it.id, startedAtMs: Date.now(), reason: null });
    completed({ ...it, status: res?.decision === 'accept' ? 'completed' : 'declined' });
    await say(`write decision: ${res?.decision}`);
    return finish();
  }

  if (text.includes('ASK')) {
    await say('I need to check something.', 'commentary');
    const callId = uid('call');
    started(item('dynamicToolCall', { id: callId, tool: 'ask_user', arguments: {}, status: 'inProgress' }));
    const res = await ask('item/tool/call', { ...base, callId, tool: 'ask_user', arguments: { question: 'Which DB?', choices: ['sqlite', 'postgres'] } });
    completed(item('dynamicToolCall', { id: callId, tool: 'ask_user', status: 'completed', success: res?.success }));
    await say(`answer: ${res?.contentItems?.[0]?.text}`);
    return finish();
  }

  if (text.includes('MODE')) {
    const res = await ask('item/tool/call', { ...base, callId: uid('call'), tool: 'kraki_get_mode', arguments: { query: 'current' } });
    await say(`mode: ${res?.contentItems?.[0]?.text}`);
    return finish();
  }

  if (text.includes('IMAGE')) {
    const path = text.split('IMAGE:')[1]?.trim().split(/\s/)[0];
    const res = await ask('item/tool/call', { ...base, callId: uid('call'), tool: 'show_image', arguments: { path, caption: 'chart' } });
    await say(`image: ${res?.success}`);
    return finish();
  }

  if (text.includes('NATIVEQ')) {
    const res = await ask('item/tool/requestUserInput', { ...base, itemId: uid('item'), isBlocking: true, questions: [
      { id: 'q1', header: 'Lang', question: 'Language?', options: [{ label: 'TS', description: '' }, { label: 'Rust', description: '' }] },
      { id: 'q2', header: 'Name', question: 'Project name?', options: null },
    ] });
    await say(`native: ${JSON.stringify(res?.answers)}`);
    return finish();
  }

  if (text.includes('COMPACT')) {
    const it = item('contextCompaction', {});
    started(it); completed(it);
  }

  await say(`echo: ${text}`);
  notify('thread/tokenUsage/updated', { ...base, tokenUsage: {
    total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
    last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
    modelContextWindow: 400000 } });
  notify('thread/name/updated', { threadId, threadName: 'Echo test' });
  finish();
}
