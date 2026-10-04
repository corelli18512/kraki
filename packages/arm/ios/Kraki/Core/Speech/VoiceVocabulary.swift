import Foundation
import Observation
import SwiftUI

/// One entry of the user's voice vocabulary: a word or name spelled as it
/// should appear, and (optionally) how speech recognition tends to mishear it.
struct VoiceTerm: Identifiable, Equatable {
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

/// The current account's spelling vocabulary, cached on this device for voice
/// correction (one `Term = heard, …` line per entry). The structured sync state
/// and unacknowledged edits are stored separately, scoped to the account.
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

/// Editing state shared by the iOS page and the Mac pane. Rows being typed
/// (empty word) stay in memory and are never saved.
@Observable
final class VoiceVocabularyStore {
    private let defaults: UserDefaults
    var terms: [VoiceTerm] { didSet { if !applyingRemote { save() } } }
    private var applyingRemote = false
    private var savedTerms: [VoiceTerm] = []
    private var draftBaseRevisions: [UUID: Int] = [:]
    private(set) var accountKey: String?
    private(set) var syncState = VoiceVocabularySyncState()
    var syncSupported = false
    var onChange: (() -> Void)?
    private static let activeKey = "voice.vocabulary.activeAccount"
    private static let migratedKey = "voice.vocabulary.legacyClaimed"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let activeAccount = defaults.string(forKey: Self.activeKey)
        accountKey = activeAccount
        if let accountKey = activeAccount, let data = defaults.data(forKey: accountKey),
           let state = try? JSONDecoder().decode(VoiceVocabularySyncState.self, from: data) {
            syncState = state
            terms = state.terms
        } else {
            terms = VoiceVocabulary.terms(from: defaults.string(forKey: VoiceVocabulary.storageKey) ?? "")
        }
        savedTerms = terms
    }

    // Before first migration, preserve the old local editor. After signing
    // out of an account, require login rather than creating unowned edits.
    var canEdit: Bool { accountKey != nil || !defaults.bool(forKey: Self.migratedKey) }
    var hasSyncProblems: Bool { !syncState.blocked.isEmpty }
    var syncStatus: String {
        if accountKey == nil { return "Sign in to sync custom words." }
        if hasSyncProblems { return "Some changes couldn't sync: a word changed elsewhere, is duplicated, or exceeds the account limit. Your edits are kept on this device." }
        if !syncSupported { return "Waiting for a server that supports Custom Words sync." }
        return syncState.pending.isEmpty ? "Synced with your Kraki account." : "Changes saved on this device. Waiting to sync."
    }

    static func accountKey(userID: String, relay: String) -> String {
        // Separate self-hosted relays may use the same user IDs.
        "voice.vocabulary.account." + VoiceVocabularySyncState.hash(relay + "\n" + userID)
    }

    func activate(userID: String, relay: String) {
        let key = Self.accountKey(userID: userID, relay: relay)
        if key == accountKey { return }
        let legacy = defaults.bool(forKey: Self.migratedKey) ? [] : VoiceVocabulary.terms(from: defaults.string(forKey: VoiceVocabulary.storageKey) ?? "")
        accountKey = key
        syncState = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(VoiceVocabularySyncState.self, from: $0) } ?? VoiceVocabularySyncState()
        if !defaults.bool(forKey: Self.migratedKey) {
            // Keep a local backup; never import this installation's words into
            // a second account after logout.
            defaults.set(defaults.string(forKey: VoiceVocabulary.storageKey) ?? "", forKey: "voice.vocabulary.legacyBackup")
            for var term in legacy {
                term = VoiceTerm(id: VoiceVocabularySyncState.legacyID(term.cleanTerm), term: term.term, heardAs: term.heardAs)
                syncState.stage(term, importing: true)
            }
            // Save the import outbox before marking migration complete.
            persist()
            defaults.set(true, forKey: Self.migratedKey)
        }
        defaults.set(key, forKey: Self.activeKey)
        refreshTerms(preserveDrafts: false)
    }

    func deactivate() {
        accountKey = nil
        syncSupported = false
        syncState = VoiceVocabularySyncState()
        defaults.removeObject(forKey: Self.activeKey)
        refreshTerms(preserveDrafts: false)
    }

    func receive(_ snapshot: VoiceVocabularySnapshot, sent: [VoiceVocabularyChange] = [], results: [[String: Any]] = []) {
        for result in results where result["status"] as? String == "applied" {
            guard let original = sent.first(where: { $0.changeId == result["changeId"] as? String }),
                  let id = UUID(uuidString: original.id), draftBaseRevisions[id] == original.baseRevision,
                  let entry = snapshot.entries.first(where: { $0.id == original.id }), !entry.deleted else { continue }
            draftBaseRevisions[id] = entry.revision
        }
        syncState.receive(snapshot, sent: sent, results: results)
        refreshTerms()
    }

    func reject(_ changes: [VoiceVocabularyChange]) {
        for c in changes where syncState.pending.contains(where: { $0.changeId == c.changeId }) {
            syncState.blocked[c.changeId] = "invalid"
        }
        persist()
    }

    func retrySync() {
        syncState.retryBlocked()
        draftBaseRevisions.removeAll()
        refreshTerms()
        onChange?()
    }
    func useSyncedWords() {
        let rejectedIDs = Set(syncState.pending.filter { syncState.blocked[$0.changeId] != nil }.map(\.id))
        applyingRemote = true
        terms.removeAll { rejectedIDs.contains($0.id.uuidString.lowercased()) }
        applyingRemote = false
        syncState.discardBlocked()
        refreshTerms()
        onChange?()
    }

    private func refreshTerms(preserveDrafts: Bool = true) {
        let drafts = preserveDrafts ? terms.filter { term in
            // Preserve raw input too: an acknowledgement must not erase a
            // comma/space the Mac user just typed to start the next alias.
            term.line == nil || term.problem != nil ||
            (savedTerms.first { $0.id == term.id }.map { $0.term != term.term || $0.heardAs != term.heardAs } ?? false)
        } : []
        let draftIDs = Set(drafts.map(\.id))
        draftBaseRevisions = draftBaseRevisions.filter { draftIDs.contains($0.key) }
        var values = syncState.terms
        for draft in drafts {
            if let index = values.firstIndex(where: { $0.id == draft.id }) { values[index] = draft }
            else { values.append(draft) }
        }
        applyingRemote = true
        terms = values
        applyingRemote = false
        savedTerms = syncState.terms
        persist()
    }

    private func persist() {
        if let accountKey, let data = try? JSONEncoder().encode(syncState) { defaults.set(data, forKey: accountKey) }
        defaults.set(VoiceVocabulary.text(from: savedTerms), forKey: VoiceVocabulary.storageKey)
    }

    var savedCount: Int { terms.filter { $0.line != nil }.count }
    var isFull: Bool { terms.count >= VoiceVocabulary.maxEntries }

    /// A term already in the list, other than `id` (case-insensitive).
    func isDuplicate(_ term: String, excluding id: UUID?) -> Bool {
        let key = term.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !key.isEmpty && terms.contains { $0.id != id && $0.cleanTerm.lowercased() == key }
    }

    func upsert(_ term: VoiceTerm, baseRevision: Int? = nil) {
        guard canEdit else { return }
        if let baseRevision { draftBaseRevisions[term.id] = baseRevision }
        if let i = terms.firstIndex(where: { $0.id == term.id }) { terms[i] = term } else if !isFull { terms.append(term) }
    }

    func revision(for id: UUID) -> Int {
        let key = id.uuidString.lowercased()
        return syncState.pending.first { $0.id == key }?.baseRevision ?? syncState.snapshot.entries.first { $0.id == key }?.revision ?? 0
    }

    func remove(_ id: UUID, baseRevision: Int? = nil) {
        guard canEdit else { return }
        if let baseRevision { draftBaseRevisions[id] = baseRevision }
        terms.removeAll { $0.id == id }
    }

    private func save() {
        guard canEdit else {
            applyingRemote = true
            terms = savedTerms
            applyingRemote = false
            return
        }
        var seen = Set<String>()
        let unique = terms.filter { $0.line != nil && $0.problem == nil && seen.insert($0.cleanTerm.lowercased()).inserted }
        if accountKey != nil {
            let visibleIDs = Set(terms.map(\.id))
            for term in terms where draftBaseRevisions[term.id] == nil {
                if let old = savedTerms.first(where: { $0.id == term.id }), old.term != term.term || old.heardAs != term.heardAs {
                    draftBaseRevisions[term.id] = revision(for: term.id)
                }
            }
            for old in savedTerms where !visibleIDs.contains(old.id) { syncState.stage(old, deleting: true, baseRevision: draftBaseRevisions[old.id]) }
            for term in unique {
                let old = savedTerms.first { $0.id == term.id }
                if old?.line != term.line { syncState.stage(term, baseRevision: draftBaseRevisions[term.id]) }
            }
            savedTerms = syncState.terms
            draftBaseRevisions = draftBaseRevisions.filter { id, _ in
                guard let raw = terms.first(where: { $0.id == id }), let saved = savedTerms.first(where: { $0.id == id }) else { return false }
                return raw.term != saved.term || raw.heardAs != saved.heardAs
            }
            persist()
            onChange?()
        } else {
            savedTerms = unique
            defaults.set(VoiceVocabulary.text(from: unique), forKey: VoiceVocabulary.storageKey)
        }
    }
}

enum VoiceVocabularyCopy {
    static let title = "Custom Words"
    static let explanation = "Help voice input get your names and terms right, like product names, people or tech jargon. Synced through your Kraki account and stored on the server; not end-to-end encrypted."
    static let emptyTitle = "No custom words yet"
    static let recognizedAs = "Often recognized as"
    static let recognizedAsFooter = "Optional. How voice input tends to get it wrong, separated by commas. Similar spellings are caught too."
    static let termFooter = "Spelled exactly as it should appear."
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
            VoiceVocabularySyncSection(store: store)
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
                        ids.forEach { store.remove($0) }
                    }
                    if !store.isFull {
                        Button { add() } label: { Label("Add Word", systemImage: "plus") }
                    }
                } footer: {
                    Text(VoiceVocabularyCopy.explanation + " \(store.savedCount) of \(VoiceVocabulary.maxEntries).")
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
    @State private var baseRevision: Int?

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
                        Button("Delete Word", role: .destructive) { store.remove(term.id, baseRevision: baseRevision); dismiss() }
                    }
                }
            }
            .navigationTitle(isNew ? "Add Word" : "Edit Word")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: dismiss) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isNew ? "Add" : "Save") { store.upsert(term, baseRevision: baseRevision); dismiss() }.disabled(!canSave)
                }
            }
            .onAppear {
                if baseRevision == nil { baseRevision = store.revision(for: term.id) }
                if isNew { focus = true }
            }
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
        VoiceVocabularySyncSection(store: store)
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
            Text(VoiceVocabularyCopy.explanation)
                .font(.footnote).foregroundStyle(.secondary)
        }
        .disabled(!store.canEdit)
    }
}
#endif

private struct VoiceVocabularySyncSection: View {
    let store: VoiceVocabularyStore
    var body: some View {
        Section {
            Text(store.syncStatus).font(.footnote).foregroundStyle(.secondary)
            if store.hasSyncProblems {
                Button("Retry My Changes") { store.retrySync() }
                Button("Use Synced Words") { store.useSyncedWords() }
            }
        }
    }
}

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

