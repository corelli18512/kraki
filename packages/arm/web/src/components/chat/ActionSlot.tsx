import { CircleCheck, CircleStop, CircleX, Lock, OctagonX } from 'lucide-react';
import type { CardActionState } from '@kraki/protocol';
import type { CardAction } from '../../lib/chat/spine';

export type PermissionDecision = 'approve' | 'always_allow' | 'deny' | 'execute';

/** Anything the bubble's lower action slot can show: the live card's action
 *  (tool / batch / permission) or a frozen row's (question choices /
 *  terminal outcome). */
export type SlotAction = CardActionState | CardAction;

export interface ActionHandlers {
  onAnswer?: (questionId: string, choice: string) => void;
  onPermission?: (permissionId: string, toolName: string | undefined, decision: PermissionDecision) => void;
  sessionMode?: 'safe' | 'discuss' | 'execute' | 'delegate';
}

const WRITE_TOOLS = new Set(['write', 'write_file', 'create', 'create_file', 'edit', 'edit_file']);

/** In discuss mode a write permission's middle action switches the session to
 *  Execute (as on iOS/Mac). */
export function switchesToExecute(mode: string | undefined, toolName: string | undefined): boolean {
  return mode === 'discuss' && !!toolName && WRITE_TOOLS.has(toolName);
}

function argsSummary(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch ((toolName ?? '').toLowerCase()) {
    case 'shell':
    case 'bash':
      return str(args.command);
    case 'write_file': case 'edit_file': case 'create_file': case 'read_file': case 'view':
      return str(args.path);
    case 'fetch_url':
      return str(args.url);
    default:
      return Object.values(args).map(str).find((v) => !!v && v.length < 200);
  }
}

export function ActionSlot({ action, handlers }: { action: SlotAction; handlers: ActionHandlers }) {
  switch (action.type) {
    case 'tool_start':
    case 'tool_complete': {
      const p = action.payload as { toolName?: string; headline?: string; success?: boolean };
      const running = action.type === 'tool_start';
      const ok = p.success !== false;
      return (
        <div className="kslot-tool">
          {running ? <span className="kspinner" aria-hidden /> : ok
            ? <CircleCheck className="kslot-icon text-green-500" aria-hidden />
            : <CircleX className="kslot-icon text-red-500" aria-hidden />}
          <span className="kslot-tool-name">{p.toolName ?? 'tool'}</span>
          {p.headline && <span className="kslot-tool-headline">{p.headline}</span>}
        </div>
      );
    }
    case 'tool_batch': {
      const running = (action.payload as { running?: number }).running ?? 0;
      return (
        <div className="kslot-tool">
          <span className="kspinner" aria-hidden />
          <span className="kslot-muted">{running === 1 ? '1 tool running in parallel…' : `${running} tools running in parallel…`}</span>
        </div>
      );
    }
    case 'permission':
      return <PermissionSlot action={action} handlers={handlers} />;
    case 'question':
      return (
        <div className="kslot-choices">
          {action.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="kchoice"
              aria-label={`Answer: ${choice}`}
              onClick={() => handlers.onAnswer?.(action.id, choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      );
    case 'user_abort':
    case 'failed': {
      const failed = action.type === 'failed';
      const detail = 'message' in action ? action.message
        : (action as { payload?: { message?: string } }).payload?.message;
      return (
        <div className={`kslot-outcome ${failed ? 'is-failed' : ''}`}>
          {failed ? <OctagonX className="kslot-icon" aria-hidden /> : <CircleStop className="kslot-icon" aria-hidden />}
          <span className="kslot-outcome-label">{failed ? 'Turn failed' : 'User aborted'}</span>
          {detail && <span className="kslot-outcome-detail">{detail}</span>}
        </div>
      );
    }
    default:
      return null;
  }
}

function PermissionSlot({ action, handlers }: { action: Extract<CardActionState, { type: 'permission' }>; handlers: ActionHandlers }) {
  const p = action.payload as {
    id: string; toolName?: string; description?: string; args?: Record<string, unknown>;
    decision?: string; localPending?: boolean; localError?: string;
  };
  const writeInDiscuss = switchesToExecute(handlers.sessionMode, p.toolName);
  const description = p.description || `Run ${p.toolName ?? 'tool'}`;
  const summary = argsSummary(p.toolName, p.args);
  const decide = (decision: PermissionDecision) => handlers.onPermission?.(p.id, p.toolName, decision);
  const denied = p.decision === 'deny';
  return (
    <div className="kslot-permission">
      <div className="kslot-permission-head">
        <Lock className="kslot-icon text-orange-500" aria-hidden />
        <div className="min-w-0 flex-1">
          {!p.decision && (
            <div className="kslot-permission-title">{writeInDiscuss ? 'Write Approval — Discuss Mode' : 'Permission Required'}</div>
          )}
          <div className="kslot-permission-desc">{description}</div>
          {summary && summary !== description && <div className="kslot-permission-args">{summary}</div>}
          {p.decision && (
            <div className={`kslot-permission-decision ${denied ? 'is-denied' : ''}`}>
              {denied ? '✗' : '✓'} {p.decision === 'always_allow' ? 'Always allowed' : denied ? 'Denied' : 'Approved'}
              {p.localPending && <span className="kslot-muted"> · Sending…</span>}
            </div>
          )}
          {p.localError && <div className="kslot-permission-error">{p.localError}</div>}
        </div>
      </div>
      {!p.decision && (
        <div className="kslot-permission-buttons">
          <button type="button" className="kperm kperm-approve" onClick={() => decide('approve')}>Approve</button>
          {writeInDiscuss
            ? <button type="button" className="kperm kperm-execute" onClick={() => decide('execute')}>Switch to Execute</button>
            : <button type="button" className="kperm kperm-allow" onClick={() => decide('always_allow')}>Allow in Session</button>}
          <button type="button" className="kperm kperm-deny" onClick={() => decide('deny')}>Deny</button>
        </div>
      )}
    </div>
  );
}
