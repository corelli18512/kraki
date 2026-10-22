import Foundation

extension CommandSender {
    /// `send`, plus the Relay Pulse connection generation it went over: nil
    /// when it went another way (the local link) or Pulse was not connected.
    /// send.summary `uploadMs` is measured on that connection only.
    func sendNotingPulse(_ message: [String: Any], sessionId: String) -> (handedOff: Bool, pulseGeneration: Int?) {
        let pulse = appState?.pulseManager
        let handoffsBefore = pulse?.payloadsHandedOff
        let handedOff = send(message, sessionId: sessionId)
        let overPulse = handedOff && pulse != nil && pulse?.payloadsHandedOff != handoffsBefore
        return (handedOff, overPulse ? pulse?.liveGeneration : nil)
    }

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
