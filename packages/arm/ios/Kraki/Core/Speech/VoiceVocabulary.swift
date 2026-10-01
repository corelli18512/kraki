import Foundation
import SwiftUI

/// The user's own spelling vocabulary for voice correction, stored on this
/// device. One entry per line: a term (`Tentacle`), or a term with the ways
/// speech recognition tends to mishear it (`Kraki = 克拉奇, 克拉基`).
/// Lines starting with `#` are comments. Nothing is built in: which words
/// matter is entirely the user's.
enum VoiceVocabulary {
    static let storageKey = "voice.vocabulary"
    /// Bounded so the correction prompt (and its cost) stays small.
    static let maxEntries = 100
    static let maxEntryLength = 120

    static func parse(_ text: String) -> [String] {
        var seen = Set<String>()
        var entries: [String] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), line.count <= maxEntryLength,
                  seen.insert(line.lowercased()).inserted else { continue }
            entries.append(line)
            if entries.count == maxEntries { break }
        }
        return entries
    }

    static func load(_ defaults: UserDefaults = .standard) -> [String] {
        parse(defaults.string(forKey: storageKey) ?? "")
    }
}

/// Settings editor (iOS settings screen and the Mac General pane).
struct VoiceVocabularyEditor: View {
    @AppStorage(VoiceVocabulary.storageKey) private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .frame(minHeight: 160)
            Text("One per line. Add how it is often misheard after “=”, e.g. “Kraki = 克拉奇, 克拉基”. Used only to fix spelling in voice input; stays on this device. \(VoiceVocabulary.load().count)/\(VoiceVocabulary.maxEntries)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
