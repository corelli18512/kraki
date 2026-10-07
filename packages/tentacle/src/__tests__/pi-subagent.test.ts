/**
 * pi subagent extensions → Kraki subagent steps. Event shapes follow live
 * traces: pi 0.87.1 with the official `examples/extensions/subagent` and with
 * nicobailon `pi-subagents` 0.76.1 (sync, parallel, background workflow).
 */
import { describe, expect, it } from 'vitest';
import { PiSubagentTracker, parseCallText, type PiSubagentEmit } from '../adapters/pi-subagent.js';

const D = 'call_D';
const summary = (emits: PiSubagentEmit[]) => emits.map((e) => e.kind === 'narration'
  ? `narr ${e.parentToolCallId} ${e.content}`
  : `${e.kind} ${e.toolName} ${e.toolCallId} <- ${e.parentToolCallId ?? '-'}${e.subagent ? ` [${e.subagent.name}:${e.subagent.status}]` : ''}${e.kind === 'complete' && e.result ? ` = ${e.result}` : ''}`);

// Official example: details.results[].messages carry the whole child conversation.
const official = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: '(running...)' }],
  details: { mode: 'single', results: [{ agent: 'scout', task: 'Find CODEWORD', exitCode: 0, messages, usage: { input: 200, output: 40 }, ...extra }] },
});
const toolCall = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const toolResult = (id: string, name: string, text: string) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }] });
const say = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

describe('PiSubagentTracker — official example', () => {
  it('single: steps under the tool call; the closing prose is the report, not a step', () => {
    const t = new PiSubagentTracker();
    expect(t.onStart(D, { agent: 'scout', task: 'Find CODEWORD\nand more' })).toEqual({ name: 'scout', task: 'Find CODEWORD', status: 'running' });
    const user = { role: 'user', content: [{ type: 'text', text: 'Task: Find CODEWORD' }] };
    const out = [
      ...t.onUpdate(D, official([user, say('I will grep.'), toolCall('g', 'grep', { pattern: 'CODEWORD' })])),
      // Snapshots repeat everything: nothing is emitted twice.
      ...t.onUpdate(D, official([user, say('I will grep.'), toolCall('g', 'grep', { pattern: 'CODEWORD' })])),
      ...t.onUpdate(D, official([user, say('I will grep.'), toolCall('g', 'grep', { pattern: 'CODEWORD' }), toolResult('g', 'grep', 'config.ts:1')])),
      ...t.onUpdate(D, official([user, say('I will grep.'), toolCall('g', 'grep', { pattern: 'CODEWORD' }), toolResult('g', 'grep', 'config.ts:1'), say('Found it in config.ts')], { stopReason: 'stop' })),
    ];
    const end = t.onEnd(D, official([], { stopReason: 'stop' }), false);
    expect(summary([...out, ...end.emits])).toEqual([
      `narr ${D} I will grep.`,
      `start grep ${D}:g <- ${D}`,
      `complete grep ${D}:g <- ${D} = config.ts:1`,
    ]);
    expect(end.subagent).toMatchObject({ name: 'scout', status: 'completed', tokens: 240 });
  });

  it('parallel: one synthetic subagent per task, each completing with its report', () => {
    const t = new PiSubagentTracker();
    expect(t.onStart(D, { tasks: [{ agent: 'scout', task: 'A' }, { agent: 'scout', task: 'B' }] })).toEqual({ name: 'parallel', task: '2 subagents', status: 'running' });
    const rows = (a: unknown[], b: unknown[], stopA?: string, stopB?: string, exitB = 0) => ({
      details: { mode: 'parallel', results: [
        { agent: 'scout', task: 'A', exitCode: 0, messages: a, stopReason: stopA },
        { agent: 'scout', task: 'B', exitCode: exitB, messages: b, stopReason: stopB },
      ] },
    });
    const out = [
      ...t.onUpdate(D, rows([toolCall('x', 'bash', { command: 'ls' })], [], undefined, undefined, -1)),
      ...t.onUpdate(D, rows([toolCall('x', 'bash', { command: 'ls' }), toolResult('x', 'bash', 'ok'), say('A done')], [toolCall('y', 'read', { path: 'f' })], 'stop')),
    ];
    const end = t.onEnd(D, rows([toolCall('x', 'bash', { command: 'ls' }), toolResult('x', 'bash', 'ok'), say('A done')], [toolCall('y', 'read', { path: 'f' }), toolResult('y', 'read', 'txt'), say('B done')], 'stop', 'stop'), false);
    expect(summary([...out, ...end.emits])).toEqual([
      `start subagent ${D}#0 <- ${D} [scout:running]`,
      `start bash ${D}#0:x <- ${D}#0`,
      `complete bash ${D}#0:x <- ${D}#0 = ok`,
      `complete subagent ${D}#0 <- ${D} [scout:completed] = A done`,
      `start subagent ${D}#1 <- ${D} [scout:running]`,
      `start read ${D}#1:y <- ${D}#1`,
      `complete read ${D}#1:y <- ${D}#1 = txt`,
      `complete subagent ${D}#1 <- ${D} [scout:completed] = B done`,
    ]);
    expect(end.subagent).toEqual({ name: 'parallel', task: '2 subagents', status: 'completed' });
  });

  it('management actions are not subagents', () => {
    const t = new PiSubagentTracker();
    expect(t.onStart(D, { action: 'list', capabilities: true })).toBeUndefined();
    expect(t.onEnd(D, { content: [] }, false)).toEqual({ emits: [] });
  });
});

describe('PiSubagentTracker — pi-subagents', () => {
  const row = (calls: string[], extra: Record<string, unknown> = {}) => ({
    details: { mode: 'single', results: [{ index: 0, agent: 'scout', task: '[prompt redacted]', exitCode: 0, toolCalls: calls.map((c) => ({ text: c.slice(0, 20), expandedText: c })), usage: { input: 1000, output: 100 }, ...extra }] },
  });

  it('single: tool call summaries become steps; task comes from the call args', () => {
    const t = new PiSubagentTracker();
    t.onStart(D, { agent: 'scout', task: 'Find CODEWORD', async: false });
    const out = [
      ...t.onUpdate(D, row(['find {"pattern":"**/*"}'], { progress: { status: 'running', toolCount: 1, durationMs: 3000 } })),
      ...t.onUpdate(D, row(['find {"pattern":"**/*"}', 'read /tmp/a.ts'], { progress: { status: 'running', toolCount: 2, durationMs: 5000 } })),
    ];
    const end = t.onEnd(D, row(['find {"pattern":"**/*"}', 'read /tmp/a.ts'], { finalOutput: 'a.ts: x', progress: { toolCount: 2, durationMs: 6000 } }), false);
    expect(summary([...out, ...end.emits])).toEqual([
      `start find ${D}:call-0 <- ${D}`, `complete find ${D}:call-0 <- ${D}`,
      `start read ${D}:call-1 <- ${D}`, `complete read ${D}:call-1 <- ${D}`,
    ]);
    expect(end.subagent).toEqual({ name: 'scout', task: 'Find CODEWORD', status: 'completed', tokens: 1100, toolCount: 2, durationMs: 6000 });
  });

  it('background workflow: receipt keeps the step open; snapshot children; notify completes it', () => {
    const t = new PiSubagentTracker();
    t.onStart(D, { workflow: true, async: true });
    const receipt = t.onEnd(D, { content: [{ type: 'text', text: 'Async workflow [run-1]\nThe async run is detached' }], details: { mode: 'workflow', runId: 'run-1' } }, false);
    expect(receipt).toEqual({ emits: [], async: true });
    expect(t.activeAsyncRuns()).toBe(1);
    const snap = (codeword: string, count: string) => ({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'run-1', kind: 'workflow', state: 'running', children: [
      { id: 'codeword', label: 'Find codeword', state: codeword, activity: { toolCount: 2 } },
      { id: 'count', label: 'Count files', state: count },
    ] }] });
    const out = [
      ...t.onAsyncSnapshot(snap('running', 'running')),
      ...t.onAsyncSnapshot(snap('running', 'complete')),
      ...t.onChildNotify('Workflow child completed: **count**\nWorkflow run: run-1\nStatus: complete\n2 files'),
      ...t.onAsyncNotify('Background task completed: **workflow**\nWorkflow run-1 completed with 2 child run(s).'),
    ];
    expect(summary(out)).toEqual([
      `start subagent ${D}#codeword <- ${D} [Find codeword:running]`,
      `start subagent ${D}#count <- ${D} [Count files:running]`,
      `complete subagent ${D}#count <- ${D} [Count files:completed]`,
      `complete subagent ${D}#count <- ${D} [Count files:completed] = Workflow child completed: **count**\nWorkflow run: run-1\nStatus: complete\n2 files`,
      `complete subagent ${D}#codeword <- ${D} [Find codeword:completed]`,
      `complete subagent ${D} <- - [workflow:completed] = Background task completed: **workflow**\nWorkflow run-1 completed with 2 child run(s).`,
    ]);
    // The snapshot still lists the run as running for a moment after notify.
    t.onAsyncSnapshot(snap('running', 'complete'));
    expect(t.activeAsyncRuns()).toBe(0);
  });

  it('a workflow child report is its saved output file when the notification points at one', () => {
    const t = new PiSubagentTracker((path) => path === '/out/codeword.md' ? 'src/a.ts: purple\n' : undefined);
    t.onStart(D, { workflow: true, async: true });
    t.onEnd(D, { content: [{ type: 'text', text: 'Async workflow [run-1]' }], details: { runId: 'run-1' } }, false);
    t.onAsyncSnapshot({ runs: [{ id: 'run-1', state: 'running', children: [{ id: 'codeword', label: 'Find codeword', state: 'running' }] }] });
    const out = t.onChildNotify('Workflow child completed: **codeword**\nWorkflow run: run-1\nOutput: /out/codeword.md\nStatus: workflow still running');
    expect(out).toEqual([expect.objectContaining({ kind: 'complete', toolCallId: `${D}#codeword`, result: 'src/a.ts: purple' })]);
  });

  it('a single background run is matched by its notification even without a run id', () => {
    const t = new PiSubagentTracker();
    t.onStart(D, { agent: 'scout', task: 'T', async: true });
    t.onEnd(D, { content: [{ type: 'text', text: 'Async: scout [run-9]' }], details: { runId: 'run-9' } }, false);
    expect(t.pendingAsyncRunIds()).toEqual(['run-9']);
    expect(summary(t.onAsyncNotify('Background task completed: **scout**\n\nfound it'))).toEqual([
      `complete subagent ${D} <- - [scout:completed] = Background task completed: **scout**\n\nfound it`,
    ]);
    expect(t.activeAsyncRuns()).toBe(0);
  });
});

describe('parseCallText', () => {
  it('maps pi-subagents call summaries to tool name + args', () => {
    expect(parseCallText('grep {"pattern":"X","path":"."}')).toEqual({ toolName: 'grep', args: { pattern: 'X', path: '.' } });
    expect(parseCallText('read /a/b.ts')).toEqual({ toolName: 'read', args: { path: '/a/b.ts' } });
    expect(parseCallText('bash ls -la')).toEqual({ toolName: 'bash', args: { command: 'ls -la' } });
    expect(parseCallText('ls')).toEqual({ toolName: 'ls', args: {} });
  });
});

describe('readSubagentOutput', () => {
  it('reads only small pi-subagents artifact files', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readSubagentOutput } = await import('../adapters/pi.js');
    const root = mkdtempSync(join(tmpdir(), 'kraki-pisub-'));
    const dir = join(root, 'subagent-artifacts', 'outputs', 'run-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codeword.md'), 'src/a.ts: purple\n');
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(70_000));
    writeFileSync(join(root, 'secret.md'), 'nope');
    expect(readSubagentOutput(join(dir, 'codeword.md'))).toBe('src/a.ts: purple\n');
    expect(readSubagentOutput(join(dir, 'big.md'))).toBeUndefined();
    expect(readSubagentOutput(join(root, 'secret.md'))).toBeUndefined();
    expect(readSubagentOutput(`${dir}/../../../secret.md`)).toBeUndefined();
    expect(readSubagentOutput('subagent-artifacts/outputs/x.md')).toBeUndefined();
  });
});
