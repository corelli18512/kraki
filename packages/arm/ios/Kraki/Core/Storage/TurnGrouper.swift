/// TurnGrouper — Port of useTurns.ts turn grouping logic.
///
/// Groups a flat ChatMessage array into turns for UI rendering.
/// Each turn contains thinking steps (tool calls, intermediate agent messages)
/// and optionally a final agent message.

import Foundation

// MARK: - Types

struct Turn: Identifiable {
    let id: String
    var thinkingMessages: [ChatMessage]
    var finalMessage: ChatMessage?
    /// True if the turn is still receiving messages (no idle yet).
    var isActive: Bool
}

enum TurnItem: Identifiable {
    case standalone(ChatMessage)
    case turn(Turn)

    var id: String {
        switch self {
        case .standalone(let msg): return "standalone:\(msg.id)"
        case .turn(let turn):      return turn.id
        }
    }
}

// MARK: - Constants

/// Message types that always display as standalone (never collapsed into thinking).
private let standaloneTypes: Set<String> = [
    "user_message",
    "send_input",
    "pending_input",
    "session_created",
    "session_ended",
    "kill_session",
    "session_deleted",
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

/// Message types that signal the end of an agent turn.
private let turnCompleteTypes: Set<String> = [
    "idle",
]

// MARK: - Grouping Function

/// Groups a flat message list into turn-based structure for UI rendering.
///
/// Rules (mirror web exactly):
/// - Standalone messages are emitted directly.
/// - Between user messages, all agent-side messages are grouped into a Turn.
/// - Within a Turn, all messages except the last agent_message go into thinkingMessages.
/// - The last agent_message becomes finalMessage.
/// - tool_start + tool_complete merged by toolCallId (complete replaces start, args merged).
/// - Questions are always standalone, splitting the turn.
/// - idle signals turn complete.
/// - Active streaming content appended as synthetic agent_message in current turn.
func groupMessagesIntoTurns(
    _ messages: [ChatMessage],
    streamingContent: String? = nil
) -> [TurnItem] {
    var result: [TurnItem] = []
    var currentThinking: [ChatMessage] = []
    /// Permission IDs that have been asked but not yet resolved, tracked in
    /// stream order. We can't rely on `ChatMessage.resolution` because
    /// `MessageStore.resolvePermissionMessage` stamps that field
    /// retroactively — by the time the grouper re-runs after the user
    /// approves, the original permission message already looks "resolved",
    /// which would cause the `idle` that fired *during* the wait to flush
    /// the turn. Stream-order tracking avoids that.
    var unresolvedPermIds: Set<String> = []
    var skipNextToolComplete = false
    var turnCounter = 0

    func flushTurn(turnComplete: Bool) {
        defer { unresolvedPermIds.removeAll() }
        guard !currentThinking.isEmpty else { return }
        turnCounter += 1
        let turnId = "turn:\(turnCounter):\(currentThinking.first?.id ?? "unknown")"

        if !turnComplete {
            // Turn still in progress — everything stays in thinking
            result.append(.turn(Turn(
                id: turnId,
                thinkingMessages: currentThinking,
                finalMessage: nil,
                isActive: true
            )))
        } else {
            // Find the last agent_message as the final output
            var lastAgentIdx = -1
            for i in stride(from: currentThinking.count - 1, through: 0, by: -1) {
                if currentThinking[i].type == "agent_message" {
                    lastAgentIdx = i
                    break
                }
            }

            if lastAgentIdx == -1 {
                // No agent_message — just thinking steps
                result.append(.turn(Turn(
                    id: turnId,
                    thinkingMessages: currentThinking,
                    finalMessage: nil,
                    isActive: false
                )))
            } else {
                let thinking = currentThinking.enumerated()
                    .filter { $0.offset != lastAgentIdx }
                    .map(\.element)
                let finalMsg = currentThinking[lastAgentIdx]
                result.append(.turn(Turn(
                    id: turnId,
                    thinkingMessages: thinking,
                    finalMessage: finalMsg,
                    isActive: false
                )))
            }
        }

        currentThinking = []
    }

    for msg in messages {
        // Track permission lifecycle in stream order so a deferred `idle`
        // fires correctly even after MessageStore retroactively stamps
        // `resolution` on the original permission message.
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
            flushTurn(turnComplete: true)
            result.append(.standalone(msg))
        } else if turnCompleteTypes.contains(msg.type) {
            // Defer the flush if the current turn has a permission that
            // hasn't been resolved yet — agents typically emit `idle`
            // while waiting on user approval, but the activity that
            // follows the approval is conceptually part of the same
            // turn (one agent thought = one bubble).
            if !unresolvedPermIds.isEmpty {
                continue
            }
            flushTurn(turnComplete: true)
        } else if thinkingTypes.contains(msg.type) {
            // Questions: merge into the preceding ask_user tool_start
            // so the question + answer render inline in the tool chip
            // rather than as a separate bubble. The tool_complete that
            // follows carries the answer in `payload.result` (or
            // similar), which the askUserBody view renders.
            if msg.type == "question" {
                // Find the preceding tool_start for ask_user and attach question text
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
            flushTurn(turnComplete: true)
            result.append(.standalone(msg))
        }
    }

    // Append streaming content as synthetic agent_message in the current turn.
    // We use a negative sentinel seq (-1) to flag this synthetic
    // entry — Int.max would be a valid seq value the persistence
    // layer could try to write and that would break head/gap
    // detection forever if it leaked. Negative sentinels are
    // explicitly rejected by `appendMessage`'s seq check.
    if let streaming = streamingContent, !streaming.isEmpty {
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

    // Flush remaining turn — still in progress
    flushTurn(turnComplete: false)

    return result
}
