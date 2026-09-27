/**
 * Kraki permission policy — the ONE place that decides whether the operator
 * is asked before an agent acts. Every adapter (Claude, Codex, Copilot, Pi)
 * classifies a tool call into a coarse kind and asks this module.
 *
 *  safe      ask before anything with side effects (file changes, shell,
 *            MCP / external tools); reads, searches, fetches run freely.
 *  auto      never ask (default).
 *  delegate  never ask; the agent's own questions are auto-answered.
 *
 * The user's local agent configuration still applies in one direction only:
 * local DENY rules keep blocking, local ALLOW / "always allow" rules never
 * bypass a Kraki `safe` prompt. "Always allow" clicked in Kraki is scoped to
 * the session and never written back to the agent's config.
 */

import { normalizeSessionMode, type SessionMode } from '@kraki/protocol';

export type { SessionMode };

/** Coarse tool classification shared by all adapters. */
export type ToolKind =
  | 'read'   // read files, list, search, grep, view images
  | 'url'    // fetch / web search (read-only network)
  | 'meta'   // agent bookkeeping with no side effects (todo lists, subagents)
  | 'write'  // create / edit / delete files
  | 'shell'  // run commands
  | 'mcp'    // MCP / external tools (arbitrary side effects)
  | 'other'; // anything unknown — treated as a side effect

const NO_SIDE_EFFECT: ReadonlySet<ToolKind> = new Set(['read', 'url', 'meta']);

/** True when Kraki lets the call run without asking the operator. */
export function krakiAutoApproves(mode: SessionMode, kind: ToolKind): boolean {
  // Defensive: a legacy name reaching here must never silently mean `safe`.
  const m = normalizeSessionMode(mode);
  if (m === 'auto' || m === 'delegate') return true;
  return NO_SIDE_EFFECT.has(kind);
}

/** Answer Kraki gives to an agent question in delegate mode. */
export const DELEGATE_ANSWER = 'proceed with your best judgment';

/** Out-of-band prefix on the next user message after a mode switch. */
export function modeChangeSignal(mode: SessionMode): string {
  return `[kraki: mode changed to ${mode}]`;
}

/** Shared description of the modes, embedded in every agent's system prompt. */
export const KRAKI_MODES_PROMPT = [
  'Your tool calls go through Kraki\'s permission system. There are three modes;',
  'sessions start in `auto`.',
  '',
  '- **safe**: the operator must approve every file change, shell command and',
  '  external/MCP tool before it runs; reads and searches run freely. Say what',
  '  you intend to do before such an action so the operator can decide.',
  '- **auto**: everything runs without approval. Work efficiently; if unsure',
  '  about intent or approach, ask the operator before proceeding.',
  '- **delegate**: everything runs without approval, and questions you ask are',
  '  auto-answered with "proceed with your best judgment" — do not re-ask; make',
  '  a reasonable call and continue.',
  '',
  'When the operator switches modes, the next user message starts with',
  '`[kraki: mode changed to <mode>]`. Treat it as out-of-band metadata: silently',
  'adopt the new mode, do not acknowledge or quote it. The text after it is the',
  'real user message.',
].join('\n');
