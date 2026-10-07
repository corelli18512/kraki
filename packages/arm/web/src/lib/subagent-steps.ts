import type { SubagentInfo } from '@kraki/protocol';
import type { ChatMessage } from '../types/store';

/**
 * A turn's TRACE steps with subagents (see protocol `SubagentInfo`):
 *  - tool_start → tool_complete merge by toolCallId; a later tool_complete for
 *    the same id replaces an earlier one (a background subagent completes
 *    twice: launch receipt, then report).
 *  - a dispatch step (one carrying `subagent`) keeps the position where it
 *    started, so its card sits where the agent delegated.
 *  - steps carrying `parentToolCallId` belong to that subagent's page.
 */

type Payload = { toolCallId?: string; parentToolCallId?: string; subagent?: SubagentInfo };

const payloadOf = (m: ChatMessage): Payload => (m.payload ?? {}) as Payload;

export const parentOf = (m: ChatMessage): string | undefined => payloadOf(m).parentToolCallId;
export const subagentOf = (m: ChatMessage): SubagentInfo | undefined => payloadOf(m).subagent;
export const callIdOf = (m: ChatMessage): string | undefined => payloadOf(m).toolCallId;

/** Merge tool lifecycles. Non-dispatch tools keep the existing contract (a
 *  finished tool sits at its completion position); dispatches stay put. */
export function mergeSteps(messages: ChatMessage[]): ChatMessage[] {
  const lastComplete = new Map<string, ChatMessage>();
  const startInfo = new Map<string, SubagentInfo>();
  for (const m of messages) {
    const id = callIdOf(m);
    if (!id) continue;
    if (m.type === 'tool_complete') lastComplete.set(id, m);
    if (m.type === 'tool_start' && subagentOf(m)) startInfo.set(id, subagentOf(m)!);
  }
  const out: ChatMessage[] = [];
  const placed = new Set<string>();
  for (const m of messages) {
    const id = callIdOf(m);
    if (!id || (m.type !== 'tool_start' && m.type !== 'tool_complete')) {
      out.push(m);
      continue;
    }
    if (placed.has(id)) continue;
    const done = lastComplete.get(id);
    const isDispatch = startInfo.has(id) || (done && subagentOf(done));
    if (m.type === 'tool_start' && done && !isDispatch) continue; // shown at completion
    placed.add(id);
    const shown = done ?? m;
    const info = startInfo.has(id) || subagentOf(shown)
      ? { ...startInfo.get(id), ...subagentOf(shown) } as SubagentInfo
      : undefined;
    out.push(info ? { ...shown, payload: { ...shown.payload, subagent: info } } as ChatMessage : shown);
  }
  return out;
}

/** Steps shown on one page: the turn's own (`parent` undefined) or one
 *  subagent's. A step whose parent is not in this trace shows at the top. */
export function stepsUnder(merged: ChatMessage[], parent?: string): ChatMessage[] {
  const ids = new Set(merged.map(callIdOf).filter(Boolean) as string[]);
  return merged.filter((m) => {
    const p = parentOf(m);
    return parent === undefined ? !p || !ids.has(p) : p === parent;
  });
}

/** A step opens a subagent page when it dispatched one or has steps under it. */
export function isSubagentStep(merged: ChatMessage[], m: ChatMessage): boolean {
  if (m.type !== 'tool_start' && m.type !== 'tool_complete') return false;
  if (subagentOf(m)) return true;
  const id = callIdOf(m);
  return !!id && merged.some((x) => parentOf(x) === id);
}

/** Tool steps a subagent took (its own page; nested subagents not counted). */
export function subagentStepCount(merged: ChatMessage[], id: string): number {
  return merged.filter((m) => parentOf(m) === id && (m.type === 'tool_start' || m.type === 'tool_complete') && !isSubagentStep(merged, m)).length;
}

/** Subagents started under this one (a group dispatch, or nesting). */
export function childSubagentCount(merged: ChatMessage[], id: string): number {
  return merged.filter((m) => parentOf(m) === id && isSubagentStep(merged, m)).length;
}

/** "3 steps" / "2 subagents" / "1 subagent · 2 steps". */
export function contentsLabel(merged: ChatMessage[], id: string): string | undefined {
  const steps = subagentStepCount(merged, id);
  const subs = childSubagentCount(merged, id);
  const parts = [
    subs ? `${subs} subagent${subs === 1 ? '' : 's'}` : undefined,
    steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function subagentStatus(m: ChatMessage): NonNullable<SubagentInfo['status']> {
  const p = m.payload as { success?: boolean; termination?: string };
  const status = subagentOf(m)?.status;
  if (status && status !== 'running') return status;
  if (m.type === 'tool_start') return 'running';
  if (p.termination === 'cancelled') return 'stopped';
  if (p.success === false || p.termination) return 'failed';
  return status ?? 'completed';
}

export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatTokens(n?: number): string | undefined {
  if (n === undefined) return undefined;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tokens` : `${n} tokens`;
}
