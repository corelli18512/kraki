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
enum Initiator: Equatable {
    /// User-initiated. The block's `openers` carries the user-side
    /// message(s) that opened it.
    case user

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

/// One visual block in the chat. Replaces the older `Turn` struct.
struct ActivityBlock: Identifiable {
    let id: String

    /// What caused this block to start. Branching point for the
    /// renderer's header look.
    let initiator: Initiator

    /// The user-side message(s) that opened this block, in arrival
    /// order. Today: always 0 entries (non-user initiators) or 1
    /// entry (`.user` initiator). Future queue support will allow
    /// multiple entries when several user messages land while the
    /// agent is still working on the block.
    var openers: [ChatMessage]

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
    "pending_input",
]

/// Message types that belong in the thinking box.
private let thinkingTypes: Set<String> = [
    "tool_start",
    "tool_complete",
    "agent_message",
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
/// - `user_message` / `send_input` / `pending_input` open a new block
///   with `initiator = .user` and append themselves to `openers`.
///   Tentacle never emits two user-side messages without an
///   intervening idle, so today each `.user` block has exactly one
///   opener; the array shape accommodates the future "queue" case
///   where multiple user messages land before the agent closes the
///   block (see `appendOpenerToActiveBlock` for that path, currently
///   unused).
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
    var currentOpeners: [ChatMessage] = []
    var currentThinking: [ChatMessage] = []
    /// Permission IDs that have been asked but not yet resolved, tracked in
    /// stream order. We can't rely on `ChatMessage.resolution` because
    /// `MessageStore.resolvePermissionMessage` stamps that field
    /// retroactively — by the time the grouper re-runs after the user
    /// approves, the original permission message already looks "resolved",
    /// which would cause the `idle` that fired *during* the wait to flush
    /// the block. Stream-order tracking avoids that.
    var unresolvedPermIds: Set<String> = []
    var skipNextToolComplete = false

    /// True iff there's an in-progress block accumulating state that
    /// hasn't been flushed yet. Used as the "should I flush before
    /// opening a new one?" gate.
    func hasOpenBlock() -> Bool {
        return currentInitiator != nil
            || !currentOpeners.isEmpty
            || !currentThinking.isEmpty
    }

    func flushBlock(blockComplete: Bool) {
        defer { unresolvedPermIds.removeAll() }
        guard hasOpenBlock() else { return }
        // Anchor on a stable message id — first opener (if any),
        // else first accumulated thinking entry. Message ids are
        // unique across the session, so the resulting block id is
        // unique without any position-dependent counter — critical
        // for the chat view's diffable-data-source identity
        // tracking, which needs to relocate a block after tentacle
        // backfill inserts older blocks at the top.
        let anchor = currentOpeners.first?.id
            ?? currentThinking.first?.id
            ?? "unknown"
        let blockId = "turn:\(anchor)"
        let initiator = currentInitiator ?? .implicit

        if !blockComplete {
            // Block still in progress — everything stays in thinking,
            // no final reply yet.
            result.append(.block(ActivityBlock(
                id: blockId,
                initiator: initiator,
                openers: currentOpeners,
                thinkingMessages: currentThinking,
                finalMessage: nil,
                isActive: true
            )))
        } else {
            // Promote the last agent_message in thinking to
            // finalMessage. If none exists (tool-only block, errored
            // block) leave finalMessage nil.
            var lastAgentIdx = -1
            for i in stride(from: currentThinking.count - 1, through: 0, by: -1) {
                if currentThinking[i].type == "agent_message" {
                    lastAgentIdx = i
                    break
                }
            }

            if lastAgentIdx == -1 {
                result.append(.block(ActivityBlock(
                    id: blockId,
                    initiator: initiator,
                    openers: currentOpeners,
                    thinkingMessages: currentThinking,
                    finalMessage: nil,
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
                    openers: currentOpeners,
                    thinkingMessages: thinking,
                    finalMessage: finalMsg,
                    isActive: false
                )))
            }
        }

        currentInitiator = nil
        currentOpeners = []
        currentThinking = []
    }

    for msg in messages {
        // Track permission lifecycle in stream order so a deferred
        // `idle` fires correctly even after MessageStore retroactively
        // stamps `resolution` on the original permission message.
        switch msg.type {
        case "permission":
            if let pid = msg.permissionId { unresolvedPermIds.insert(pid) }
        case "approve", "deny", "always_allow", "permission_resolved":
            if let pid = msg.payload["permissionId"]?.stringValue {
                unresolvedPermIds.remove(pid)
            }
        default: break
        }

        if standaloneTypes.contains(msg.type) {
            flushBlock(blockComplete: true)
            result.append(.standalone(msg))
        } else if userMessageTypes.contains(msg.type) {
            // User-side message opens a new block. Tentacle today
            // never sends two user-side messages without an
            // intervening idle, but defensively close any in-progress
            // block first so a stray double-send still renders cleanly.
            //
            // Future queue work: when multiple user messages can land
            // while the agent is still active, replace this flush with
            // an append into the current block's `openers` — the
            // surrounding shape already supports it.
            if hasOpenBlock() {
                flushBlock(blockComplete: true)
            }
            currentInitiator = .user
            currentOpeners = [msg]
        } else if turnCompleteTypes.contains(msg.type) {
            // Defer the flush if the current block has a permission
            // that hasn't been resolved yet — agents typically emit
            // `idle` while waiting on user approval, but the activity
            // that follows the approval is conceptually part of the
            // same block (one agent thought = one bubble).
            if !unresolvedPermIds.isEmpty {
                continue
            }
            flushBlock(blockComplete: true)
        } else if thinkingTypes.contains(msg.type) {
            // Open an implicit block if a thinking-class message
            // arrives with no opener — this happens in legitimate
            // stream patterns (e.g. an agent reply that follows a
            // standalone `session_created` with no preceding user
            // input) and would otherwise be silently dropped by
            // `flushBlock`'s guard.
            if currentInitiator == nil && currentOpeners.isEmpty && currentThinking.isEmpty {
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
            } else if msg.type == "question_resolved" || msg.type == "answer" || msg.type == "permission_resolved" {
                // Structural — skip, the originating message carries the visible result
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
            flushBlock(blockComplete: true)
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
        if currentInitiator == nil && currentOpeners.isEmpty && currentThinking.isEmpty {
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

    // Flush remaining block — still in progress
    flushBlock(blockComplete: false)

    return result
}
