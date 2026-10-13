/** Pi tools by permission mode: which tools run without asking, and how a permission request is described. */

import type { ToolArgs } from '@kraki/protocol';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { krakiAutoApproves, type SessionMode, type ToolKind } from './permission-policy.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Section 2 — adapter: pools one PiRpcProcess per Kraki session
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = SessionMode;
export const MUTATING_DEFAULT_MODE: Mode = DEFAULT_SESSION_MODE;

/** pi tool names → Kraki policy kinds. pi's built-ins are read/bash/edit/write
 *  plus grep/find/ls; anything from a user extension is treated as a side
 *  effect unless it is plainly read-only. */
export function piToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
    case 'grep':
    case 'find':
    case 'ls':
    case 'view_image':
    case 'memory_search':
      return 'read';
    case 'edit':
    case 'write':
      return 'write';
    case 'bash':
      return 'shell';
    default:
      return 'other';
  }
}

/** Kraki's shared permission policy for a pi tool call. Returns true when the
 *  call should run silently (no card). */
export function shouldAutoApprove(mode: Mode, toolName: string, input: Record<string, unknown> = {}): boolean {
  return krakiAutoApproves(mode, piSubagentToolKind(toolName, input) ?? piToolKind(toolName));
}

/** Read-only `subagent` management actions (pi-subagents). */
export const PI_SUBAGENT_READ_ACTIONS = new Set(['list', 'status', 'guide', 'doctor', 'cost', 'inspect']);

/** Subagent extension bookkeeping that has no side effects. Launching a
 *  subagent stays a side effect: Kraki cannot ask before each of the child's
 *  own steps, so the launch itself is what `safe` asks about. */
export function piSubagentToolKind(toolName: string, input: Record<string, unknown>): ToolKind | undefined {
  if (toolName === 'subagents_enable') return 'meta';
  if (toolName === 'subagent' && typeof input.action === 'string' && PI_SUBAGENT_READ_ACTIONS.has(input.action)) return 'read';
  return undefined;
}

export function toolsForMode(_mode: Mode): string[] | undefined {
  // Full tool set in every mode (undefined = pi default set). Mutating calls in
  // safe are gated per-call by the permission-gate extension instead of
  // being stripped, so pi can still write/bash after the user approves.
  return undefined;
}

/** Map a pi tool name + JSON-encoded input (as delivered by the permission-gate
 *  extension's confirm request) into a Kraki permission card. Known pi tools are
 *  normalized to the shared ToolArgs shapes; anything else falls back to the
 *  raw name + args so the card still renders. */
export function parsePiPermission(toolName: string, inputJson: string): { toolArgs: ToolArgs; description: string } {
  let input: Record<string, unknown> = {};
  try {
    const parsed = inputJson ? JSON.parse(inputJson) : {};
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  } catch {
    /* leave input empty on malformed JSON */
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (toolName) {
    case 'bash': {
      const command = str(input.command);
      return { toolArgs: { toolName: 'shell', args: { command } }, description: command || 'Run a shell command' };
    }
    case 'write': {
      const path = str(input.path);
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: str(input.content) } },
        description: path ? `Write ${path}` : 'Write a file',
      };
    }
    case 'edit': {
      const path = str(input.path);
      return { toolArgs: { toolName, args: input }, description: path ? `Edit ${path}` : 'Edit a file' };
    }
    case 'subagent': {
      const tasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : null;
      const what = tasks
        ? `${tasks.length} subagents`
        : [str(input.agent), str(input.task).split('\n')[0]].filter(Boolean).join(': ') || 'a subagent';
      return {
        toolArgs: { toolName, args: input },
        description: `Start ${what} — its own commands and edits will not ask again`,
      };
    }
    default:
      return { toolArgs: { toolName, args: input }, description: toolName };
  }
}
