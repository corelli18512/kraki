import Foundation
import Observation
import SwiftUI

/// One entry of the user's voice vocabulary: a word or name spelled as it
/// should appear, and (optionally) how speech recognition tends to mishear it.
struct VoiceTerm: Identifiable, Equatable, Codable {
    let id: UUID
    var term: String
    /// Mishearings as typed: separated by commas or semicolons (ASCII or full-width) or the ideographic comma.
    var heardAs: String

    init(id: UUID = UUID(), term: String = "", heardAs: String = "") {
        self.id = id; self.term = term; self.heardAs = heardAs
    }

    var heardList: [String] {
        // Newlines count as separators: the iOS field is multi-line, and a
        // newline must never reach the one-entry-per-line storage.
        heardAs.split(whereSeparator: { ",\u{FF0C}\u{3001};\u{FF1B}".contains($0) || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    var cleanTerm: String {
        term.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// Why this entry cannot be kept as typed (nil: fine). Storage is one
    /// `Term = …` line, so the word itself may not hold “=” or start with “#”.
    var problem: String? {
        let t = cleanTerm
        if t.contains("=") || t.contains("\u{FF1D}") { return "A word can't contain “=”." }
        if t.hasPrefix("#") { return "A word can't start with “#”." }
        if let l = line, l.count > VoiceVocabulary.maxEntryLength {
            return "Too long (max \(VoiceVocabulary.maxEntryLength) characters)."
        }
        return nil
    }

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
            let line = raw.replacingOccurrences(of: "\u{FF1D}", with: "=").trimmingCharacters(in: .whitespaces)
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

/// Custom Words for the signed-in account, shared by the iOS page and the Mac
/// pane. Edits show at once and are kept on the device; `flush()` (debounced by
/// PreferencesManager) turns them into intents for Head, and `receive` adopts
/// the account's list. Sync is silent: there is no conflict UI, the later
/// intent wins. Rows being typed (empty or invalid word) are never sent.
@Observable
final class VoiceVocabularyStore {
    private let defaults: UserDefaults
    var terms: [VoiceTerm] { didSet { if !applyingRemote { changed() } } }
    private var applyingRemote = false
    private var state = VoiceVocabularyAccountState()
    private(set) var accountKey: String?
    /// Head supports sync (else edits stay queued on this device).
    var syncSupported = false
    /// Local edit happened; PreferencesManager debounces and sends.
    var onChange: (() -> Void)?
    var outbox: [VoiceWordOp] { state.outbox }

    private static let activeKey = "voice.vocabulary.activeAccount"
    private static let migratedKey = "voice.vocabulary.legacyClaimed"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let active = defaults.string(forKey: Self.activeKey)
        if let active, let loaded = Self.load(active, defaults) {
            accountKey = active
            state = loaded
            terms = loaded.rows
        } else {
            terms = VoiceVocabulary.terms(from: defaults.string(forKey: VoiceVocabulary.storageKey) ?? "")
        }
    }

    /// Before the first sign-in the old device-local list stays editable.
    /// After signing out, edits wait for sign-in rather than belong to no one.
    var canEdit: Bool { accountKey != nil || !defaults.bool(forKey: Self.migratedKey) }
    var savedCount: Int { terms.filter { $0.line != nil }.count }
    var isFull: Bool { terms.count >= VoiceVocabulary.maxEntries }

    /// A term already in the list, other than `id` (case-insensitive).
    func isDuplicate(_ term: String, excluding id: UUID?) -> Bool {
        let key = VoiceWordList.key(term)
        return !key.isEmpty && terms.contains { $0.id != id && VoiceWordList.key($0.cleanTerm) == key }
    }

    func upsert(_ term: VoiceTerm) {
        guard canEdit else { return }
        if let i = terms.firstIndex(where: { $0.id == term.id }) { terms[i] = term } else if !isFull { terms.append(term) }
    }

    func remove(_ id: UUID) {
        guard canEdit else { return }
        terms.removeAll { $0.id == id }
    }

    // MARK: Account

    func activate(userID: String) {
        let key = VoiceVocabularyAccountState.storageKey(userID: userID)
        guard key != accountKey else { return }
        accountKey = key
        state = Self.load(key, defaults) ?? VoiceVocabularyAccountState()
        if !defaults.bool(forKey: Self.migratedKey) {
            // This installation's pre-sync words go to the first account that
            // signs in, once; the next flush uploads them as additions, which
            // Head merges with words from the user's other devices.
            let text = defaults.string(forKey: VoiceVocabulary.storageKey) ?? ""
            defaults.set(text, forKey: "voice.vocabulary.legacyBackup")
            let keys = Set(state.rows.map { VoiceWordList.key($0.cleanTerm) })
            state.rows += VoiceVocabulary.terms(from: text).filter { !keys.contains(VoiceWordList.key($0.cleanTerm)) }
            persist()
            defaults.set(true, forKey: Self.migratedKey)
        }
        defaults.set(key, forKey: Self.activeKey)
        show(state.rows)
    }

    /// Sign-out: hide the account's words. Its queued edits stay stored and
    /// are sent when that account signs in again.
    func deactivate() {
        accountKey = nil
        syncSupported = false
        state = VoiceVocabularyAccountState()
        defaults.removeObject(forKey: Self.activeKey)
        show([])
    }

    // MARK: Sync

    /// Turns edits since the last flush into intents in the outbox.
    func flush() {
        guard accountKey != nil else { return }
        let valid = Self.valid(terms)
        let validIDs = Set(valid.map(\.id))
        let committed = Dictionary(state.committed.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var ops = state.committed.filter { !validIDs.contains($0.id) }
            .map { VoiceWordOp(op: .remove, term: $0.cleanTerm) }
        // Edits before additions: renaming A and adding a new A must not fold
        // the new A into the renamed word.
        for row in valid {
            guard let old = committed[row.id], old.line != row.line else { continue }
            ops.append(VoiceWordOp(op: .edit, term: row.word.term, heardAs: row.word.heardAs, from: old.cleanTerm))
        }
        for row in valid where committed[row.id] == nil {
            ops.append(VoiceWordOp(op: .add, term: row.word.term, heardAs: row.word.heardAs))
        }
        guard !ops.isEmpty else { return }
        state.outbox += ops
        state.committed = valid
        persist()
    }

    /// The account's list from Head. `acknowledged`: how many outbox intents
    /// (from the front) this list already includes.
    func receive(_ words: [VoiceWord], acknowledged: Int = 0) {
        guard accountKey != nil else { return }
        flush()
        state.outbox.removeFirst(min(acknowledged, state.outbox.count))
        state.server = words
        let rows = reconcile(VoiceWordList.apply(state.outbox, to: words))
        state.committed = Self.valid(rows)
        show(rows)
    }

    /// Keeps row identity and raw text (e.g. a trailing comma being typed on
    /// Mac) for words that are unchanged, and keeps drafts.
    private func reconcile(_ target: [VoiceWord]) -> [VoiceTerm] {
        var pool = terms
        var rows: [VoiceTerm] = []
        for word in target {
            let key = VoiceWordList.key(word.term)
            if let i = pool.firstIndex(where: { $0.line != nil && $0.problem == nil && VoiceWordList.key($0.cleanTerm) == key }) {
                var row = pool.remove(at: i)
                if row.word != word { row.term = word.term; row.heardAs = word.heardAs }
                rows.append(row)
            } else {
                rows.append(VoiceTerm(term: word.term, heardAs: word.heardAs))
            }
        }
        let keys = Set(target.map { VoiceWordList.key($0.term) })
        return rows + pool.filter { $0.line == nil || $0.problem != nil || keys.contains(VoiceWordList.key($0.cleanTerm)) }
    }

    // MARK: Storage

    private func changed() {
        if accountKey == nil {
            guard canEdit else { show([]); return }
            defaults.set(VoiceVocabulary.text(from: Self.valid(terms)), forKey: VoiceVocabulary.storageKey)
            return
        }
        state.rows = terms
        persist()
        onChange?()
    }

    private func show(_ rows: [VoiceTerm]) {
        applyingRemote = true
        terms = rows
        applyingRemote = false
        state.rows = rows
        persist()
    }

    private func persist() {
        if let accountKey, let data = try? JSONEncoder().encode(state) { defaults.set(data, forKey: accountKey) }
        // What the next dictation request reads.
        defaults.set(VoiceVocabulary.text(from: Self.valid(state.rows)), forKey: VoiceVocabulary.storageKey)
    }

    private static func load(_ key: String, _ defaults: UserDefaults) -> VoiceVocabularyAccountState? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(VoiceVocabularyAccountState.self, from: $0) }
    }

    static func valid(_ terms: [VoiceTerm]) -> [VoiceTerm] {
        var seen = Set<String>()
        return terms.filter { $0.line != nil && $0.problem == nil && seen.insert(VoiceWordList.key($0.cleanTerm)).inserted }
    }
}

extension VoiceTerm {
    var word: VoiceWord { VoiceWord(term: cleanTerm, heardAs: heardList.joined(separator: ", ")) }
}

enum VoiceVocabularyCopy {
    static let title = "Custom Words"
    static let explanation = "Help voice input get your names and terms right, like product names, people or tech jargon. Synced across your devices with your Kraki account."
    static let emptyTitle = "No custom words yet"
    static let recognizedAs = "Often recognized as"
    static let recognizedAsFooter = "Optional. How voice input tends to get it wrong, separated by commas. Similar spellings are caught too."
    static let termFooter = "Spelled exactly as it should appear."
    static let signedOut = "Sign in to edit your custom words."
}

#if os(iOS)
/// Settings → Custom Words.
struct VoiceVocabularyPage: View {
    @Environment(AppState.self) private var appState
    private var store: VoiceVocabularyStore { appState.voiceVocabularyStore }
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
                        Text(store.canEdit ? VoiceVocabularyCopy.explanation : VoiceVocabularyCopy.signedOut)
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
                        ids.forEach { store.remove($0) }
                    }
                    if !store.isFull {
                        Button { add() } label: { Label("Add Word", systemImage: "plus") }
                    }
                } footer: {
                    Text(store.canEdit ? VoiceVocabularyCopy.explanation + " \(store.savedCount) of \(VoiceVocabulary.maxEntries)."
                         : VoiceVocabularyCopy.signedOut)
                }
            }
        }
        .disabled(!store.canEdit)
        .onChange(of: store.accountKey) { _, _ in editing = nil }
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
    private var canSave: Bool { store.canEdit && !term.cleanTerm.isEmpty && !duplicate && term.problem == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("e.g. PostgreSQL", text: $term.term)
                        .focused($focus)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: { Text("Word or name") } footer: {
                    if duplicate { Text("Already in your custom words.").foregroundStyle(.orange) }
                    else if let problem = term.problem { Text(problem).foregroundStyle(.orange) }
                    else { Text(VoiceVocabularyCopy.termFooter) }
                }
                Section {
                    TextField("e.g. post gress, postgres Q L", text: $term.heardAs, axis: .vertical)
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
/// Settings → Voice Input → Custom Words (Mac): one editable row per word.
struct VoiceVocabularyMacSection: View {
    @Environment(AppState.self) private var appState
    private var store: VoiceVocabularyStore { appState.voiceVocabularyStore }
    @FocusState private var focused: UUID?

    var body: some View {
        @Bindable var store = store
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
                              prompt: Text("Optional, e.g. post gress, postgres Q L"))
                        .labelsHidden()
                        .multilineTextAlignment(.leading)
                        .textFieldStyle(.roundedBorder)
                    Button { store.remove(term.id) } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Remove")
                }
                if let problem = term.problem {
                    Text(problem + " This word isn't saved.").font(.caption).foregroundStyle(.orange)
                } else if store.isDuplicate(term.term, excluding: term.id) {
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
            Text(store.canEdit ? VoiceVocabularyCopy.explanation : VoiceVocabularyCopy.signedOut)
                .font(.footnote).foregroundStyle(.secondary)
        }
        .disabled(!store.canEdit)
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
        .onChange(of: correction) { _, _ in appState.voiceInputController.applySettings() }
    }
}
#endif

