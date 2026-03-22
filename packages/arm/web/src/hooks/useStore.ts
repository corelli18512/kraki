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
    return 'disconnected'; // has credentials — will attempt connect
  }
  return 'awaiting_login'; // no credentials — show login immediately
}

const initialState = {
  status: getInitialStatus(),
  channel: null,
  deviceId: null,
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
  sessionModes: new Map<string, 'ask' | 'auto'>(),
  githubClientId: null,
  lastSeq: 0,
  replaying: false,
};

export const useStore = create<Store>()(persist((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setAuth: (channel, deviceId) => set({ channel, deviceId }),

  setUser: (user) => set({ user }),

  setSessions: (sessions) =>
    set({ sessions: new Map(sessions.map((s) => [s.id, s])) }),

  upsertSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(session.id, session);
      return { sessions: next };
    }),

  removeSession: (sessionId) =>
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
    }),

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

  appendMessage: (sessionId, message) =>
    set((state) => {
      const nextMsgs = new Map(state.messages);
      const list = [...(nextMsgs.get(sessionId) ?? []), message];
      nextMsgs.set(sessionId, list);
      return { messages: nextMsgs };
    }),

  resolvePendingInput: (sessionId) =>
    set((state) => {
      const msgs = state.messages.get(sessionId);
      if (!msgs) return state;
      const hasPending = msgs.some((m) => m.type === 'pending_input');
      if (!hasPending) return state;
      // Convert pending_input to confirmed user_message (keep the text visible)
      const resolved = msgs.map((m) =>
        m.type === 'pending_input'
          ? {
              type: 'user_message' as const,
              sessionId: m.sessionId,
              deviceId: '',
              seq: 0,
              channel: '',
              timestamp: m.timestamp,
              payload: { content: m.text },
            }
          : m,
      );
      const next = new Map(state.messages);
      next.set(sessionId, resolved);
      return { messages: next };
    }),

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

  addPermission: (perm) =>
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.set(perm.id, perm);
      return { pendingPermissions: next };
    }),

  removePermission: (id) =>
    set((state) => {
      const next = new Map(state.pendingPermissions);
      next.delete(id);
      return { pendingPermissions: next };
    }),

  addQuestion: (q) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.set(q.id, q);
      return { pendingQuestions: next };
    }),

  removeQuestion: (id) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      next.delete(id);
      return { pendingQuestions: next };
    }),

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
      if (mode === 'ask') {
        next.delete(sessionId);
      } else {
        next.set(sessionId, mode);
      }
      return { sessionModes: next };
    }),

  setGithubClientId: (clientId) => set({ githubClientId: clientId }),

  setLastSeq: (seq) => set({ lastSeq: seq }),

  setReplaying: (replaying) => set({ replaying }),

  clearTransientState: () => set((state) => {
    // Remove pending_input messages from all sessions (fix #12)
    const cleanedMessages = new Map(state.messages);
    for (const [sid, msgs] of cleanedMessages) {
      const filtered = msgs.filter((m) => m.type !== 'pending_input');
      if (filtered.length !== msgs.length) {
        cleanedMessages.set(sid, filtered);
      }
    }
    return {
      streamingContent: new Map(),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      unreadCount: new Map(),
      messages: cleanedMessages,
    };
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
    lastSeq: 0,
    replaying: false,
  }),
}), {
  name: 'kraki-store',
  storage: createJSONStorage(() => localStorage, {
    replacer,
    reviver,
  }),
  partialize: (state) => ({
    messages: state.messages,
    sessions: state.sessions,
    devices: state.devices,
    unreadCount: state.unreadCount,
    pinnedSessions: state.pinnedSessions,
    sessionModes: state.sessionModes,
    drafts: state.drafts,
    lastSeq: state.lastSeq,
  }),
}));
