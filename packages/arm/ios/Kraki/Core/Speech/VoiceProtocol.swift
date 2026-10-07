import Foundation
import VoiceInputCore

struct VoiceCapability: Codable, Equatable, Sendable {
    let brokerUrl: String
    let resource: String

    init(brokerUrl: String, resource: String) {
        self.brokerUrl = brokerUrl
        self.resource = resource
    }

    /// From the relay's `auth_ok.voice`. A broker the app would not send
    /// microphone audio to (see `validatedBrokerURL`) means no voice input.
    init?(json: [String: Any]) {
        guard let brokerUrl = json["brokerUrl"] as? String,
              let resource = json["resource"] as? String else { return nil }
        self.init(brokerUrl: brokerUrl, resource: resource)
        guard (try? validatedBrokerURL()) != nil else {
            KLog.diag("Voice broker rejected: \(URL(string: brokerUrl)?.host ?? "invalid URL")")
            return nil
        }
    }

    /// Microphone audio only goes to Kraki's own speech service over TLS:
    /// `wss://` on kraki.chat or a subdomain. Debug builds also accept a
    /// local broker (ws or wss on localhost / 127.0.0.1).
    func validatedBrokerURL() throws -> URL {
        guard let url = URL(string: brokerUrl), let host = url.host?.lowercased() else {
            throw VoiceInputError.invalidBrokerURL
        }
        if url.scheme == "wss", host == "kraki.chat" || host.hasSuffix(".kraki.chat") {
            return url
        }
        #if DEBUG
        if url.scheme == "wss" || url.scheme == "ws",
           host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".invalid") {
            return url
        }
        #endif
        throw VoiceInputError.invalidBrokerURL
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
    case microphoneUnavailable
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
            return "Couldn't connect to Kraki. Check your connection and try again."
        case .microphoneDenied:
            #if os(iOS)
            return "Microphone access is required. Enable it in Settings → Privacy & Security → Microphone."
            #else
            return "Microphone access is required. Enable it in System Settings → Privacy & Security → Microphone."
            #endif
        case .microphoneUnavailable:
            #if os(macOS)
            return "No microphone is available. Connect a microphone and select it in System Settings → Sound → Input, then try again."
            #else
            return "No microphone is available. Connect a microphone and try again."
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
    /// A Session that does not exist yet (the Mac new-session composer): the
    /// chosen agent, model and computer are the only context.
    static func buildNewSession(agent: String, model: String?, deviceName: String?,
                                userVocabulary: [String] = VoiceVocabulary.load(),
                                shareConversation: Bool = VoiceInputSettings.shareConversationContext) -> VoiceSessionContext {
        var fields: [String: VoiceInputJSONValue] = [
            "product": .string("kraki"),
            "inputMethod": .string("dictation"),
            "locale": .string(Locale.current.identifier),
        ]
        guard shareConversation else { return VoiceSessionContext(fields: fields, vocabulary: userVocabulary) }
        let terms = [agent, model ?? "", deviceName ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= 2 && $0.count <= 48 && $0.rangeOfCharacter(from: .letters) != nil }
        fields["session"] = .object([
            "agent": .string(agent),
            "model": model.map(VoiceInputJSONValue.string) ?? .null,
            "terms": .array(terms.map(VoiceInputJSONValue.string)),
        ])
        return VoiceSessionContext(
            fields: fields,
            vocabulary: userVocabulary + terms.filter { term in
                !userVocabulary.contains { $0.lowercased() == term.lowercased() }
            }
        )
    }

    /// `userVocabulary`: the user's own terms (Settings → Voice Input → Custom Words),
    /// first; then terms taken from the current conversation.
    static func build(session: SessionInfo, recentMessages: [ChatMessage],
                      userVocabulary: [String] = VoiceVocabulary.load(),
                      shareConversation: Bool = VoiceInputSettings.shareConversationContext) -> VoiceSessionContext {
        // Without conversation context: only the user's own words and the
        // locale leave the device (no title, agent, model or message terms).
        guard shareConversation else {
            return VoiceSessionContext(
                fields: [
                    "product": .string("kraki"),
                    "inputMethod": .string("dictation"),
                    "locale": .string(Locale.current.identifier),
                ],
                vocabulary: userVocabulary
            )
        }
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

        if !VoiceContextTermFilter.isSensitive(session.displayTitle) { add(session.displayTitle) }
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
                if isDistinctive, !VoiceContextTermFilter.isSensitive(token) { add(token) }
                if terms.count >= 32 { stop.pointee = true }
            }
        }

        let fields: [String: VoiceInputJSONValue] = [
            "product": .string("kraki"),
            "sessionId": .string(session.id),
            "inputMethod": .string("dictation"),
            "locale": .string(Locale.current.identifier),
            "session": .object([
                "title": .string(VoiceContextTermFilter.isSensitive(session.displayTitle) ? "" : session.displayTitle),
                "agent": .string(session.agent),
                "model": session.model.map(VoiceInputJSONValue.string) ?? .null,
                "mode": .string(session.mode.rawValue),
                "terms": .array(terms.map(VoiceInputJSONValue.string)),
            ]),
        ]
        return VoiceSessionContext(
            fields: fields,
            vocabulary: userVocabulary + terms.filter { term in
                !userVocabulary.contains { $0.lowercased().hasPrefix(term.lowercased()) }
            }
        )
    }
}

/// Terms scraped from the conversation must help spelling, never leak
/// secrets: drop anything shaped like a credential, a URL or path, an
/// e-mail address, or a long high-entropy identifier (keys, hashes, ids).
enum VoiceContextTermFilter {
    /// Case-sensitive prefixes of well-known credential formats.
    private static let secretPrefixes = [
        "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "sk-", "sk_live_", "sk_test_", "rk_live_",
        "pk_live_", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "xapp-", "AIza", "ya29.", "npm_", "hf_",
        "eyJ", "dop_v1_", "shpat_", "-----BEGIN",
    ]

    static func isSensitive(_ raw: String) -> Bool {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if secretPrefixes.contains(where: { token.hasPrefix($0) }) { return true }
        // AWS access key ids.
        if token.count == 20, token.hasPrefix("AKIA") || token.hasPrefix("ASIA"),
           token.allSatisfy({ $0.isUppercase || $0.isNumber }) { return true }
        // URLs, host:port, user@host, file paths.
        if token.contains("://") || token.contains("@") || token.contains("/") || token.contains("\\") { return true }
        if token.contains(":"), token.split(separator: ":").last.map({ $0.allSatisfy(\.isNumber) }) == true { return true }
        // Long hex (hashes, ids) and long mixed letter+digit strings with
        // high entropy (API keys, tokens).
        let hexDigits = token.filter(\.isHexDigit)
        if token.count >= 12, hexDigits.count == token.count, token.contains(where: \.isNumber) { return true }
        let digits = token.filter(\.isNumber).count
        if token.count >= 16, digits >= 3, entropy(token) >= 3.5 { return true }
        return false
    }

    /// Shannon entropy in bits per character.
    static func entropy(_ s: String) -> Double {
        guard !s.isEmpty else { return 0 }
        var counts: [Character: Int] = [:]
        for c in s { counts[c, default: 0] += 1 }
        let n = Double(s.count)
        return counts.values.reduce(0) { acc, count in
            let p = Double(count) / n
            return acc - p * log2(p)
        }
    }
}
