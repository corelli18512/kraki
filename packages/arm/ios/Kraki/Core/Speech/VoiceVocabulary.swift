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
    static let explanation = "Names and jargon voice input may not know: products, people, tools. Optionally add a few ways it might come out as examples. They are hints, not find-and-replace: your voice messages are corrected in context, similar sounds are caught too, and ordinary words that sound the same are left alone. Kept on this device."
    static let emptyTitle = "No terms yet"
    static let soundsLike = "Sounds like (examples)"
    static let soundsLikeFooter = "Optional. A few ways voice input might write it, separated by commas. Used as hints: similar sounds are recognized too, and ordinary words that sound the same are left alone."
    static let termFooter = "Spelled exactly as it should appear."
}

#if os(iOS)
/// Settings → Voice Vocabulary.
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
                            HStack(spacing: 6) { Image(systemName: "plus"); Text("Add Term") }
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
                        Button { add() } label: { Label("Add Term", systemImage: "plus") }
                    }
                } footer: {
                    Text(VoiceVocabularyCopy.explanation + " \(store.savedCount) of \(VoiceVocabulary.maxEntries).")
                }
            }
        }
        .navigationTitle("Voice Vocabulary")
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
                Text("Sounds like " + term.heardList.joined(separator: ", "))
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
                } header: { Text("Term") } footer: {
                    if duplicate { Text("Already in your vocabulary.").foregroundStyle(.orange) }
                    else { Text(VoiceVocabularyCopy.termFooter) }
                }
                Section {
                    TextField("e.g. 破四格, post gress", text: $term.heardAs, axis: .vertical)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: { Text(VoiceVocabularyCopy.soundsLike) } footer: {
                    Text(VoiceVocabularyCopy.soundsLikeFooter)
                }
                if !isNew {
                    Section {
                        Button("Delete Term", role: .destructive) { store.remove(term.id); dismiss() }
                    }
                }
            }
            .navigationTitle(isNew ? "Add Term" : "Edit Term")
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
/// Settings → General → Voice Vocabulary: one editable row per word.
struct VoiceVocabularyMacSection: View {
    @State private var store = VoiceVocabularyStore()
    @FocusState private var focused: UUID?

    var body: some View {
        Section {
            if store.terms.isEmpty {
                Text("No terms yet. Add names and jargon that voice input may not know.")
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    Text("Term").frame(width: 180, alignment: .leading)
                    Text(VoiceVocabularyCopy.soundsLike)
                    Spacer()
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            ForEach($store.terms) { $term in
                HStack(spacing: 10) {
                    TextField("Term", text: $term.term, prompt: Text("e.g. PostgreSQL"))
                        .labelsHidden()
                        .multilineTextAlignment(.leading)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 180)
                        .focused($focused, equals: term.id)
                    TextField(VoiceVocabularyCopy.soundsLike, text: $term.heardAs,
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
                } label: { Label("Add Term", systemImage: "plus") }
                .disabled(store.isFull)
                Spacer()
                Text("\(store.savedCount) / \(VoiceVocabulary.maxEntries)")
                    .monospacedDigit().font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Voice Vocabulary")
        } footer: {
            Text(VoiceVocabularyCopy.explanation)
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
#endif
