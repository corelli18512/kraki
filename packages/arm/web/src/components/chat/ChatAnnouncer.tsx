import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { collapseWhitespace, resolveCardStatus, STATUS_LABEL, type SessionCardStatus } from '../../lib/chat/session-card';

/** States worth interrupting a screen reader for: the turn ended with a reply
 *  or a failure, or the agent waits for the user. */
const ANNOUNCED = new Set<SessionCardStatus>(['agentMessage', 'approval', 'waiting', 'error']);

/** Polite live region for the open conversation: says when it changes to one
 *  of the ANNOUNCED states (with the row's preview), never the state it was
 *  opened in. Streaming text itself is not read out. */
export function ChatAnnouncer({ sessionId }: { sessionId: string }) {
  const status = useStore((s) => {
    const session = s.sessions.get(sessionId);
    const device = session ? s.devices.get(session.deviceId) : undefined;
    return resolveCardStatus(session?.state, s.sessionPreviews.get(sessionId)?.type, device?.online, false,
      s.runtimeStatuses.get(sessionId)?.status === 'compacting');
  });
  const preview = useStore((s) => s.sessionPreviews.get(sessionId)?.text);
  const [message, setMessage] = useState('');
  const last = useRef<{ sessionId: string; status: SessionCardStatus; preview?: string } | null>(null);
  useEffect(() => {
    const before = last.current;
    last.current = { sessionId, status, preview };
    if (!before || before.sessionId !== sessionId) { setMessage(''); return; }
    if (!ANNOUNCED.has(status) || (before.status === status && before.preview === preview)) return;
    setMessage([STATUS_LABEL[status], collapseWhitespace(preview)].filter(Boolean).join(': '));
  }, [sessionId, status, preview]);
  return <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-announcer">{message}</div>;
}
