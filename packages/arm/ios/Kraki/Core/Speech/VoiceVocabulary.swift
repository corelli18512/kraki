import Foundation
import Observation
import SwiftUI

/// One entry of the user's voice vocabulary: a word or name spelled as it
/// should appear, and (optionally) how speech recognition tends to mishear it.
struct VoiceTerm: Identifiable, Equatable {
    let id: UUID
    var term: String
    /// Mishearings as typed: separated by commas (`,` `，` `、` `;` `；`).
    var heardAs: String

    init(id: UUID = UUID(), term: String = "", heardAs: String = "") {
        self.id = id; self.term = term; self.heardAs = heardAs
    }

    var heardList: [String] {
        heardAs.split(whereSeparator: { ",，、;；".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    var cleanTerm: String { term.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The line sent to the corrector: `Term` or `Term = heard 1, heard 2`.
    var line: String? {
        guard !cleanTerm.isEmpty else { return nil }
        let heard = heardList
        return heard.isEmpty ? cleanTerm : "\(cleanTerm) = \(heard.joined(separator: ", "))"
    }
}

/// Voice input preferences (Settings → Voice Input), stored on this device.
enum VoiceInputSettings {
    static let correctionKey = "voice.correction"
    static let shareContextKey = "voice.correctionContext"

    /// AI correction of the finished transcript. Off: exactly what speech
    /// recognition produced is used.
    static var correctionEnabled: Bool {
        UserDefaults.standard.object(forKey: correctionKey) as? Bool ?? true
    }
    /// Send the conversation title and names/terms found in recent messages
    /// (never the messages themselves) to help correction.
    static var shareConversationContext: Bool {
        UserDefaults.standard.object(forKey: shareContextKey) as? Bool ?? true
    }
}

/// The user's own spelling vocabulary for voice correction, stored on this
/// device (UserDefaults, one `Term = heard, …` line per entry). Nothing is
/// built in: which words matter is entirely the user's.
enum VoiceVocabulary {
    static let storageKey = "voice.vocabulary"
    /// Bounded so the correction prompt (and its cost) stays small.
    static let maxEntries = 100
    static let maxEntryLength = 120

    static func terms(from text: String) -> [VoiceTerm] {
        var seen = Set<String>()
        var result: [VoiceTerm] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.replacingOccurrences(of: "＝", with: "=").trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            let term = VoiceTerm(term: parts[0], heardAs: parts.count > 1 ? parts[1] : "")
            guard let entry = term.line, entry.count <= maxEntryLength,
                  seen.insert(term.cleanTerm.lowercased()).inserted else { continue }
            result.append(term)
            if result.count == maxEntries { break }
        }
        return result
    }

    static func text(from terms: [VoiceTerm]) -> String {
        terms.compactMap(\.line).joined(separator: "\n")
    }

    /// Entries for the correction request.
    static func parse(_ text: String) -> [String] { terms(from: text).compactMap(\.line) }

    static func load(_ defaults: UserDefaults = .standard) -> [String] {
        parse(defaults.string(forKey: storageKey) ?? "")
    }
}

/// Editing state shared by the iOS page and the Mac pane. Rows being typed
/// (empty word) stay in memory and are never saved.
@Observable
final class VoiceVocabularyStore {
    private let defaults: UserDefaults
    var terms: [VoiceTerm] { didSet { save() } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        terms = VoiceVocabulary.terms(from: defaults.string(forKey: VoiceVocabulary.storageKey) ?? "")
    }

    var savedCount: Int { terms.filter { $0.line != nil }.count }
    var isFull: Bool { terms.count >= VoiceVocabulary.maxEntries }

    /// A term already in the list, other than `id` (case-insensitive).
    func isDuplicate(_ term: String, excluding id: UUID?) -> Bool {
        let key = term.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !key.isEmpty && terms.contains { $0.id != id && $0.cleanTerm.lowercased() == key }
    }

    func upsert(_ term: VoiceTerm) {
        if let i = terms.firstIndex(where: { $0.id == term.id }) { terms[i] = term } else if !isFull { terms.append(term) }
    }

    func remove(_ id: UUID) { terms.removeAll { $0.id == id } }

    private func save() {
        var seen = Set<String>()
        let unique = terms.filter { $0.line != nil && seen.insert($0.cleanTerm.lowercased()).inserted }
        defaults.set(VoiceVocabulary.text(from: unique), forKey: VoiceVocabulary.storageKey)
    }
}

enum VoiceVocabularyCopy {
    static let title = "Custom Words"
    static let explanation = "Help voice input get your names and terms right, like product names, people or tech jargon. Kept on this device."
    static let emptyTitle = "No custom words yet"
    static let recognizedAs = "Often recognized as"
    static let recognizedAsFooter = "Optional. How voice input tends to get it wrong, separated by commas. Similar spellings are caught too."
    static let termFooter = "Spelled exactly as it should appear."
}

#if os(iOS)
/// Settings → Custom Words.
struct VoiceVocabularyPage: View {
    @State private var store = VoiceVocabularyStore()
    @State private var editing: VoiceTerm?
    @State private var isNew = false

    var body: some View {
        List {
            if store.terms.isEmpty {
                Section {
                    VStack(spacing: 10) {
                        Image(systemName: "character.book.closed")
                            .font(.system(size: 34, weight: .light))
                            .foregroundStyle(Color.krakiPrimary)
                        Text(VoiceVocabularyCopy.emptyTitle).font(.headline)
                        Text(VoiceVocabularyCopy.explanation)
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button { add() } label: {
                            HStack(spacing: 6) { Image(systemName: "plus"); Text("Add Word") }
                                .padding(.horizontal, 6)
                        }
                        .buttonStyle(.borderedProminent).padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 18)
                }
            } else {
                Section {
                    ForEach(store.terms) { term in
                        Button { isNew = false; editing = term } label: { VoiceTermRow(term: term) }
                            .foregroundStyle(.primary)
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { store.terms[$0].id }
                        ids.forEach(store.remove)
                    }
                    if !store.isFull {
                        Button { add() } label: { Label("Add Word", systemImage: "plus") }
                    }
                } footer: {
                    Text(VoiceVocabularyCopy.explanation + " \(store.savedCount) of \(VoiceVocabulary.maxEntries).")
                }
            }
        }
        .navigationTitle(VoiceVocabularyCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !store.terms.isEmpty {
                ToolbarItem(placement: .topBarTrailing) { EditButton() }
            }
        }
        .sheet(item: $editing) { term in
            VoiceTermEditor(term: term, isNew: isNew, store: store) { editing = nil }
        }
    }

    private func add() { isNew = true; editing = VoiceTerm() }
}

private struct VoiceTermRow: View {
    let term: VoiceTerm
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(term.cleanTerm).font(.body)
            if !term.heardList.isEmpty {
                Text("Often recognized as " + term.heardList.joined(separator: ", "))
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#if DEBUG
/// Screenshot/test access to the editor sheet.
struct VoiceTermEditorForTesting: View {
    let term: VoiceTerm; let isNew: Bool; let store: VoiceVocabularyStore
    var body: some View { VoiceTermEditor(term: term, isNew: isNew, store: store) {} }
}
#endif

private struct VoiceTermEditor: View {
    @State var term: VoiceTerm
    let isNew: Bool
    let store: VoiceVocabularyStore
    let dismiss: () -> Void
    @FocusState private var focus: Bool

    private var duplicate: Bool { store.isDuplicate(term.term, excluding: term.id) }
    private var canSave: Bool {
        !term.cleanTerm.isEmpty && !duplicate && (term.line?.count ?? 0) <= VoiceVocabulary.maxEntryLength
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("e.g. PostgreSQL, 张三丰", text: $term.term)
                        .focused($focus)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: { Text("Word or name") } footer: {
                    if duplicate { Text("Already in your vocabulary.").foregroundStyle(.orange) }
                    else { Text(VoiceVocabularyCopy.termFooter) }
                }
                Section {
                    TextField("e.g. 破四格, post gress", text: $term.heardAs, axis: .vertical)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: { Text(VoiceVocabularyCopy.recognizedAs + " (optional)") } footer: {
                    Text(VoiceVocabularyCopy.recognizedAsFooter)
                }
                if !isNew {
                    Section {
                        Button("Delete Word", role: .destructive) { store.remove(term.id); dismiss() }
                    }
                }
            }
            .navigationTitle(isNew ? "Add Word" : "Edit Word")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: dismiss) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isNew ? "Add" : "Save") { store.upsert(term); dismiss() }.disabled(!canSave)
                }
            }
            .onAppear { if isNew { focus = true } }
        }
        .presentationDetents([.medium, .large])
    }
}
#endif

#if os(macOS)
/// Settings → General → Custom Words: one editable row per word.
struct VoiceVocabularyMacSection: View {
    @State private var store = VoiceVocabularyStore()
    @FocusState private var focused: UUID?

    var body: some View {
        Section {
            if store.terms.isEmpty {
                Text("No custom words yet. Add names and terms voice input gets wrong.")
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    Text("Word or name").frame(width: 180, alignment: .leading)
                    Text(VoiceVocabularyCopy.recognizedAs + " (optional)")
                    Spacer()
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            ForEach($store.terms) { $term in
                HStack(spacing: 10) {
                    TextField("Word or name", text: $term.term, prompt: Text("e.g. PostgreSQL"))
                        .labelsHidden()
                        .multilineTextAlignment(.leading)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 180)
                        .focused($focused, equals: term.id)
                    TextField(VoiceVocabularyCopy.recognizedAs, text: $term.heardAs,
                              prompt: Text("Optional, e.g. 破四格, post gress"))
                        .labelsHidden()
                        .multilineTextAlignment(.leading)
                        .textFieldStyle(.roundedBorder)
                    Button { store.remove(term.id) } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Remove")
                }
                if store.isDuplicate(term.term, excluding: term.id) {
                    Text("“\(term.cleanTerm)” is already in the list; only the first is used.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            HStack {
                Button {
                    let new = VoiceTerm()
                    store.upsert(new)
                    focused = new.id
                } label: { Label("Add Word", systemImage: "plus") }
                .disabled(store.isFull)
                Spacer()
                Text("\(store.savedCount) / \(VoiceVocabulary.maxEntries)")
                    .monospacedDigit().font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text(VoiceVocabularyCopy.title)
        } footer: {
            Text(VoiceVocabularyCopy.explanation)
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
#endif

// MARK: - Voice Input settings screens

enum VoiceInputCopy {
    static let title = "Voice Input"
    static let correction = "Correct Transcripts"
    static let correctionFooter = "After you finish speaking, an AI model fixes recognition mistakes such as names, terms and punctuation. Turn off to use exactly what was recognized."
    static let context = "Use Conversation Context"
    static let contextFooter = "Sends the conversation title and names or terms that appear in recent messages, never the messages themselves, so names you are discussing are spelled right."
}

#if os(iOS)
/// Settings → Voice Input.
struct VoiceInputSettingsPage: View {
    @Environment(AppState.self) private var appState
    @AppStorage(VoiceInputSettings.correctionKey) private var correction = true
    @AppStorage(VoiceInputSettings.shareContextKey) private var shareContext = true
    @AppStorage(VoiceVocabulary.storageKey) private var vocabularyText = ""

    var body: some View {
        Form {
            Section {
                Toggle(VoiceInputCopy.correction, isOn: $correction)
            } footer: { Text(VoiceInputCopy.correctionFooter) }

            Section {
                Toggle(VoiceInputCopy.context, isOn: $shareContext)
                NavigationLink {
                    VoiceVocabularyPage()
                } label: {
                    HStack {
                        Text(VoiceVocabularyCopy.title)
                        Spacer()
                        let count = VoiceVocabulary.parse(vocabularyText).count
                        if count > 0 { Text("\(count)").foregroundStyle(.secondary) }
                    }
                }
            } header: {
                Text("Correction")
            } footer: {
                Text(VoiceInputCopy.contextFooter)
            }
            .disabled(!correction)
        }
        .navigationTitle(VoiceInputCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: correction) { _, _ in appState.voiceInputController.applySettings() }
    }
}
#endif

#if os(macOS)
/// Settings → Voice Input (Mac tab).
struct VoiceInputPane: View {
    @Environment(AppState.self) private var appState
    @AppStorage(VoiceInputSettings.correctionKey) private var correction = true
    @AppStorage(VoiceInputSettings.shareContextKey) private var shareContext = true

    var body: some View {
        Form {
            Section {
                Toggle(VoiceInputCopy.correction, isOn: $correction)
            } footer: {
                Text(VoiceInputCopy.correctionFooter).font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Toggle(VoiceInputCopy.context, isOn: $shareContext)
            } footer: {
                Text(VoiceInputCopy.contextFooter).font(.footnote).foregroundStyle(.secondary)
            }
            .disabled(!correction)
            VoiceVocabularyMacSection()
                .disabled(!correction)
        }
        .formStyle(.grouped)
        .padding()
        .onChange(of: correction) { _, _ in appState.voiceInputController.applySettings() }
    }
}
#endif

