import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Store, ChatMessage, PendingPermission, PendingQuestion, ConnectionStatus } from '../types/store';
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
  pendingPermissions: new Map<string, PendingPermission>(),
  pendingQuestions: new Map<string, PendingQuestion>(),
  streamingContent: new Map<string, string>(),
  pinnedSessions: new Set<string>(),
  unreadCount: new Map<string, number>(),
  lastError: null,
  drafts: new Map<string, string>(),
  navigateToSession: null,
  activeSessionId: null,
  sessionModes: new Map<string, 'safe' | 'discuss' | 'execute' | 'delegate'>(),
  githubClientId: null,
  relayVersion: null,
  deviceModels: new Map<string, string[]>(),
  deviceModelDetails: new Map<string, import('@kraki/protocol').ModelDetail[]>(),
  sessionUsage: new Map<string, import('@kraki/protocol').SessionUsage>(),
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
      const pendingPermissions = new Map(state.pendingPermissions);
      for (const [id, p] of pendingPermissions) {
        if (p.sessionId === sessionId) pendingPermissions.delete(id);
      }
      const pendingQuestions = new Map(state.pendingQuestions);
      for (const [id, q] of pendingQuestions) {
        if (q.sessionId === sessionId) pendingQuestions.delete(id);
      }
      const streamingContent = new Map(state.streamingContent);
      streamingContent.delete(sessionId);
      const unreadCount = new Map(state.unreadCount);
      unreadCount.delete(sessionId);
      const drafts = new Map(state.drafts);
      drafts.delete(sessionId);
      const pinnedSessions = new Set(state.pinnedSessions);
      pinnedSessions.delete(sessionId);
      return { sessions, messages, pendingPermissions, pendingQuestions, streamingContent, unreadCount, drafts, pinnedSessions };
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
    // Write to IndexedDB (async, fire-and-forget — idempotent by [sessionId, seq])
    import('../lib/message-db').then(db => db.putMessage(sessionId, message)).catch((e) => { console.error('[Kraki:idb]', e); });
    set((state) => {
      const nextMsgs = new Map(state.messages);
      const list = [...(nextMsgs.get(sessionId) ?? []), message];
      nextMsgs.set(sessionId, list);
      return { messages: nextMsgs };
    });
  },

  resolvePendingInput: (sessionId, seq) => {
    set((state) => {
      const msgs = state.messages.get(sessionId);
      if (!msgs) return state;
      const hasPending = msgs.some((m) => m.type === 'pending_input');
      if (!hasPending) return state;
      const resolved = msgs.map((m) =>
        m.type === 'pending_input'
          ? {
              type: 'user_message' as const,
              sessionId: m.sessionId,
              deviceId: '',
              seq: seq ?? 0,
              timestamp: m.timestamp,
              payload: { content: m.text },
            }
          : m,
      );
      const next = new Map(state.messages);
      next.set(sessionId, resolved);
      // Sync resolved messages to IndexedDB
      import('../lib/message-db').then(db => db.updateSessionMessages(sessionId, resolved)).catch((e) => { console.error('[Kraki:idb]', e); });
      return { messages: next };
    });
  },

  appendDelta: (sessionId, content) =>
    set((state) => {
      const next = new Map(state.streamingContent);
      const existing = next.get(sessionId) ?? '';
      next.set(sessionId, existing + content);
      return { streamingContent: next };
    }),

  flushDelta: (sessionId) =>
    set((state) => {
      const next = new Map(state.streamingContent);
      next.delete(sessionId);
      return { streamingContent: next };
    }),

  addPermission: (perm) => {
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.set(perm.id, perm);
      return { pendingPermissions: next };
    });
  },

  removePermission: (id) => {
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.delete(id);
      return { pendingPermissions: next };
    });
  },

  addQuestion: (q) => {
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.set(q.id, q);
      return { pendingQuestions: next };
    });
  },

  removeQuestion: (id) => {
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.delete(id);
      return { pendingQuestions: next };
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
        next.delete(sessionId); // plan is default, no need to store
      } else {
        next.set(sessionId, mode);
      }
      return { sessionModes: next };
    }),

  setGithubClientId: (clientId) => set({ githubClientId: clientId }),
  setRelayVersion: (version) => set({ relayVersion: version }),

  setDeviceModels: (deviceId, models) =>
    set((state) => {
      const next = new Map(state.deviceModels);
      if (models.length > 0) {
        next.set(deviceId, models);
      } else {
        next.delete(deviceId);
      }
      return { deviceModels: next };
    }),

  setDeviceModelDetails: (deviceId, details) =>
    set((state) => {
      const next = new Map(state.deviceModelDetails);
      if (details.length > 0) {
        next.set(deviceId, details);
      } else {
        next.delete(deviceId);
      }
      return { deviceModelDetails: next };
    }),

  setSessionUsage: (sessionId, usage) =>
    set((state) => {
      const next = new Map(state.sessionUsage);
      next.set(sessionId, usage);
      return { sessionUsage: next };
    }),

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

  clearTransientState: () => set({
    streamingContent: new Map(),
    unreadCount: new Map(),
    sessionUsage: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    // messages are NOT touched — they're managed by IndexedDB hydration.
    // pending_input cleanup happens during hydration.
    // pendingPermissions/pendingQuestions are in-memory only —
    // restored from message replay via processReplayedActions on reconnect.
  }),

  reset: () => set({
    ...initialState,
    sessions: new Map(),
    devices: new Map(),
    messages: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    streamingContent: new Map(),
    pinnedSessions: new Set(),
    unreadCount: new Map(),
    lastError: null,
    drafts: new Map(),
    navigateToSession: null,
    activeSessionId: null,
    user: null,
    sessionModes: new Map(),
    githubClientId: null,
  relayVersion: null,
    deviceModels: new Map(),
    deviceModelDetails: new Map(),
    sessionUsage: new Map(),
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
    drafts: state.drafts,
    // messages are stored in IndexedDB, not localStorage
  }),
}));
