/// ProtocolTypes — Swift equivalents of @kraki/protocol types.
///
/// Mirrors sessions.ts, devices.ts, tools.ts, and messages.ts from the
/// TypeScript protocol package. These are the shared vocabulary used by
/// all stores and the networking layer.

import Foundation

// MARK: - AnyCodable

/// Type-erased Codable wrapper for heterogeneous JSON payloads.
struct AnyCodable: Codable, Equatable, @unchecked Sendable, CustomStringConvertible {
    let value: Any?

    init(_ value: Any?) { self.value = value }
    init(_ value: String) { self.value = value }
    init(_ value: Int) { self.value = value }
    init(_ value: Double) { self.value = value }
    init(_ value: Bool) { self.value = value }

    // MARK: Accessors

    var stringValue: String? { value as? String }
    var intValue: Int? {
        if let i = value as? Int { return i }
        // JSONSerialization parses JSON `1` into an NSNumber that Swift may
        // bridge as Bool (NSNumber objCType 'c'), so `as? Int` fails even
        // though the value is numeric. Go through NSNumber.intValue directly.
        if let n = value as? NSNumber, CFGetTypeID(n) == CFNumberGetTypeID() { return n.intValue }
        if let d = value as? Double { return Int(d) }
        return nil
    }
    var doubleValue: Double? { value as? Double }
    var boolValue: Bool? { value as? Bool }
    var arrayValue: [AnyCodable]? {
        if let arr = value as? [AnyCodable] { return arr }
        if let arr = value as? [Any] { return arr.map { AnyCodable($0) } }
        return nil
    }
    var dictValue: [String: AnyCodable]? {
        if let dict = value as? [String: AnyCodable] { return dict }
        if let dict = value as? [String: Any] { return dict.mapValues { AnyCodable($0) } }
        return nil
    }

    // MARK: Codable

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let b = try? container.decode(Bool.self) {
            // Bool AFTER Int/Double: JSONDecoder treats JSON `1`/`0` as a
            // valid Bool (`true`/`false`), so trying Bool first silently
            // turns a numeric `steps: 1` into `true`. Numbers must win.
            value = b
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let arr = try? container.decode([AnyCodable].self) {
            value = arr
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict
        } else {
            value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case nil:                            try container.encodeNil()
        case let n as NSNumber:
            // Disambiguate BEFORE Bool/Int: values arriving via JSONSerialization
            // (the WS path) are NSNumber, and `as? Bool` matches a JSON `1` —
            // round-tripping it as `true` (e.g. corrupting `payload.steps: 1`).
            // objCType 'c'/'B' is a real bool; everything else is a number.
            let t = String(cString: n.objCType)
            if t == "c" || t == "B" {
                try container.encode(n.boolValue)
            } else if n.doubleValue.truncatingRemainder(dividingBy: 1) == 0 {
                try container.encode(n.intValue)
            } else {
                try container.encode(n.doubleValue)
            }
        case let b as Bool:                  try container.encode(b)
        case let i as Int:                   try container.encode(i)
        case let d as Double:                try container.encode(d)
        case let s as String:                try container.encode(s)
        case let arr as [AnyCodable]:        try container.encode(arr)
        case let dict as [String: AnyCodable]: try container.encode(dict)
        // Tolerate raw collections that callers occasionally hand us
        // directly (e.g. from JSONSerialization or sloppy bridging).
        // Without these branches the previous default-case fall-through
        // would silently encode them as `null`, losing the user's data.
        case let arr as [Any]:
            try container.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:                             try container.encodeNil()
        }
    }

    // MARK: Equatable

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case (nil, nil):                                                   return true
        case let (l as Bool, r as Bool):                                   return l == r
        case let (l as Int, r as Int):                                     return l == r
        case let (l as Double, r as Double):                               return l == r
        case let (l as String, r as String):                               return l == r
        case let (l as [AnyCodable], r as [AnyCodable]):                   return l == r
        case let (l as [String: AnyCodable], r as [String: AnyCodable]):   return l == r
        default:                                                           return false
        }
    }

    var description: String {
        switch value {
        case nil:           return "nil"
        case let v as Bool:   return String(describing: v)
        case let v as Int:    return String(describing: v)
        case let v as Double: return String(describing: v)
        case let v as String: return v
        default:            return String(describing: value as Any)
        }
    }
}

// MARK: - Literals

extension AnyCodable: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self.value = value }
}

extension AnyCodable: ExpressibleByIntegerLiteral {
    init(integerLiteral value: Int) { self.value = value }
}

extension AnyCodable: ExpressibleByFloatLiteral {
    init(floatLiteral value: Double) { self.value = value }
}

extension AnyCodable: ExpressibleByBooleanLiteral {
    init(booleanLiteral value: Bool) { self.value = value }
}

extension AnyCodable: ExpressibleByNilLiteral {
    init(nilLiteral: ()) { self.value = nil }
}

// MARK: - Session Enums

enum SessionState: String, Codable, Sendable {
    case active
    case idle
    case compacting
}

enum SessionMode: String, Codable, Sendable {
    case safe
    case discuss
    case execute
    case delegate
}

// MARK: - Device Enums

enum DeviceRole: String, Codable, Sendable {
    case tentacle
    case app
}

enum DeviceKind: String, Codable, Sendable {
    case desktop
    case server
    case vm
    case web
    case ios
    case android
}

enum ReasoningEffort: String, Codable, Sendable {
    case low
    case medium
    case high
    case xhigh
}

// MARK: - Session Types

struct SessionUsage: Codable, Equatable, Sendable {
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var cacheWriteTokens: Int
    var totalCost: Double
    var totalDurationMs: Double
    /// Prompt tokens used by the last turn — per-turn snapshot, NOT
    /// cumulative. Compared against `ModelDetail.contextWindow` to
    /// produce the context-utilisation read on the session info sheet.
    /// Optional: older tentacles / non-Copilot adapters may omit it.
    var contextTokens: Int?
}

/// Compact session metadata sent in session_list for sync.
struct SessionDigest: Codable, Identifiable, Sendable {
    let id: String
    let agent: String
    var model: String? = nil
    var title: String? = nil
    var autoTitle: String? = nil
    var state: SessionState
    var mode: SessionMode
    var lastSeq: Int
    var readSeq: Int
    var messageCount: Int
    var createdAt: String
    var usage: SessionUsage? = nil
    var pinned: Bool? = nil
    /// Where this session came from (`copilot-cli`, `vscode`, `imported`,
    /// or `unknown`). Native Kraki sessions leave this absent.
    var source: String? = nil
    /// Sidebar preview pre-computed by tentacle. Carries the last
    /// meaningful message's text, type, and timestamp so the arm can
    /// paint the sidebar with zero replay round-trips.
    var preview: SessionPreview? = nil
}

// MARK: - Device Types

struct DeviceSummary: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var role: DeviceRole
    var kind: DeviceKind?
    var publicKey: String?
    var encryptionKey: String?
    var online: Bool
    var lastSeen: String?
    var createdAt: String?
}

struct ModelDetail: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let supportsReasoningEffort: Bool
    var supportedReasoningEfforts: [ReasoningEffort]?
    var defaultReasoningEffort: ReasoningEffort?
    /// Total token ceiling for the model (e.g. 200_000 for sonnet-4.6).
    /// Pairs with `SessionUsage.contextTokens` to render context
    /// utilisation. Optional: adapters that don't know it omit it.
    var contextWindow: Int?
}

// MARK: - Session Preview

/// Rich preview metadata for session list cards — mirrors web SessionPreview.
struct SessionPreview: Codable, Equatable, Sendable {
    let text: String
    /// "message", "question", "permission", etc.
    let type: String
    let timestamp: String
}

// MARK: - Attachment Types

struct ImageAttachment: Codable, Sendable {
    let type: String
    let mimeType: String
    let data: String // base64-encoded
}

/// Reference to lazy content (image, tool args, tool result) stored on
/// the tentacle's attachment store. Mirrors the protocol's `ContentRef`
/// (TypeScript `ContentRef` from `@kraki/protocol`). Bytes ship as
/// `attachment_data` chunks keyed by `id`.
struct ContentRef: Codable, Equatable, Sendable {
    /// Always "content_ref" in v0.17+. Older payloads may still use
    /// "image_ref"; both are accepted at parse time.
    let type: String
    /// Content-addressed sha256 hex (truncated to 32 chars).
    let id: String
    let mimeType: String
    let size: Int
    let caption: String?
    let name: String?
    let width: Int?
    let height: Int?

    static func from(_ dict: [String: AnyCodable]) -> ContentRef? {
        guard let type = dict["type"]?.stringValue,
              (type == "content_ref" || type == "image_ref"),
              let id = dict["id"]?.stringValue,
              let mimeType = dict["mimeType"]?.stringValue else { return nil }
        let size = dict["size"]?.intValue ?? 0
        return ContentRef(
            type: type,
            id: id,
            mimeType: mimeType,
            size: size,
            caption: dict["caption"]?.stringValue,
            name: dict["name"]?.stringValue,
            width: dict["width"]?.intValue,
            height: dict["height"]?.intValue
        )
    }
}
