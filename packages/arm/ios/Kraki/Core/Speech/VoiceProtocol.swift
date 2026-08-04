import Foundation
import VoiceInputCore

struct VoiceCapability: Codable, Equatable, Sendable {
    let brokerUrl: String
    let resource: String

    init(brokerUrl: String, resource: String) {
        self.brokerUrl = brokerUrl
        self.resource = resource
    }

    init?(json: [String: Any]) {
        guard let brokerUrl = json["brokerUrl"] as? String,
              let resource = json["resource"] as? String else { return nil }
        self.init(brokerUrl: brokerUrl, resource: resource)
    }

    func validatedBrokerURL() throws -> URL {
        guard let url = URL(string: brokerUrl),
              url.scheme == "wss" || url.scheme == "ws",
              url.host != nil else {
            throw VoiceInputError.invalidBrokerURL
        }
        return url
    }
}

enum VoiceLeaseDeniedReason: String, Codable, Equatable, Sendable {
    case quotaExhausted = "quota_exhausted"
    case notEntitled = "not_entitled"
    case invalidRequest = "invalid_request"
}

struct VoiceLeasePayload: Codable, Equatable, Sendable {
    let ver: Int
    let iss: String
    let sub: String
    let did: String
    let iat: Int
    let exp: Int
    let quotaSeconds: Int
    let resource: String
    let jti: String

    enum CodingKeys: String, CodingKey {
        case ver, iss, sub, did, iat, exp, resource, jti
        case quotaSeconds = "quota_seconds"
    }
}

struct VoiceLease: Codable, Equatable, Sendable {
    let payload: VoiceLeasePayload
    let signature: String
    let alg: String

    var voiceInputJSONValue: VoiceInputJSONValue {
        .object([
            "payload": .object([
                "ver": .number(Double(payload.ver)),
                "iss": .string(payload.iss),
                "sub": .string(payload.sub),
                "did": .string(payload.did),
                "iat": .number(Double(payload.iat)),
                "exp": .number(Double(payload.exp)),
                "quota_seconds": .number(Double(payload.quotaSeconds)),
                "resource": .string(payload.resource),
                "jti": .string(payload.jti),
            ]),
            "signature": .string(signature),
            "alg": .string(alg),
        ])
    }
}

struct VoiceLeaseGrantMessage: Codable, Equatable, Sendable {
    let type: String
    let lease: VoiceLease
}

struct VoiceLeaseDeniedMessage: Codable, Equatable, Sendable {
    let type: String
    let reason: VoiceLeaseDeniedReason
    let detail: String?
}

enum VoiceInputError: LocalizedError, Equatable {
    case unavailable
    case invalidBrokerURL
    case offline
    case microphoneDenied
    case leaseInFlight
    case leaseTimedOut
    case leaseDenied(VoiceLeaseDeniedReason, String?)
    case gateway(String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Voice input isn't available in this region."
        case .invalidBrokerURL:
            return "The voice service address is invalid."
        case .offline:
            return "Reconnect to Kraki before starting voice input."
        case .microphoneDenied:
            #if os(iOS)
            return "Microphone access is required. Enable it in Settings → Privacy & Security → Microphone."
            #else
            return "Microphone access is required. Enable it in System Settings → Privacy & Security → Microphone."
            #endif
        case .leaseInFlight:
            return "A previous voice request is still finishing. Try again in a moment."
        case .leaseTimedOut:
            return "The voice authorization request timed out."
        case .leaseDenied(.quotaExhausted, _):
            return "Today's voice-input quota has been used."
        case .leaseDenied(.notEntitled, _):
            return "Voice input isn't enabled for this account."
        case .leaseDenied(.invalidRequest, let detail):
            return detail ?? "The voice authorization request was rejected."
        case .gateway(let reason):
            return reason
        }
    }
}

struct VoiceSessionContext: Equatable, Sendable {
    let fields: [String: VoiceInputJSONValue]
    let vocabulary: [String]
}

enum VoiceSessionContextBuilder {
    private static let baseVocabulary = [
        "Kraki = cracker, kracky, kraki, 克拉奇, 克拉基",
    ]

    static func build(session: SessionInfo, recentMessages: [ChatMessage]) -> VoiceSessionContext {
        var terms: [String] = []
        var seen = Set<String>()

        func add(_ candidate: String) {
            let value = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.count >= 2, value.count <= 48,
                  value.rangeOfCharacter(from: .letters) != nil else { return }
            let key = value.lowercased()
            guard seen.insert(key).inserted else { return }
            terms.append(value)
        }

        add(session.displayTitle)
        add(session.agent)
        if let model = session.model { add(model) }

        // Extract only spelling-relevant identifiers/proper terms. Never ship
        // complete conversation text to the voice correction service.
        let pattern = #"[A-Za-z_][A-Za-z0-9_./:+#-]{2,47}"#
        let regex = try? NSRegularExpression(pattern: pattern)
        for message in recentMessages.suffix(12).reversed() {
            guard terms.count < 32,
                  let content = message.content ?? message.interruptedDraft,
                  !content.isEmpty else { continue }
            let ns = content as NSString
            let range = NSRange(location: 0, length: ns.length)
            regex?.enumerateMatches(in: content, range: range) { match, _, stop in
                guard let match else { return }
                let token = ns.substring(with: match.range)
                let isDistinctive = token.contains(where: { $0.isUppercase })
                    || token.contains("_") || token.contains("/")
                    || token.contains("-") || token.contains(".")
                if isDistinctive { add(token) }
                if terms.count >= 32 { stop.pointee = true }
            }
        }

        let fields: [String: VoiceInputJSONValue] = [
            "product": .string("kraki"),
            "sessionId": .string(session.id),
            "inputMethod": .string("dictation"),
            "locale": .string(Locale.current.identifier),
            "session": .object([
                "title": .string(session.displayTitle),
                "agent": .string(session.agent),
                "model": session.model.map(VoiceInputJSONValue.string) ?? .null,
                "mode": .string(session.mode.rawValue),
                "terms": .array(terms.map(VoiceInputJSONValue.string)),
            ]),
        ]
        return VoiceSessionContext(
            fields: fields,
            vocabulary: baseVocabulary + terms
        )
    }
}
