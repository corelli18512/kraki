/// When the composer's local Send/Stop latches end (iOS and Mac composers).

import SwiftUI

extension View {
    /// `awaitingActive` (a sent prompt waits for its turn to start) ends at the
    /// first session-state transition: once active, later submissions are
    /// steers; once idle, normal prompts. `abortPending` (Stop sent) ends when
    /// the session goes idle or the app goes offline. Both also end when the
    /// session's newest message is an `error`: a rejected Stop or an input the
    /// computer could not deliver leaves the state unchanged, and the composer
    /// must not stay busy or keep Stop disabled.
    func settlesComposerLatches(sessionId: String, state: SessionState?,
                                awaitingActive: Binding<Bool>, abortPending: Binding<Bool>) -> some View {
        modifier(ComposerLatchSettling(sessionId: sessionId, state: state,
                                       awaitingActive: awaitingActive, abortPending: abortPending))
    }
}

private struct ComposerLatchSettling: ViewModifier {
    @Environment(AppState.self) private var appState
    let sessionId: String
    let state: SessionState?
    @Binding var awaitingActive: Bool
    @Binding var abortPending: Bool

    /// Seq of the session's newest message when that message is an `error`.
    private var trailingErrorSeq: Int? {
        guard let last = appState.messageStore.messages[sessionId]?.last, last.type == "error" else { return nil }
        return last.seq
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: state) { _, newState in
                awaitingActive = false
                if newState == .idle { abortPending = false }
            }
            .onChange(of: appState.isFullyOnline) { _, online in
                if !online { abortPending = false }
            }
            .onChange(of: trailingErrorSeq) { _, seq in
                guard seq != nil else { return }
                awaitingActive = false
                abortPending = false
            }
    }
}
