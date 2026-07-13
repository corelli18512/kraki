/// TurnGrouper — Groups a flat ChatMessage stream into ActivityBlocks
/// for UI rendering.
///
/// An **ActivityBlock** is a contiguous slice of session events that
/// should render as one visual block in the chat: optional opener(s)
/// at the top, an agent-activity ("thinking") history, and an optional
/// terminal agent reply.
///
/// Generalises the earlier `Turn` model, which assumed every block
/// was opened by a single user message. The new model:
///   • Allows zero, one, or many openers (forward-compat for queueing
///     multiple user messages within one block, and for blocks opened
///     by non-user events such as subagent revoke or system hooks).
///   • Carries an `Initiator` enum that names why the block exists,
///     so renderers can pick the right header look without sniffing
///     payload types.
///
/// Today the grouper only ever emits `.user` and `.implicit` initiators
/// — the other cases (`.agentResumed`, `.systemTriggered`) are reserved
/// for future grouping rules driven by new tentacle message types
/// (e.g. `subagent_complete`, `hook_fired`). The struct shape is
/// designed so adding those rules is an internal grouper change with
/// no impact on rendering call sites beyond growing the
/// `MessageRow` switch.
///
/// Block ids retain the historical `"turn:<anchor_message_id>"` format
/// for cell-identity stability across the rename — UICollectionView's
/// diffable data source diffs by id, so preserving the format avoids
/// gratuitous re-renders for in-flight chats during the rollout.

import Foundation

// MARK: - Types

/// What caused an `ActivityBlock` to start. Renderers branch on this
/// to pick a header style (blue user bubble vs subagent pill vs
/// system-reminder badge vs no header at all).
///
/// `.user` carries the originating `ChatMessage` directly — the
/// opener and the initiator are one and the same. Earlier drafts
/// kept a separate `openers: [ChatMessage]` on the block to support
/// "multiple user messages queued into one block", but real agent
/// SDKs (Anthropic, OpenAI, what Claude Code / Copilot CLI build on)
/// don't accept multi-message input mid-turn — queued messages each
/// become their own block on dispatch. Single opener per `.user`
/// block matches the world we actually live in.
enum Initiator: Equatable {
    /// User-initiated. The associated message is the user-side
    /// bubble that opened the block.
    case user(ChatMessage)

    /// Agent woke back up — e.g. a spawned subagent returned and the
    /// parent agent resumed. `reason` is a free-form tag used by the
    /// renderer to pick a label ("subagent_complete",
    /// "parent_resumed", etc.). Not produced by the current grouper;
    /// reserved for future use.
    case agentResumed(reason: String?)

    /// External trigger — hook, timer, automation. `source` names
    /// the trigger ("openclaw_reminder", "cron:nightly",
    /// "hook:foo"). Not produced by the current grouper; reserved
    /// for future use.
    case systemTriggered(source: String)

    /// No identifiable opener — the first agent-activity event for
    /// the block landed without a preceding initiator-class event.
    /// Defensive fallback so orphan thinking entries don't get
    /// silently dropped.
    case implicit
}

extension Initiator {
    /// Convenience accessor for the user-side opener message when
    /// this is a `.user` initiator. Returns nil for every other
    /// case. Lets callers that only care about user-msg
    /// identification (entry-scroll target, idle-anchor lookup)
    /// stay one line.
    var userMessage: ChatMessage? {
        if case .user(let msg) = self { return msg }
        return nil
    }
}

/// One visual block in the chat. Replaces the older `Turn` struct.
///
/// **Seq range.** `startSeq` and `endSeq` describe the seq window
/// this block occupies in the session's message stream. Two reasons
/// to store them explicitly rather than deriving from children:
///
///   1. `endSeq` for a closed block is the **closing `idle`'s seq**.
///      The idle isn't promoted to `finalMessage`; we'd otherwise
///      need to either look it up via the always-last `thinkingMessages`
///      entry (fragile) or scan all children for the max (O(k)).
///   2. Reconstructing the raw seq order from a cached block
///      (the gap-fill / island-merge paths in `SessionGrouperCache`)
///      needs to know "where did this block end" without re-running
///      the grouper. With explicit endSeq we can emit a fake `idle`
///      with the exact original seq when flattening, instead of the
///      old workaround of synthesising one with the block's
///      max-internal seq.
///
/// **isActive** is also still explicit (not derived from `endSeq`)
/// because there are two distinct "closed without final reply"
/// states — `(closed, no final agent_message)` for tool-only or
/// errored turns — and we need the grouper to mark the difference
/// at flush time. `isActive == true` ⇒ block is still receiving
/// content (no idle seen); the trailing `endSeq` is the seq of the
/// last in-progress message and is **provisional**.
struct ActivityBlock: Identifiable {
    let id: String

    /// What caused this block to start. For `.user` initiators the
    /// opener message is embedded; for other initiators the block
    /// has no user bubble at the top.
    let initiator: Initiator

    /// Everything the agent did inside the block — tool starts /
    /// completions, intermediate `agent_message` chunks, permission
    /// requests, questions, errors, mode toggles. The set of types
    /// here matches `thinkingTypes` below.
    var thinkingMessages: [ChatMessage]

    /// The block's terminal agent reply, if any. Nil while the block
    /// is still active, or for blocks that closed without a final
    /// agent_message (tool-only blocks, errored blocks, blocks
    /// terminated by an external event before producing a reply).
    var finalMessage: ChatMessage?

    /// Smallest seq covered by this block: the initiator's user
    /// message seq, or the first thinking entry's seq for
    /// `.implicit` blocks.
    var startSeq: Int

    /// Largest seq covered by this block. For closed blocks this is
    /// the **closing `idle`'s seq**. For active blocks it's the seq
    /// of the latest message we've ingested; it will keep climbing
    /// until the block closes.
    var endSeq: Int

    /// True until the closing `idle` (or any future explicit
    /// terminator) arrives. Drives streaming-bubble affordances on
    /// the final reply (animated cursor, etc.).
    var isActive: Bool
}

/// An entry in the chat list. Either a free-floating single-message
/// event (session lifecycle) or a full ActivityBlock.
enum TurnItem: Identifiable {
    case standalone(ChatMessage)
    case block(ActivityBlock)

    var id: String {
        switch self {
        case .standalone(let msg): return "standalone:\(msg.id)"
        case .block(let b):        return b.id
        }
    }
}

// MARK: - Constants

/// Message types that display as their own standalone bubble — true
/// session-level events that don't belong to any agent activity
/// block. User messages are NOT standalone: they live at the top of
/// their owning block (idle-bounded).
private let standaloneTypes: Set<String> = [
    "session_created",
    "session_ended",
    "kill_session",
    "session_deleted",
]

/// User-side message types that open a new block. The first one in a
/// block becomes the first entry in `ActivityBlock.openers`. Tentacle
/// today guarantees no two consecutive user-side messages without an
/// intervening agent activity + idle, so we only ever store one
/// opener per block right now — but the `openers` array is sized for
/// the future case where queued user messages are appended into the
/// same block.
private let userMessageTypes: Set<String> = [
    "user_message",
    "send_input",
]

/// Message types that belong in the thinking box.
private let thinkingTypes: Set<String> = [
    "tool_start",
    "tool_complete",
    "agent_message",
    "interrupted_turn",
    "turn_status",
    "permission",
    "permission_resolved",
    "question",
    "question_resolved",
    "answer",
    "error",
    "approve",
    "deny",
    "always_allow",
    "session_mode_set",
    "active",
]

/// Message types that signal the end of an agent block.
private let turnCompleteTypes: Set<String> = [
    "idle",
]

// MARK: - Grouping Function

/// Groups a flat message list into idle-bounded `ActivityBlock`
/// structures for UI rendering.
///
/// Rules:
/// - A **block** is everything between two `idle` markers (the
///   trailing `idle` closes it). Each block typically has one
///   user-side opener + agent activity + a final agent reply.
/// - `user_message` / `send_input` open a new block
///   with `initiator = .user(msg)`. Tentacle never emits two
///   user-side messages without an intervening idle, so today each
///   `.user` block is opened by exactly one message.
/// - Within a block, all messages except the last `agent_message` go
///   into `thinkingMessages`; the last `agent_message` becomes
///   `finalMessage` on block close.
/// - `session_created` / `session_ended` / `kill_session` /
///   `session_deleted` render as their own standalone bubbles.
/// - `tool_start` + `tool_complete` merged by `toolCallId`.
/// - `question` merged into the preceding `ask_user` tool_start.
/// - `idle` arriving while a permission is still unresolved is
///   DEFERRED (skipped) — the activity following approval is
///   conceptually part of the same block.
/// - Active streaming content is appended as a synthetic
///   `agent_message` in the current block.
/// - Thinking-class messages arriving with no open block fall back
///   to `initiator: .implicit` rather than being dropped.
func groupMessagesIntoTurns(
    _ messages: [ChatMessage],
    streamingContent: String? = nil
) -> [TurnItem] {
    var result: [TurnItem] = []
    var currentInitiator: Initiator? = nil
    var currentThinking: [ChatMessage] = []
    /// Permission IDs that have been asked but not yet resolved,
    /// tracked in stream order. Idle is deferred while this is
    /// non-empty so the resolver lands inside the same open block —
    /// the grouper can then backpatch the originating permission row
    /// with the resolution badge. Tracking by id (rather than
    /// scanning `currentThinking` payloads) keeps the deferral logic
    /// cheap and lets us survive future changes to how the resolution
    /// is encoded on the row.
    var unresolvedPermIds: Set<String> = []
    /// Question IDs that have been asked but not yet answered. Same
    /// mechanism as permissions — defers idle so the answer lands in
    /// the same open block for backpatch. `ask_user` is a blocking
    /// tool so in practice the agent doesn't idle before the answer,
    /// but the explicit gate matches the permission path and protects
    /// against future agent SDKs with different timing.
    var unresolvedQuestionIds: Set<String> = []
    var skipNextToolComplete = false

    /// True iff there's an in-progress block accumulating state that
    /// hasn't been flushed yet. Used as the "should I flush before
    /// opening a new one?" gate.
    func hasOpenBlock() -> Bool {
        return currentInitiator != nil
            || !currentThinking.isEmpty
    }

    func flushBlock(closingSeq: Int?) {
        // closingSeq:
        //   - Real idle seq when called by the idle branch.
        //   - nil when called by "force-close before opening a new
        //     block" paths (user-message-back-to-back, standalone
        //     arrival, unknown type) — in those cases we mark the
        //     block as still active so the UI doesn't claim it
        //     finished cleanly. endSeq falls back to the seq of the
        //     last thinking message.
        //   - nil when called at end-of-stream → block stays active.
        defer {
            unresolvedPermIds.removeAll()
            unresolvedQuestionIds.removeAll()
        }
        guard hasOpenBlock() else { return }
        // Anchor on a stable message id — the .user initiator's
        // message (if any), else first accumulated thinking entry.
        // Message ids are unique across the session, so the resulting
        // block id is unique without any position-dependent counter —
        // critical for the chat view's diffable-data-source identity
        // tracking, which needs to relocate a block after tentacle
        // backfill inserts older blocks at the top.
        let anchor = currentInitiator?.userMessage?.id
            ?? currentThinking.first?.id
            ?? "unknown"
        let blockId = "turn:\(anchor)"
        let initiator = currentInitiator ?? .implicit

        let startSeq = currentInitiator?.userMessage?.seq
            ?? currentThinking.first?.seq
            ?? 0
        // For closed blocks: closingSeq is the real idle. For active
        // blocks: the seq of the latest piece we have.
        let lastInternalSeq = max(
            currentInitiator?.userMessage?.seq ?? 0,
            currentThinking.map(\.seq).max() ?? 0
        )
        let endSeq = closingSeq ?? lastInternalSeq
        let isActive = (closingSeq == nil)

        if isActive {
            // Block still in progress — everything stays in thinking,
            // no final reply yet.
            result.append(.block(ActivityBlock(
                id: blockId,
                initiator: initiator,
                thinkingMessages: currentThinking,
                finalMessage: nil,
                startSeq: startSeq,
                endSeq: endSeq,
                isActive: true
            )))
        } else {
            // Promote the last agent_message in thinking to
            // finalMessage. If none exists (tool-only block, errored
            // block) leave finalMessage nil.
            var lastAgentIdx = -1
            for i in stride(from: currentThinking.count - 1, through: 0, by: -1) {
                if currentThinking[i].type == "agent_message" || currentThinking[i].type == "interrupted_turn" || currentThinking[i].type == "turn_status" {
                    lastAgentIdx = i
                    break
                }
            }

            if lastAgentIdx == -1 {
                result.append(.block(ActivityBlock(
                    id: blockId,
                    initiator: initiator,
                    thinkingMessages: currentThinking,
                    finalMessage: nil,
                    startSeq: startSeq,
                    endSeq: endSeq,
                    isActive: false
                )))
            } else {
                let thinking = currentThinking.enumerated()
                    .filter { $0.offset != lastAgentIdx }
                    .map(\.element)
                let finalMsg = currentThinking[lastAgentIdx]
                result.append(.block(ActivityBlock(
                    id: blockId,
                    initiator: initiator,
                    thinkingMessages: thinking,
                    finalMessage: finalMsg,
                    startSeq: startSeq,
                    endSeq: endSeq,
                    isActive: false
                )))
            }
        }

        currentInitiator = nil
        currentThinking = []
    }

    for msg in messages {
        // Track permission lifecycle in stream order so a deferred
        // `idle` fires correctly. When a resolver arrives we also
        // backpatch the matching permission row in `currentThinking`
        // with its resolution — the rendered bubble reads
        // `payload["resolution"]` to show the approved/denied badge.
        // This replaces the old `MessageStore.resolvePermissionMessage`
        // in-memory stamp; folding inside the grouper means cold-start
        // (re-derive from raw messages) and live ingest converge on
        // the same render state.
        switch msg.type {
        case "permission":
            if let pid = msg.permissionId { unresolvedPermIds.insert(pid) }
        case "approve", "deny", "always_allow", "permission_resolved":
            let pid = msg.payload["permissionId"]?.stringValue
            let resolution = derivedPermissionResolution(msg)
            if let pid {
                unresolvedPermIds.remove(pid)
                if let resolution {
                    backpatchPermission(in: &currentThinking,
                                        permissionId: pid,
                                        resolution: resolution)
                }
            }
        case "question":
            // Only track question lifecycle when there's a matching
            // `ask_user` tool_start to merge into — orphan questions
            // (no preceding tool) get dropped by the grouper, so they
            // can't be backpatched and shouldn't gate idle.
            if let qid = msg.payload["id"]?.stringValue,
               currentThinking.contains(where: {
                   $0.type == "tool_start" && ($0.toolName == "ask_user" || $0.toolName == "ask")
               }) {
                unresolvedQuestionIds.insert(qid)
            }
        case "answer", "question_resolved":
            if let qid = msg.payload["questionId"]?.stringValue {
                unresolvedQuestionIds.remove(qid)
                if let answer = msg.payload["answer"]?.stringValue {
                    backpatchQuestion(in: &currentThinking,
                                      questionId: qid,
                                      answer: answer)
                }
            }
        default: break
        }

        if standaloneTypes.contains(msg.type) {
            // Force-close: there's no idle here, so endSeq falls
            // back to the last in-block seq and the block stays
            // active (closingSeq: nil).
            flushBlock(closingSeq: nil)
            result.append(.standalone(msg))
        } else if userMessageTypes.contains(msg.type) {
            // User-side message opens a new block. Tentacle today
            // never sends two user-side messages without an
            // intervening idle, but defensively close any in-progress
            // block first so a stray double-send still renders cleanly.
            //
            // If queue support ever lands at the SDK level (multiple
            // user messages dispatched to one agent invocation), this
            // is the spot to grow — either keep the flush-and-open
            // pattern (one block per dispatched message) or attach the
            // new opener as a sibling on the active block. The struct
            // is single-opener today; multi-opener would require
            // bringing back the array shape.
            if hasOpenBlock() {
                flushBlock(closingSeq: nil)
            }
            currentInitiator = .user(msg)
        } else if turnCompleteTypes.contains(msg.type) {
            // Defer the flush if the current block has a permission
            // or question that hasn't been resolved/answered yet —
            // agents typically emit `idle` while waiting on user
            // input, but the activity that follows is conceptually
            // part of the same block (one agent thought = one bubble).
            if !unresolvedPermIds.isEmpty || !unresolvedQuestionIds.isEmpty {
                continue
            }
            // Real idle closes the block; its seq becomes the
            // block's endSeq.
            flushBlock(closingSeq: msg.seq)
        } else if thinkingTypes.contains(msg.type) {
            // Open an implicit block if a thinking-class message
            // arrives with no opener — this happens in legitimate
            // stream patterns (e.g. an agent reply that follows a
            // standalone `session_created` with no preceding user
            // input) and would otherwise be silently dropped by
            // `flushBlock`'s guard.
            if currentInitiator == nil && currentThinking.isEmpty {
                currentInitiator = .implicit
            }
            // Questions: merge into the preceding ask_user tool_start
            // so the question + answer render inline in the tool chip
            // rather than as a separate bubble. The tool_complete that
            // follows carries the answer in `payload.result` (or
            // similar), which the askUserBody view renders.
            if msg.type == "question" {
                if let startIdx = currentThinking.lastIndex(where: {
                    $0.type == "tool_start" && ($0.toolName == "ask_user" || $0.toolName == "ask")
                }) {
                    var updatedPayload = currentThinking[startIdx].payload
                    updatedPayload["questionText"] = AnyCodable(msg.payload["question"]?.stringValue ?? "")
                    updatedPayload["questionChoices"] = msg.payload["choices"] ?? AnyCodable(nil)
                    updatedPayload["questionId"] = AnyCodable(msg.payload["id"]?.stringValue ?? "")
                    currentThinking[startIdx] = ChatMessage(
                        type: currentThinking[startIdx].type,
                        seq: currentThinking[startIdx].seq,
                        sessionId: currentThinking[startIdx].sessionId,
                        deviceId: currentThinking[startIdx].deviceId,
                        timestamp: currentThinking[startIdx].timestamp,
                        payload: updatedPayload
                    )
                }
                // Don't append — question is now merged into the tool entry
            } else if msg.type == "question_resolved" || msg.type == "answer"
                        || msg.type == "permission_resolved"
                        || msg.type == "approve" || msg.type == "deny" || msg.type == "always_allow" {
                // Structural resolver echoes — the originating
                // permission/question row carries the visible result
                // after the backpatch above. Don't emit them.
            } else if msg.type == "tool_complete" && skipNextToolComplete {
                skipNextToolComplete = false
            } else if msg.type == "tool_complete" {
                // Replace matching tool_start with this tool_complete (merge args)
                let toolCallId = msg.toolCallId
                if let toolCallId, !toolCallId.isEmpty {
                    if let startIdx = currentThinking.firstIndex(where: {
                        $0.type == "tool_start" && $0.toolCallId == toolCallId
                    }) {
                        let startMsg = currentThinking[startIdx]
                        let startArgs = startMsg.args ?? [:]
                        let completeArgs = msg.args ?? [:]
                        var mergedPayload = msg.payload
                        mergedPayload["toolName"] = msg.payload["toolName"] ?? startMsg.payload["toolName"]
                        // Carry over argsRef from tool_start: tentacle only
                        // ships the lazy ref on tool_start, but the view
                        // renders tool_complete and needs to fetch args
                        // (e.g. to show an `edit` diff).
                        if mergedPayload["argsRef"] == nil,
                           let ar = startMsg.payload["argsRef"] {
                            mergedPayload["argsRef"] = ar
                        }
                        // Carry over question metadata from tool_start (merged from question message)
                        if let qt = startMsg.payload["questionText"] { mergedPayload["questionText"] = qt }
                        if let qc = startMsg.payload["questionChoices"] { mergedPayload["questionChoices"] = qc }
                        if let qi = startMsg.payload["questionId"] { mergedPayload["questionId"] = qi }
                        var mergedArgs: [String: AnyCodable] = [:]
                        for (k, v) in startArgs { mergedArgs[k] = v }
                        for (k, v) in completeArgs { mergedArgs[k] = v }
                        mergedPayload["args"] = AnyCodable(mergedArgs)

                        currentThinking[startIdx] = ChatMessage(
                            type: msg.type,
                            seq: startMsg.seq,
                            sessionId: msg.sessionId,
                            deviceId: msg.deviceId,
                            timestamp: msg.timestamp,
                            payload: mergedPayload
                        )
                    } else {
                        currentThinking.append(msg)
                    }
                } else {
                    currentThinking.append(msg)
                }
            } else {
                currentThinking.append(msg)
            }
        } else {
            // Unknown type — treat as standalone to be safe
            flushBlock(closingSeq: nil)
            result.append(.standalone(msg))
        }
    }

    // Append streaming content as synthetic agent_message in the
    // current block. We use a negative sentinel seq (-1) to flag this
    // synthetic entry — Int.max would be a valid seq value the
    // persistence layer could try to write and that would break
    // head/gap detection forever if it leaked. Negative sentinels are
    // explicitly rejected by `appendMessage`'s seq check.
    if let streaming = streamingContent, !streaming.isEmpty {
        // Streaming without an open block ⇒ open implicit so the
        // synthetic message has a home.
        if currentInitiator == nil && currentThinking.isEmpty {
            currentInitiator = .implicit
        }
        let syntheticMessage = ChatMessage(
            type: "agent_message",
            seq: -1,
            sessionId: nil,
            deviceId: nil,
            timestamp: ISO8601.now(),
            payload: ["content": AnyCodable(streaming)]
        )
        currentThinking.append(syntheticMessage)
    }

    // Flush remaining block — still in progress (no closing idle).
    flushBlock(closingSeq: nil)

    return result
}

// MARK: - Resolution backpatch helpers
//
// Shared with IncrementalGrouper via the same logic (both grouper
// paths must produce identical output for `testStreamingMatchesBatch`
// to pass). IncrementalGrouper has its own file-private copies in
// SessionGrouperCache — keep these in sync.

/// Map a resolver message onto the canonical resolution string carried
/// by the originating permission row. `permission_resolved` ships the
/// resolution explicitly; the legacy `approve`/`deny`/`always_allow`
/// types derive it from the type itself.
fileprivate func derivedPermissionResolution(_ msg: ChatMessage) -> String? {
    switch msg.type {
    case "approve": return "approved"
    case "deny": return "denied"
    case "always_allow": return "always_allowed"
    case "permission_resolved": return msg.payload["resolution"]?.stringValue
    default: return nil
    }
}

/// Stamp `resolution` onto the most recent matching `permission` row
/// in `thinking`. Idle is gated by `unresolvedPermIds` so the
/// originating row is always still in `currentThinking` when its
/// resolver arrives — no need to scan closed blocks.
fileprivate func backpatchPermission(in thinking: inout [ChatMessage],
                                     permissionId: String,
                                     resolution: String) {
    guard let idx = thinking.lastIndex(where: {
        $0.type == "permission" && $0.permissionId == permissionId
    }) else { return }
    var patched = thinking[idx]
    patched.payload["resolution"] = AnyCodable(resolution)
    thinking[idx] = patched
}

/// Stamp `answer` onto the entry carrying `questionId`. After the
/// `question` merges into the preceding `ask_user` tool_start (and
/// possibly further into a subsequent tool_complete), the questionId
/// lives in that merged entry's payload. Idle is gated by
/// `unresolvedQuestionIds` so the entry is still in `currentThinking`
/// when the answer arrives.
fileprivate func backpatchQuestion(in thinking: inout [ChatMessage],
                                   questionId: String,
                                   answer: String) {
    guard let idx = thinking.lastIndex(where: {
        $0.payload["questionId"]?.stringValue == questionId
    }) else { return }
    var patched = thinking[idx]
    patched.payload["answer"] = AnyCodable(answer)
    thinking[idx] = patched
}
