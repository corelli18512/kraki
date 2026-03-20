import { getStore } from './store-adapter';

/** Check if a session is currently being viewed. */
export function isViewingSession(sessionId: string): boolean {
  // Check store first (set by useEffect), fall back to URL for synchronous accuracy
  const storeId = getStore().activeSessionId;
  if (storeId) return storeId === sessionId;
  return window.location.pathname === `/session/${sessionId}`;
}

/** Tracks replay state, sequence numbers, and read state. */
export class ReplayState {
  lastSeq = 0;
  readState: Record<string, number> = {};
  replaying = false;
  private replayEndTimer: ReturnType<typeof setTimeout> | null = null;

  updateSeq(seq: number): void {
    this.lastSeq = Math.max(this.lastSeq, seq);
  }

  startReplay(send: (msg: Record<string, unknown>) => void): void {
    this.replaying = true;
    send({ type: 'replay', afterSeq: this.lastSeq });
  }

  /** Debounce end-of-replay detection — call after each replayed message. */
  scheduleReplayEnd(): void {
    if (this.replayEndTimer) clearTimeout(this.replayEndTimer);
    this.replayEndTimer = setTimeout(() => this.onReplayComplete(), 300);
  }

  /** Called when replay messages stop arriving — compute unread from readState. */
  private onReplayComplete(): void {
    this.replaying = false;
    const store = getStore();
    const messages = store.messages;

    for (const [sessionId, msgs] of messages) {
      if (!msgs.length) continue;
      const lastReadSeq = this.readState[sessionId] ?? 0;
      // Count messages with seq > lastReadSeq
      let unread = 0;
      for (const m of msgs) {
        if ('seq' in m && typeof (m as any).seq === 'number' && (m as any).seq > lastReadSeq) {
          // Only count agent-facing messages as unread
          if (m.type === 'agent_message' || m.type === 'permission' || m.type === 'question' || m.type === 'error') {
            unread++;
          }
        }
      }
      if (unread > 0 && !isViewingSession(sessionId)) {
        store.clearUnread(sessionId);
        for (let i = 0; i < unread; i++) store.incrementUnread(sessionId);
      }
    }
  }

  /** Send mark_read to the head. */
  markRead(sessionId: string, send: (msg: Record<string, unknown>) => void): void {
    // Find the max seq for this session
    const messages = getStore().messages.get(sessionId);
    if (!messages?.length) return;
    let maxSeq = 0;
    for (const m of messages) {
      if ('seq' in m && typeof (m as any).seq === 'number') {
        maxSeq = Math.max(maxSeq, (m as any).seq);
      }
    }
    if (maxSeq > 0) {
      this.readState[sessionId] = maxSeq;
      send({ type: 'mark_read', sessionId, seq: maxSeq });
    }
  }
}
