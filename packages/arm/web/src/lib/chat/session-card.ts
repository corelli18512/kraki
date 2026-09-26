/**
 * Session list row projection shared by the wide (Mac sidebar) and narrow
 * (iPhone list) layouts — a port of the native `SessionCardProjection`.
 */
export type SessionCardStatus =
  | 'active' | 'compacting' | 'waiting' | 'approval' | 'error'
  | 'offline' | 'agentMessage' | 'humanMessage' | 'idle';

export function resolveCardStatus(
  sessionState: string | undefined,
  previewType: string | undefined,
  deviceOnline: boolean | undefined,
  hasDraft: boolean,
  compacting: boolean,
): SessionCardStatus {
  if (deviceOnline === false) return 'offline';
  if (previewType === 'question') return 'waiting';
  if (previewType === 'permission') return 'approval';
  if (previewType === 'error') return 'error';
  if (compacting || sessionState === 'compacting') return 'compacting';
  if (sessionState === 'active') return 'active';
  if (hasDraft) return 'humanMessage';
  if (previewType === 'agent' || previewType === 'agent_message') return 'agentMessage';
  if (previewType === 'user' || previewType === 'user_message') return 'humanMessage';
  return 'idle';
}

export const STATUS_LABEL: Partial<Record<SessionCardStatus, string>> = {
  active: 'Running',
  compacting: 'Compacting',
  waiting: 'Waiting for an answer',
  approval: 'Waiting for approval',
  error: 'Failed',
  offline: 'Offline',
  agentMessage: 'Last message from agent',
  humanMessage: 'Last message from you',
};

/** HH:mm today, "Yesterday", weekday within a week, else a short date. */
export function sessionTimeLabel(iso: string, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function collapseWhitespace(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
