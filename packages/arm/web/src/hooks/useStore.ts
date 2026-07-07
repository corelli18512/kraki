import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Store, ChatMessage, ConnectionStatus, PendingInputMessage, SessionCard } from '../types/store';
import type { SessionSummary, DeviceSummary } from '@kraki/protocol';
import { loadStoredDevice, getUrlParams } from '../lib/transport';

// --- Custom Map/Set JSON serialization ---

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: 'Map', entries: [...value.entries()] };
  }
  if (value instanceof Set) {
    return { __type: 'Set', values: [...value.values()] };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__type' in value) {
    const obj = value as Record<string, unknown>;
    if (obj.__type === 'Map' && Array.isArray(obj.entries)) {
      return new Map(obj.entries as [unknown, unknown][]);
    }
    if (obj.__type === 'Set' && Array.isArray(obj.values)) {
      return new Set(obj.values as unknown[]);
    }
  }
  return value;
}

// Determine initial status: if no credentials exist, go straight to awaiting_login
function getInitialStatus(): ConnectionStatus {
  const stored = loadStoredDevice();
  const params = getUrlParams();
  if (stored?.deviceId || params.token || params.githubCode) {
    return 'connecting';
  }
  return 'awaiting_login';
}

const initialState = {
  status: getInitialStatus(),
  deviceId: null,
  reconnectAttempts: 0,
  nextReconnectDelayMs: null,
  user: null,
  sessions: new Map<string, SessionSummary>(),
  devices: new Map<string, DeviceSummary>(),
  messages: new Map<string, ChatMessage[]>(),
  cards: new Map<string, SessionCard>(),
  pinnedSessions: new Set<string>(),
  unreadCount: new Map<string, number>(),
  lastError: null,
  drafts: new Map<string, string>(),
  navigateToSession: null,
  activeSessionId: null,
  sessionModes: new Map<string, 'safe' | 'discuss' | 'execute' | 'delegate'>(),
  githubClientId: null,
  vapidPublicKey: null,
  relayVersion: null,
  deviceAgents: new Map<string, import('@kraki/protocol').AgentCapabilities[]>(),
  deviceVersions: new Map<string, string>(),
  sessionUsage: new Map<string, import('@kraki/protocol').SessionUsage>(),
  sessionPreviews: new Map<string, import('../types/store').SessionPreview>(),
  loadingSessions: new Set<string>(),
  pendingSessions: new Set<string>(),
  localSessions: [],
  localSessionsLoading: false,
};

export const useStore = create<Store>()(persist((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setAuth: (deviceId) => set({ deviceId }),

  setUser: (user) => set({ user }),

  setReconnectState: (attempts, nextDelayMs) =>
    set({
      reconnectAttempts: attempts,
      nextReconnectDelayMs: nextDelayMs,
    }),

  setSessions: (sessions) =>
    set({ sessions: new Map(sessions.map((s) => [s.id, s])) }),

  upsertSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(session.id, session);
      return { sessions: next };
    }),

  removeSession: (sessionId) => {
    // Clean up IndexedDB
    import('../lib/message-db').then(db => db.deleteSessionMessages(sessionId)).catch((e) => { console.error('[Kraki:idb]', e); });
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(sessionId);
      const messages = new Map(state.messages);
      messages.delete(sessionId);
      const cards = new Map(state.cards);
      cards.delete(sessionId);
      const unreadCount = new Map(state.unreadCount);
      unreadCount.delete(sessionId);
      const drafts = new Map(state.drafts);
      drafts.delete(sessionId);
      const pinnedSessions = new Set(state.pinnedSessions);
      pinnedSessions.delete(sessionId);
      const sessionModes = new Map(state.sessionModes);
      sessionModes.delete(sessionId);
      const sessionUsage = new Map(state.sessionUsage);
      sessionUsage.delete(sessionId);
      const sessionPreviews = new Map(state.sessionPreviews);
      sessionPreviews.delete(sessionId);
      return { sessions, messages, cards, unreadCount, drafts, pinnedSessions, sessionModes, sessionUsage, sessionPreviews };
    });
  },

  setDevices: (devices) =>
    set({ devices: new Map(devices.map((d) => [d.id, d])) }),

  upsertDevice: (device) =>
    set((state) => {
      const next = new Map(state.devices);
      next.set(device.id, device);
      return { devices: next };
    }),

  removeDevice: (deviceId) =>
    set((state) => {
      const next = new Map(state.devices);
      next.delete(deviceId);
      return { devices: next };
    }),

  setDeviceOnline: (deviceId, online) =>
    set((state) => {
      const device = state.devices.get(deviceId);
      if (!device) return state;
      const next = new Map(state.devices);
      next.set(deviceId, { ...device, online });
      return { devices: next };
    }),

  appendMessage: (sessionId, message) => {
    // pending_input is optimistic, transient UI — never persist it.
    // tool_start/tool_complete/agent_narration are the TRACE axis: they stream
    // live for the in-progress turn but are pulled lazily from the tentacle's
    // trace.jsonl (see setTurnSteps / messageProvider.requestTurnTrace) rather
    // than living on the spine — so they are kept in memory for live rendering
    // but NEVER written to IndexedDB. The compound IDB key is [sessionId, seq]
    // and ALL pending_input messages have seq=0, so writing them would collide-
    // and-overwrite each other on rapid send. After resolve, the resulting
    // user_message has a real seq and goes through updateSessionMessages.
    const isTransient = message.type === 'pending_input'
      || message.type === 'tool_start'
      || message.type === 'tool_complete'
      || message.type === 'agent_narration';
    if (!isTransient) {
      // Write to IndexedDB (async, fire-and-forget — idempotent by [sessionId, seq])
      import('../lib/message-db').then(db => db.putMessage(sessionId, message)).catch((e) => { console.error('[Kraki:idb]', e); });
    }
    set((state) => {
      const nextMsgs = new Map(state.messages);
      const existing = nextMsgs.get(sessionId) ?? [];
      // A landing agent_message is the turn's permanent reply — it graduates the
      // live draft. Clear the card's draft text in the SAME store update so the
      // bubble replaces the draft in place, with no frame gap (the old flicker
      // was a separate clear-then-re-add). The action slot is left as the server
      // sent it — its VISIBILITY is gated on liveness in ChatView (a resolved
      // action no longer pins the card), so no local mutation of server state.
      let nextCards = state.cards;
      if (message.type === 'agent_message') {
        const card = state.cards.get(sessionId);
        if (card && card.text) {
          nextCards = new Map(state.cards);
          nextCards.set(sessionId, { text: '', action: card.action });
        }
      }
      // Dedup by [type, seq] for server-broadcast messages. The relay
      // can re-broadcast on reconnect (or in edge cases like a
      // user_message echoed twice when the resolve path also fired),
      // and silently duplicating bubbles is the visible failure mode.
      // pending_input has seq=0 by convention — never dedup against
      // it; pendings are keyed by `clientId` in `resolvePendingInput`.
      const hasRealSeq = 'seq' in message && typeof message.seq === 'number' && message.seq > 0;
      if (hasRealSeq) {
        const dupIdx = existing.findIndex(
          (m) => m.type === message.type && 'seq' in m && (m as { seq?: number }).seq === message.seq,
        );
        if (dupIdx >= 0) {
          const replaced = [...existing];
          replaced[dupIdx] = message;
          nextMsgs.set(sessionId, replaced);
          return { messages: nextMsgs, cards: nextCards };
        }
      }
      const list = [...existing, message];
      nextMsgs.set(sessionId, list);
      return { messages: nextMsgs, cards: nextCards };
    });
  },

  resolvePendingInput: (sessionId, seq, clientId, serverContent) => {
    let resolved = false;
    set((state) => {
      const msgs = state.messages.get(sessionId);
      if (!msgs) return state;
      // Identify the right pending:
      //   1. With clientId: exact match by clientId (new clients ↔ new tentacle).
      //   2. Without clientId, with serverContent: match the first
      //      pending whose local text equals the server's content. This
      //      handles "new client → old tentacle" (which strips the
      //      clientId but echoes the same text) without inappropriately
      //      claiming user_messages broadcast by other devices.
      //   3. Without either: no resolve. Caller will appendMessage.
      let idx = -1;
      if (clientId) {
        idx = msgs.findIndex((m) => m.type === 'pending_input' && m.clientId === clientId);
      } else if (serverContent !== undefined) {
        idx = msgs.findIndex((m) => m.type === 'pending_input' && m.text === serverContent);
      }
      if (idx < 0) return state;

      const pending = msgs[idx] as PendingInputMessage;
      const next = [...msgs];
      next[idx] = {
        type: 'user_message' as const,
        sessionId: pending.sessionId,
        deviceId: '',
        seq,
        timestamp: pending.timestamp,
        payload: {
          content: serverContent ?? pending.text,
          ...(pending.attachments?.length && { attachments: pending.attachments }),
        },
      };
      // Re-sort: pending_input (seq=0) always lives at the tail — it
      // is logically "in-flight, not yet assigned a real seq" and
      // should appear AFTER any resolved messages, regardless of their
      // numeric seq. Among resolved messages, sort by server seq so
      // that a user_message arriving after a transient event (e.g. a
      // tool_start that was inserted between the optimistic pending
      // and the server's ack) slots into the correct position.
      next.sort((a, b) => {
        const pendA = a.type === 'pending_input';
        const pendB = b.type === 'pending_input';
        if (pendA && !pendB) return 1;
        if (!pendA && pendB) return -1;
        const sa = 'seq' in a ? (a as { seq?: number }).seq ?? 0 : 0;
        const sb = 'seq' in b ? (b as { seq?: number }).seq ?? 0 : 0;
        return sa - sb;
      });

      const map = new Map(state.messages);
      map.set(sessionId, next);
      import('../lib/message-db').then(db => db.updateSessionMessages(sessionId, next)).catch((e) => { console.error('[Kraki:idb]', e); });
      resolved = true;
      return { messages: map };
    });
    return resolved;
  },

  applyCardMessage: (sessionId, content, reset) =>
    set((state) => {
      const next = new Map(state.cards);
      const existing = next.get(sessionId) ?? { text: '', action: null };
      next.set(sessionId, {
        // Draft bubble: a reset starts a fresh segment (keep-last); otherwise
        // the streaming delta appends. The action slot is untouched — it lives
        // in parallel (tool activity while the draft streams).
        text: reset ? content : existing.text + content,
        action: existing.action,
      });
      return { cards: next };
    }),

  setCardAction: (sessionId, action) =>
    set((state) => {
      const next = new Map(state.cards);
      const existing = next.get(sessionId) ?? { text: '', action: null };
      next.set(sessionId, { text: existing.text, action });
      return { cards: next };
    }),

  clearCard: (sessionId) => {
    set((state) => {
      const next = new Map(state.cards);
      next.delete(sessionId);
      return { cards: next };
    });
  },

  togglePin: (sessionId) =>
    set((state) => {
      const next = new Set(state.pinnedSessions);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return { pinnedSessions: next };
    }),

  setPinnedSessions: (pinned) => set({ pinnedSessions: pinned }),

  incrementUnread: (sessionId) =>
    set((state) => {
      const next = new Map(state.unreadCount);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return { unreadCount: next };
    }),

  clearUnread: (sessionId) =>
    set((state) => {
      if (!state.unreadCount.has(sessionId)) return state;
      const next = new Map(state.unreadCount);
      next.delete(sessionId);
      return { unreadCount: next };
    }),

  setSessionPreview: (sessionId, preview, doIncrementUnread) =>
    set((state) => {
      const previews = new Map(state.sessionPreviews);
      previews.set(sessionId, preview);
      if (doIncrementUnread) {
        const unread = new Map(state.unreadCount);
        unread.set(sessionId, (unread.get(sessionId) ?? 0) + 1);
        return { sessionPreviews: previews, unreadCount: unread };
      }
      return { sessionPreviews: previews };
    }),

  setDraft: (sessionId, text) =>
    set((state) => {
      const next = new Map(state.drafts);
      if (text) {
        next.set(sessionId, text);
      } else {
        next.delete(sessionId);
      }
      return { drafts: next };
    }),

  setLastError: (message) => set({ lastError: message }),

  setNavigateToSession: (sessionId) => set({ navigateToSession: sessionId }),

  setActiveSessionId: (sessionId) => set({ activeSessionId: sessionId }),

  setSessionMode: (sessionId, mode) =>
    set((state) => {
      const next = new Map(state.sessionModes);
      if (mode === 'discuss') {
        next.delete(sessionId); // discuss is default, no need to store
      } else {
        next.set(sessionId, mode);
      }
      return { sessionModes: next };
    }),

  setGithubClientId: (clientId) => set({ githubClientId: clientId }),
  setVapidPublicKey: (key) => set({ vapidPublicKey: key }),
  setRelayVersion: (version) => set({ relayVersion: version }),

  setDeviceAgents: (deviceId, agents) =>
    set((state) => {
      const next = new Map(state.deviceAgents);
      next.set(deviceId, agents);
      return { deviceAgents: next };
    }),

  clearDeviceAgents: (deviceId) =>
    set((state) => {
      const next = new Map(state.deviceAgents);
      next.delete(deviceId);
      return { deviceAgents: next };
    }),

  setDeviceVersion: (deviceId, version) =>
    set((state) => {
      const next = new Map(state.deviceVersions);
      next.set(deviceId, version);
      return { deviceVersions: next };
    }),

  setSessionUsage: (sessionId, usage) =>
    set((state) => {
      const next = new Map(state.sessionUsage);
      next.set(sessionId, usage);
      return { sessionUsage: next };
    }),

  setSessionLoading: (sessionId, loading) =>
    set((state) => {
      const next = new Set(state.loadingSessions);
      if (loading) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return { loadingSessions: next };
    }),

  addPendingSession: (sessionId) =>
    set((state) => {
      const next = new Set(state.pendingSessions);
      next.add(sessionId);
      return { pendingSessions: next };
    }),

  removePendingSession: (sessionId) =>
    set((state) => {
      const next = new Set(state.pendingSessions);
      next.delete(sessionId);
      return { pendingSessions: next };
    }),

  setLocalSessions: (sessions) => set({ localSessions: sessions }),

  setLocalSessionsLoading: (loading) => set({ localSessionsLoading: loading }),

  prependMessages: (sessionId, older) => {
    // Write to IndexedDB (idempotent by [sessionId, seq] key)
    import('../lib/message-db').then(db => db.putMessages(sessionId, older)).catch((e) => { console.error('[Kraki:idb]', e); });
    set((state) => {
      const existing = state.messages.get(sessionId) ?? [];
      // Deduplicate by seq
      const existingSeqs = new Set<number>();
      for (const m of existing) {
        const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
        if (typeof seq === 'number') existingSeqs.add(seq);
      }
      const unique = older.filter(m => {
        const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
        return typeof seq === 'number' && !existingSeqs.has(seq);
      });
      if (unique.length === 0) return state;
      const merged = [...unique, ...existing];
      merged.sort((a, b) => {
        const seqA = 'seq' in a ? (a as { seq?: number }).seq ?? 0 : 0;
        const seqB = 'seq' in b ? (b as { seq?: number }).seq ?? 0 : 0;
        return seqA - seqB;
      });
      const next = new Map(state.messages);
      next.set(sessionId, merged);
      return { messages: next };
    });
  },

  setTurnSteps: (sessionId, bubbleSeq, entries) => {
    set((state) => {
      const existing = state.messages.get(sessionId);
      if (!existing) return state;

      const bubbleIdx = existing.findIndex(
        (msg) => 'seq' in msg && (msg as { seq?: number }).seq === bubbleSeq,
      );
      if (bubbleIdx < 0) return state; // bubble not loaded — nothing to attach to

      const isTrace = (t: string) =>
        t === 'tool_start' || t === 'tool_complete' || t === 'agent_narration';

      // The target bubble is either the concluding agent_message (a concluded
      // turn — steps go BEFORE it) or the leading user_message of an in-progress
      // turn (no conclusion yet — steps go AFTER it, at the tail).
      const inProgress = existing[bubbleIdx].type === 'user_message';

      // Trace region (exclusive index bounds) whose live/previous entries are
      // dropped so a re-pull replaces rather than duplicates.
      let regionStart: number;
      let regionEnd: number;
      if (inProgress) {
        regionStart = bubbleIdx;         // steps live after the user_message
        regionEnd = existing.length;     // …through the current tail
      } else {
        let turnStartIdx = -1;
        for (let i = bubbleIdx - 1; i >= 0; i--) {
          if (existing[i].type === 'user_message') { turnStartIdx = i; break; }
        }
        regionStart = turnStartIdx;      // steps live after the prior user_message
        regionEnd = bubbleIdx;           // …up to (before) the concluding bubble
      }

      const kept: ChatMessage[] = [];
      for (let i = 0; i < existing.length; i++) {
        const inRegion = i > regionStart && i < regionEnd;
        if (inRegion && isTrace(existing[i].type)) continue;
        kept.push(existing[i]);
      }

      if (entries.length === 0) {
        const map = new Map(state.messages);
        map.set(sessionId, kept);
        return { messages: map };
      }

      // Assign fractional seqs so the entries sort into the turn's trace slot in
      // recorded order and survive any later seq-sort (prependMessages /
      // resolvePendingInput). Concluded turns place them in (bubbleSeq-1,
      // bubbleSeq); in-progress turns place them in (bubbleSeq, bubbleSeq+1).
      const base = inProgress ? bubbleSeq : bubbleSeq - 1;
      const stamped = entries.map((e, i) => ({
        ...(e as ChatMessage),
        seq: base + (i + 1) / (entries.length + 1),
      })) as ChatMessage[];

      const bubblePos = kept.findIndex(
        (msg) => 'seq' in msg && (msg as { seq?: number }).seq === bubbleSeq,
      );
      const insertAt = inProgress ? bubblePos + 1 : bubblePos;
      const result = [...kept.slice(0, insertAt), ...stamped, ...kept.slice(insertAt)];

      const map = new Map(state.messages);
      map.set(sessionId, result);
      // NOTE: trace is transient — deliberately NOT persisted to IndexedDB.
      return { messages: map };
    });
  },

  clearTransientState: () => set({
    lastError: null,
    cards: new Map(),
    sessionUsage: new Map(),
    loadingSessions: new Set(),
    pendingSessions: new Set(),
    // unreadCount kept — persisted snapshot shown until session_list reconciles.
    // sessionPreviews kept — persisted snapshot shown until rebuildPreview refreshes.
    // messages are NOT touched — they're managed by IndexedDB hydration.
    // pending_input cleanup happens during hydration.
    // cards are in-memory only — restored via request_card when a session opens.
  }),

  reset: () => set({
    ...initialState,
    sessions: new Map(),
    devices: new Map(),
    messages: new Map(),
    cards: new Map(),
    pinnedSessions: new Set(),
    unreadCount: new Map(),
    lastError: null,
    drafts: new Map(),
    navigateToSession: null,
    activeSessionId: null,
    user: null,
    sessionModes: new Map(),
    githubClientId: null,
    vapidPublicKey: null,
  relayVersion: null,
    deviceAgents: new Map(),
    deviceVersions: new Map(),
    sessionUsage: new Map(),
    sessionPreviews: new Map(),
    loadingSessions: new Set(),
    reconnectAttempts: 0,
    nextReconnectDelayMs: null,
  }),
}), {
  name: 'kraki-store',
  storage: createJSONStorage(() => localStorage, {
    replacer,
    reviver,
  }),
  partialize: (state) => ({
    sessions: state.sessions,
    devices: state.devices,
    unreadCount: state.unreadCount,
    pinnedSessions: state.pinnedSessions,
    sessionModes: state.sessionModes,
    sessionPreviews: state.sessionPreviews,
    drafts: state.drafts,
    // messages are stored in IndexedDB, not localStorage
  }),
}));
