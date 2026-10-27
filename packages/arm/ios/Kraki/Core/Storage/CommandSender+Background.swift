import Foundation

extension CommandSender {
    /// Inputs on their way to a reachable Tentacle whose echo has not arrived
    /// yet: leaving the app now would strand them until the next foreground
    /// (diag 10-18/10-20: 35 s and 82 s). See `BackgroundSocketGrace`.
    var hasSendsAwaitingEcho: Bool {
        outbox.contains { sessionId, bucket in
            bucket.values.contains { pendingState($0) == .sending } && isDeliveryPathUp(sessionId)
        }
    }
}
