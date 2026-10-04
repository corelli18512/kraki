import Foundation
import CryptoKit

struct VoiceVocabularySnapshot: Codable, Equatable {
    struct Entry: Codable, Equatable {
        var id: String
        var revision: Int
        var term: String
        var heardAs: String
        var deleted: Bool
        var changeId: String
        var voiceTerm: VoiceTerm? {
            guard !deleted, let uuid = UUID(uuidString: id) else { return nil }
            return VoiceTerm(id: uuid, term: term, heardAs: heardAs)
        }
    }
    var version = 1
    var revision = 0
    var entries: [Entry] = []

    static func decode(_ json: Any?) -> Self? {
        guard let json, JSONSerialization.isValidJSONObject(json),
              let data = try? JSONSerialization.data(withJSONObject: json),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              value.version == 1, value.revision >= 0, value.entries.count <= 2000,
              Set(value.entries.map(\.id)).count == value.entries.count,
              value.entries.allSatisfy({ UUID(uuidString: $0.id) != nil && $0.revision >= 0 && $0.revision <= value.revision }) else { return nil }
        return value
    }
}

struct VoiceVocabularyChange: Codable, Equatable {
    var changeId = UUID().uuidString.lowercased()
    var id: String
    var baseRevision: Int
    var action: String
    var term: String?
    var heardAs: String?

    var json: [String: Any] {
        var result: [String: Any] = ["changeId": changeId, "id": id, "baseRevision": baseRevision, "action": action]
        if let term { result["term"] = term }
        if let heardAs { result["heardAs"] = heardAs }
        return result
    }
}

/// Persisted per (relay, account), including unacknowledged edits. IDs survive
/// launches, unlike the legacy one-line format. No wall clocks are involved.
struct VoiceVocabularySyncState: Codable {
    var snapshot = VoiceVocabularySnapshot()
    var pending: [VoiceVocabularyChange] = []
    var blocked: [String: String] = [:]

    var terms: [VoiceTerm] {
        var result = snapshot.entries.compactMap(\.voiceTerm)
        for c in pending {
            guard let id = UUID(uuidString: c.id) else { continue }
            let index = result.firstIndex { $0.id == id }
            if c.action == "delete" {
                if let index { result.remove(at: index) }
            } else if let term = c.term {
                let value = VoiceTerm(id: id, term: term, heardAs: c.heardAs ?? "")
                if let index { result[index] = value } else { result.append(value) }
            }
        }
        return result
    }

    mutating func stage(_ term: VoiceTerm, deleting: Bool = false, importing: Bool = false, baseRevision: Int? = nil) {
        let id = term.id.uuidString.lowercased()
        let previous = pending.first { $0.id == id }
        if let previous { blocked.removeValue(forKey: previous.changeId) }
        pending.removeAll { $0.id == id }
        pending.append(VoiceVocabularyChange(
            id: id, baseRevision: baseRevision ?? previous?.baseRevision ?? snapshot.entries.first { $0.id == id }?.revision ?? 0,
            action: deleting ? "delete" : (importing || previous?.action == "import" ? "import" : "upsert"),
            term: deleting ? nil : term.cleanTerm,
            heardAs: deleting ? nil : term.heardList.joined(separator: ", ")
        ))
    }

    mutating func receive(_ remote: VoiceVocabularySnapshot, sent: [VoiceVocabularyChange] = [], results: [[String: Any]] = []) {
        // An old response may acknowledge a write, but must not roll back a
        // newer broadcast already received from another device.
        if remote.revision >= snapshot.revision { snapshot = remote }
        for result in results {
            guard let changeId = result["changeId"] as? String,
                  let status = result["status"] as? String,
                  let original = sent.first(where: { $0.changeId == changeId }),
                  let index = pending.firstIndex(where: { $0.id == original.id }) else { continue }
            if pending[index].changeId == changeId {
                if status == "applied" {
                    pending.remove(at: index)
                    blocked.removeValue(forKey: changeId)
                } else {
                    blocked[changeId] = status
                }
            } else if status == "applied" {
                // User kept typing while this request was in flight. Only
                // advance over OUR acknowledged write, not someone else's.
                let acknowledged = remote.entries.first { $0.id == original.id }
                if acknowledged?.deleted == true && pending[index].action != "delete" {
                    blocked[pending[index].changeId] = "conflict"
                } else {
                    pending[index].baseRevision = acknowledged?.revision ?? 0
                    if acknowledged != nil { pending[index].action = pending[index].action == "delete" ? "delete" : "upsert" }
                }
            } else {
                blocked[pending[index].changeId] = status
            }
        }
    }

    mutating func retryBlocked() {
        for i in pending.indices where blocked[pending[i].changeId] != nil {
            pending[i].changeId = UUID().uuidString.lowercased()
            pending[i].baseRevision = snapshot.entries.first { $0.id == pending[i].id }?.revision ?? 0
        }
        blocked.removeAll()
    }

    mutating func discardBlocked() {
        pending.removeAll { blocked[$0.changeId] != nil }
        blocked.removeAll()
    }

    static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Every old installation assigns the same identity to the same spelling,
    /// so a late migration also recognizes a previously deleted legacy word.
    static func legacyID(_ term: String) -> UUID {
        let hex = Array(hash("kraki.voice.legacy:" + term.precomposedStringWithCanonicalMapping.lowercased()))
        let text = "\(String(hex[0..<8]))-\(String(hex[8..<12]))-\(String(hex[12..<16]))-\(String(hex[16..<20]))-\(String(hex[20..<32]))"
        return UUID(uuidString: text)!
    }
}
