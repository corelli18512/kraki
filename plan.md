# Plan: Sync Pinned Sessions Across All Arms

## Problem

Pinned sessions are stored locally in each arm's localStorage (via Zustand persist).
When a user pins a session on their phone, it doesn't show as pinned on their browser
or another device. Pins should sync across all arms via the tentacle, following the
same pattern as `mark_read` and `set_session_mode`.

## Approach

Follow the existing `mark_read` / `set_session_mode` sync pattern:

1. Arm sends a consumer message to tentacle
2. Tentacle persists the state in SessionManager (meta.json)
3. Tentacle broadcasts a producer message to all arms
4. All arms update their local store
5. On reconnect, `session_list` includes the pin state so new arms get it

## Changes by Package

### 1. protocol — Add message types and digest field

**`packages/protocol/src/sessions.ts`**
- Add `pinned?: boolean` to `SessionDigest`

**`packages/protocol/src/messages.ts`**
- Add `PinSessionMessage` consumer message (`type: 'pin_session'`, payload: `{ pinned: boolean }`)
- Add `SessionPinnedMessage` producer message (`type: 'session_pinned'`, payload: `{ pinned: boolean }`)
- Add both to their respective union types

### 2. tentacle/session-manager — Persist pin state

**`packages/tentacle/src/session-manager.ts`**
- Add `pinned?: boolean` to `SessionMeta`
- Add `setPin(sessionId, pinned)` method (like `setMode`)
- Include `pinned` in `getSessionList()` output

### 3. tentacle/relay-client — Handle pin messages

**`packages/tentacle/src/relay-client.ts`**
- Handle `pin_session` in `handleConsumerMessage`: call `sessionManager.setPin()`, broadcast `session_pinned`
- Wire into the existing switch statement (like `set_session_mode` → `session_mode_set`)

### 4. arm/web — Send pin, receive pin, sync on session_list

**`packages/arm/web/src/lib/commands.ts`**
- Add `pinSession(sessionId, pinned, send)` function

**`packages/arm/web/src/lib/message-router.ts`**
- Handle `session_pinned` producer message: call `store.setPin(sessionId, pinned)`

**`packages/arm/web/src/hooks/useStore.ts`**
- Replace `togglePin` with `setPin(sessionId, pinned)` (or keep togglePin as a convenience that calls setPin)
- Remove `pinnedSessions` from `partialize` (no longer persisted locally — comes from tentacle)

**`packages/arm/web/src/lib/ws-client.ts`**
- In `handleSessionList`: read `pinned` from digest and call `store.setPin`
- Add `pinSession(sessionId, pinned)` method that sends the consumer message

**`packages/arm/web/src/components/sessions/SessionCard.tsx`**
- Change `togglePin` call to use the new ws-client method (sends to tentacle instead of local-only)

### 5. Tests

- `packages/tentacle/src/__tests__/session-manager.test.ts` — test `setPin` persistence
- `packages/tentacle/src/__tests__/relay-client.test.ts` — test `pin_session` → `session_pinned` flow
- Existing arm tests should still pass (pin rendering is unchanged)

## Migration

Existing local pins in localStorage will be lost on the first sync (session_list
from tentacle won't have any pins yet). This is acceptable for a preview-stage
feature — pins are low-cost to recreate.

## Message Flow

```
Arm A: user pins session "s1"
  → sends { type: 'pin_session', sessionId: 's1', payload: { pinned: true } }  (unicast to tentacle)
  → local store: setPin('s1', true) (optimistic)

Tentacle:
  → sessionManager.setPin('s1', true)  (persists to meta.json)
  → broadcasts { type: 'session_pinned', sessionId: 's1', payload: { pinned: true } }

Arm B (and Arm A):
  → receives session_pinned → store.setPin('s1', true)

On reconnect:
  → session_list includes { ..., pinned: true } for 's1'
  → arm hydrates pin state from digest
```
