import type { PendingInput } from './outbox';
/**
 * Session list row projection shared by the wide (Mac sidebar) and narrow
 * (iPhone list) layouts — a port of the native `SessionCardProjection`.
 */
export type SessionCardStatus =
  | 'active' | 'compacting' | 'waiting' | 'approval' | 'error'
  | 'delivery' | 'offline' | 'agentMessage' | 'humanMessage' | 'idle';

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

/** Local HH:mm today, lowercase yesterday, then elapsed calendar days (Mac). */
export function sessionTimeLabel(iso: string, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days === 1) return 'yesterday';
  const elapsedDays = days - ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) < (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000) ? 1 : 0);
  return `${Math.max(elapsedDays, 2)}d ago`;
}

export function collapseWhitespace(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export type SessionDeliveryStatus = 'correcting' | 'sending' | 'unconfirmed' | 'failed' | 'queued';
export type SessionPendingInput = Omit<PendingInput, 'state'> & { state: Exclude<SessionDeliveryStatus, 'queued'> };
export const DELIVERY_LABEL = {
  correcting: 'Correcting voice message before sending', unconfirmed: 'Awaiting delivery confirmation',
  sending: 'Sending, awaiting confirmation', failed: 'Send failed', queued: 'Waiting for connection',
};

/** Errors win over new sends; local order, timestamp and clientId break ties. */
export function sessionPendingPreview(entries: SessionPendingInput[], sessionId: string, online: boolean) {
  const pending = entries.filter((entry) => entry.sessionId === sessionId).sort((a, b) =>
    Number(a.state === 'failed') - Number(b.state === 'failed') || a.order - b.order ||
    a.timestamp.localeCompare(b.timestamp) || a.clientId.localeCompare(b.clientId)).at(-1);
  if (!pending) return undefined;
  const status: SessionDeliveryStatus = pending.state === 'sending' ? (online ? 'sending' : 'queued') : pending.state;
  const text = collapseWhitespace(pending.text) || (pending.attachments?.length ? '[image]' : '…');
  const prefix = status === 'failed' ? 'Send failed · ' : status === 'queued' ? 'Waiting for connection · ' : status === 'unconfirmed' ? 'Awaiting confirmation · ' : '';
  return { text: prefix + text, timestamp: pending.timestamp, status };
}
