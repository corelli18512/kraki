import { wsClient } from '../../lib/ws-client';
import { useStore } from '../../hooks/useStore';
import type { PendingPermission } from '../../types/store';
import { Lock } from 'lucide-react';

function getArgsSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'shell':
    case 'bash':
      return typeof args.command === 'string' ? args.command : '';
    case 'write_file':
    case 'edit_file':
    case 'create_file':
    case 'read_file':
    case 'view':
      return typeof args.path === 'string' ? args.path : '';
    case 'fetch_url':
      return typeof args.url === 'string' ? args.url : '';
    default:
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 200) return v;
      }
      return '';
  }
}

export function PermissionInput({ permission }: { permission: PendingPermission }) {
  const { id, sessionId, toolName, args, description } = permission;
  const argsSummary = getArgsSummary(toolName, args);
  const sessionMode = useStore((s) => s.sessionModes.get(sessionId) ?? 'plan');
  const isWriteInPlan = sessionMode === 'plan' && ['write_file', 'edit_file', 'create_file', 'write', 'edit', 'create'].includes(toolName);

  return (
    <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/5 px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2.5 flex items-start gap-2">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {isWriteInPlan ? 'Write Approval — Plan Mode' : 'Permission Required'}
            </p>
            <p className="mt-0.5 text-sm text-text-primary">{description || `Run ${toolName}`}</p>
            {argsSummary && (
              <pre className="mt-1 max-h-20 overflow-auto rounded bg-surface-tertiary px-2 py-1 font-mono text-[11px] text-text-secondary">
                {argsSummary}
              </pre>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => wsClient.approve(id, sessionId)}
            className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white transition-all hover:bg-emerald-600 active:scale-[0.98]"
          >
            Approve
          </button>
          {isWriteInPlan ? (
            <button
              onClick={() => wsClient.setSessionMode(sessionId, 'execute')}
              className="flex-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-600 transition-all hover:bg-amber-500/20 active:scale-[0.98] dark:text-amber-400"
            >
              Switch to Execute
            </button>
          ) : (
            <button
              onClick={() => wsClient.alwaysAllow(id, sessionId, toolName)}
              className="flex-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-600 transition-all hover:bg-emerald-500/20 active:scale-[0.98] dark:text-emerald-400"
            >
              Allow in Session
            </button>
          )}
          <button
            onClick={() => wsClient.deny(id, sessionId)}
            className="flex-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-500 transition-all hover:bg-red-500/20 active:scale-[0.98] dark:text-red-400"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
