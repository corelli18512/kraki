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
        if let d = value as? Double { return Int(d) }
        return nil
    }
    var doubleValue: Double? { value as? Double }
    var boolValue: Bool? { value as? Bool }
    var arrayValue: [AnyCodable]? { value as? [AnyCodable] }
    var dictValue: [String: AnyCodable]? { value as? [String: AnyCodable] }

    // MARK: Codable

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
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
        case let b as Bool:                  try container.encode(b)
        case let i as Int:                   try container.encode(i)
        case let d as Double:                try container.encode(d)
        case let s as String:                try container.encode(s)
        case let arr as [AnyCodable]:        try container.encode(arr)
        case let dict as [String: AnyCodable]: try container.encode(dict)
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
}

/// Compact session metadata sent in session_list for sync.
struct SessionDigest: Codable, Identifiable, Sendable {
    let id: String
    let agent: String
    var model: String?
    var title: String?
    var autoTitle: String?
    var state: SessionState
    var mode: SessionMode
    var lastSeq: Int
    var readSeq: Int
    var messageCount: Int
    var createdAt: String
    var usage: SessionUsage?
    var pinned: Bool?
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
}

// MARK: - Session Preview

/// Rich preview metadata for session list cards — mirrors web SessionPreview.
struct SessionPreview: Equatable, Sendable {
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
