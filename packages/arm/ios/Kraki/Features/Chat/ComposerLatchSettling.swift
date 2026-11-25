/// When the composer's local Send/Stop latches end (iOS and Mac composers).

import SwiftUI

extension View {
    /// `awaitingActive` (a sent prompt waits for its turn to start) ends at the
    /// first session-state transition: once active, later submissions are
    /// steers; once idle, normal prompts. It also ends when that prompt is not
    /// on its way to start a turn: queued for an offline computer, or
    /// unconfirmed / failed (no state change would ever end it, and the idle
    /// session's next message must be a prompt, not a steer). Once the prompt
    /// is echoed the latch holds until the turn starts. `abortPending` (Stop sent) ends when
    /// the session goes idle, the app goes offline or (Mac) the local link
    /// that carried the Stop drops. Both also end when the
    /// session's newest message is an `error`: a rejected Stop or an input the
    /// computer could not deliver leaves the state unchanged, and the composer
    /// must not stay busy or keep Stop disabled. `onStopRejected` gets the
    /// text to show when that error is the pending Stop's own failure (the
    /// agent refused to stop; the turn goes on).
    func settlesComposerLatches(sessionId: String, state: SessionState?,
                                awaitingActive: Binding<Bool>, abortPending: Binding<Bool>,
                                onStopRejected: ((String) -> Void)? = nil) -> some View {
        modifier(ComposerLatchSettling(sessionId: sessionId, state: state,
                                       awaitingActive: awaitingActive, abortPending: abortPending,
                                       onStopRejected: onStopRejected))
    }
}

/// What the composer says when the computer could not stop the turn.
enum StopRejectionNotice {
    /// Tentacle's `error` for a failed `abort_session`.
    static let tentaclePrefix = "Failed to abort session: "

    /// `nil` unless the error is the Stop's own failure: any other session
    /// error (a failed steer, an agent API error) may land while Stop is in
    /// flight and says nothing about whether the Stop worked.
    static func text(errorMessage: String) -> String? {
        guard errorMessage.hasPrefix(tentaclePrefix) else { return nil }
        let trimmed = errorMessage.dropFirst(tentaclePrefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "Couldn't stop the agent.") : String(localized: "Couldn't stop: \(trimmed)")
    }
}

private struct ComposerLatchSettling: ViewModifier {
    @Environment(AppState.self) private var appState
    let sessionId: String
    let state: SessionState?
    @Binding var awaitingActive: Bool
    @Binding var abortPending: Bool
    /// Client id of the prompt `awaitingActive` waits for.
    @State private var latchedPromptId: String?
    let onStopRejected: ((String) -> Void)?

    /// Seq of the session's newest message when that message is an `error`.
    private var trailingErrorSeq: Int? {
        guard let last = appState.messageStore.messages[sessionId]?.last, last.type == "error" else { return nil }
        return last.seq
    }

    /// The newest prompt of this session in the outbox: the one just sent.
    private var newestPromptId: String? {
        appState.commandSender?.pendingInputs(sessionId).last {
            $0.payload["delivery"]?.stringValue != "steer" && $0.payload["answerTo"] == nil
        }?.payload["clientId"]?.stringValue
    }

    /// The prompt `id` is still in the outbox but cannot start a turn now.
    private func promptStalled(_ id: String?) -> Bool {
        guard let id, let sender = appState.commandSender,
              let message = sender.outbox[sessionId]?[id] else { return false }
        switch sender.pendingState(message) {
        case .unconfirmed, .failed: return true
        case .sending, .correcting:
            guard let deviceId = appState.sessionStore.sessions[sessionId]?.deviceId else { return false }
            return appState.deviceStore.devices[deviceId]?.online != true
        }
    }

    private var trailingErrorMessage: String {
        appState.messageStore.messages[sessionId]?.last?.payload["message"]?.stringValue ?? ""
    }

    /// Changes when a Stop of this session was lost with the local link.
    private var stopsLostWithLocalLink: Int {
        #if os(macOS)
        appState.stopsLostWithLocalLink[sessionId] ?? 0
        #else
        0
        #endif
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: stopsLostWithLocalLink) { _, _ in abortPending = false }
            .onChange(of: state) { _, newState in
                awaitingActive = false
                if newState == .idle { abortPending = false }
            }
            .onChange(of: appState.isFullyOnline) { _, online in
                if !online { abortPending = false }
            }
            .onChange(of: awaitingActive, initial: true) { _, latched in
                let id = latched ? newestPromptId : nil
                latchedPromptId = id
                if latched, promptStalled(id) { awaitingActive = false }
            }
            .onChange(of: promptStalled(latchedPromptId)) { _, stalled in
                if stalled { awaitingActive = false }
            }
            .onChange(of: trailingErrorSeq) { _, seq in
                guard seq != nil else { return }
                let stopWasPending = abortPending
                awaitingActive = false
                abortPending = false
                if stopWasPending, let notice = StopRejectionNotice.text(errorMessage: trailingErrorMessage) {
                    onStopRejected?(notice)
                }
            }
    }
}
