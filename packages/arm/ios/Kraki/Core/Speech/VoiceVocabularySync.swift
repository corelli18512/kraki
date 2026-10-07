import Foundation
import CryptoKit

/// One Custom Words entry as stored on the account.
struct VoiceWord: Codable, Equatable {
    var term: String
    var heardAs: String

    var line: String { heardAs.isEmpty ? term : "\(term) = \(heardAs)" }

    static func decodeList(_ json: Any?) -> [VoiceWord]? {
        guard let array = json as? [[String: Any]] else { return nil }
        return array.compactMap { item in
            guard let term = item["term"] as? String, let heardAs = item["heardAs"] as? String else { return nil }
            return VoiceWord(term: term, heardAs: heardAs)
        }
    }
}

/// One user intent sent to Head. Lists are never uploaded, so a stale device
/// cannot overwrite newer words; Head applies intents in arrival order.
struct VoiceWordOp: Codable, Equatable {
    enum Kind: String, Codable { case add, edit, remove }
    var op: Kind
    var term: String
    var heardAs: String?
    /// edit: the word being replaced.
    var from: String?

    var json: [String: Any] {
        var result: [String: Any] = ["op": op.rawValue, "term": term]
        if let heardAs { result["heardAs"] = heardAs }
        if let from { result["from"] = from }
        return result
    }
}

/// Mirror of Head's `applyVoiceWordOps` (packages/head/src/voice-vocabulary.ts),
/// used for the optimistic local view. Keep the two in step.
enum VoiceWordList {
    static func key(_ term: String) -> String {
        term.trimmingCharacters(in: .whitespaces).precomposedStringWithCanonicalMapping.lowercased()
    }

    static func aliases(_ text: String) -> [String] {
        VoiceTerm(term: "x", heardAs: text).heardList
    }

    static func apply(_ ops: [VoiceWordOp], to current: [VoiceWord], max: Int = VoiceVocabulary.maxEntries) -> [VoiceWord] {
        var words = current
        func find(_ term: String) -> Int? { words.firstIndex { key($0.term) == key(term) } }
        func merge(_ i: Int, _ heardAs: String) {
            var seen = Set<String>()
            let merged = (aliases(words[i].heardAs) + aliases(heardAs)).filter { seen.insert($0).inserted }
            let candidate = VoiceWord(term: words[i].term, heardAs: merged.joined(separator: ", "))
            if candidate.line.count <= VoiceVocabulary.maxEntryLength { words[i] = candidate }
        }
        for op in ops {
            if op.op == .remove {
                if let i = find(op.term) { words.remove(at: i) }
                continue
            }
            let word = VoiceWord(term: op.term, heardAs: op.heardAs ?? "")
            var at: Int?
            if op.op == .edit, let from = op.from {
                at = find(from)
                if let i = at, key(from) == key(word.term) { words[i] = word; continue }
                if let i = at { words.remove(at: i) }
            }
            if let existing = find(word.term) {
                merge(existing, word.heardAs)
            } else if words.count < max {
                words.insert(word, at: at ?? words.count)
            }
        }
        return words
    }
}

/// Everything the device keeps for one account: the last list from Head, the
/// intents Head has not acknowledged yet, and the rows as the user sees them.
struct VoiceVocabularyAccountState: Codable {
    var server: [VoiceWord] = []
    var outbox: [VoiceWordOp] = []
    /// Rows as edited, including drafts (empty/invalid rows, raw spacing).
    var rows: [VoiceTerm] = []
    /// Valid rows as of the last flush; the next flush diffs against these.
    var committed: [VoiceTerm] = []

    static func storageKey(userID: String) -> String {
        "voice.vocabulary.account." + SHA256.hash(data: Data(userID.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
