/**
 * pi has no built-in subagents; they come from extensions that register a
 * `subagent` tool. This module turns such a tool's progress into Kraki trace
 * steps attributed to their subagent, without touching pi or the extension.
 *
 * Supported shapes (both report progress as `tool_execution_update` snapshots
 * whose `details.results[]` has one row per child):
 *  - pi's official example (`examples/extensions/subagent`): each row carries
 *    the child's full `messages` (assistant tool calls/text, tool results).
 *  - nicobailon `pi-subagents`: rows carry `toolCalls[]` text, `progress` and
 *    `finalOutput`; background (async) runs report through the documented
 *    RPC-host status snapshot (`subagent-async` widget, PI_SUBAGENT_ASYNC_JSON)
 *    and finish with a `subagent-notify` custom message.
 * Unknown shapes degrade to a plain tool step.
 *
 * Snapshots are not deltas: every update is diffed against what was already
 * emitted, so a step is reported once.
 */
import type { SubagentInfo } from '@kraki/protocol';

export const PI_SUBAGENT_TOOL = 'subagent';

export type PiSubagentEmit =
  | { kind: 'start'; toolCallId: string; toolName: string; args: Record<string, unknown>; parentToolCallId?: string; subagent?: SubagentInfo }
  | { kind: 'complete'; toolCallId: string; toolName: string; result: string; success: boolean; parentToolCallId?: string; subagent?: SubagentInfo }
  | { kind: 'narration'; content: string; parentToolCallId: string };

interface ChildState {
  /** Trace id of this child's dispatch step. */
  id: string;
  /** Synthetic (one child of a multi-child dispatch) vs. the tool call itself. */
  synthetic: boolean;
  info: SubagentInfo;
  /** Official example: child tool call ids already started / completed. */
  started: Set<string>;
  completed: Set<string>;
  /** Official example: assistant text blocks already seen (count). */
  textSeen: number;
  /** Latest prose, held until a further step proves it was narration. */
  draft?: string;
  /** pi-subagents: expandedText of toolCalls already emitted, in order. */
  callTexts: string[];
  finalOutput?: string;
}

interface DispatchState {
  toolCallId: string;
  args: Record<string, unknown>;
  children: ChildState[];
  /** Multi-child dispatch: the tool step itself is a group of subagents. */
  group: boolean;
  /** pi-subagents background run started by this call. */
  asyncRunId?: string;
  done?: boolean;
}

/** Async (background) run as seen in the host status snapshot. */
export interface PiAsyncRun {
  id: string;
  state: string;
}

const TERMINAL_RUN_STATES = new Set(['complete', 'completed', 'failed', 'stopped', 'cancelled', 'canceled', 'error', 'aborted', 'interrupted', 'timeout', 'timed_out']);

export function isTerminalRunState(state: string): boolean {
  return TERMINAL_RUN_STATES.has(state.toLowerCase());
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** First line of a task prompt, capped — a label, never the full prompt. */
export function taskLabel(text: string, max = 120): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function rowsOf(payload: unknown): Array<Record<string, unknown>> | null {
  const details = (payload as { details?: { results?: unknown } } | undefined)?.details;
  return Array.isArray(details?.results) ? details!.results as Array<Record<string, unknown>> : null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

/** Tasks named in the dispatch args, by child position (single / parallel / chain). */
function argTasks(args: Record<string, unknown>): Array<{ agent?: string; task?: string }> {
  for (const key of ['tasks', 'chain']) {
    const list = args[key];
    if (Array.isArray(list)) return list.map((t) => ({ agent: str((t as Record<string, unknown>)?.agent) || undefined, task: str((t as Record<string, unknown>)?.task) || undefined }));
  }
  return [{ agent: str(args.agent) || undefined, task: str(args.task) || undefined }];
}

/** "find {\"pattern\":\"x\"}" / "read /a/b" → a tool step name + args. */
export function parseCallText(text: string): { toolName: string; args: Record<string, unknown> } {
  const trimmed = text.trim();
  const space = trimmed.indexOf(' ');
  const toolName = (space < 0 ? trimmed : trimmed.slice(0, space)) || 'tool';
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  if (rest.startsWith('{')) {
    try {
      const parsed = JSON.parse(rest);
      if (parsed && typeof parsed === 'object') return { toolName, args: parsed as Record<string, unknown> };
    } catch { /* not JSON */ }
  }
  if (!rest) return { toolName, args: {} };
  return { toolName, args: toolName === 'bash' ? { command: rest } : { path: rest } };
}

function usageInfo(row: Record<string, unknown>): Partial<SubagentInfo> {
  const usage = row.usage as { input?: number; output?: number } | undefined;
  const progress = row.progress as { toolCount?: number; durationMs?: number } | undefined;
  const tokens = (usage?.input ?? 0) + (usage?.output ?? 0);
  return {
    ...(tokens > 0 && { tokens }),
    ...(typeof progress?.toolCount === 'number' && { toolCount: progress.toolCount }),
    ...(typeof progress?.durationMs === 'number' && { durationMs: progress.durationMs }),
  };
}

export class PiSubagentTracker {
  /** Reads a child's saved output (the file a notification points at). */
  constructor(private readonly readOutput?: (path: string) => string | undefined) {}

  private dispatches = new Map<string, DispatchState>();
  /** Background runs by run id → dispatching tool call. */
  private asyncRuns = new Map<string, string>();
  /** Background runs already notified (the snapshot may still list them). */
  private finishedRuns = new Set<string>();
  /** Latest host snapshot of background runs (pi-subagents). */
  private snapshot: PiAsyncRun[] | null = null;

  isSubagentTool(toolName: string): boolean {
    return toolName === PI_SUBAGENT_TOOL;
  }

  /** A `subagent` tool call started. Returns the info for its own step. */
  onStart(toolCallId: string, args: Record<string, unknown>): SubagentInfo | undefined {
    // Management calls (list/status/doctor…) are not subagents.
    if (typeof args.action === 'string') return undefined;
    const tasks = argTasks(args);
    const group = tasks.length > 1 || args.workflow !== undefined;
    const d: DispatchState = { toolCallId, args, children: [], group };
    this.dispatches.set(toolCallId, d);
    if (group) {
      const mode = Array.isArray(args.chain) ? 'chain' : args.workflow !== undefined ? 'workflow' : 'parallel';
      return { name: mode, task: tasks.length > 1 ? `${tasks.length} subagents` : undefined, status: 'running' };
    }
    const t = tasks[0];
    return { name: t.agent || 'subagent', ...(t.task && { task: taskLabel(t.task) }), status: 'running' };
  }

  /** A progress snapshot (`tool_execution_update.partialResult`). */
  onUpdate(toolCallId: string, partialResult: unknown): PiSubagentEmit[] {
    const d = this.dispatches.get(toolCallId);
    const rows = rowsOf(partialResult);
    if (!d || !rows) return [];
    return this.apply(d, rows, false);
  }

  /** The tool finished. Returns step emits plus the dispatch's final info. */
  onEnd(toolCallId: string, result: unknown, isError: boolean): { emits: PiSubagentEmit[]; subagent?: SubagentInfo; async?: boolean } {
    const d = this.dispatches.get(toolCallId);
    if (!d) return { emits: [] };
    const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
    const text = textOf((result as { content?: unknown } | undefined)?.content);
    const runId = str(details?.runId) || str(details?.asyncId);
    // A background launch: the tool only returns a receipt; the run reports later.
    if (!isError && runId && (d.args.async === true || /\bAsync\b/.test(text))) {
      d.asyncRunId = runId;
      this.asyncRuns.set(runId, toolCallId);
      return { emits: [], async: true };
    }
    const rows = rowsOf(result) ?? [];
    const emits = this.apply(d, rows, true, isError);
    d.done = true;
    const info = this.dispatchInfo(d, isError ? 'failed' : 'completed');
    if (!d.group) this.dispatches.delete(toolCallId);
    return { emits, subagent: info };
  }

  /** Host status snapshot (PI_SUBAGENT_ASYNC_JSON). Returns child card updates. */
  onAsyncSnapshot(payload: unknown): PiSubagentEmit[] {
    const runs = (payload as { runs?: unknown } | undefined)?.runs;
    if (!Array.isArray(runs)) return [];
    this.snapshot = runs.map((r) => ({ id: str((r as Record<string, unknown>).id), state: str((r as Record<string, unknown>).state) }));
    const emits: PiSubagentEmit[] = [];
    for (const run of runs as Array<Record<string, unknown>>) {
      const toolCallId = this.asyncRuns.get(str(run.id));
      const d = toolCallId ? this.dispatches.get(toolCallId) : undefined;
      if (!d || d.done) continue;
      const children = Array.isArray(run.children) ? run.children as Array<Record<string, unknown>> : [];
      if (!d.group) {
        // A single background subagent: its step is the tool call itself.
        const activity = (children[0]?.activity ?? run.activity) as { toolCount?: number } | undefined;
        if (typeof activity?.toolCount === 'number') {
          const prev = this.singleInfo(d);
          d.children[0] = { ...(d.children[0] ?? this.newChild(d.toolCallId, false, prev)), info: { ...prev, toolCount: activity.toolCount } };
        }
        continue;
      }
      children.forEach((c, i) => {
        const id = `${toolCallId}#${str(c.id) || i}`;
        let child = d.children.find((x) => x.id === id);
        const state = str(c.state);
        const status: SubagentInfo['status'] = isTerminalRunState(state) ? (/fail|error/.test(state) ? 'failed' : /stop|cancel|abort|interrupt/.test(state) ? 'stopped' : 'completed') : 'running';
        const activity = c.activity as { toolCount?: number } | undefined;
        const info: SubagentInfo = { name: str(c.label) || str(c.id) || 'subagent', status, ...(typeof activity?.toolCount === 'number' && { toolCount: activity.toolCount }) };
        if (!child) {
          child = this.newChild(id, true, info);
          d.children.push(child);
          emits.push({ kind: 'start', toolCallId: id, toolName: PI_SUBAGENT_TOOL, args: { agent: info.name }, parentToolCallId: toolCallId, subagent: info });
        }
        const wasRunning = child.info.status === 'running';
        child.info = { ...child.info, ...info };
        if (wasRunning && status !== 'running') {
          emits.push({ kind: 'complete', toolCallId: id, toolName: PI_SUBAGENT_TOOL, result: '', success: status === 'completed', parentToolCallId: toolCallId, subagent: child.info });
        }
      });
    }
    return emits;
  }

  /** `subagent-notify` (background run finished). Completes its dispatch with
   *  the notification text as the report. */
  onAsyncNotify(content: string): PiSubagentEmit[] {
    let toolCallId: string | undefined;
    for (const [runId, id] of this.asyncRuns) {
      if (content.includes(runId)) { toolCallId = id; break; }
    }
    // A plain single-run notification does not name the run: take the oldest
    // background dispatch still open.
    if (!toolCallId) {
      for (const id of this.asyncRuns.values()) {
        if (!this.dispatches.get(id)?.done) { toolCallId = id; break; }
      }
    }
    const d = toolCallId ? this.dispatches.get(toolCallId) : undefined;
    if (!d || d.done || !toolCallId) return [];
    d.done = true;
    if (d.asyncRunId) { this.asyncRuns.delete(d.asyncRunId); this.finishedRuns.add(d.asyncRunId); }
    const failed = /\b(failed|error)\b/i.test(content.split('\n')[0] ?? '');
    const emits: PiSubagentEmit[] = [];
    for (const child of d.children) {
      if (!child.synthetic || child.info.status !== 'running') continue;
      child.info = { ...child.info, status: failed ? 'failed' : 'completed' };
      emits.push({ kind: 'complete', toolCallId: child.id, toolName: PI_SUBAGENT_TOOL, result: '', success: !failed, parentToolCallId: toolCallId, subagent: child.info });
    }
    emits.push({ kind: 'complete', toolCallId, toolName: PI_SUBAGENT_TOOL, result: content, success: !failed, subagent: this.dispatchInfo(d, failed ? 'failed' : 'completed') });
    this.dispatches.delete(toolCallId);
    return emits;
  }

  /** `subagent-incremental-child-notify`: one child of a background workflow
   *  finished — its notification text is that child's report. */
  onChildNotify(content: string): PiSubagentEmit[] {
    const key = /\*\*([^*]+)\*\*/.exec(content)?.[1];
    if (!key) return [];
    for (const [runId, toolCallId] of this.asyncRuns) {
      if (!content.includes(runId)) continue;
      const d = this.dispatches.get(toolCallId);
      const child = d?.children.find((c) => c.id === `${toolCallId}#${key}`);
      if (!d || !child || child.completed.has('__report__')) return [];
      child.completed.add('__report__');
      const failed = /\bStatus:\s*(failed|error)/i.test(content);
      child.info = { ...child.info, status: failed ? 'failed' : 'completed' };
      // The notification points at the child's saved output — its actual report.
      const outputPath = /^Output:\s*(\S.*)$/m.exec(content)?.[1]?.trim();
      const report = (outputPath && this.readOutput?.(outputPath)?.trim()) || content;
      return [{ kind: 'complete', toolCallId: child.id, toolName: PI_SUBAGENT_TOOL, result: report, success: !failed, parentToolCallId: toolCallId, subagent: child.info }];
    }
    return [];
  }

  /** Background runs still working, per the latest snapshot (authoritative)
   *  or, before any snapshot, the launches not yet notified. */
  activeAsyncRuns(): number {
    if (this.snapshot) {
      const live = this.snapshot.filter((r) => !isTerminalRunState(r.state) && !this.finishedRuns.has(r.id)).length;
      // A launch not yet listed in the snapshot is still pending.
      let unlisted = 0;
      for (const [runId, id] of this.asyncRuns) {
        if (!this.dispatches.get(id)?.done && !this.snapshot.some((r) => r.id === runId)) unlisted++;
      }
      return live + unlisted;
    }
    let n = 0;
    for (const id of this.asyncRuns.values()) if (!this.dispatches.get(id)?.done) n++;
    return n;
  }

  /** Background runs launched but not yet notified (owed a completion). */
  pendingAsyncRunIds(): string[] {
    return [...this.asyncRuns.entries()].filter(([, id]) => !this.dispatches.get(id)?.done).map(([runId]) => runId);
  }

  reset(): void {
    this.dispatches.clear();
    this.asyncRuns.clear();
    this.finishedRuns.clear();
    this.snapshot = null;
  }

  // ── internals ──

  private newChild(id: string, synthetic: boolean, info: SubagentInfo): ChildState {
    return { id, synthetic, info, started: new Set(), completed: new Set(), textSeen: 0, callTexts: [] };
  }

  private singleInfo(d: DispatchState): SubagentInfo {
    const t = argTasks(d.args)[0];
    return d.children[0]?.info ?? { name: t.agent || 'subagent', ...(t.task && { task: taskLabel(t.task) }), status: 'running' };
  }

  private dispatchInfo(d: DispatchState, status: NonNullable<SubagentInfo['status']>): SubagentInfo {
    if (!d.group) return { ...this.singleInfo(d), status };
    const tasks = argTasks(d.args);
    const mode = Array.isArray(d.args.chain) ? 'chain' : d.args.workflow !== undefined ? 'workflow' : 'parallel';
    const n = Math.max(tasks.length, d.children.length);
    return { name: mode, ...(n > 1 && { task: `${n} subagents` }), status };
  }

  private apply(d: DispatchState, rows: Array<Record<string, unknown>>, final: boolean, isError = false): PiSubagentEmit[] {
    const emits: PiSubagentEmit[] = [];
    const tasks = argTasks(d.args);
    rows.forEach((row, i) => {
      const index = typeof row.index === 'number' ? row.index : i;
      const argTask = tasks[index] ?? {};
      const rowTask = str(row.task);
      const task = argTask.task || (rowTask && rowTask !== '[prompt redacted]' ? rowTask.replace(/^Task:\s*/, '') : '');
      const name = str(row.agent) || argTask.agent || 'subagent';
      const exit = typeof row.exitCode === 'number' ? row.exitCode : undefined;
      const progressStatus = str((row.progress as { status?: unknown } | undefined)?.status);
      // Official example: a child's last assistant stopReason ('toolUse' while
      // it works; 'stop' / 'error' / 'aborted' once it is done).
      const stopReason = str(row.stopReason);
      const childDone = exit !== -1 && ['stop', 'error', 'aborted', 'length'].includes(stopReason);
      const finished = final || childDone || (!!progressStatus && isTerminalRunState(progressStatus)) || (exit !== undefined && exit > 0);
      const failed = (final && isError) || (exit !== undefined && exit > 0) || stopReason === 'error' || stopReason === 'aborted' || /fail|error/.test(progressStatus);
      const status: SubagentInfo['status'] = finished ? (failed ? 'failed' : 'completed') : 'running';
      const info: SubagentInfo = { name, ...(task && { task: taskLabel(task) }), status, ...usageInfo(row) };

      let child = d.children[index];
      if (!child) {
        if (d.group) {
          // A queued parallel child (official example: exitCode -1, no messages)
          // appears once it starts working.
          if (exit === -1 && !(Array.isArray(row.messages) && row.messages.length > 0) && !final) return;
          child = this.newChild(`${d.toolCallId}#${index}`, true, info);
          emits.push({ kind: 'start', toolCallId: child.id, toolName: PI_SUBAGENT_TOOL, args: { agent: name, ...(task && { task }) }, parentToolCallId: d.toolCallId, subagent: info });
        } else {
          child = this.newChild(d.toolCallId, false, info);
        }
        d.children[index] = child;
      }
      child.info = { ...child.info, ...info };
      const parent = child.id;

      // Official example: full child messages.
      if (Array.isArray(row.messages)) {
        let textCount = 0;
        for (const m of row.messages as Array<Record<string, unknown>>) {
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                textCount++;
                if (textCount > child.textSeen) {
                  child.textSeen = textCount;
                  child.draft = child.draft ? `${child.draft}\n${block.text}` : block.text;
                }
              } else if (block.type === 'toolCall' && typeof block.id === 'string' && !child.started.has(block.id)) {
                child.started.add(block.id);
                this.flushDraft(child, emits);
                emits.push({ kind: 'start', toolCallId: `${parent}:${block.id}`, toolName: str(block.name) || 'tool', args: (block.arguments as Record<string, unknown>) ?? {}, parentToolCallId: parent });
              }
            }
          } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string' && child.started.has(m.toolCallId) && !child.completed.has(m.toolCallId)) {
            child.completed.add(m.toolCallId);
            emits.push({ kind: 'complete', toolCallId: `${parent}:${m.toolCallId}`, toolName: str(m.toolName) || 'tool', result: textOf(m.content), success: m.isError !== true, parentToolCallId: parent });
          }
        }
      }

      // pi-subagents: tool call summaries (no results).
      if (Array.isArray(row.toolCalls)) {
        const texts = (row.toolCalls as Array<{ text?: string; expandedText?: string }>).map((c) => str(c.expandedText) || str(c.text)).filter(Boolean);
        let from = child.callTexts.length;
        if (texts.length < from || (from > 0 && texts[from - 1] !== child.callTexts[from - 1])) {
          // A sliding window: resume after the last call already shown.
          const last = child.callTexts[child.callTexts.length - 1];
          const at = texts.lastIndexOf(last);
          from = at >= 0 ? at + 1 : texts.length;
        }
        for (const text of texts.slice(from)) {
          const n = child.callTexts.length;
          child.callTexts.push(text);
          const call = parseCallText(text);
          const id = `${parent}:call-${n}`;
          emits.push({ kind: 'start', toolCallId: id, ...call, parentToolCallId: parent });
          emits.push({ kind: 'complete', toolCallId: id, toolName: call.toolName, result: '', success: true, parentToolCallId: parent });
        }
      }
      if (typeof row.finalOutput === 'string') child.finalOutput = row.finalOutput;

      if (finished && child.synthetic && !child.completed.has('__self__')) {
        child.completed.add('__self__');
        // Close child tools that never reported back.
        for (const id of child.started) {
          if (child.completed.has(id)) continue;
          child.completed.add(id);
          emits.push({ kind: 'complete', toolCallId: `${parent}:${id}`, toolName: 'tool', result: '', success: false, parentToolCallId: parent });
        }
        const report = child.finalOutput ?? child.draft ?? '';
        child.draft = undefined;
        emits.push({ kind: 'complete', toolCallId: child.id, toolName: PI_SUBAGENT_TOOL, result: report, success: status === 'completed', parentToolCallId: d.toolCallId, subagent: child.info });
      } else if (finished && !child.synthetic) {
        // The tool's own result is the report; the trailing prose is not a step.
        child.draft = undefined;
      }
    });
    return emits;
  }

  private flushDraft(child: ChildState, emits: PiSubagentEmit[]): void {
    if (!child.draft) return;
    emits.push({ kind: 'narration', content: child.draft, parentToolCallId: child.id });
    child.draft = undefined;
  }
}
