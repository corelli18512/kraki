import Foundation

/// One `send.summary` per user input, from creation to its end (delivered,
/// deleted, cleared): how long confirmation took and whether the user was ever
/// shown "unconfirmed"/"failed" — and whether that was a false alarm.
/// Metadata only. Main thread only (owned by AppState, fed by CommandSender).
final class SendTracker {
    struct Summary: Equatable {
        enum Kind: String { case typed, voice, answer, steer }
        enum Outcome: String { case delivered, deleted, cleared }
        enum Shown: String { case none, unconfirmed, failed }
        var kind: Kind
        var outcome: Outcome = .delivered
        /// Created → echo confirmed (wall clock; spans an app restart).
        var confirmMs: Double?
        /// Voice: recording done → corrected transcript handed to transport.
        var correctionMs: Double?
        /// The worst state the bubble showed, and for how long in total.
        var shown: Shown = .none
        var shownMs: Double = 0
        /// Why it was marked: stalled (no echo), correction, signed_out, refused.
        var cause: String?
        /// The app was in the background when it was marked failed.
        var failedInBackground = false
        var manualRetries = 0
        var autoResends = 0
        /// Survived an app restart (restored from disk).
        var restored = false
        /// The relay path was down when the user sent it (queued offline).
        var offlineAtSend = false
        var attachments = 0
        var textLength = 0
        /// Shown as a problem, yet delivered without the user retrying.
        var falseAlarm: Bool { shown != .none && outcome == .delivered && manualRetries == 0 }
    }

    var now: () -> Date = Date.init
    var onSummary: ((Summary) -> Void)?
    #if DEBUG
    private(set) var summaries: [Summary] = []
    #endif

    private struct Entry {
        var summary: Summary
        var createdAt: Date
        var shownSince: Date?
    }
    private var entries: [String: Entry] = [:]

    func created(_ clientId: String, kind: Summary.Kind, textLength: Int, attachments: Int, pathUp: Bool) {
        entries[clientId] = Entry(
            summary: Summary(kind: kind, offlineAtSend: !pathUp, attachments: attachments, textLength: textLength),
            createdAt: now()
        )
    }

    /// Restored from the persisted outbox after a relaunch.
    func restored(_ clientId: String, kind: Summary.Kind, createdAt: Date?, failed: Bool) {
        guard entries[clientId] == nil else { return }
        var entry = Entry(summary: Summary(kind: kind, restored: true), createdAt: createdAt ?? now())
        if failed {
            entry.summary.shown = .failed
            entry.shownSince = now()
        }
        entries[clientId] = entry
    }

    /// A staged voice input finished correction and was handed to transport.
    func dispatched(_ clientId: String) {
        guard var entry = entries[clientId], entry.summary.correctionMs == nil else { return }
        entry.summary.correctionMs = now().timeIntervalSince(entry.createdAt) * 1000
        entries[clientId] = entry
    }

    /// The bubble's delivery state changed (sending/unconfirmed/failed/correcting).
    func state(_ clientId: String, _ state: String, cause: String? = nil, inBackground: Bool = false) {
        guard var entry = entries[clientId] else { return }
        let problem: Summary.Shown? = state == "failed" ? .failed : state == "unconfirmed" ? .unconfirmed : nil
        if let problem {
            if entry.shownSince == nil { entry.shownSince = now() }
            if problem == .failed || entry.summary.shown == .none { entry.summary.shown = problem }
            if let cause { entry.summary.cause = cause }
            if problem == .failed { entry.summary.failedInBackground = inBackground }
        } else if let since = entry.shownSince {
            entry.summary.shownMs += now().timeIntervalSince(since) * 1000
            entry.shownSince = nil
        }
        entries[clientId] = entry
    }

    func retried(_ clientId: String, manual: Bool) {
        guard entries[clientId] != nil else { return }
        if manual { entries[clientId]?.summary.manualRetries += 1 } else { entries[clientId]?.summary.autoResends += 1 }
    }

    /// The input left the outbox. Unless marked deleted/cleared, its echo landed.
    func finished(_ clientId: String, _ outcome: Summary.Outcome) {
        guard var entry = entries.removeValue(forKey: clientId) else { return }
        let t = now()
        if let since = entry.shownSince { entry.summary.shownMs += t.timeIntervalSince(since) * 1000 }
        entry.summary.outcome = outcome
        if outcome == .delivered { entry.summary.confirmMs = t.timeIntervalSince(entry.createdAt) * 1000 }
        #if DEBUG
        summaries.append(entry.summary)
        #endif
        onSummary?(entry.summary)
    }

    var inFlight: Int { entries.count }
}

/// One `voice.summary` per recording attempt: where it ended, why it failed
/// (a coarse cause tag, never the message), and how long each step took.
/// Main thread only (owned by KrakiVoiceInputController).
final class VoiceTracker {
    struct Summary: Equatable {
        enum Outcome: String { case final, failed, cancelled, departed, suspended, ended }
        var outcome: Outcome = .ended
        /// The step the attempt ended in: preflight, permission, lease, recording, finishing.
        var stage = "preflight"
        /// Failure class: permission, mic_unavailable, unavailable, offline, quota,
        /// lease_rejected, timeout, network, identity_changed, audio_session, gateway.
        var cause: String?
        /// Press → capturing (permission prompt / lease / connect wait).
        var startMs: Double?
        /// Capturing → released.
        var recordMs: Double?
        /// Released → final transcript (or failure).
        var finalizeMs: Double?
        /// Correction confirmed by the gateway (else the raw text is kept as a draft).
        var correctionConfirmed = false
        /// The user's Correct Transcripts setting for this recording. Off:
        /// `correctionConfirmed` is false by design, not a correction failure.
        var correctionEnabled = true
        var textLength = 0
        /// The broker connection was already warm when the user pressed.
        var warm = false
        var leaseRollovers = 0
    }

    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var onSummary: ((Summary) -> Void)?
    #if DEBUG
    private(set) var summaries: [Summary] = []
    #endif

    private var current: Summary?
    private var began: TimeInterval = 0
    private var recordingAt: TimeInterval?
    private var finishingAt: TimeInterval?
    private var pendingOutcome: Summary.Outcome?

    func begin(warm: Bool, correctionEnabled: Bool = true) {
        current = Summary(correctionEnabled: correctionEnabled, warm: warm)
        began = now()
        recordingAt = nil
        finishingAt = nil
        pendingOutcome = nil
    }

    /// Controller state transitions (tags: idle, requestingPermission,
    /// obtainingLease, recording, finishing, failed).
    func stateChanged(_ state: String) {
        guard current != nil else { return }
        let t = now()
        switch state {
        case "requestingPermission": current?.stage = "permission"
        case "obtainingLease": current?.stage = "lease"
        case "recording":
            current?.stage = "recording"
            if recordingAt == nil {
                recordingAt = t
                current?.startMs = (t - began) * 1000
            }
        case "finishing":
            current?.stage = "finishing"
            finishingAt = t
            if let r = recordingAt { current?.recordMs = (t - r) * 1000 }
        case "failed": end(.failed, at: t)
        case "idle": end(pendingOutcome ?? .ended, at: t)
        default: break
        }
    }

    /// Set right before the controller moves to `.failed`.
    func cause(_ tag: String) { if current != nil { current?.cause = tag } }
    /// Set right before the controller moves to `.idle` for a known reason.
    func outcome(_ outcome: Summary.Outcome, overwrite: Bool = true) {
        guard current != nil, overwrite || pendingOutcome == nil else { return }
        pendingOutcome = outcome
    }
    func rollover() { if current != nil { current?.leaseRollovers += 1 } }
    func finalReceived(textLength: Int, correctionConfirmed: Bool) {
        guard current != nil else { return }
        current?.textLength = textLength
        current?.correctionConfirmed = correctionConfirmed
        pendingOutcome = .final
    }

    private func end(_ outcome: Summary.Outcome, at t: TimeInterval) {
        guard var summary = current else { return }
        current = nil
        summary.outcome = outcome
        if let f = finishingAt { summary.finalizeMs = (t - f) * 1000 }
        else if let r = recordingAt, summary.recordMs == nil { summary.recordMs = (t - r) * 1000 }
        #if DEBUG
        summaries.append(summary)
        #endif
        onSummary?(summary)
    }

    /// Coarse class of a gateway/broker failure reason (never the text itself).
    static func classify(gatewayReason reason: String) -> String {
        let lower = reason.lowercased()
        if lower.contains("permission") { return "permission" }
        if lower.contains("audio input unavailable") { return "mic_unavailable" }
        if lower.contains("audio capture stalled") { return "capture_stalled" }
        if lower.contains("audio input changed") || lower.contains("audio input format") { return "capture_interrupted" }
        if lower.contains("voice upload") { return "upload_stalled" }
        if lower.contains("asr closed without final") || lower.contains("asr_closed_without_final") { return "asr_final_missing" }
        if lower.contains("quota") { return "quota" }
        if lower.contains("lease") || lower.contains("denied") || lower.contains("authorization")
            || lower.contains("signature") || lower.contains("wrong_") { return "lease_rejected" }
        if lower.contains("timed out") || lower.contains("timeout") { return "timeout" }
        if lower.contains("network") || lower.contains("ws ") || lower.contains("socket")
            || lower.contains("connection") { return "network" }
        return "gateway"
    }
}

/// Whether the previous process ended while the app was on screen (a crash,
/// watchdog kill or force quit), reported on the next cold opening.
struct ForegroundExitMarker {
    let defaults: UserDefaults
    private let key = "kraki.stability.foreground"

    /// "clean", "unclean" or "first" (no earlier run recorded). Read once per launch.
    func previousExit() -> String {
        guard let value = defaults.object(forKey: key) as? Bool else { return "first" }
        return value ? "unclean" : "clean"
    }
    func enteredForeground() { defaults.set(true, forKey: key) }
    func leftForeground() { defaults.set(false, forKey: key) }
}
