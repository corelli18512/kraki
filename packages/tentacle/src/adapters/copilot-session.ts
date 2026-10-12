/** Copilot adapter state: per-session entry, pending permissions/questions, small helpers. */

import type { CopilotSession, PermissionRequestResult } from '@github/copilot-sdk';
import { createLogger } from '../logger.js';
import { TurnTracker } from './turn-tracker.js';
import { type ToolKind } from './permission-policy.js';

export const logger = createLogger('copilot-adapter');

/** Copilot permission request kinds → Kraki policy kinds. */
export function copilotToolKind(kind: string): ToolKind {
  switch (kind) {
    case 'read': return 'read';
    case 'url': return 'url';
    case 'write': return 'write';
    case 'shell': return 'shell';
    case 'mcp': return 'mcp';
    default: return 'other';
  }
}
// ── Local type aliases for SDK handler params ───────────
// (UserInputRequest / UserInputResponse are not re-exported by the SDK)

export interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

export interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

// ── Types for internal bookkeeping ──────────────────────

/** Resolve function stored while a permission request is pending. */
export interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  /** Tool kind from the SDK request (e.g. 'shell', 'write', 'read') */
  toolKind: string;
}

/** Resolve function stored while a question is pending. */
export interface PendingQuestion {
  resolve: (result: UserInputResponse) => void;
}

/** Everything we track per session. */
export interface SessionEntry {
  session: CopilotSession;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  /** Kraki's view of the current turn: prose (narration vs reply), user stop,
   *  idle once. Survives a resume of the SDK session mid-turn. */
  turn: TurnTracker;
}

// ── Helpers ─────────────────────────────────────────────

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
