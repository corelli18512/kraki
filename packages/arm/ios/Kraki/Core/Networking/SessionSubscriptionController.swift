import Foundation

/// Parsed `session_subscription_set` acknowledgement. Kept independent of the
/// wire JSON so the serial assure state machine can be tested without stores.
struct SessionSubscriptionAck {
    let tentacleId: String
    let sessionId: String?
    let accepted: Bool
    let snapshot: [String: Any]?
    let errorMessage: String?
}

protocol SessionSubscriptionHost: AnyObject {
    var subscriptionConnected: Bool { get }
    func resolveTentacle(for sessionId: String) -> String?
    func isTentacleOnline(_ tentacleId: String) -> Bool
    func sendSessionSubscription(to tentacleId: String, sessionId: String?) -> Bool
    func applySessionSubscriptionSnapshot(_ ack: SessionSubscriptionAck)
    func reportSessionSubscriptionError(_ message: String)
}

/// Serial single-session subscription assurance.
///
/// Invariants:
/// - At most one request is in flight.
/// - A post-auth `session_list` from the owning Tentacle is the reconnect barrier.
/// - Same-Tentacle A→B is one atomic replace request.
/// - Cross-Tentacle X→Y confirms X:null before subscribing on Y while X is
///   online; an offline X cannot block Y and is cleaned up when it returns.
/// - Rapid desired changes coalesce to the final value.
/// - Subscriber-only live frames are accepted only for the confirmed session.
final class SessionSubscriptionController {
    private struct InFlight: Equatable {
        let tentacleId: String
        let sessionId: String?
    }

    private weak var host: SessionSubscriptionHost?
    private(set) var desiredSessionId: String?
    private(set) var confirmedSessionId: String?
    private(set) var confirmedTentacleId: String?
    private var inFlight: InFlight?
    private var barriers: Set<String> = []
    private var blockedDesired: String?
    /// A departed peer may still receive an old queued subscribe when it comes
    /// back. Explicitly replace/release it after its fresh session_list barrier.
    private var retiredTentacles: Set<String> = []

    init(host: SessionSubscriptionHost) {
        self.host = host
    }

    var liveReady: Bool {
        desiredSessionId != nil && confirmedSessionId == desiredSessionId
    }

    func setDesired(_ sessionId: String?) {
        if desiredSessionId != sessionId {
            blockedDesired = nil
            // Navigation stops accepting the old session immediately. Keep the
            // old Tentacle authority until its null ACK when crossing devices.
            if confirmedSessionId != sessionId { confirmedSessionId = nil }
        }
        desiredSessionId = sessionId
        drive()
    }

    /// Reset connection-scoped authority but retain the visible page's desired
    /// session so reconnect can reassert it after the new session_list barrier.
    func onDisconnected() {
        if let confirmedTentacleId { retiredTentacles.insert(confirmedTentacleId) }
        if let inFlight { retiredTentacles.insert(inFlight.tentacleId) }
        confirmedSessionId = nil
        confirmedTentacleId = nil
        inFlight = nil
        barriers.removeAll()
        blockedDesired = nil
    }

    func onTentacleUnavailable(_ tentacleId: String) {
        barriers.remove(tentacleId)
        if confirmedTentacleId == tentacleId || inFlight?.tentacleId == tentacleId {
            retiredTentacles.insert(tentacleId)
        }
        if confirmedTentacleId == tentacleId {
            confirmedTentacleId = nil
            confirmedSessionId = nil
        }
        if inFlight?.tentacleId == tentacleId { inFlight = nil }
        if let desiredSessionId, host?.resolveTentacle(for: desiredSessionId) == tentacleId {
            blockedDesired = nil
        }
        drive()
    }

    func onSessionList(tentacleId: String) {
        // Decryption can finish after device_left; such a digest is not proof
        // of a live peer and cannot restore its subscription barrier.
        guard host?.isTentacleOnline(tentacleId) == true else { return }
        barriers.insert(tentacleId)
        if let desiredSessionId,
           host?.resolveTentacle(for: desiredSessionId) == tentacleId {
            blockedDesired = nil
        }
        drive()
    }

    func acceptsLive(_ sessionId: String) -> Bool {
        confirmedSessionId != nil && confirmedSessionId == sessionId
    }

    func onAck(_ ack: SessionSubscriptionAck) {
        KLog.diag("✅ [subscription] ack tentacle=\(ack.tentacleId.prefix(12)) session=\(ack.sessionId?.prefix(12) ?? "nil") accepted=\(ack.accepted) desired=\(desiredSessionId?.prefix(12) ?? "nil")")
        guard let flight = inFlight else { return }
        guard ack.tentacleId == flight.tentacleId else { return }
        guard ack.sessionId == flight.sessionId else { return }

        inFlight = nil
        guard ack.accepted else {
            if flight.sessionId == nil, retiredTentacles.contains(flight.tentacleId) {
                // Do not spin on a rejected best-effort old-peer cleanup. Retry
                // only after another authority barrier, without blocking the
                // already confirmed live subscription on a different peer.
                barriers.remove(flight.tentacleId)
            }
            if flight.sessionId == desiredSessionId {
                blockedDesired = flight.sessionId
                host?.reportSessionSubscriptionError(
                    ack.errorMessage ?? "Cannot open the live session."
                )
            }
            drive()
            return
        }

        retiredTentacles.remove(ack.tentacleId)
        if ack.sessionId == nil {
            // Cleanup of a returned old peer must not clear the current peer's
            // confirmed subscription.
            if confirmedTentacleId == ack.tentacleId {
                confirmedSessionId = nil
                confirmedTentacleId = nil
            }
        } else if ack.sessionId != desiredSessionId {
            // The request was valid when sent, but navigation moved while it
            // was in flight. Tentacle now holds this value; remember its
            // authority so drive() can replace/release it, but discard the
            // stale page snapshot and never enter liveReady for it.
            confirmedSessionId = nil
            confirmedTentacleId = ack.tentacleId
        } else {
            // Snapshot must land before confirmed flips, so a following ordered
            // stream-0 delta cannot append to stale/empty card state.
            host?.applySessionSubscriptionSnapshot(ack)
            confirmedSessionId = ack.sessionId
            confirmedTentacleId = ack.tentacleId
        }
        drive()
    }

    private func drive() {
        guard let host, host.subscriptionConnected, inFlight == nil else { return }

        let desired = desiredSessionId
        let desiredTentacle = desired.flatMap { host.resolveTentacle(for: $0) }

        if let retired = retiredTentacles.sorted().first(where: {
            $0 != desiredTentacle && barriers.contains($0) && host.isTentacleOnline($0)
        }) {
            issue(tentacleId: retired, sessionId: nil)
            return
        }

        // Release old authority before crossing Tentacles.
        if let confirmedTentacleId, confirmedTentacleId != desiredTentacle {
            issue(tentacleId: confirmedTentacleId, sessionId: nil)
            return
        }

        guard let desired else { return }
        guard let desiredTentacle, barriers.contains(desiredTentacle),
              host.isTentacleOnline(desiredTentacle) else { return }
        if confirmedSessionId == desired && confirmedTentacleId == desiredTentacle { return }
        if blockedDesired == desired { return }

        issue(tentacleId: desiredTentacle, sessionId: desired)
    }

    private func issue(tentacleId: String, sessionId: String?) {
        let flight = InFlight(tentacleId: tentacleId, sessionId: sessionId)
        inFlight = flight
        KLog.diag("🔔 [subscription] issue tentacle=\(tentacleId.prefix(12)) session=\(sessionId?.prefix(12) ?? "nil") desired=\(desiredSessionId?.prefix(12) ?? "nil")")
        guard host?.sendSessionSubscription(to: tentacleId, sessionId: sessionId) == true else {
            if inFlight == flight {
                inFlight = nil
                blockedDesired = sessionId
                host?.reportSessionSubscriptionError(
                    "Cannot set live session subscription: target is unavailable."
                )
            }
            return
        }
    }
}
