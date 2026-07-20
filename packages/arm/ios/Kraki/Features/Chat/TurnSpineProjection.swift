#if os(iOS)
import Foundation

/// Projects durable wire/history records into the flat visual chat spine.
/// Raw records remain untouched in MessageStore/SQLite for replay and Steps.
///
/// Invariants:
/// - `error` is turn detail, never a top-level bubble.
/// - A terminal record owns its turn. If an agent_message landed first, its
///   draft/attachments are folded into the terminal record and the agent record
///   is hidden.
/// - A user-bounded turn exposes at most one agent_message: the final one.
enum TurnSpineProjection {
    private static let traceTypes: Set<String> = [
        "tool_start", "tool_complete", "agent_narration", "active",
    ]

    static func project(_ messages: [ChatMessage]) -> [ChatMessage] {
        var projected: [ChatMessage] = []
        var segment: [ChatMessage] = []

        func flushSegment() {
            guard !segment.isEmpty else { return }
            let artifacts = segment.reversed().first(where: { $0.type == "idle" })?.turnArtifacts ?? []
            if let terminalIndex = segment.lastIndex(where: {
                $0.type == "turn_status" || $0.type == "interrupted_turn"
            }) {
                var terminal = normalizedTerminal(segment[terminalIndex],
                                                  fallbackFrom: segment[..<terminalIndex])
                terminal = attaching(artifacts, to: terminal)
                for index in segment.indices {
                    let message = segment[index]
                    if message.type == "error" || message.type == "agent_message" { continue }
                    projected.append(index == terminalIndex ? terminal : message)
                }
            } else {
                var visible = segment.filter { $0.type != "error" }
                if !artifacts.isEmpty,
                   let outcomeIndex = visible.lastIndex(where: {
                       $0.type == "agent_message" || $0.type == "system_message"
                   }) {
                    visible[outcomeIndex] = attaching(artifacts, to: visible[outcomeIndex])
                }
                projected.append(contentsOf: visible)
            }
            segment.removeAll(keepingCapacity: true)
        }

        for message in messages {
            if traceTypes.contains(message.type) { continue }
            segment.append(message)
            if message.type == "idle" { flushSegment() }
        }
        flushSegment()

        return keepOnlyFinalConclusionPerUserTurn(projected)
    }

    private static func normalizedTerminal(
        _ terminal: ChatMessage,
        fallbackFrom prefix: ArraySlice<ChatMessage>
    ) -> ChatMessage {
        guard let fallback = prefix.reversed().first(where: {
            guard $0.type == "agent_message" else { return false }
            return !($0.content ?? "").isEmpty || !($0.attachments ?? []).isEmpty
        }) else { return terminal }

        let ownDraft = terminal.interruptedDraft ?? ""
        let ownAttachments = terminal.payload["attachments"]?.arrayValue ?? []
        let fallbackAttachments = fallback.payload["attachments"]?.arrayValue ?? []
        let needsDraft = ownDraft.isEmpty && !(fallback.content ?? "").isEmpty
        let needsAttachments = ownAttachments.isEmpty && !fallbackAttachments.isEmpty
        guard needsDraft || needsAttachments else { return terminal }

        var normalized = terminal
        if needsDraft { normalized.payload["draft"] = AnyCodable(fallback.content ?? "") }
        if needsAttachments { normalized.payload["attachments"] = AnyCodable(fallbackAttachments) }
        return normalized
    }

    private static func attaching(_ artifacts: [ContentRef], to message: ChatMessage) -> ChatMessage {
        guard !artifacts.isEmpty else { return message }
        var merged = message.payload["attachments"]?.arrayValue ?? []
        var seen: Set<String> = Set(merged.compactMap { item -> String? in
            guard let dict = item.dictValue else { return nil }
            return ContentRef.from(dict)?.id
        })
        for artifact in artifacts where seen.insert(artifact.id).inserted {
            var encoded: [String: AnyCodable] = [
                "type": AnyCodable(artifact.type),
                "id": AnyCodable(artifact.id),
                "mimeType": AnyCodable(artifact.mimeType),
                "size": AnyCodable(artifact.size),
            ]
            if let caption = artifact.caption { encoded["caption"] = AnyCodable(caption) }
            if let name = artifact.name { encoded["name"] = AnyCodable(name) }
            if let width = artifact.width { encoded["width"] = AnyCodable(width) }
            if let height = artifact.height { encoded["height"] = AnyCodable(height) }
            merged.append(AnyCodable(encoded))
        }
        var result = message
        result.payload["attachments"] = AnyCodable(merged)
        return result
    }

    private static func keepOnlyFinalConclusionPerUserTurn(_ messages: [ChatMessage]) -> [ChatMessage] {
        var retainedConclusionIndices = Set<Int>()
        var selectedIndex: Int?
        var terminalOwnsTurn = false

        func retainSelected() {
            if let selectedIndex { retainedConclusionIndices.insert(selectedIndex) }
        }

        for index in messages.indices {
            switch messages[index].type {
            case "user_message", "send_input":
                // A steer is a visible user interjection inside the current
                // agent lifecycle. It remains on the spine but must not split
                // conclusion ownership or TRACE into a synthetic new turn.
                if messages[index].payload["delivery"]?.stringValue != "steer" {
                    retainSelected()
                    selectedIndex = nil
                    terminalOwnsTurn = false
                }
            case "agent_message":
                // Multiple normal replies collapse to the last one. Once a
                // terminal exists, malformed/late agent records cannot revive
                // another reply bubble in the same user-bounded turn.
                if !terminalOwnsTurn { selectedIndex = index }
            case "turn_status", "interrupted_turn":
                // Terminal always wins over a normal reply. Duplicate terminal
                // records can straddle idle markers (seen in production abort
                // history), so keep replacing with the latest terminal until
                // the next user boundary.
                selectedIndex = index
                terminalOwnsTurn = true
            default:
                break
            }
        }
        retainSelected()

        return messages.enumerated().compactMap { index, message in
            let isConclusion = message.type == "agent_message"
                || message.type == "turn_status"
                || message.type == "interrupted_turn"
            guard isConclusion else { return message }
            return retainedConclusionIndices.contains(index) ? message : nil
        }
    }
}
#endif
