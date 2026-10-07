/// Messages — the app's chat model and the few wire shapes it decodes.
///
/// Incoming messages are decoded generically into `ChatMessage` (type + seq +
/// AnyCodable payload) by `ProducerMessageDecoder`; outgoing commands are
/// built as dictionaries in CommandSender. The typed enum mirror of every
/// @kraki/protocol message that used to live here was never used and was
/// removed (2026-10 review); @kraki/protocol (TypeScript) is the reference.
///
/// Foundation types (AnyCodable, SessionState, SessionMode, SessionUsage,
/// SessionDigest, DeviceSummary, DeviceRole, DeviceKind, ReasoningEffort,
/// ModelDetail, ImageAttachment) are defined in ProtocolTypes.swift.

import Foundation

// MARK: - Supporting Types

/// General agent category. Mirrors `AgentType` in the TS protocol.
typealias AgentType = String  // currently only "code"

/// Specific agent implementation within a type.
/// Mirrors `AgentId` in the TS protocol. Kept as a String alias instead
/// of a closed enum so a tentacle advertising a future agent doesn't
/// fail to decode on this client.
typealias AgentId = String  // "copilot" | "claude" | future

/// Per-agent capability descriptor reported by a tentacle in
/// `device_greeting`. A single tentacle can advertise multiple agents
/// (e.g. Copilot + Claude Code) — the previous flat `models[]` is
/// replaced by an array of these.
struct AgentCapabilities: Codable, Equatable, Sendable {
    var type: AgentType
    var id: AgentId
    var models: [String]?
    var modelDetails: [ModelDetail]?
}

// MARK: - Session spine contract

/// The durable per-Session sequence owned by Tentacle.
///
/// There are three distinct ordering domains in the protocol:
/// - transport/Pulse ordering, which is connection-scoped;
/// - the global envelope `seq` retained by transient live messages;
/// - this dense per-Session spine `seq`, assigned only when Tentacle appends a
///   `PERSISTENT_TYPE` to `messages.jsonl`.
///
/// Rendering is a projection of this set: lifecycle rows, `error`, and `idle`
/// remain on the durable spine even when they do not produce their own cell.
/// Historical pre-pure-spine logs can be sparse because retired transient rows
/// consumed Session seq values; replay filters those rows without renumbering.
/// Keep this set exactly aligned with `RelayClient.PERSISTENT_TYPES`.
enum SessionSpineContract {
    static let persistentTypes: Set<String> = [
        "session_created",
        "agent_message",
        "interrupted_turn",
        "turn_status",
        "user_message",
        "system_message",
        "error",
        "session_ended",
        "idle",
    ]

    static func contains(type: String, seq: Int) -> Bool {
        seq > 0 && persistentTypes.contains(type)
    }
}

// MARK: - Chat Message (unified storage type)

/// Flat message representation used for storage and UI rendering.
/// Bridges between the strongly-typed protocol messages and the
/// generic key-value store used by MessageStore and views.
struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    /// Stable identity for diffable rendering. Confirmed messages
    /// use `(sessionId, seq)` since seq is unique within a session.
    /// Optimistic pending placeholders have `seq == 0` so we fall
    /// back to the `clientId` correlation id — without this, two
    /// simultaneous in-flight sends would collide on `session:0`.
    var id: String {
        if seq == 0, let cid = payload["clientId"]?.stringValue {
            return "\(sessionId ?? "none"):pending:\(cid)"
        }
        return "\(sessionId ?? "none"):\(seq)\(questionPresentation?.identitySuffix ?? "")"
    }

    /// `agent_message.payload.question`: the agent asked the human.
    struct QuestionSpec: Equatable, Sendable {
        let id: String
        let text: String
        let choices: [String]
    }

    var questionSpec: QuestionSpec? {
        guard type == "agent_message",
              let q = payload["question"]?.dictValue,
              let id = q["id"]?.stringValue else { return nil }
        let choices = q["choices"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return QuestionSpec(id: id, text: q["text"]?.stringValue ?? "", choices: choices)
    }

    /// `user_message.payload.answerTo` / pending input: answers that question.
    var answerTo: String? { payload["answerTo"]?.stringValue }

    /// The terminal outcome of a `turn_status` (or legacy `interrupted_turn`,
    /// rebuilt from its reason). Nil for other messages and for a
    /// `turn_status` without an action.
    var terminalOutcome: TerminalOutcome? {
        switch type {
        case "turn_status":
            guard let action = terminalAction, let kind = action["type"]?.stringValue else { return nil }
            return TerminalOutcome(type: kind, message: action["payload"]?.dictValue?["message"]?.stringValue)
        case "interrupted_turn":
            return payload["reason"]?.stringValue == "process_lost"
                ? TerminalOutcome(type: "failed", message: "Agent process was lost")
                : TerminalOutcome(type: "user_abort", message: nil)
        default:
            return nil
        }
    }

    /// Body text + action slot of a spine row drawn as a frozen card (the
    /// same view as the live card), on iOS and Mac alike:
    /// - a terminal status: its draft + the outcome ("User aborted");
    /// - a question: the lead-in prose and the **bold** question (identical
    ///   in every state), plus the choices while it is open, or the outcome
    ///   of the turn that ended while it was asked.
    /// Nil for every other row.
    var frozenCard: MessageStore.SessionCard? {
        if let spec = questionSpec {
            var parts: [String] = []
            if let lead = content, !lead.isEmpty { parts.append(lead) }
            let bold = spec.text.split(separator: "\n", omittingEmptySubsequences: true)
                .map { "**\($0.trimmingCharacters(in: .whitespaces))**" }.joined(separator: "\n")
            if !bold.isEmpty { parts.append(bold) }
            let action: ChatMessage?
            if questionPresentation?.state == .open {
                action = actionMessage("question", [
                    "id": AnyCodable(spec.id),
                    "choices": AnyCodable(spec.choices),
                ])
            } else {
                action = questionPresentation?.outcome.map(outcomeAction)
            }
            return MessageStore.SessionCard(text: parts.joined(separator: "\n\n"), action: action)
        }
        guard type == "turn_status" || type == "interrupted_turn" else { return nil }
        return MessageStore.SessionCard(text: interruptedDraft ?? "", action: terminalOutcome.map(outcomeAction))
    }

    private func outcomeAction(_ outcome: TerminalOutcome) -> ChatMessage {
        actionMessage(outcome.type, outcome.message.map { ["message": AnyCodable($0)] } ?? [:])
    }

    private func actionMessage(_ type: String, _ payload: [String: AnyCodable]) -> ChatMessage {
        ChatMessage(type: type, seq: 0, sessionId: sessionId, deviceId: deviceId,
                    timestamp: timestamp, payload: payload)
    }

    let type: String
    let seq: Int
    let sessionId: String?
    let deviceId: String?
    let timestamp: String?
    var payload: [String: AnyCodable]
    /// Client-only presentation of a question bubble, derived from what
    /// follows it on the spine (`ChatViewModel.presentingQuestions`). Never
    /// decoded, encoded or persisted.
    var questionPresentation: QuestionPresentation? = nil

    private enum CodingKeys: String, CodingKey {
        case type, seq, sessionId, deviceId, timestamp, payload
    }

    // MARK: Convenience Accessors

    var content: String? { payload["content"]?.stringValue }
    var interruptedDraft: String? { payload["draft"]?.stringValue }
    /// `turn_status` payload's terminal action: `{type: user_abort|failed, payload:{...}}`.
    /// For `interrupted_turn` (legacy) the card action is rebuilt by the caller.
    var terminalAction: [String: AnyCodable]? { payload["action"]?.dictValue }
    /// `turn_status.finishedAt` — the real ISO timestamp a frozen terminal card
    /// anchors its footer to (mirrors web `frozen.timestamp`). Falls back to
    /// `interrupted_turn.interruptedAt` for the legacy message.
    var finishedAt: String? { payload["finishedAt"]?.stringValue ?? payload["interruptedAt"]?.stringValue }
    var toolName: String? { payload["toolName"]?.stringValue }
    var toolCallId: String? { payload["toolCallId"]?.stringValue }
    var result: String? { payload["result"]?.stringValue }
    var permissionId: String? { payload["id"]?.stringValue ?? payload["permissionId"]?.stringValue }
    var questionId: String? { payload["id"]?.stringValue ?? payload["questionId"]?.stringValue }
    var description_: String? { payload["description"]?.stringValue }
    var toolDescription: String? { description_ }
    var requestId: String? { payload["requestId"]?.stringValue }
    var errorMessage: String? { payload["message"]?.stringValue }
    var reason: String? { payload["reason"]?.stringValue }
    var resolution: String? { payload["resolution"]?.stringValue }
    var cancelled: Bool { payload["cancelled"]?.boolValue ?? false }
    /// TRACE step count stamped on a concluding bubble (agent_message /
    /// system_message) by the tentacle. `> 0` ⇒ the turn has pullable steps.
    var steps: Int? { payload["steps"]?.intValue }
    /// Draft-bubble keep-last flag on `agent_message_delta`: replace the current
    /// draft with `content` instead of appending when true.
    var reset: Bool? { payload["reset"]?.boolValue }
    /// `system_message` kind (e.g. "no_reply").
    var systemKind: String? { payload["kind"]?.stringValue }
    var pinned: Bool? { payload["pinned"]?.boolValue }
    var mode: String? { payload["mode"]?.stringValue }
    var model: String? { payload["model"]?.stringValue }
    var title: String? { payload["title"]?.stringValue }
    var autoTitle: String? { payload["autoTitle"]?.stringValue }
    /// Correlation id round-tripped through tentacle for pending_input
    /// resolution. Present on pending_input placeholders and on
    /// user_message broadcasts that resulted from a `send_input`
    /// carrying it. Absent on legacy/imported messages.
    var clientId: String? { payload["clientId"]?.stringValue }

    var choices: [String]? {
        payload["choices"]?.arrayValue?.compactMap { $0.stringValue }
    }

    var attachments: [ImageAttachment]? {
        guard let arr = payload["attachments"]?.arrayValue else { return nil }
        return arr.compactMap { item -> ImageAttachment? in
            guard let dict = item.dictValue,
                  let type = dict["type"]?.stringValue,
                  let mimeType = dict["mimeType"]?.stringValue,
                  let data = dict["data"]?.stringValue else { return nil }
            return ImageAttachment(type: type, mimeType: mimeType, data: data)
        }
    }

    /// Tentacle-composed short header for tool messages (v0.17+).
    /// Read directly without per-tool client logic.
    var headline: String? { payload["headline"]?.stringValue }

    /// Lazy ref to the tool's args JSON (v0.17+). Absent for trivially
    /// small args that ship inline. Backed by the attachment pipeline.
    var argsRef: ContentRef? {
        guard let dict = payload["argsRef"]?.dictValue else { return nil }
        return ContentRef.from(dict)
    }

    /// Lazy ref to the tool's result body (v0.17+). Always present on
    /// `tool_complete` except when the tool produced no result.
    var resultRef: ContentRef? {
        guard let dict = payload["resultRef"]?.dictValue else { return nil }
        return ContentRef.from(dict)
    }

    /// Content-ref typed entries in the message's `attachments` array
    /// (used for tool-produced images via `kraki-show_image`). Inline
    /// image attachments are still surfaced via `attachments`.
    /// An image-only message ("[image]" placeholder text) whose image is no
    /// longer on the record. Shown as a note instead of vanishing entirely.
    var imageUnavailable: Bool {
        guard content == "[image]" else { return false }
        if attachments?.contains(where: { $0.type == "image" }) == true { return false }
        return !contentRefAttachments.contains { $0.mimeType.hasPrefix("image/") }
    }
    static let imageUnavailableText = "_Image unavailable_"

    var contentRefAttachments: [ContentRef] {
        guard let arr = payload["attachments"]?.arrayValue else { return [] }
        return arr.compactMap { item -> ContentRef? in
            guard let dict = item.dictValue else { return nil }
            return ContentRef.from(dict)
        }
    }

    /// Durable user-visible image/HTML refs attached to a turn's closing idle.
    /// The visual projection moves these onto the final agent/terminal outcome;
    /// bytes remain lazy in AttachmentStore.
    var turnArtifacts: [ContentRef] {
        guard type == "idle", let arr = payload["turnArtifacts"]?.arrayValue else { return [] }
        return arr.compactMap { item -> ContentRef? in
            guard let dict = item.dictValue else { return nil }
            return ContentRef.from(dict)
        }
    }

    var args: [String: AnyCodable]? {
        payload["args"]?.dictValue
    }

    var usage: SessionUsage? {
        guard let dict = payload["usage"]?.dictValue else { return nil }
        guard let input = dict["inputTokens"]?.intValue,
              let output = dict["outputTokens"]?.intValue,
              let cacheRead = dict["cacheReadTokens"]?.intValue,
              let cacheWrite = dict["cacheWriteTokens"]?.intValue,
              let cost = dict["totalCost"]?.doubleValue,
              let duration = dict["totalDurationMs"]?.doubleValue else { return nil }
        let contextTokens = dict["contextTokens"]?.intValue
        return SessionUsage(
            inputTokens: input, outputTokens: output,
            cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
            totalCost: cost, totalDurationMs: duration,
            contextTokens: contextTokens
        )
    }

    /// True for message types that should be rendered in the chat.
    var isRenderable: Bool {
        switch type {
        case "user_message", "agent_message", "interrupted_turn", "pending_input", "send_input",
             "permission", "tool_start", "tool_complete",
             "idle", "active", "error", "session_created", "session_ended",
             "session_deleted", "kill_session", "permission_resolved":
            return true
        default:
            return false
        }
    }

    /// True for transient messages that don't get logged.
    var isTransient: Bool {
        type == "agent_message_delta" || type == "session_mode_set"
    }
}

// MARK: - Pending Action Types

struct PendingPermission: Identifiable, Equatable, Sendable {
    let id: String
    let sessionId: String
    let description: String
    let toolName: String?
    let args: [String: AnyCodable]?
    let timestamp: Date

    /// Tool kind for Always Allow grouping.
    var toolKind: String? { toolName }
}

/// How a question bubble reads, given what follows it on the spine.
struct QuestionPresentation: Equatable, Sendable {
    enum State: Equatable, Sendable {
        /// At the conversation head with nothing after it: answerable.
        case open
        case answered
        /// Something other than its answer followed (the agent moved on).
        case unanswered
        /// Last in a window that is not at the head: unknown, drawn neutrally.
        case undetermined
    }
    var state: State
    /// The turn ended (user_abort / failed) while this question was asked and
    /// nothing streamed after it: the outcome is drawn inside the question
    /// bubble, as an aborted turn draws it under its draft.
    var outcome: TerminalOutcome? = nil

    /// Both chat lists cache a row's height and prepared content by its id,
    /// so a row whose drawing changes gets a new identity (as a pending input
    /// does when its echo lands). Only states that draw differently differ.
    var identitySuffix: String {
        if state == .open { return "#q-open" }
        if let outcome { return "#q-\(outcome.type)" }
        return ""
    }
}

/// `user_abort` | `failed`, with the failure message if any.
struct TerminalOutcome: Equatable, Sendable {
    let type: String
    let message: String?
}

struct PendingQuestion: Identifiable, Equatable, Sendable {
    let id: String
    let sessionId: String
    let question: String
    let choices: [String]?
    let timestamp: Date
}

// MARK: - Relay Envelopes

/// Encrypted blob with per-recipient keys (deviceId → encrypted AES key).
struct BlobPayload: Codable, Sendable {
    let blob: String
    let keys: [String: String]
}

// MARK: - Producer Message Decoder

/// Decodes incoming producer messages from JSON data into ChatMessage structs.
enum ProducerMessageDecoder {

    static func decode(_ data: Data) -> ChatMessage? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }

        let seq = json["seq"] as? Int ?? 0
        let sessionId = json["sessionId"] as? String
        let deviceId = json["deviceId"] as? String
        let timestamp = json["timestamp"] as? String

        let payload: [String: AnyCodable]
        if let payloadDict = json["payload"] as? [String: Any] {
            payload = payloadDict.mapValues { AnyCodable($0) }
        } else {
            var p = json
            for key in ["type", "seq", "sessionId", "deviceId", "timestamp"] {
                p.removeValue(forKey: key)
            }
            payload = p.mapValues { AnyCodable($0) }
        }

        return ChatMessage(
            type: type,
            seq: seq,
            sessionId: sessionId,
            deviceId: deviceId,
            timestamp: timestamp,
            payload: payload
        )
    }

    /// Decode a session_replay_batch's inner messages array.
    static func decodeBatchMessages(_ messagesArray: [[String: Any]]) -> [ChatMessage] {
        messagesArray.compactMap { dict -> ChatMessage? in
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return decode(data)
        }
    }
}

