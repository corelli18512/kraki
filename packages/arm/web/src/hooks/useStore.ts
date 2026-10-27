import { diag } from '../lib/diag';
import { desktopCredentials } from '../lib/desktop';
import { create } from 'zustand';
import { DEFAULT_SESSION_MODE, normalizeSessionMode } from '@kraki/protocol';
import { persist, createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { Store, ChatMessage, ConnectionStatus, SessionCard, WebSessionSummary } from '../types/store';
import type { DeviceSummary, DeviceUpdateInfo } from '@kraki/protocol';
import { isActivePhase } from '../lib/device-update';
import { loadStoredDevice, getUrlParams } from '../lib/transport';
import { outbox } from '../lib/chat/outbox';
import { aboveSteer, followSteer } from '../lib/chat/card-steer';
import { payloadOf, seqOf } from '../lib/chat/spine';
import { messageProvider } from '../lib/message-provider';
import { beginSessionDeletion, captureMessageGeneration } from '../lib/message-persistence-generation';

/** Same own values (undefined counts as absent): digests are rebuilt on every
 *  session_list, so identity alone would always differ. */
function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

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
  if (stored?.deviceId || params.token || params.githubCode || desktopCredentials()) {
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
  sessions: new Map<string, WebSessionSummary>(),
  devices: new Map<string, DeviceSummary>(),
  messages: new Map<string, ChatMessage[]>(),
  cards: new Map<string, SessionCard>(),
  cardHoldUntil: new Map<string, number>(),
  historyCaughtUpThrough: new Map<string, number>(),
  runtimeStatuses: new Map<string, import('../types/store').SessionRuntimeStatus>(),
  pinnedSessions: new Set<string>(),
  unreadCount: new Map<string, number>(),
  lastError: null,
  drafts: new Map<string, string>(),
  navigateToSession: null,
  activeSessionId: null,
  sessionModes: new Map<string, import('@kraki/protocol').SessionMode>(),
  githubClientId: null,
  vapidPublicKey: null,
  relayVersion: null,
  deviceAgents: new Map<string, import('@kraki/protocol').AgentCapabilities[]>(),
  deviceVersions: new Map<string, string>(),
  deviceUsage: new Map(),
  usageRefreshes: new Map(),
  deviceUpdates: new Map<string, DeviceUpdateInfo>(),
  updateProgress: new Map(),
  sessionUsage: new Map<string, import('@kraki/protocol').SessionUsage>(),
  sessionPreviews: new Map<string, import('../types/store').SessionPreview>(),
  loadingSessions: new Set<string>(),
  pendingSessions: new Set<string>(),
  localSessions: [],
  localSessionsLoading: false,
  archiveInfo: new Map<string, { count: number; days: number }>(),
  archivedSessions: new Map<string, import('@kraki/protocol').SessionDigest[]>(),
};

// --- Persistence ---

type PersistedStore = Pick<Store, 'sessions' | 'devices' | 'unreadCount' | 'pinnedSessions' | 'sessionModes' | 'sessionPreviews' | 'drafts'>;

let persistedSessionsSource: Store['sessions'] | undefined;
let persistedSessionsValue: Store['sessions'] = new Map();
/** Compacting is runtime-only. Persist the underlying working fallback so a
 *  cold launch cannot resurrect a stale compacting state before session_list
 *  delivers the authoritative live snapshot. Memoized by identity so an
 *  unchanged sessions map stays the same persisted value. */
function persistedSessions(sessions: Store['sessions']): Store['sessions'] {
  if (sessions !== persistedSessionsSource) {
    persistedSessionsSource = sessions;
    persistedSessionsValue = new Map([...sessions].map(([id, session]) => [
      id,
      session.state === 'compacting' ? { ...session, state: 'active' as const } : session,
    ]));
  }
  return persistedSessionsValue;
}

/** Gives the sessions of `deviceId` the device's current name. Returns the same
 *  map when nothing changed so subscribers and persistence stay quiet. */
function relabelSessions(sessions: Store['sessions'], deviceId: string, name: string): Store['sessions'] {
  let next = sessions;
  for (const [id, session] of sessions) {
    if (session.deviceId !== deviceId || session.deviceName === name) continue;
    if (next === sessions) next = new Map(sessions);
    next.set(id, { ...session, deviceName: name });
  }
  return next;
}

/** zustand's persist serializes the whole snapshot to localStorage after every
 *  set, even one that changed nothing persisted (a session_list ran ~450 of
 *  them). Store slices are immutable, so identical slice references mean the
 *  stored JSON is already current. */
function unchangedSkippingStorage(storage: PersistStorage<PersistedStore> | undefined): PersistStorage<PersistedStore> | undefined {
  if (!storage) return storage;
  let written: StorageValue<PersistedStore> | null = null;
  const unchanged = (value: StorageValue<PersistedStore>) => written !== null
    && written.version === value.version
    && (Object.keys(value.state) as Array<keyof PersistedStore>).every((key) => written!.state[key] === value.state[key])
    && Object.keys(written.state).length === Object.keys(value.state).length;
  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      if (unchanged(value)) return;
      storage.setItem(name, value);
      written = value;
    },
    removeItem: (name) => {
      written = null;
      return storage.removeItem(name);
    },
  };
}

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
    set((state) => {
      const incomingIds = new Set(sessions.map((session) => session.id));
      const unreadCount = new Map(
        [...state.unreadCount].filter(([sessionId]) => incomingIds.has(sessionId)),
      );
      for (const session of sessions) {
        if (session.lastSeq !== undefined && session.readSeq !== undefined) {
          if (session.readSeq < session.lastSeq) unreadCount.set(session.id, 1);
          else unreadCount.delete(session.id);
        }
      }
      return {
        sessions: new Map(sessions.map((session) => [session.id, session])),
        unreadCount,
      };
    }),

  upsertSession: (session) =>
    set((state) => {
      // The Tentacle re-broadcasts the whole list after every reply; an
      // unchanged digest must not notify every subscriber.
      if (sameFields(state.sessions.get(session.id), session)) {
        const unread = state.unreadCount.get(session.id);
        if (session.lastSeq === undefined || session.readSeq === undefined) return state;
        if (session.readSeq < session.lastSeq ? unread === 1 : unread === undefined) return state;
      }
      const sessions = new Map(state.sessions);
      sessions.set(session.id, session);
      const unreadCount = new Map(state.unreadCount);
      if (session.lastSeq !== undefined && session.readSeq !== undefined) {
        if (session.readSeq < session.lastSeq) unreadCount.set(session.id, 1);
        else unreadCount.delete(session.id);
      }
      return { sessions, unreadCount };
    }),

  removeSession: (sessionId) => {
    // Reserve the lifecycle synchronously, before either the lazy import or
    // provider listeners can enqueue more work. No store access occurs during
    // message-provider module initialization (its store adapter is lazy).
    const deletion = beginSessionDeletion(sessionId);
    messageProvider.invalidateSession(sessionId);
    import('../lib/message-db').then(db => db.deleteSessionMessages(sessionId, deletion)).catch((e) => {
      deletion.reject(e);
      console.error('[Kraki:idb]', e);
    });
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(sessionId);
      const messages = new Map(state.messages);
      messages.delete(sessionId);
      const cards = new Map(state.cards);
      cards.delete(sessionId);
      const cardHoldUntil = new Map(state.cardHoldUntil);
      cardHoldUntil.delete(sessionId);
      const historyCaughtUpThrough = new Map(state.historyCaughtUpThrough);
      historyCaughtUpThrough.delete(sessionId);
      const runtimeStatuses = new Map(state.runtimeStatuses);
      runtimeStatuses.delete(sessionId);
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
      return { sessions, messages, cards, cardHoldUntil, historyCaughtUpThrough, runtimeStatuses, unreadCount, drafts, pinnedSessions, sessionModes, sessionUsage, sessionPreviews };
    });
  },

  // The device list is authoritative for names: a computer renamed while this
  // app was offline must relabel its persisted sessions (as Swift does).
  setDevices: (devices) =>
    set((state) => {
      let sessions = state.sessions;
      for (const device of devices) sessions = relabelSessions(sessions, device.id, device.name);
      return { devices: new Map(devices.map((d) => [d.id, d])), sessions };
    }),

  upsertDevice: (device) =>
    set((state) => {
      const next = new Map(state.devices);
      next.set(device.id, device);
      return { devices: next, sessions: relabelSessions(state.sessions, device.id, device.name) };
    }),

  removeDevice: (deviceId) =>
    set((state) => {
      const next = new Map(state.devices);
      next.delete(deviceId);
      return { devices: next };
    }),

  renameDevice: (deviceId, name, defaultName) =>
    set((state) => {
      const device = state.devices.get(deviceId);
      let devices = state.devices;
      if (device) {
        const { defaultName: _old, ...rest } = device;
        devices = new Map(state.devices);
        devices.set(deviceId, defaultName ? { ...rest, name, defaultName } : { ...rest, name });
      }
      const sessions = relabelSessions(state.sessions, deviceId, name);
      return devices === state.devices && sessions === state.sessions ? state : { devices, sessions };
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
    const isTransient = message.type === 'tool_start'
      || message.type === 'tool_complete'
      || message.type === 'agent_narration'
      || message.type === 'active'
      || message.type === 'compacting';
    if (!isTransient) {
      // Write to IndexedDB (async, fire-and-forget — idempotent by [sessionId, seq])
      const generation = captureMessageGeneration(sessionId);
      import('../lib/message-db').then(db => db.putMessage(sessionId, message, generation)).catch((e) => { console.error('[Kraki:idb]', e); });
    }
    set((state) => {
      const nextMsgs = new Map(state.messages);
      const existing = nextMsgs.get(sessionId) ?? [];
      // Land prose and retire the turn in the same update as the spine row.
      // Questions land only a segment; late incremental state after a true
      // conclusion must never resurrect a second assistant bubble.
      let nextCards = state.cards;
      const card = state.cards.get(sessionId);
      const payload = payloadOf(message);
      const dupIdx = seqOf(message) > 0
        ? existing.findIndex((m) => m.type === message.type && seqOf(m) === seqOf(message)) : -1;
      if (message.type === 'user_message' && dupIdx < 0) {
        nextCards = new Map(state.cards);
        nextCards.set(sessionId, payload.delivery === 'steer'
          ? aboveSteer({ ...card, text: card?.text ?? '', action: card?.action ?? null, turnConcluded: false },
            typeof payload.clientId === 'string' ? payload.clientId : `${sessionId}:${seqOf(message)}`)
          : { text: '', action: null });
      } else if (dupIdx < 0 && (message.type === 'agent_message' || message.type === 'turn_status' || message.type === 'interrupted_turn'
        || message.type === 'system_message' || message.type === 'idle' || message.type === 'session_ended')) {
        const isQuestion = message.type === 'agent_message' && !!payload.question;
        if (!isQuestion) {
          nextCards = new Map(state.cards);
          nextCards.set(sessionId, { text: '', action: null, closed: true, turnConcluded: true });
        } else if (card && !card.turnConcluded) {
          nextCards = new Map(state.cards);
          nextCards.set(sessionId, { ...card, text: '', closed: !card.action, steer: followSteer(card) });
        }
      }
      // Dedup by [type, seq] for server-broadcast messages. The relay
      // can re-broadcast on reconnect (or in edge cases like a
      // user_message echoed twice when the resolve path also fired),
      // and silently duplicating bubbles is the visible failure mode.
      if (dupIdx >= 0) {
        const replaced = [...existing];
        replaced[dupIdx] = message;
        nextMsgs.set(sessionId, replaced);
        return { messages: nextMsgs, cards: nextCards };
      }
      const list = [...existing, message];
      nextMsgs.set(sessionId, list);
      return { messages: nextMsgs, cards: nextCards };
    });
  },

  applyCardMessage: (sessionId, content, reset) =>
    set((state) => {
      const next = new Map(state.cards);
      const existing = next.get(sessionId) ?? { text: '', action: null };
      if (existing.turnConcluded) return state;
      // Narration resumed: a retained resolved permission is superseded, as
      // Tentacle intended when it cleared the slot.
      const retained = (existing.action?.payload as { retained?: boolean } | undefined)?.retained === true;
      next.set(sessionId, {
        ...existing,
        steer: reset || (!existing.text && content) ? followSteer(existing) : existing.steer,
        // Draft bubble: a reset starts a fresh segment (keep-last); otherwise
        // the streaming delta appends. The action slot is untouched — it lives
        // in parallel (tool activity while the draft streams).
        text: reset ? content : existing.text + content,
        action: retained && content ? null : existing.action,
        // New words reopen a landed question's segment, not a concluded turn.
        closed: existing.closed && !content,
      });
      return { cards: next };
    }),

  setCardAction: (sessionId, action) =>
    set((state) => {
      const next = new Map(state.cards);
      const existing = next.get(sessionId) ?? { text: '', action: null };
      if (existing.turnConcluded) return state;
      const current = existing.action;
      if (action === null && current?.type === 'permission' && current.payload.decision) {
        // Tentacle retires a resolved permission just before the next delta.
        // Applied alone it empties the live bubble for a few frames (a
        // flash); keep the read-only outcome until narration or a new action
        // replaces it (iOS/Mac `MessageStore.setCardAction`). The clear is
        // itself confirmation that the decision arrived.
        const { localPending: _pending, ...rest } = current.payload as Record<string, unknown>;
        next.set(sessionId, { ...existing, action: { ...current, payload: { ...rest, retained: true } } as unknown as typeof current });
        return { cards: next };
      }
      if (current?.type === 'permission' && (current.payload as { localPending?: boolean }).localPending
        && action?.type === 'permission' && action.payload.id === current.payload.id && !action.payload.decision) {
        // An unresolved update can predate the click. Keep the optimistic
        // decision until Tentacle confirms it or the local timeout reverts it.
        return state;
      }
      next.set(sessionId, { ...existing, text: existing.closed ? '' : existing.text, action, closed: existing.closed && !action });
      return { cards: next };
    }),

  revertLocalPermission: (sessionId, permissionId, localError) =>
    set((state) => {
      const card = state.cards.get(sessionId);
      if (!card) return state;
      const action = card.action;
      if (action?.type !== 'permission' || action.payload.id !== permissionId
        || !(action.payload as { localPending?: boolean }).localPending) return state;
      // Local failure is not a stale Tentacle update: bypass the merge guard.
      const { decision: _decision, localPending: _pending, ...rest } = action.payload as Record<string, unknown>;
      const next = new Map(state.cards);
      next.set(sessionId, {
        ...card,
        action: { ...action, payload: { ...rest, localError } } as unknown as typeof action,
      });
      return { cards: next };
    }),

  placeCardAboveSteer: (sessionId, anchor) => set((state) => {
    const card = state.cards.get(sessionId);
    if (!card) return state;
    const placed = aboveSteer(card, anchor);
    if (placed === card) return state;
    const cards = new Map(state.cards);
    cards.set(sessionId, placed);
    return { cards };
  }),

  replaceCardFromSubscription: (sessionId, card, live) => set((state) => {
    const cards = new Map(state.cards);
    cards.set(sessionId, live ? { text: card.text, action: card.action }
      : { text: '', action: null, closed: true, turnConcluded: true });
    return { cards };
  }),

  setRuntimeStatus: (sessionId, status) =>
    set((state) => {
      if (sameFields(state.runtimeStatuses.get(sessionId), status ?? undefined)) return state;
      const next = new Map(state.runtimeStatuses);
      if (status) next.set(sessionId, status);
      else next.delete(sessionId);
      return { runtimeStatuses: next };
    }),

  clearCard: (sessionId) => {
    set((state) => {
      const next = new Map(state.cards);
      next.delete(sessionId);
      return { cards: next };
    });
  },

  holdCard: (sessionId, untilSeq) => set((state) => {
    const cardHoldUntil = new Map(state.cardHoldUntil);
    if (untilSeq > 0) cardHoldUntil.set(sessionId, untilSeq);
    else cardHoldUntil.delete(sessionId);
    return { cardHoldUntil };
  }),

  markHistoryCaughtUp: (sessionId, throughSeq) => set((state) => {
    if (throughSeq <= (state.historyCaughtUpThrough.get(sessionId) ?? 0)) return state;
    const historyCaughtUpThrough = new Map(state.historyCaughtUpThrough);
    historyCaughtUpThrough.set(sessionId, throughSeq);
    return { historyCaughtUpThrough };
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

  setPinnedSessions: (pinned) => set((state) => (
    pinned.size === state.pinnedSessions.size && [...pinned].every((id) => state.pinnedSessions.has(id))
      ? state : { pinnedSessions: pinned })),

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
      if (!doIncrementUnread && sameFields(state.sessionPreviews.get(sessionId), preview)) return state;
      const previews = new Map(state.sessionPreviews);
      previews.set(sessionId, preview);
      if (doIncrementUnread) {
        const unread = new Map(state.unreadCount);
        unread.set(sessionId, (unread.get(sessionId) ?? 0) + 1);
        return { sessionPreviews: previews, unreadCount: unread };
      }
      return { sessionPreviews: previews };
    }),

  clearSessionPreview: (sessionId) =>
    set((state) => {
      if (!state.sessionPreviews.has(sessionId)) return state;
      const previews = new Map(state.sessionPreviews);
      previews.delete(sessionId);
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
      const normalized = normalizeSessionMode(mode);
      if ((state.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE) === normalized) return state;
      const next = new Map(state.sessionModes);
      if (normalized === DEFAULT_SESSION_MODE) {
        next.delete(sessionId); // the default is implied, no need to store
      } else {
        next.set(sessionId, normalized);
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

  setDeviceUpdate: (deviceId, update) =>
    set((state) => {
      const next = new Map(state.deviceUpdates);
      next.set(deviceId, update);
      // The new version greeting us is the update having landed.
      const p = state.updateProgress.get(deviceId);
      if (p && isActivePhase(p.phase) && p.to && update.current === p.to) {
        const progress = new Map(state.updateProgress);
        progress.set(deviceId, { ...p, phase: 'updated', at: Date.now() });
        return { deviceUpdates: next, updateProgress: progress };
      }
      return { deviceUpdates: next };
    }),

  setUpdateProgress: (deviceId, progress) =>
    set((state) => {
      const next = new Map(state.updateProgress);
      if (progress) next.set(deviceId, progress);
      else next.delete(deviceId);
      return { updateProgress: next };
    }),

  setSessionUsage: (sessionId, usage) =>
    set((state) => {
      if (sameFields(state.sessionUsage.get(sessionId), usage)) return state;
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
  setArchiveInfo: (deviceId, info) => set((state) => {
    const prev = state.archiveInfo.get(deviceId);
    if (prev && prev.count === info.count && prev.days === info.days) return state;
    const next = new Map(state.archiveInfo);
    next.set(deviceId, info);
    return { archiveInfo: next };
  }),
  receiveDeviceUsage: (deviceId, payload) => set((state) => {
    const out: Partial<typeof state> = {};
    if (payload.requestId) {
      const pending = state.usageRefreshes.get(deviceId);
      if (pending && pending.requestId !== payload.requestId) return {};
      if (pending && !pending.finished) {
        const next = new Map(state.usageRefreshes);
        next.set(deviceId, { ...pending, finished: true, error: payload.refreshError });
        out.usageRefreshes = next;
      }
    }
    // A transport/disabled error carries a cache, not a new successful reading.
    if (!payload.refreshError) {
      const next = new Map(state.deviceUsage);
      next.set(deviceId, { accounts: payload.accounts ?? [], receivedAt: Date.now() });
      out.deviceUsage = next;
    }
    return out;
  }),

  beginUsageRefresh: (deviceId, requestId) => set((state) => {
    const next = new Map(state.usageRefreshes);
    next.set(deviceId, { requestId, startedAt: Date.now(), finished: false });
    return { usageRefreshes: next };
  }),

  finishUsageRefresh: (deviceId, requestId, error) => set((state) => {
    const cur = state.usageRefreshes.get(deviceId);
    if (!cur || cur.requestId !== requestId || cur.finished) return {};
    const next = new Map(state.usageRefreshes);
    next.set(deviceId, { ...cur, finished: true, error });
    return { usageRefreshes: next };
  }),

  setArchivedSessions: (deviceId, sessions) => set((state) => {
    const next = new Map(state.archivedSessions);
    next.set(deviceId, sessions);
    return { archivedSessions: next };
  }),

  prependMessages: (sessionId, older) => diag.work('web/message_batch', sessionId, () => {
    // Range batches are authoritative for their session seqs. Besides normal
    // deduplication, they must replace stale rows written by older clients
    // (for example a transient `active` row occupying an agent reply's seq).
    const generation = captureMessageGeneration(sessionId);
    import('../lib/message-db').then(db => db.putMessages(sessionId, older, generation)).catch((e) => { console.error('[Kraki:idb]', e); });
    set((state) => {
      const existing = state.messages.get(sessionId) ?? [];
      const incomingSeqs = new Set<number>();
      const incoming = older.filter((message) => {
        const seq = 'seq' in message ? (message as { seq?: number }).seq : undefined;
        if (typeof seq !== 'number' || seq <= 0 || incomingSeqs.has(seq)) return false;
        incomingSeqs.add(seq);
        return true;
      });
      if (incoming.length === 0) return state;

      const retained = existing.filter((message) => {
        const seq = 'seq' in message ? (message as { seq?: number }).seq : undefined;
        return typeof seq !== 'number' || !incomingSeqs.has(seq);
      });
      // A range batch usually re-delivers rows we already hold (the tail
      // reconcile after every idle). Keep the existing object when the record
      // is unchanged so views memoized on it do not all re-render.
      const bySeq = new Map<number, ChatMessage>();
      for (const message of existing) {
        const seq = (message as { seq?: number }).seq;
        if (typeof seq === 'number') bySeq.set(seq, message);
      }
      const reused = incoming.map((message) => {
        const prior = bySeq.get((message as { seq: number }).seq);
        return prior && prior.type === message.type
          && JSON.stringify(prior.payload) === JSON.stringify(message.payload) ? prior : message;
      });
      // Nothing new: keep the same array (no re-render at all).
      if (reused.every((m) => bySeq.get((m as { seq: number }).seq) === m)) return state;
      const merged = [...reused, ...retained];
      merged.sort((a, b) => {
        const seqA = 'seq' in a ? (a as { seq?: number }).seq ?? 0 : 0;
        const seqB = 'seq' in b ? (b as { seq?: number }).seq ?? 0 : 0;
        return seqA - seqB;
      });
      const next = new Map(state.messages);
      next.set(sessionId, merged);
      return { messages: next };
    });
  }),

  setTurnSteps: (sessionId, bubbleSeq, entries) => {
    set((state) => {
      const existing = state.messages.get(sessionId);
      if (!existing) return state;

      const bubbleIdx = existing.findIndex(
        (msg) => 'seq' in msg && (msg as { seq?: number }).seq === bubbleSeq,
      );
      if (bubbleIdx < 0) return state; // bubble not loaded — nothing to attach to

      // A final agent_message can briefly become the visible turn anchor before
      // a following turn_status arrives. Its async trace pull may then complete
      // after the terminal pull and re-inject the entire turn a second time.
      // Once a terminal record exists later in the same user-bounded turn, that
      // record exclusively owns Steps; discard stale agent-anchor responses.
      if (existing[bubbleIdx].type === 'agent_message') {
        for (let i = bubbleIdx + 1; i < existing.length; i++) {
          const next = existing[i];
          if ((next.type === 'user_message' && next.payload.delivery !== 'steer') || next.type === 'send_input') break;
          if (next.type === 'turn_status' || next.type === 'interrupted_turn') return state;
        }
      }

      const replaceErrors = entries.some((entry) => entry.type === 'error');
      const isTrace = (t: string) =>
        t === 'tool_start' || t === 'tool_complete' || t === 'agent_narration' ||
        t === 'permission' || (replaceErrors && t === 'error');

      // The target is either a concluding bubble (steps go BEFORE it) or the
      // leading user_message used by a live pull (steps go AFTER it). That live
      // response may arrive after the turn has concluded and another has begun.
      const inProgress = existing[bubbleIdx].type === 'user_message'
        && existing[bubbleIdx].payload.delivery !== 'steer';

      // Trace region (exclusive index bounds) whose live/previous entries are
      // dropped so a re-pull replaces rather than duplicates.
      let regionStart: number;
      let regionEnd: number;
      if (inProgress) {
        regionStart = bubbleIdx;
        regionEnd = existing.length;
        for (let i = bubbleIdx + 1; i < existing.length; i++) {
          const next = existing[i];
          if ((next.type === 'user_message' && next.payload.delivery !== 'steer') || next.type === 'send_input') {
            regionEnd = i; // never replace another prompt's trace, even on a late live response
            break;
          }
        }
      } else {
        let turnStartIdx = -1;
        for (let i = bubbleIdx - 1; i >= 0; i--) {
          const candidate = existing[i];
          if (candidate.type === 'user_message' && (candidate.payload as { delivery?: string }).delivery !== 'steer') {
            turnStartIdx = i;
            break;
          }
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
    cardHoldUntil: new Map(),
    historyCaughtUpThrough: new Map(),
    runtimeStatuses: new Map(),
    sessionUsage: new Map(),
    loadingSessions: new Set(),
    pendingSessions: new Set(),
    // unreadCount kept — persisted snapshot shown until session_list reconciles.
    // sessionPreviews kept — persisted snapshot shown until the session_list
    // digest (the tentacle) reconciles it.
    // messages are NOT touched — they're managed by IndexedDB hydration.
    // pending_input cleanup happens during hydration.
    // cards are in-memory only — restored via request_card when a session opens.
  }),

  // Sign-out / credential wipe: unsent messages belong to the old account.
  reset: () => (outbox.reset(), set({
    ...initialState,
    sessions: new Map(),
    devices: new Map(),
    messages: new Map(),
    cards: new Map(),
    cardHoldUntil: new Map(),
    historyCaughtUpThrough: new Map(),
    runtimeStatuses: new Map(),
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
    deviceUsage: new Map(),
    usageRefreshes: new Map(),
    sessionUsage: new Map(),
    sessionPreviews: new Map(),
    loadingSessions: new Set(),
    reconnectAttempts: 0,
    nextReconnectDelayMs: null,
  })),
}), {
  name: 'kraki-store',
  storage: unchangedSkippingStorage(createJSONStorage<PersistedStore>(() => localStorage, {
    replacer,
    reviver,
  })),
  partialize: (state) => ({
    sessions: persistedSessions(state.sessions),
    devices: state.devices,
    unreadCount: state.unreadCount,
    pinnedSessions: state.pinnedSessions,
    sessionModes: state.sessionModes,
    sessionPreviews: state.sessionPreviews,
    drafts: state.drafts,
    // messages are stored in IndexedDB, not localStorage
  }),
}));

// Local diagnostics (dev server / local stack only): inspect state from the
// browser console or a Playwright probe.
if (typeof window !== 'undefined' && (import.meta.env.DEV || window.location.hostname === 'localhost')) {
  (window as unknown as { __krakiStore: typeof useStore }).__krakiStore = useStore;
}
