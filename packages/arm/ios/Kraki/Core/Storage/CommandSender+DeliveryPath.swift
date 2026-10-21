import Foundation

extension CommandSender {
    /// Whether an input for `sessionId` can reach its Tentacle now: signed in
    /// and the session's Tentacle online.
    func isDeliveryPathUp(_ sessionId: String) -> Bool {
        guard let appState else { return false }
        #if DEBUG
        if appState.testOutboundMessageHandler != nil { return true }
        #endif
        guard appState.isFullyOnline,
              let deviceId = appState.sessionStore.sessions[sessionId]?.deviceId else { return false }
        return appState.deviceStore.devices[deviceId]?.online == true
    }

    /// `send.summary.offline` only (delivery itself keeps `isDeliveryPathUp`):
    /// a new-session placeholder counts as up when its target Tentacle is.
    func isMetricsPathUp(_ sessionId: String) -> Bool {
        if isDeliveryPathUp(sessionId) { return true }
        guard let appState, appState.isFullyOnline, let target = pendingPlaceholderTargets[sessionId] else { return false }
        return appState.deviceStore.devices[target]?.online == true
    }
}
