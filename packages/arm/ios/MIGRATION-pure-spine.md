# Migration: client → "pure spine cache" (PR #154 data model)

> Goal: the iOS client becomes a **dumb spine cache** — it only persists landed
> spine messages (to cut history re-fetch) and renders them; all transient
> status (draft, action slot, tools, narration, permission/question prompts) is
> **pass-through ephemeral**, never business-logic'd or stored.
>
> Confirmed facts:
> - Tentacle (`main`) already assigns **dense per-session seq only to spine**
>   (`PERSISTENT_TYPES = {session_created, agent_message, user_message, error,
>   system_message, session_ended, idle}`), tools/narration → `trace.jsonl`
>   (no seq), permission/question → card action slot (no seq). So the client's
>   `seq == bottomSeq+1` contiguity contract holds natively.
> - No back-compat: **wipe the local DB** on migration.
> - `ChatMessage` is dynamic (`type` + `payload[AnyCodable]`) → new types are
>   cheap (type strings + accessors, no per-type Codable).

Phases are ordered so each is independently buildable/testable.

---

## Phase 1 — Protocol + persistentTypes + DB wipe (foundation)

**`Core/Protocol/Messages.swift`**
- [ ] Add payload accessors: `steps: Int?` (`payload["steps"]`), `reset: Bool?`
      (`payload["reset"]`), `narrationContent` (already `content`), `headline`
      (exists), `decision`/`answer`/`allowFreeform`.
- [ ] Add a `CardActionState` decode helper (from a `card_action` payload's
      `action`): enum `.toolStart / .toolComplete / .toolBatch(running) /
      .permission / .question` discriminated by the inner `type`.
- [ ] Add a `TraceEntry` decode helper (tool_start / tool_complete /
      agent_narration) reused by the Steps view.
- [ ] `ProducerMessageDecoder`: make sure `system_message`, `card_action`,
      `agent_narration`, `turn_trace_batch` decode (they're dynamic, so mostly
      "don't drop them"). Confirm nothing hard-rejects unknown types.

**`Core/Networking/CommandSender.swift`** (consumer → tentacle)
- [ ] Add `requestTurnTrace(sessionId:, bubbleSeq:)` → `request_turn_trace`.
- [ ] Add `requestCard(sessionId:)` → `request_card`.

**persistentTypes — TWO places must match the tentacle exactly**
- [ ] `MessageStore.persistentTypes` (L74) →
      `{ session_created, user_message, agent_message, system_message, error, idle, session_ended }`.
- [ ] `MessageRouter.persistentTypes` (L96) → same set.
- [ ] `MessageRouter.notifyWorthyTypes` → `{ idle, error }` (permission/question
      are no longer spine; they're the card).

**`Core/Storage/MessageDatabase.swift`**
- [ ] Add migration `v2_pure_spine` that `DROP TABLE messages` + recreate
      (clean wipe, no compat). Bump `schemaVersion`. Old tool/permission rows +
      mismatched seqs gone on next launch.

*Build gate:* compiles; nothing renders differently yet (types just decode).

---

## Phase 2 — MessageStore: card + trace state, drop streaming

**`Core/Storage/MessageStore.swift`**
- [ ] DELETE the streaming machinery: `streamingContent`, `appendDelta`,
      `flushDelta`, `promotePendingDelta`, `pendingDeltaBuffer/Tasks`,
      `onStreamingActivity`, `deltaCoalesceWindow`, `promotePendingDeltaForTesting`,
      `cancelAllDeltaTasks` (streaming parts). `removeStreamingContent` → fold into
      card clear.
- [ ] ADD `struct SessionCard { var text: String; var action: CardActionState? }`
      + `var cards: [String: SessionCard]` (@Observable) +
      `applyCardMessage(_ sid, _ content, reset:)` (keep-last),
      `setCardAction(_ sid, _ action)`, `clearCard(_ sid)`.
- [ ] ADD `var traces: [String: [Int: [TraceEntry]]]` (sid → bubbleSeq → steps,
      **in-memory only, never to DB**) + `setTurnSteps(_ sid, bubbleSeq:, _ entries:)`.
- [ ] SIMPLIFY `hasUnreadWorthy`: unread = `error` OR `idle`-after-`agent_message`
      (drop the permission/question/tool branches — no longer spine).
- [ ] OPTIONAL: drop the px-window-cap (`heightForSeq`/`maxWindowPx`/
      `pxModeCountCeiling`) → revert to plain count cap (ungroup makes cells
      bounded, so the px cap's reason for existing is gone). Can defer.
- [ ] KEEP unchanged: window model (`append`/`ingestBatch`/`expandWindow`/
      `loadInitialWindow`/`recentFromDB`/`dbMessages`/`dropMessagesAboveSeq`…).
      The `append` gap-assert now genuinely can't fire (dense spine).

*Build gate:* store compiles; router still references removed streaming APIs → fixed in Phase 3.

---

## Phase 3 — MessageRouter: spine-only + card/trace pass-through

**`Core/Networking/MessageRouter.swift` `handleDataMessage` cases:**
- [ ] `agent_message_delta` → REPLACE `appendDelta`+`setAgentTextActivity` with
      `store.applyCardMessage(sid, content, reset: payload.reset)`. (draft = card)
- [ ] `card_action` → NEW: `store.setCardAction(sid, CardActionState(payload.action))`.
- [ ] `turn_trace_batch` → NEW: `provider.handleTurnTraceBatch(sid, bubbleSeq, entries, complete)`.
- [ ] `agent_message` → keep spine ingest; REMOVE `flushDelta`/streaming; ADD
      `store.clearCard(sid)` (land-and-clear). Keep preview.
- [ ] `system_message` → NEW: `ingestTailCandidate` (spine) + preview + clearCard.
- [ ] `idle` → keep spine ingest; `clearCard`; preview from last agent_message;
      pull authoritative trace: find concluding `agent_message.seq` →
      `provider.invalidateTurnTrace` + `provider.requestTurnTrace(bubbleSeq)`.
- [ ] `tool_start` / `tool_complete` → DROP (delete the whole case bodies incl.
      `setCurrentTool`/`clearCurrentTool`). Live tool = card action slot.
      (Keep `registerContentRefs` only if attachments still push for card tools —
      move that into the `card_action` handler instead.)
- [ ] `agent_narration` → DROP (trace only, pulled).
- [ ] `permission` / `question` → DROP the spine handling (they're card slots now,
      arriving via `card_action`). Drop the `updatePreview(type: permission/question)`
      — session_list preview already carries it.
- [ ] `permission_resolved` / `question_resolved` / `approve` / `deny` /
      `always_allow` / `answer` → DROP (retired).
- [ ] Keep: `session_created`, `user_message`, `error`, `active`(still no-op),
      metadata cases (`session_mode_set`/`model`/`title`/`pinned`/`read`), and the
      seq bookkeeping block (now correct because persistentTypes shrank).

**`App/AppState.swift`**
- [ ] Remove the `onStreamingActivity → setAgentTextActivity` wiring (L42).

**`Core/Storage/SessionStore.swift`**
- [ ] Remove `setCurrentTool`/`clearCurrentTool`/`currentTool` state and
      `setAgentTextActivity` IF now unused (verify session-list card preview no
      longer needs live tool text — it comes from the digest preview).

*Build/device gate:* live turn shows draft + action via card; spine lands conclusion; no tool bubbles on spine.

---

## Phase 4 — MessageProvider: trace + card channels

**`Core/Storage/MessageProvider.swift`**
- [ ] ADD `requestTurnTrace(sid, bubbleSeq)` (dedup via `tracePulled: Set<String>`
      keyed `sid:bubbleSeq`), `invalidateTurnTrace`, `handleTurnTraceBatch(... )`
      → `store.setTurnSteps`; `requestCard(sid)` (dedup, gated on device
      encryptable) → `commandSender.requestCard`.
- [ ] `ingestTailCandidate` unchanged (its `MessageStore.isPersistent` filter now
      correctly admits only spine).
- [ ] KEEP paging/gap machinery (`PendingTailBuffer`, range fetch, warmup,
      ensureOlder/Newer, jumpToHead) — still valid; fires rarely with dense spine.
      Low-priority simplification later.

*Build gate:* Steps pull works end-to-end against a live tentacle.

---

## Phase 5 — Delete grouping, slim ChatViewModel

- [ ] DELETE `Core/Storage/TurnGrouper.swift` (619) — OR reduce to a tiny
      `turnBoundary(forBubbleSeq:in:)` helper (concluding agent seq → its
      user_message boundary) for the Steps target. Keep the `TurnItem` /
      `ActivityBlock` / `Initiator` TYPES (render layer + ungroup still use
      `.standalone`); delete only the grouping FUNCTIONS.
- [ ] DELETE `Core/Storage/IncrementalGrouper.swift` (743) + `SessionGrouperCache`.
- [ ] `Features/Chat/ChatViewModel.swift`:
      - DELETE `grouperCache`, `groupedKeys`, `cachedRawTurns`, `cachedAllTurnCount`,
        `lastKnownFirstTurnId`, `refreshGroupingCache`, `displayTurns`,
        `pagedTurns` hold-back, `isImplicitBlock`/`isBlock`.
      - DELETE `permissions` / `questions` scans, `streaming`.
      - ADD `spine: [ChatMessage]` = window (already spine); `card` accessor;
        `steps(forBubbleSeq:)` accessor; `stepsTarget` helper.
      - KEEP paging triggers + window seq accessors + pending outbox turns.

*Build gate:* ChatViewModel compiles against the flat spine.

---

## Phase 6 — View integration (productionize the test-page ungroup)

- [ ] Port the validated test-page ungroup into the real path
      (`ChatPerfListView` / `TextKitBubble`): each spine message → one bubble;
      agent bubble body-only; **Steps button → popup** (reuse `WebStepsSheet`-style
      but iOS-styled from `traces`); remove in-bubble expand.
- [ ] Add the **LiveAgentBubble** (draft + single action slot) driven by `card`,
      land-and-clear when the conclusion lands.
- [ ] Re-attach ChatView chrome (navbar / compose / entry-scroll) previously
      bypassed by `usePerfList=true`.

*Device gate:* full chat renders from pure spine + card + lazy trace; scroll perf ≥ current.

---

## Deletion tally (net simplification)
- `TurnGrouper.swift` (~619) + `IncrementalGrouper.swift` (~743) → mostly gone (~1300).
- `ChatViewModel` grouping/permissions/questions/streaming → ~half gone.
- `MessageRouter`: ~8 case bodies deleted (tool/narration/permission/question/
  resolved/approve/deny/answer) + streaming.
- `MessageStore`: streaming machinery deleted; card + trace added (small).

## Open decisions (locked)
1. DB: **wipe** (schema v2 drop-recreate). ✅
2. permission/question: **card slot only** (not spine-persisted). ✅ (matches web)
3. spine seq density: **already dense** on tentacle. ✅ (verified in relay-client.ts)
