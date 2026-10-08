#if os(iOS) || os(macOS)
import Foundation
import Observation

/// What the voice composer needs from the app: drafts, the shared speech
/// controller, and the optimistic outbox used for a sent voice message.
protocol IOSVoiceComposerHost: AnyObject {
    var sessionStore: SessionStore { get }
    var voiceInputController: KrakiVoiceInputController { get }
    func stageVoiceInput(sessionID: String, text: String, attachments: [ImageAttachment]?,
                         delivery: CommandSender.InputDelivery, answerTo: String?) -> String?
    func updateVoiceInput(sessionID: String, clientID: String, text: String, original: String, uncorrected: NSRange?)
    func dispatchVoiceInput(sessionID: String, clientID: String, text: String) -> Bool
    func failVoiceInput(sessionID: String, clientID: String, text: String)
    func discardVoiceInput(sessionID: String, clientID: String)
}

/// Shared iOS/macOS tap-to-dictate transaction (historical iOS name),
/// owned by AppState (independent of any SwiftUI
/// composer's lifetime).
///
/// - Recording: the composer shows a read-only preview; the draft is untouched,
///   so Cancel needs no restore.
/// - Text (✓): the raw utterance is inserted into the real draft at the caret;
///   the correction later replaces only that utterance unless the user edited.
/// - Send (↑): the whole message is staged as a bubble at once; it is only
///   transmitted when the correction completes, so the agent always gets
///   corrected text. An unconfirmed correction is never sent automatically.
@Observable final class IOSVoiceComposer {
    enum Phase: Equatable {
        case recording
        case toDraft
        case staged(clientID: String)
    }
    struct Operation {
        let id: UUID
        let sessionID: String
        let base: String
        let range: NSRange
        let startedAt: Date
        var revision: UInt64
        var expectedDraft: String
        var raw = ""
        var phase: Phase = .recording
        var dirty = false
        var committed = false
        var focusEditor = true
        var hasAttachment = false
        /// Characters of the raw utterance already covered by the streamed
        /// correction (monotonic, so the bubble never jumps backwards).
        var correctedRawPrefix = 0
        var correctedText = ""
        var uncorrectedDraftRange: NSRange?
        var delivery: CommandSender.InputDelivery = .prompt
    }

    private weak var host: IOSVoiceComposerHost?
    private(set) var operation: Operation?
    private(set) var editorRequest: UUID?
    private(set) var editorSessionID: String?
    private(set) var selectionRequest: NSRange?
    /// A staged prompt was transmitted (composer latches "awaiting active").
    private(set) var dispatchedSessionID: String?
    private(set) var dispatchSignal = UUID()
    private var startTask: Task<Void, Never>?

    init(host: IOSVoiceComposerHost) { self.host = host }

    /// Draft owner for the Mac new-session composer: there is no Session yet,
    /// so its text lives under this reserved key in `SessionStore.drafts`.
    /// It only supports Edit (✓); a send waits for the correction and then
    /// creates the Session (no staged bubble without a Session).
    static let newSessionDraftID = "kraki.new-session-draft"

    private func ownsDraft(_ store: SessionStore, _ id: String) -> Bool {
        store.sessions[id] != nil || id == Self.newSessionDraftID
    }

    var sessionID: String? { operation?.sessionID }
    var isRecording: Bool { operation?.phase == .recording }
    func isRecording(in sessionID: String) -> Bool { isRecording && operation?.sessionID == sessionID }
    /// Speech is still finishing for this session (after ✓ or ↑).
    func isFinishing(in sessionID: String) -> Bool {
        guard let operation, operation.sessionID == sessionID else { return false }
        return operation.phase != .recording
    }
    /// Presentation only: never persist correction styling into the draft.
    /// Revision checks also remove the tint for edits made outside this view.
    func uncorrectedRange(in sessionID: String) -> NSRange? {
        guard let op = operation, op.sessionID == sessionID, op.phase == .toDraft,
              op.focusEditor, !op.dirty, matches(op) else { return nil }
        return op.uncorrectedDraftRange
    }

    var rawText: String { operation?.raw ?? "" }
    var recordingStartedAt: Date? { operation?.startedAt }

    /// The draft as it will read with the utterance inserted, split so the
    /// live (not yet editable) part can be styled.
    var preview: (prefix: String, spoken: String, suffix: String) {
        guard let op = operation else { return ("", "", "") }
        let range = Self.safeRange(op.range, in: op.base)
        let base = op.base as NSString
        let prefix = base.substring(to: range.location)
        let suffix = base.substring(from: range.location + range.length)
        let full = Self.insert(op.raw, into: op.base, range: op.range).0 as NSString
        let spokenLength = full.length - (prefix as NSString).length - (suffix as NSString).length
        let spoken = spokenLength > 0 ? full.substring(with: NSRange(location: (prefix as NSString).length, length: spokenLength)) : ""
        return (prefix, spoken, suffix)
    }

    /// SwiftUI may publish a selection BEFORE the corresponding text binding.
    /// Never feed those transient foreign/out-of-bounds indices to NSRange(_:in:)
    /// (it traps). Resolve only boundaries actually belonging to this snapshot.
    static func selectionRange(_ range: Range<String.Index>, in text: String) -> NSRange? {
        let boundaries = Array(text.indices) + [text.endIndex]
        guard let lower = boundaries.first(where: { $0 == range.lowerBound }),
              let upper = boundaries.first(where: { $0 == range.upperBound }) else { return nil }
        let start = lower.utf16Offset(in: text), end = upper.utf16Offset(in: text)
        guard end >= start else { return nil }
        return NSRange(location: start, length: end - start)
    }
    static func safeRange(_ range: NSRange?, in text: String) -> NSRange {
        let end = text.utf16.count
        guard let range, range.location != NSNotFound, range.location <= end,
              range.length <= end - range.location else { return NSRange(location: end, length: 0) }
        var boundaries = Set(text.indices.map { $0.utf16Offset(in: text) })
        boundaries.insert(end)
        guard boundaries.contains(range.location), boundaries.contains(range.location + range.length) else {
            return NSRange(location: end, length: 0)
        }
        return range
    }
    static func insert(_ text: String, into base: String, range: NSRange) -> (String, NSRange) {
        let range = safeRange(range, in: base)
        guard !text.isEmpty else {
            return ((base as NSString).replacingCharacters(in: range, with: text), NSRange(location: range.location, length: 0))
        }
        let ns = base as NSString
        let before = ns.substring(to: range.location), after = ns.substring(from: range.location + range.length)
        // Latin-script neighbours need a word separator; CJK, whitespace and
        // punctuation boundaries do not ("Hello" + "world" -> "Hello world",
        // "before" + "spoken" -> "beforespoken" in CJK). The caret lands after the spoken text.
        let leading = needsSeparator(before.last, text.first) ? " " : ""
        let trailing = needsSeparator(text.last, after.first) ? " " : ""
        let replacement = leading + text + trailing
        return (ns.replacingCharacters(in: range, with: replacement),
                NSRange(location: range.location + (leading + text).utf16.count, length: 0))
    }
    static func needsSeparator(_ left: Character?, _ right: Character?) -> Bool {
        guard let left, let right, !left.isWhitespace, !right.isWhitespace,
              !isCJK(left), !isCJK(right) else { return false }
        if "([{<“‘/-".contains(left) { return false }
        if ".,!?;:)]}>%”’/-…".contains(right) { return false }
        return true
    }
    private static func isCJK(_ character: Character) -> Bool {
        guard let v = character.unicodeScalars.first?.value else { return false }
        switch v {
        case 0x1100...0x11FF, 0x2E80...0x2FFF, 0x3000...0x303F, 0x3040...0x30FF, 0x3100...0x31FF,
             0x3130...0x318F, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF, 0xF900...0xFAFF,
             0xFE30...0xFE4F, 0xFF00...0xFFEF, 0x20000...0x2FA1F:
            return true
        default:
            return false
        }
    }

    // MARK: - Recording

    func begin(sessionID: String, selection: NSRange?, context: VoiceSessionContext) {
        guard let host, ownsDraft(host.sessionStore, sessionID), !isRecording else { return }
        // A newer utterance supersedes one still correcting into the draft;
        // its visible text is kept. A staged send is left to finish.
        if operation?.phase == .toDraft { retireKeepingDraft() }
        guard operation == nil, !host.voiceInputController.isBusy else { return }
        let store = host.sessionStore
        let base = store.drafts[sessionID] ?? ""
        let id = UUID()
        operation = Operation(id: id, sessionID: sessionID, base: base,
                              range: Self.safeRange(selection, in: base), startedAt: Date(),
                              revision: store.draftRevisions[sessionID] ?? 0, expectedDraft: base)
        editorRequest = nil
        selectionRequest = nil
        startTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled, self.operation?.id == id, self.isRecording,
                  let host = self.host else { return }
            await host.voiceInputController.begin(
                sessionID: sessionID, context: context,
                onRaw: { [weak self] text in self?.receive(text, id: id) },
                onCorrection: { [weak self] text in self?.corrected(text, id: id) },
                onCompletion: { [weak self] result in self?.complete(result, id: id) },
                onFinal: { _ in })
        }
    }

    /// ✕ — drop this utterance. The draft was never touched while recording.
    func cancel() {
        guard let op = operation, op.phase == .recording else { return }
        discard()
    }

    /// ✓ — put the utterance into the real editor and keep editing there.
    func finishToDraft(focusEditor: Bool = true) {
        guard var op = operation, op.phase == .recording else { return }
        op.phase = .toDraft
        op.focusEditor = focusEditor
        operation = op
        updateDraftCorrection()
        if focusEditor { requestEditor(op.sessionID) }
        finishSpeech(op)
    }

    /// ↑ — send the whole message; it is transmitted after correction.
    @discardableResult
    func send(attachments: [ImageAttachment]?, delivery: CommandSender.InputDelivery,
              answerTo: String? = nil) -> Bool {
        guard var op = operation, op.phase == .recording, let host else { return false }
        let text = Self.insert(op.raw, into: op.base, range: op.range).0
        guard let clientID = host.stageVoiceInput(sessionID: op.sessionID, text: text.isEmpty ? "…" : text,
                                                  attachments: attachments, delivery: delivery,
                                                  answerTo: answerTo) else { return false }
        if text.isEmpty {
            host.updateVoiceInput(sessionID: op.sessionID, clientID: clientID, text: "…", original: "", uncorrected: nil)
        } else {
            // Nothing is corrected yet: the whole utterance starts light.
            let (full, uncorrected) = Self.staged(corrected: "", raw: op.raw, covered: 0, base: op.base, range: op.range)
            host.updateVoiceInput(sessionID: op.sessionID, clientID: clientID, text: full, original: full, uncorrected: uncorrected)
        }
        op.phase = .staged(clientID: clientID)
        op.hasAttachment = attachments?.isEmpty == false
        op.delivery = delivery
        operation = op
        // The composer is free for the next message immediately.
        host.sessionStore.setDraft(op.sessionID, "")
        finishSpeech(op)
        return true
    }

    private func finishSpeech(_ op: Operation) {
        guard let host else { return }
        let speech = host.voiceInputController
        if speech.activeSessionID == op.sessionID, speech.isRecording {
            speech.finish()
        } else {
            // Permission / lease still pending: never open the mic afterwards.
            startTask?.cancel()
            if speech.activeSessionID == op.sessionID { speech.cancel() }
            complete(VoiceInputCompletion(text: op.raw, rawText: op.raw, completed: false), id: op.id)
        }
    }

    // MARK: - Speech events

    func receive(_ text: String, id: UUID) {
        guard var op = operation, op.id == id else { return }
        op.raw = text
        operation = op
        switch op.phase {
        case .recording: break
        case .toDraft: updateDraftCorrection()
        case .staged(let clientID):
            let (full, uncorrected) = Self.staged(corrected: "", raw: text, covered: 0, base: op.base, range: op.range)
            host?.updateVoiceInput(sessionID: op.sessionID, clientID: clientID, text: full, original: full,
                                   uncorrected: uncorrected)
        }
    }

    /// Correct in place, retaining the raw tail. Edit opts the real draft into
    /// the same progressive presentation, but only until the user takes over.
    /// Departure without Edit keeps its existing final-only behavior.
    func corrected(_ text: String, id: UUID) {
        guard var op = operation, op.id == id, op.phase != .recording else { return }
        if op.phase == .toDraft && (!op.focusEditor || op.dirty || !matches(op)) { return }
        op.correctedText = text
        op.correctedRawPrefix = max(op.correctedRawPrefix,
                                    KrakiVoiceInputController.alignedRawPrefixLength(corrected: text, raw: op.raw))
        operation = op
        switch op.phase {
        case .toDraft:
            updateDraftCorrection()
        case .staged(let clientID):
            let (full, uncorrected) = Self.staged(corrected: text, raw: op.raw, covered: op.correctedRawPrefix,
                                                  base: op.base, range: op.range)
            host?.updateVoiceInput(sessionID: op.sessionID, clientID: clientID, text: full,
                                   original: Self.insert(op.raw, into: op.base, range: op.range).0,
                                   uncorrected: uncorrected)
        case .recording: break
        }
    }

    private func updateDraftCorrection() {
        guard let op = operation, op.phase == .toDraft else { return }
        let spoken = Self.overlay(corrected: op.correctedText, onto: op.raw, coveredPrefix: op.correctedRawPrefix)
        let (_, pending) = Self.staged(corrected: op.correctedText, raw: op.raw, covered: op.correctedRawPrefix,
                                       base: op.base, range: op.range)
        commit(spoken, uncorrected: op.focusEditor ? pending : nil)
    }

    /// Bubble text while correcting, and the UTF-16 range of the part the
    /// correction has not reached yet (the tail of the utterance).
    static func staged(corrected: String, raw: String, covered: Int, base: String, range: NSRange) -> (String, NSRange?) {
        let spoken = overlay(corrected: corrected, onto: raw, coveredPrefix: covered)
        let rest = String(raw.dropFirst(min(max(0, covered), raw.count)))
        let (full, caret) = insert(spoken, into: base, range: range)
        let length = rest.utf16.count
        guard length > 0, caret.location >= length else { return (full, nil) }
        return (full, NSRange(location: caret.location - length, length: length))
    }

    /// `corrected` followed by the part of `raw` it does not cover yet.
    static func overlay(corrected: String, onto raw: String, coveredPrefix: Int) -> String {
        let rest = String(raw.dropFirst(min(max(0, coveredPrefix), raw.count)))
        guard !rest.isEmpty else { return corrected }
        let needsSpace = needsSeparator(corrected.last, rest.first)
        return corrected + (needsSpace ? " " : "") + rest
    }

    func complete(_ result: VoiceInputCompletion, id: UUID) {
        guard let op = operation, op.id == id, let host else { return }
        startTask?.cancel(); startTask = nil
        let raw = result.rawText.isEmpty ? op.raw : result.rawText
        let final = result.text.isEmpty ? raw : result.text
        switch op.phase {
        case .recording, .toDraft:
            // An unexpected terminal while still recording (failure, departure)
            // keeps what was heard as a draft; it is never sent.
            commit(final)
            operation = nil
        case .staged(let clientID):
            operation = nil
            let sessionID = op.sessionID
            let spoke = !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let corrected = Self.insert(final, into: op.base, range: op.range).0
            let original = Self.insert(raw, into: op.base, range: op.range).0
            if result.completed && spoke {
                dispatch(sessionID, clientID, corrected, op.delivery)
            } else if !spoke {
                // Nothing was said: send what the user had already written or
                // attached, otherwise there is nothing to send.
                if !op.base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    dispatch(sessionID, clientID, op.base, op.delivery)
                } else if op.hasAttachment {
                    dispatch(sessionID, clientID, "[image]", op.delivery)
                } else {
                    host.discardVoiceInput(sessionID: sessionID, clientID: clientID)
                }
            } else if !op.hasAttachment {
                // No usable final transcript (recognition was cut off, e.g.
                // the upload stalled): the words heard are probably only the
                // first part. Never leave them as a "not delivered" bubble that
                // looks like a network send failure: take the message back and
                // put it in the box to finish and send. A failed *correction*
                // still completes with the raw transcript and is sent above.
                host.discardVoiceInput(sessionID: sessionID, clientID: clientID)
                let store = host.sessionStore
                let draft = store.drafts[sessionID] ?? ""
                let restored = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? original : original + "\n" + draft
                store.setDraft(sessionID, restored)
                host.voiceInputController.appendFailureDetail(Self.returnedToDraftDetail, for: sessionID)
            } else {
                // Images cannot go back into the box: keep the message as not
                // sent (Retry sends what was heard, or Delete).
                host.failVoiceInput(sessionID: sessionID, clientID: clientID, text: original)
                host.voiceInputController.appendFailureDetail(Self.keptUnsentDetail, for: sessionID)
            }
        }
    }

    static let returnedToDraftDetail = "Nothing was sent; the text so far is back in the box."
    static let keptUnsentDetail = "Not sent. Tap the message to retry or delete it."

    private func dispatch(_ sessionID: String, _ clientID: String, _ text: String, _ delivery: CommandSender.InputDelivery) {
        guard host?.dispatchVoiceInput(sessionID: sessionID, clientID: clientID, text: text) == true else { return }
        if delivery == .prompt { dispatchedSessionID = sessionID; dispatchSignal = UUID() }
    }

    // MARK: - Draft ownership (✓ path)

    private func matches(_ op: Operation) -> Bool {
        guard let store = host?.sessionStore, ownsDraft(store, op.sessionID) else { return false }
        return (store.draftRevisions[op.sessionID] ?? 0) == op.revision && (store.drafts[op.sessionID] ?? "") == op.expectedDraft
    }
    /// Write the utterance into the draft unless the user has taken over.
    private func commit(_ text: String, uncorrected: NSRange? = nil) {
        guard var op = operation, let store = host?.sessionStore else { return }
        guard !op.dirty, matches(op) else { op.dirty = true; operation = op; return }
        // No text received means no replacement of a selected range.
        guard !text.isEmpty else { return }
        let (updated, caret) = Self.insert(text, into: op.base, range: op.range)
        if updated != op.expectedDraft { store.setDraft(op.sessionID, updated) }
        op.expectedDraft = updated
        op.revision = store.draftRevisions[op.sessionID] ?? 0
        op.committed = true
        op.uncorrectedDraftRange = uncorrected
        operation = op
        selectionRequest = caret
    }
    /// Typing, caret moves or focus by the user: a late correction must not
    /// overwrite their draft.
    func takeOver(sessionID: String) {
        guard var op = operation, op.sessionID == sessionID, op.phase == .toDraft else { return }
        op.dirty = true
        operation = op
        // A queued native update must not restore an old automatic caret after
        // a real selection / IME / typing event has claimed this draft.
        selectionRequest = nil
    }
    private func requestEditor(_ sessionID: String) {
        editorSessionID = sessionID
        editorRequest = UUID()
    }

    // MARK: - Lifecycle

    /// Leaving the conversation / app inactive: an in-progress recording
    /// becomes a draft (never sent); anything already finishing continues at
    /// its original owner.
    func depart(sessionID: String) {
        guard operation?.sessionID == sessionID, isRecording else { return }
        finishToDraft(focusEditor: false)
    }
    /// Logout: drop everything.
    func discard() {
        guard let op = operation else { return }
        startTask?.cancel(); startTask = nil
        operation = nil
        if host?.voiceInputController.activeSessionID == op.sessionID { host?.voiceInputController.cancel() }
    }
    /// Background / manual submit / superseded: stop now, keep everything
    /// heard. A staged message that can no longer be corrected is kept as
    /// not-sent with its original transcript.
    func retireKeepingDraft() {
        guard let op = operation, let host else { return }
        switch op.phase {
        case .recording: commit(op.raw)
        case .toDraft: break // Keep the visible progressive correction, not the old raw text.
        case .staged(let clientID):
            let original = Self.insert(op.raw, into: op.base, range: op.range).0
            if op.raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !op.hasAttachment
                && op.base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                host.discardVoiceInput(sessionID: op.sessionID, clientID: clientID)
            } else {
                host.failVoiceInput(sessionID: op.sessionID, clientID: clientID, text: original.isEmpty ? "[image]" : original)
            }
        }
        operation = nil
        startTask?.cancel(); startTask = nil
        if host.voiceInputController.activeSessionID == op.sessionID { host.voiceInputController.cancel() }
    }
}

extension AppState: IOSVoiceComposerHost {
    func stageVoiceInput(sessionID: String, text: String, attachments: [ImageAttachment]?,
                         delivery: CommandSender.InputDelivery, answerTo: String?) -> String? {
        commandSender?.stageInput(sessionId: sessionID, text: text, attachments: attachments,
                                  delivery: delivery, answerTo: answerTo)
    }
    func updateVoiceInput(sessionID: String, clientID: String, text: String, original: String, uncorrected: NSRange?) {
        commandSender?.updateStagedInput(sessionId: sessionID, clientId: clientID, text: text, original: original,
                                         uncorrected: uncorrected)
    }
    func dispatchVoiceInput(sessionID: String, clientID: String, text: String) -> Bool {
        commandSender?.dispatchStagedInput(sessionId: sessionID, clientId: clientID, text: text) == true
    }
    func failVoiceInput(sessionID: String, clientID: String, text: String) {
        commandSender?.failStagedInput(sessionId: sessionID, clientId: clientID, text: text)
    }
    func discardVoiceInput(sessionID: String, clientID: String) {
        guard commandSender?.isStaged(sessionId: sessionID, clientId: clientID) == true else { return }
        commandSender?.discardPending(sessionId: sessionID, clientId: clientID)
    }
}
#endif
