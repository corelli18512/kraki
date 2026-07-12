/// Messages — Strongly-typed protocol messages mirroring @kraki/protocol.
///
/// Defines ProducerMessage (tentacle → app), ConsumerMessage (app → tentacle),
/// ControlMessage (device ↔ relay), and relay envelope types. All messages are
/// Codable enums with type-field discriminators and nested payload structures.
///
/// Foundation types (AnyCodable, SessionState, SessionMode, SessionUsage,
/// SessionDigest, DeviceSummary, DeviceRole, DeviceKind, ReasoningEffort,
/// ModelDetail, ImageAttachment) are defined in ProtocolTypes.swift.

import Foundation

// MARK: - Supporting Types

/// Push notification provider type.
enum PushProviderType: String, Codable, Sendable {
    case apns
    case fcm
    case webPush = "web_push"
}

/// Device descriptor sent during authentication.
struct DeviceInfo: Codable, Sendable {
    let name: String
    let role: DeviceRole
    var kind: DeviceKind?
    var publicKey: String?
    var encryptionKey: String?
    var deviceId: String?
    var capabilities: DeviceCapabilities?
}

/// Capabilities advertised by a device.
struct DeviceCapabilities: Codable, Equatable, Sendable {
    var models: [String]?
    var modelDetails: [ModelDetail]?
}

/// Authenticated user info from auth_ok.
struct AuthUser: Codable, Sendable, Equatable {
    let id: String
    let login: String
    var provider: String?
    var email: String?
    var preferences: [String: AnyCodable]?
}

/// Authentication method sent in the auth control message.
enum AuthMethod: Codable, Sendable {
    case pairing(token: String)
    case challenge(deviceId: String)
    case githubOAuth(code: String)
    case open(sharedKey: String?)

    private enum CodingKeys: String, CodingKey {
        case method, token, deviceId, code, sharedKey
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let method = try container.decode(String.self, forKey: .method)
        switch method {
        case "pairing":
            let token = try container.decode(String.self, forKey: .token)
            self = .pairing(token: token)
        case "challenge":
            let deviceId = try container.decode(String.self, forKey: .deviceId)
            self = .challenge(deviceId: deviceId)
        case "github_oauth":
            let code = try container.decode(String.self, forKey: .code)
            self = .githubOAuth(code: code)
        case "open":
            let key = try container.decodeIfPresent(String.self, forKey: .sharedKey)
            self = .open(sharedKey: key)
        default:
            self = .open(sharedKey: nil)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pairing(let token):
            try container.encode("pairing", forKey: .method)
            try container.encode(token, forKey: .token)
        case .challenge(let deviceId):
            try container.encode("challenge", forKey: .method)
            try container.encode(deviceId, forKey: .deviceId)
        case .githubOAuth(let code):
            try container.encode("github_oauth", forKey: .method)
            try container.encode(code, forKey: .code)
        case .open(let key):
            try container.encode("open", forKey: .method)
            if let key { try container.encode(key, forKey: .sharedKey) }
        }
    }
}

/// Tool arguments container.
struct ToolArgs: Codable, Sendable {
    let toolName: String
    let args: [String: AnyCodable]
}

/// Session summary used in session lifecycle events.
struct SessionSummary: Codable, Identifiable, Sendable {
    let id: String
    let deviceId: String
    let deviceName: String
    var agent: String?
    var model: String?
    var title: String?
    var autoTitle: String?
    var state: SessionState
    var messageCount: Int
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
        return "\(sessionId ?? "none"):\(seq)"
    }
    let type: String
    let seq: Int
    let sessionId: String?
    let deviceId: String?
    let timestamp: String?
    var payload: [String: AnyCodable]

    // MARK: Convenience Accessors

    var content: String? { payload["content"]?.stringValue }
    var interruptedDraft: String? { payload["draft"]?.stringValue }
    var toolName: String? { payload["toolName"]?.stringValue }
    var toolCallId: String? { payload["toolCallId"]?.stringValue }
    var result: String? { payload["result"]?.stringValue }
    var permissionId: String? { payload["id"]?.stringValue ?? payload["permissionId"]?.stringValue }
    var questionId: String? { payload["id"]?.stringValue ?? payload["questionId"]?.stringValue }
    var question: String? { payload["question"]?.stringValue }
    var description_: String? { payload["description"]?.stringValue }
    var toolDescription: String? { description_ }
    var requestId: String? { payload["requestId"]?.stringValue }
    var errorMessage: String? { payload["message"]?.stringValue }
    var reason: String? { payload["reason"]?.stringValue }
    var resolution: String? { payload["resolution"]?.stringValue }
    var answer: String? { payload["answer"]?.stringValue }
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
    var contentRefAttachments: [ContentRef] {
        guard let arr = payload["attachments"]?.arrayValue else { return [] }
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
             "permission", "question", "tool_start", "tool_complete",
             "idle", "active", "error", "session_created", "session_ended",
             "session_deleted", "kill_session", "answer",
             "permission_resolved", "question_resolved":
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

struct PendingQuestion: Identifiable, Equatable, Sendable {
    let id: String
    let sessionId: String
    let question: String
    let choices: [String]?
    let timestamp: Date
}

// MARK: - Envelope CodingKeys

/// Shared coding keys for the envelope + payload wire format used by
/// both producer and consumer messages.
enum EnvelopeCodingKeys: String, CodingKey {
    case type, deviceId, seq, timestamp, sessionId, payload
}

// MARK: - Producer Message Payloads

struct SessionCreatedPayload: Codable, Sendable {
    let agent: String
    var model: String?
    var requestId: String?
    var lastSeq: Int?
}

struct SessionEndedPayload: Codable, Sendable {
    let reason: String
}

struct UserMessagePayload: Codable, Sendable {
    let content: String
}

struct AgentMessagePayload: Codable, Sendable {
    let content: String
    var attachments: [ImageAttachment]?
}

struct AgentMessageDeltaPayload: Codable, Sendable {
    let content: String
}

struct PermissionPayload: Codable, Sendable {
    let id: String
    let description: String
    let toolName: String
    let args: [String: AnyCodable]
}

struct QuestionPayload: Codable, Sendable {
    let id: String
    let question: String
    var choices: [String]?
}

struct ToolStartPayload: Codable, Sendable {
    let toolName: String
    let args: [String: AnyCodable]
    var toolCallId: String?
}

struct ToolCompletePayload: Codable, Sendable {
    let toolName: String
    let args: [String: AnyCodable]
    let result: String
    var toolCallId: String?
    var attachments: [ImageAttachment]?
}

struct IdlePayload: Codable, Sendable {
    var usage: SessionUsage?
}

struct ErrorPayload: Codable, Sendable {
    let message: String
}

struct SessionModeSetPayload: Codable, Sendable {
    let mode: SessionMode
}

struct SessionModelSetPayload: Codable, Sendable {
    let model: String
    var reasoningEffort: ReasoningEffort?
}

struct SessionTitleUpdatedPayload: Codable, Sendable {
    var title: String?
    var autoTitle: String?
}

struct SessionPinnedPayload: Codable, Sendable {
    let pinned: Bool
}

struct SessionReadPayload: Codable, Sendable {
    let seq: Int
}

struct DeviceGreetingPayload: Codable, Sendable {
    let name: String
    var kind: DeviceKind?
    var models: [String]?
    var modelDetails: [ModelDetail]?
    var version: String?
}

/// A single message inside a replay batch.
struct ReplayMessage: Codable, Sendable {
    let type: String
    let deviceId: String
    let seq: Int
    let timestamp: String
    var sessionId: String?
    var payload: [String: AnyCodable]?
}

struct SessionReplayBatchPayload: Codable, Sendable {
    let sessionId: String
    let messages: [ReplayMessage]
    let lastSeq: Int
    let totalLastSeq: Int
}

struct SessionListPayload: Codable, Sendable {
    let sessions: [SessionDigest]
}

struct PermissionResolvedPayload: Codable, Sendable {
    let permissionId: String
    let resolution: String
    var reason: String?
}

struct QuestionResolvedPayload: Codable, Sendable {
    let questionId: String
    let answer: String
    var cancelled: Bool?
}

// MARK: - Producer Message

/// Inbound messages from tentacle → app (decrypted inner payload).
/// Decoded by reading the "type" discriminator, then decoding the "payload" object.
enum ProducerMessage: Sendable {
    // Session lifecycle
    case sessionCreated(SessionCreatedPayload)
    case sessionEnded(SessionEndedPayload)
    case sessionDeleted

    // Chat
    case userMessage(UserMessagePayload)
    case agentMessage(AgentMessagePayload)
    case agentMessageDelta(AgentMessageDeltaPayload)

    // Interaction
    case permission(PermissionPayload)
    case question(QuestionPayload)

    // Tools
    case toolStart(ToolStartPayload)
    case toolComplete(ToolCompletePayload)

    // State
    case idle(IdlePayload)
    case active
    case error(ErrorPayload)

    // Session metadata
    case sessionModeSet(SessionModeSetPayload)
    case sessionModelSet(SessionModelSetPayload)
    case sessionTitleUpdated(SessionTitleUpdatedPayload)
    case sessionPinned(SessionPinnedPayload)
    case sessionRead(SessionReadPayload)

    // Multi-session / device
    case deviceGreeting(DeviceGreetingPayload)
    case sessionReplayBatch(SessionReplayBatchPayload)
    case sessionList(SessionListPayload)

    // Resolutions
    case permissionResolved(PermissionResolvedPayload)
    case questionResolved(QuestionResolvedPayload)

    /// The wire-format type string for this message.
    var typeString: String {
        switch self {
        case .sessionCreated:       return "session_created"
        case .sessionEnded:         return "session_ended"
        case .sessionDeleted:       return "session_deleted"
        case .userMessage:          return "user_message"
        case .agentMessage:         return "agent_message"
        case .agentMessageDelta:    return "agent_message_delta"
        case .permission:           return "permission"
        case .question:             return "question"
        case .toolStart:            return "tool_start"
        case .toolComplete:         return "tool_complete"
        case .idle:                 return "idle"
        case .active:               return "active"
        case .error:                return "error"
        case .sessionModeSet:       return "session_mode_set"
        case .sessionModelSet:      return "session_model_set"
        case .sessionTitleUpdated:  return "session_title_updated"
        case .sessionPinned:        return "session_pinned"
        case .sessionRead:          return "session_read"
        case .deviceGreeting:       return "device_greeting"
        case .sessionReplayBatch:   return "session_replay_batch"
        case .sessionList:          return "session_list"
        case .permissionResolved:   return "permission_resolved"
        case .questionResolved:     return "question_resolved"
        }
    }
}

extension ProducerMessage: Codable {

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EnvelopeCodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        self = try Self.decodePayload(type: type, from: container)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: EnvelopeCodingKeys.self)
        try container.encode(typeString, forKey: .type)
        try encodePayload(to: &container)
    }

    /// Decode from a keyed container that has "type" and "payload" keys.
    static func decodePayload(
        type: String,
        from container: KeyedDecodingContainer<EnvelopeCodingKeys>
    ) throws -> ProducerMessage {
        switch type {
        case "session_created":
            return .sessionCreated(try container.decode(SessionCreatedPayload.self, forKey: .payload))
        case "session_ended":
            return .sessionEnded(try container.decode(SessionEndedPayload.self, forKey: .payload))
        case "session_deleted":
            return .sessionDeleted
        case "user_message":
            return .userMessage(try container.decode(UserMessagePayload.self, forKey: .payload))
        case "agent_message":
            return .agentMessage(try container.decode(AgentMessagePayload.self, forKey: .payload))
        case "agent_message_delta":
            return .agentMessageDelta(try container.decode(AgentMessageDeltaPayload.self, forKey: .payload))
        case "permission":
            return .permission(try container.decode(PermissionPayload.self, forKey: .payload))
        case "question":
            return .question(try container.decode(QuestionPayload.self, forKey: .payload))
        case "tool_start":
            return .toolStart(try container.decode(ToolStartPayload.self, forKey: .payload))
        case "tool_complete":
            return .toolComplete(try container.decode(ToolCompletePayload.self, forKey: .payload))
        case "idle":
            return .idle(try container.decode(IdlePayload.self, forKey: .payload))
        case "active":
            return .active
        case "error":
            return .error(try container.decode(ErrorPayload.self, forKey: .payload))
        case "session_mode_set":
            return .sessionModeSet(try container.decode(SessionModeSetPayload.self, forKey: .payload))
        case "session_model_set":
            return .sessionModelSet(try container.decode(SessionModelSetPayload.self, forKey: .payload))
        case "session_title_updated":
            return .sessionTitleUpdated(try container.decode(SessionTitleUpdatedPayload.self, forKey: .payload))
        case "session_pinned":
            return .sessionPinned(try container.decode(SessionPinnedPayload.self, forKey: .payload))
        case "session_read":
            return .sessionRead(try container.decode(SessionReadPayload.self, forKey: .payload))
        case "device_greeting":
            return .deviceGreeting(try container.decode(DeviceGreetingPayload.self, forKey: .payload))
        case "session_replay_batch":
            return .sessionReplayBatch(try container.decode(SessionReplayBatchPayload.self, forKey: .payload))
        case "session_list":
            return .sessionList(try container.decode(SessionListPayload.self, forKey: .payload))
        case "permission_resolved":
            return .permissionResolved(try container.decode(PermissionResolvedPayload.self, forKey: .payload))
        case "question_resolved":
            return .questionResolved(try container.decode(QuestionResolvedPayload.self, forKey: .payload))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "Unknown producer message type: \(type)"
            )
        }
    }

    /// Encode payload into a keyed container.
    func encodePayload(to container: inout KeyedEncodingContainer<EnvelopeCodingKeys>) throws {
        switch self {
        case .sessionCreated(let p):       try container.encode(p, forKey: .payload)
        case .sessionEnded(let p):         try container.encode(p, forKey: .payload)
        case .sessionDeleted:              try container.encode([String: String](), forKey: .payload)
        case .userMessage(let p):          try container.encode(p, forKey: .payload)
        case .agentMessage(let p):         try container.encode(p, forKey: .payload)
        case .agentMessageDelta(let p):    try container.encode(p, forKey: .payload)
        case .permission(let p):           try container.encode(p, forKey: .payload)
        case .question(let p):             try container.encode(p, forKey: .payload)
        case .toolStart(let p):            try container.encode(p, forKey: .payload)
        case .toolComplete(let p):         try container.encode(p, forKey: .payload)
        case .idle(let p):                 try container.encode(p, forKey: .payload)
        case .active:                      try container.encode([String: String](), forKey: .payload)
        case .error(let p):                try container.encode(p, forKey: .payload)
        case .sessionModeSet(let p):       try container.encode(p, forKey: .payload)
        case .sessionModelSet(let p):      try container.encode(p, forKey: .payload)
        case .sessionTitleUpdated(let p):  try container.encode(p, forKey: .payload)
        case .sessionPinned(let p):        try container.encode(p, forKey: .payload)
        case .sessionRead(let p):          try container.encode(p, forKey: .payload)
        case .deviceGreeting(let p):       try container.encode(p, forKey: .payload)
        case .sessionReplayBatch(let p):   try container.encode(p, forKey: .payload)
        case .sessionList(let p):          try container.encode(p, forKey: .payload)
        case .permissionResolved(let p):   try container.encode(p, forKey: .payload)
        case .questionResolved(let p):     try container.encode(p, forKey: .payload)
        }
    }
}

// MARK: - Producer Envelope

/// A fully decoded inbound message: envelope fields + typed producer message.
struct ProducerEnvelope: Codable, Sendable {
    let deviceId: String
    let seq: Int
    let timestamp: String
    var sessionId: String?
    let message: ProducerMessage

    init(
        deviceId: String,
        seq: Int,
        timestamp: String,
        sessionId: String? = nil,
        message: ProducerMessage
    ) {
        self.deviceId = deviceId
        self.seq = seq
        self.timestamp = timestamp
        self.sessionId = sessionId
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EnvelopeCodingKeys.self)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        seq = try container.decode(Int.self, forKey: .seq)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        let type = try container.decode(String.self, forKey: .type)
        message = try ProducerMessage.decodePayload(type: type, from: container)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: EnvelopeCodingKeys.self)
        try container.encode(message.typeString, forKey: .type)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(seq, forKey: .seq)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(sessionId, forKey: .sessionId)
        try message.encodePayload(to: &container)
    }
}

// MARK: - Consumer Message Payloads

struct SendInputPayload: Codable, Sendable {
    let text: String
    var attachments: [ImageAttachment]?
}

struct ApprovePayload: Codable, Sendable {
    let permissionId: String
}

struct DenyPayload: Codable, Sendable {
    let permissionId: String
}

struct AlwaysAllowPayload: Codable, Sendable {
    let permissionId: String
    var toolKind: String?
}

struct AnswerPayload: Codable, Sendable {
    let questionId: String
    let answer: String
}

struct CreateSessionPayload: Codable, Sendable {
    let requestId: String
    let targetDeviceId: String
    let model: String
    var reasoningEffort: ReasoningEffort?
    var prompt: String?
    var cwd: String?
}

struct ForkSessionPayload: Codable, Sendable {
    let requestId: String
    let sourceSessionId: String
}

struct SetSessionModePayload: Codable, Sendable {
    let mode: SessionMode
}

struct SetSessionModelPayload: Codable, Sendable {
    let model: String
    var reasoningEffort: ReasoningEffort?
}

struct MarkReadPayload: Codable, Sendable {
    let seq: Int
}

struct RequestSessionReplayPayload: Codable, Sendable {
    let sessionId: String
    let afterSeq: Int
    var limit: Int?
}

struct RenameSessionPayload: Codable, Sendable {
    let title: String
}

struct PinSessionPayload: Codable, Sendable {
    let pinned: Bool
}

// MARK: - Consumer Message

/// Outbound messages from app → tentacle (before encryption).
/// Encoded with a "type" discriminator and a "payload" object.
enum ConsumerMessage: Sendable {
    // Input
    case sendInput(SendInputPayload)

    // Permissions
    case approve(ApprovePayload)
    case deny(DenyPayload)
    case alwaysAllow(AlwaysAllowPayload)

    // Questions
    case answer(AnswerPayload)

    // Session control
    case killSession
    case abortSession

    // Session lifecycle
    case createSession(CreateSessionPayload)
    case forkSession(ForkSessionPayload)
    case deleteSession

    // Session settings
    case setSessionMode(SetSessionModePayload)
    case setSessionModel(SetSessionModelPayload)

    // Read state
    case markRead(MarkReadPayload)
    case markUnread

    // Replay
    case requestSessionReplay(RequestSessionReplayPayload)

    // Metadata
    case renameSession(RenameSessionPayload)
    case pinSession(PinSessionPayload)

    /// The wire-format type string for this message.
    var typeString: String {
        switch self {
        case .sendInput:             return "send_input"
        case .approve:               return "approve"
        case .deny:                  return "deny"
        case .alwaysAllow:           return "always_allow"
        case .answer:                return "answer"
        case .killSession:           return "kill_session"
        case .abortSession:          return "abort_session"
        case .createSession:         return "create_session"
        case .forkSession:           return "fork_session"
        case .deleteSession:         return "delete_session"
        case .setSessionMode:        return "set_session_mode"
        case .setSessionModel:       return "set_session_model"
        case .markRead:              return "mark_read"
        case .markUnread:            return "mark_unread"
        case .requestSessionReplay:  return "request_session_replay"
        case .renameSession:         return "rename_session"
        case .pinSession:            return "pin_session"
        }
    }
}

extension ConsumerMessage: Codable {

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EnvelopeCodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        self = try Self.decodePayload(type: type, from: container)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: EnvelopeCodingKeys.self)
        try container.encode(typeString, forKey: .type)
        try encodePayload(to: &container)
    }

    static func decodePayload(
        type: String,
        from container: KeyedDecodingContainer<EnvelopeCodingKeys>
    ) throws -> ConsumerMessage {
        switch type {
        case "send_input":
            return .sendInput(try container.decode(SendInputPayload.self, forKey: .payload))
        case "approve":
            return .approve(try container.decode(ApprovePayload.self, forKey: .payload))
        case "deny":
            return .deny(try container.decode(DenyPayload.self, forKey: .payload))
        case "always_allow":
            return .alwaysAllow(try container.decode(AlwaysAllowPayload.self, forKey: .payload))
        case "answer":
            return .answer(try container.decode(AnswerPayload.self, forKey: .payload))
        case "kill_session":
            return .killSession
        case "abort_session":
            return .abortSession
        case "create_session":
            return .createSession(try container.decode(CreateSessionPayload.self, forKey: .payload))
        case "fork_session":
            return .forkSession(try container.decode(ForkSessionPayload.self, forKey: .payload))
        case "delete_session":
            return .deleteSession
        case "set_session_mode":
            return .setSessionMode(try container.decode(SetSessionModePayload.self, forKey: .payload))
        case "set_session_model":
            return .setSessionModel(try container.decode(SetSessionModelPayload.self, forKey: .payload))
        case "mark_read":
            return .markRead(try container.decode(MarkReadPayload.self, forKey: .payload))
        case "mark_unread":
            return .markUnread
        case "request_session_replay":
            return .requestSessionReplay(try container.decode(RequestSessionReplayPayload.self, forKey: .payload))
        case "rename_session":
            return .renameSession(try container.decode(RenameSessionPayload.self, forKey: .payload))
        case "pin_session":
            return .pinSession(try container.decode(PinSessionPayload.self, forKey: .payload))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "Unknown consumer message type: \(type)"
            )
        }
    }

    func encodePayload(to container: inout KeyedEncodingContainer<EnvelopeCodingKeys>) throws {
        switch self {
        case .sendInput(let p):            try container.encode(p, forKey: .payload)
        case .approve(let p):              try container.encode(p, forKey: .payload)
        case .deny(let p):                 try container.encode(p, forKey: .payload)
        case .alwaysAllow(let p):          try container.encode(p, forKey: .payload)
        case .answer(let p):               try container.encode(p, forKey: .payload)
        case .killSession:                 try container.encode([String: String](), forKey: .payload)
        case .abortSession:                try container.encode([String: String](), forKey: .payload)
        case .createSession(let p):        try container.encode(p, forKey: .payload)
        case .forkSession(let p):          try container.encode(p, forKey: .payload)
        case .deleteSession:               try container.encode([String: String](), forKey: .payload)
        case .setSessionMode(let p):       try container.encode(p, forKey: .payload)
        case .setSessionModel(let p):      try container.encode(p, forKey: .payload)
        case .markRead(let p):             try container.encode(p, forKey: .payload)
        case .markUnread:                  try container.encode([String: String](), forKey: .payload)
        case .requestSessionReplay(let p): try container.encode(p, forKey: .payload)
        case .renameSession(let p):        try container.encode(p, forKey: .payload)
        case .pinSession(let p):           try container.encode(p, forKey: .payload)
        }
    }
}

// MARK: - Consumer Envelope

/// A fully encoded outbound message: envelope fields + typed consumer message.
struct ConsumerEnvelope: Codable, Sendable {
    let deviceId: String
    let seq: Int
    let timestamp: String
    var sessionId: String?
    let message: ConsumerMessage

    init(
        deviceId: String,
        seq: Int,
        timestamp: String,
        sessionId: String? = nil,
        message: ConsumerMessage
    ) {
        self.deviceId = deviceId
        self.seq = seq
        self.timestamp = timestamp
        self.sessionId = sessionId
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EnvelopeCodingKeys.self)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        seq = try container.decode(Int.self, forKey: .seq)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        let type = try container.decode(String.self, forKey: .type)
        message = try ConsumerMessage.decodePayload(type: type, from: container)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: EnvelopeCodingKeys.self)
        try container.encode(message.typeString, forKey: .type)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(seq, forKey: .seq)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(sessionId, forKey: .sessionId)
        try message.encodePayload(to: &container)
    }
}

// MARK: - Control Message Payloads

struct AuthPayload: Codable, Sendable {
    let auth: AuthMethod
    let device: DeviceInfo
}

struct AuthOkPayload: Codable, Sendable {
    let deviceId: String
    let authMethod: String
    var user: AuthUser?
    var devices: [DeviceSummary]?
    var githubClientId: String?
    var vapidPublicKey: String?
    var relayVersion: String?
    var pendingMessages: Int?
}

struct AuthErrorPayload: Codable, Sendable {
    let code: String
    let message: String
}

struct AuthChallengePayload: Codable, Sendable {
    let nonce: String
}

struct AuthResponsePayload: Codable, Sendable {
    let deviceId: String
    let signature: String
}

struct ServerErrorPayload: Codable, Sendable {
    let message: String
    var ref: String?
}

struct DeviceJoinedPayload: Codable, Sendable {
    let device: DeviceSummary
}

struct DeviceLeftPayload: Codable, Sendable {
    let deviceId: String
}

struct RemoveDevicePayload: Codable, Sendable {
    let deviceId: String
}

struct DeviceRemovedPayload: Codable, Sendable {
    let deviceId: String
}

struct RegisterPushTokenPayload: Codable, Sendable {
    let provider: PushProviderType
    let token: String
    var environment: String?
    var bundleId: String?
}

struct PushTokenRegisteredPayload: Codable, Sendable {
    let provider: PushProviderType
}

struct UnregisterPushTokenPayload: Codable, Sendable {
    let provider: PushProviderType
}

// MARK: - Control Message

/// Unencrypted control-plane messages between device and relay.
/// These are flat JSON objects (no nested "payload" wrapper).
enum ControlMessage: Sendable {
    case auth(AuthPayload)
    case authOk(AuthOkPayload)
    case authError(AuthErrorPayload)
    case authChallenge(AuthChallengePayload)
    case authResponse(AuthResponsePayload)
    case serverError(ServerErrorPayload)
    case deviceJoined(DeviceJoinedPayload)
    case deviceLeft(DeviceLeftPayload)
    case removeDevice(RemoveDevicePayload)
    case deviceRemoved(DeviceRemovedPayload)
    case registerPushToken(RegisterPushTokenPayload)
    case pushTokenRegistered(PushTokenRegisteredPayload)
    case unregisterPushToken(UnregisterPushTokenPayload)
    case ping
    case pong

    /// The wire-format type string for this message.
    var typeString: String {
        switch self {
        case .auth:                 return "auth"
        case .authOk:               return "auth_ok"
        case .authError:            return "auth_error"
        case .authChallenge:        return "auth_challenge"
        case .authResponse:         return "auth_response"
        case .serverError:          return "server_error"
        case .deviceJoined:         return "device_joined"
        case .deviceLeft:           return "device_left"
        case .removeDevice:         return "remove_device"
        case .deviceRemoved:        return "device_removed"
        case .registerPushToken:    return "register_push_token"
        case .pushTokenRegistered:  return "push_token_registered"
        case .unregisterPushToken:  return "unregister_push_token"
        case .ping:                 return "ping"
        case .pong:                 return "pong"
        }
    }
}

extension ControlMessage: Codable {

    private enum TypeKey: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let typeContainer = try decoder.container(keyedBy: TypeKey.self)
        let type = try typeContainer.decode(String.self, forKey: .type)

        switch type {
        case "auth":
            self = .auth(try AuthPayload(from: decoder))
        case "auth_ok":
            self = .authOk(try AuthOkPayload(from: decoder))
        case "auth_error":
            self = .authError(try AuthErrorPayload(from: decoder))
        case "auth_challenge":
            self = .authChallenge(try AuthChallengePayload(from: decoder))
        case "auth_response":
            self = .authResponse(try AuthResponsePayload(from: decoder))
        case "server_error":
            self = .serverError(try ServerErrorPayload(from: decoder))
        case "device_joined":
            self = .deviceJoined(try DeviceJoinedPayload(from: decoder))
        case "device_left":
            self = .deviceLeft(try DeviceLeftPayload(from: decoder))
        case "remove_device":
            self = .removeDevice(try RemoveDevicePayload(from: decoder))
        case "device_removed":
            self = .deviceRemoved(try DeviceRemovedPayload(from: decoder))
        case "register_push_token":
            self = .registerPushToken(try RegisterPushTokenPayload(from: decoder))
        case "push_token_registered":
            self = .pushTokenRegistered(try PushTokenRegisteredPayload(from: decoder))
        case "unregister_push_token":
            self = .unregisterPushToken(try UnregisterPushTokenPayload(from: decoder))
        case "ping":
            self = .ping
        case "pong":
            self = .pong
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: typeContainer,
                debugDescription: "Unknown control message type: \(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var typeContainer = encoder.container(keyedBy: TypeKey.self)
        try typeContainer.encode(typeString, forKey: .type)

        switch self {
        case .auth(let p):                try p.encode(to: encoder)
        case .authOk(let p):              try p.encode(to: encoder)
        case .authError(let p):           try p.encode(to: encoder)
        case .authChallenge(let p):       try p.encode(to: encoder)
        case .authResponse(let p):        try p.encode(to: encoder)
        case .serverError(let p):         try p.encode(to: encoder)
        case .deviceJoined(let p):        try p.encode(to: encoder)
        case .deviceLeft(let p):          try p.encode(to: encoder)
        case .removeDevice(let p):        try p.encode(to: encoder)
        case .deviceRemoved(let p):       try p.encode(to: encoder)
        case .registerPushToken(let p):   try p.encode(to: encoder)
        case .pushTokenRegistered(let p): try p.encode(to: encoder)
        case .unregisterPushToken(let p): try p.encode(to: encoder)
        case .ping, .pong:                break
        }
    }
}

// MARK: - Relay Envelopes

/// Encrypted blob with per-recipient keys (deviceId → encrypted AES key).
struct BlobPayload: Codable, Sendable {
    let blob: String
    let keys: [String: String]
}

/// Push notification preview attached to broadcast envelopes.
struct PushPreview: Codable, Sendable {
    var title: String?
    var body: String?
    var sessionId: String?
}

/// Relay envelope for point-to-point encrypted messages.
struct UnicastEnvelope: Codable, Sendable {
    let type: String // "unicast"
    let to: String
    let blob: String
    let keys: [String: String]
    var ref: String?

    init(to: String, blob: String, keys: [String: String], ref: String? = nil) {
        self.type = "unicast"
        self.to = to
        self.blob = blob
        self.keys = keys
        self.ref = ref
    }
}

/// Relay envelope for encrypted broadcast messages.
struct BroadcastEnvelope: Codable, Sendable {
    let type: String // "broadcast"
    let blob: String
    let keys: [String: String]
    var pushPreview: PushPreview?

    init(blob: String, keys: [String: String], pushPreview: PushPreview? = nil) {
        self.type = "broadcast"
        self.blob = blob
        self.keys = keys
        self.pushPreview = pushPreview
    }
}

/// Discriminated relay envelope (unicast or broadcast).
enum RelayEnvelope: Codable, Sendable {
    case unicast(UnicastEnvelope)
    case broadcast(BroadcastEnvelope)

    private enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "unicast":
            self = .unicast(try UnicastEnvelope(from: decoder))
        case "broadcast":
            self = .broadcast(try BroadcastEnvelope(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "Unknown relay envelope type: \(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .unicast(let env):   try env.encode(to: encoder)
        case .broadcast(let env): try env.encode(to: encoder)
        }
    }
}

// MARK: - Consumer Message Builder

/// Builds outgoing consumer messages as JSON dictionaries.
/// Used by CommandSender for the untyped send path.
enum ConsumerMessageBuilder {

    static func sendInput(sessionId: String, deviceId: String, text: String, attachments: [ImageAttachment]? = nil) -> [String: Any] {
        var payload: [String: Any] = ["text": text]
        if let attachments, !attachments.isEmpty {
            payload["attachments"] = attachments.map { ["type": $0.type, "mimeType": $0.mimeType, "data": $0.data] }
        }
        return envelope(type: "send_input", sessionId: sessionId, deviceId: deviceId, payload: payload)
    }

    static func approve(sessionId: String, deviceId: String, permissionId: String) -> [String: Any] {
        envelope(type: "approve", sessionId: sessionId, deviceId: deviceId, payload: ["permissionId": permissionId])
    }

    static func deny(sessionId: String, deviceId: String, permissionId: String) -> [String: Any] {
        envelope(type: "deny", sessionId: sessionId, deviceId: deviceId, payload: ["permissionId": permissionId])
    }

    static func alwaysAllow(sessionId: String, deviceId: String, permissionId: String, toolKind: String? = nil) -> [String: Any] {
        var payload: [String: Any] = ["permissionId": permissionId]
        if let toolKind { payload["toolKind"] = toolKind }
        return envelope(type: "always_allow", sessionId: sessionId, deviceId: deviceId, payload: payload)
    }

    static func answer(sessionId: String, deviceId: String, questionId: String, answer: String) -> [String: Any] {
        envelope(type: "answer", sessionId: sessionId, deviceId: deviceId, payload: ["questionId": questionId, "answer": answer])
    }

    static func killSession(sessionId: String, deviceId: String) -> [String: Any] {
        envelope(type: "kill_session", sessionId: sessionId, deviceId: deviceId, payload: [:])
    }

    static func abortSession(sessionId: String, deviceId: String) -> [String: Any] {
        envelope(type: "abort_session", sessionId: sessionId, deviceId: deviceId, payload: [:])
    }

    static func createSession(deviceId: String, requestId: String, targetDeviceId: String, model: String, reasoningEffort: ReasoningEffort? = nil, prompt: String? = nil, cwd: String? = nil) -> [String: Any] {
        var payload: [String: Any] = ["requestId": requestId, "targetDeviceId": targetDeviceId, "model": model]
        if let re = reasoningEffort { payload["reasoningEffort"] = re.rawValue }
        if let p = prompt { payload["prompt"] = p }
        if let c = cwd { payload["cwd"] = c }
        return envelope(type: "create_session", sessionId: nil, deviceId: deviceId, payload: payload)
    }

    static func forkSession(sessionId: String, deviceId: String, requestId: String, sourceSessionId: String) -> [String: Any] {
        envelope(type: "fork_session", sessionId: sessionId, deviceId: deviceId, payload: ["requestId": requestId, "sourceSessionId": sourceSessionId])
    }

    static func setSessionMode(sessionId: String, deviceId: String, mode: SessionMode) -> [String: Any] {
        envelope(type: "set_session_mode", sessionId: sessionId, deviceId: deviceId, payload: ["mode": mode.rawValue])
    }

    static func setSessionModel(sessionId: String, deviceId: String, model: String, reasoningEffort: ReasoningEffort? = nil) -> [String: Any] {
        var payload: [String: Any] = ["model": model]
        if let re = reasoningEffort { payload["reasoningEffort"] = re.rawValue }
        return envelope(type: "set_session_model", sessionId: sessionId, deviceId: deviceId, payload: payload)
    }

    static func deleteSession(sessionId: String, deviceId: String) -> [String: Any] {
        envelope(type: "delete_session", sessionId: sessionId, deviceId: deviceId, payload: [:])
    }

    static func markRead(sessionId: String, deviceId: String, seq: Int) -> [String: Any] {
        envelope(type: "mark_read", sessionId: sessionId, deviceId: deviceId, payload: ["seq": seq])
    }

    static func markUnread(sessionId: String, deviceId: String) -> [String: Any] {
        envelope(type: "mark_unread", sessionId: sessionId, deviceId: deviceId, payload: [:])
    }

    static func requestReplay(sessionId: String, deviceId: String, afterSeq: Int, limit: Int? = nil) -> [String: Any] {
        var payload: [String: Any] = ["sessionId": sessionId, "afterSeq": afterSeq]
        if let limit { payload["limit"] = limit }
        return envelope(type: "request_session_replay", sessionId: sessionId, deviceId: deviceId, payload: payload)
    }

    static func renameSession(sessionId: String, deviceId: String, title: String) -> [String: Any] {
        envelope(type: "rename_session", sessionId: sessionId, deviceId: deviceId, payload: ["title": title])
    }

    static func pinSession(sessionId: String, deviceId: String, pinned: Bool) -> [String: Any] {
        envelope(type: "pin_session", sessionId: sessionId, deviceId: deviceId, payload: ["pinned": pinned])
    }

    // MARK: Envelope Helper

    private static func envelope(type: String, sessionId: String?, deviceId: String, payload: [String: Any]) -> [String: Any] {
        var msg: [String: Any] = [
            "type": type,
            "deviceId": deviceId,
            "seq": 0,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "payload": payload,
        ]
        if let sessionId { msg["sessionId"] = sessionId }
        return msg
    }
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

// MARK: - Envelope Type Detection

/// Classifies raw incoming WebSocket frames by type.
enum IncomingMessageType {
    case control(String)
    case unicast
    case broadcast
    case unknown

    static func detect(from json: [String: Any]) -> IncomingMessageType {
        guard let type = json["type"] as? String else { return .unknown }
        switch type {
        case "unicast":    return .unicast
        case "broadcast":  return .broadcast
        case "auth_ok", "auth_error", "auth_challenge", "auth_response",
             "server_error", "device_joined", "device_left", "device_removed",
             "pong", "push_token_registered", "pairing_token_created",
             "auth_info_response", "preferences_updated":
            return .control(type)
        default:
            return .unknown
        }
    }
}
