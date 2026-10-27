/// AppState as the session subscription host: which Session this device follows, and applying the snapshots it gets.

import SwiftUI
import Observation

// MARK: - Session subscription

extension AppState: SessionSubscriptionHost {
    var subscriptionConnected: Bool { connectionStatus == .connected }

    func resolveTentacle(for sessionId: String) -> String? {
        sessionStore.sessions[sessionId]?.deviceId
    }

    func isTentacleOnline(_ tentacleId: String) -> Bool {
        #if os(macOS)
        if localLink?.isLinked(tentacleId) == true { return true }
        #endif
        return deviceStore.devices[tentacleId]?.online == true
    }

    /// Commands the Tentacle handles idempotently (client ids, permission ids,
    /// absolute settings), so a copy delivered again over the Head after the
    /// link died unconfirmed is harmless. Not here: create/fork (would create
    /// twice), connection-scoped commands (abort, subscription), which must
    /// not outlive their connection, and `mark_unread`, which is relative to
    /// the read cursor: a late copy would undo a read that happened since.
    static let replayableAcrossRoutes: Set<String> = [
        "send_input", "approve", "deny", "always_allow",
        "set_session_mode", "set_session_model", "rename_session", "pin_session",
        "mark_read", "archive_session", "delete_session", "kill_session",
    ]

    #if os(macOS)
    /// The route to `tentacleId` switched between the Head and the local link.
    /// Like a Tentacle (re)join: drop connection-scoped subscription authority
    /// (the Tentacle re-sends session_list on the new route, which is the new
    /// barrier), re-declare features and re-send inputs still waiting.
    func localLinkDidChange(tentacleId: String, linked: Bool) {
        sessionSubscriptionController.onTentacleUnavailable(tentacleId)
        for (sessionId, stopTentacle) in stopsOverLocalLink where stopTentacle == tentacleId {
            stopsOverLocalLink.removeValue(forKey: sessionId)
            if !linked { stopsLostWithLocalLink[sessionId, default: 0] += 1 }
        }
        if let store = attachmentStore {
            if Thread.isMainThread {
                MainActor.assumeIsolated { store.routeChanged() }
            } else {
                Task { @MainActor in store.routeChanged() }
            }
        }
        if linked || deviceStore.devices[tentacleId]?.online == true {
            messageRouter?.declareClientFeatures(to: tentacleId)
            commandSender?.resendPendingInputs(
                deviceId: tentacleId,
                reason: linked ? "local_link_up" : "local_link_down"
            )
        }
    }
    #endif

    func sendSessionSubscription(to tentacleId: String, sessionId: String?) -> Bool {
        sendSessionSubscription(to: tentacleId, sessionId: sessionId, requestId: UUID().uuidString)
    }

    func sendSessionSubscription(to tentacleId: String, sessionId: String?, requestId: String) -> Bool {
        var payload: [String: Any] = [:]
        payload["sessionId"] = sessionId ?? NSNull()
        payload["requestId"] = requestId
        return sendEncryptedMessage([
            "type": "set_session_subscription",
            "deviceId": deviceId ?? "",
            "seq": 0,
            "timestamp": ISO8601.now(),
            "payload": payload,
        ], routingTarget: tentacleId, connectionScoped: true)
    }

    func applySessionSubscriptionSnapshot(_ ack: SessionSubscriptionAck) {
        guard let sessionId = ack.sessionId,
              let snapshot = ack.snapshot,
              let digestJSON = snapshot["digest"] as? [String: Any],
              let digest = SessionDigest(json: digestJSON) else { return }

        let device = deviceStore.device(for: ack.tentacleId)
        sessionStore.upsertSession(
            digest,
            deviceId: ack.tentacleId,
            deviceName: device?.name ?? ack.tentacleId
        )
        sessionStore.setMode(sessionId, digest.mode)
        if let usage = digest.usage { sessionStore.setUsage(sessionId, usage) }
        if let preview = digest.preview {
            sessionStore.setPreview(
                sessionId,
                text: preview.text,
                type: preview.type,
                timestamp: preview.timestamp
            )
        }

        if digest.runtimeStatus?.status == "compacting" {
            let reason = digest.runtimeStatus?.reason.flatMap(CompactionReason.init(rawValue:))
            messageStore.setCompacting(sessionId, reason: reason)
        } else {
            switch digest.state {
            case .compacting:
                messageStore.setCompacting(sessionId, reason: nil)
            case .idle, .active:
                messageStore.clearRuntimeStatus(sessionId)
            }
        }

        let cardJSON = snapshot["card"] as? [String: Any] ?? [:]
        let draft = cardJSON["draft"] as? String ?? ""
        let actionPayload = cardJSON["action"].map { ["action": $0] }
        let action = MessageRouter.decodeCardAction(actionPayload)
        messageStore.replaceCardFromSubscription(
            sessionId,
            draft: draft,
            action: action,
            state: digest.state
        )

        let spineHeadSeq = snapshot["spineHeadSeq"] as? Int ?? digest.lastSeq
        // The card belongs to the turn after `spineHeadSeq`: show it only once
        // this device has the messages up to there (catch-up comes next).
        messageStore.holdCard(sessionId, untilSeq: spineHeadSeq)
        messageProvider?.setTentacleInfo(
            sessionId: sessionId,
            lastSeq: spineHeadSeq,
            deviceId: ack.tentacleId
        )
        messageProvider?.ensureLoaded(
            sessionId: sessionId,
            reason: "subscriptionSnapshot"
        )
    }

    func reportSessionSubscriptionError(_ message: String) {
        lastError = message
    }

    func tentacleRouteIsIndependent(_ tentacleId: String) -> Bool {
        #if os(macOS)
        return localLink?.isLinked(tentacleId) == true
        #else
        return false
        #endif
    }
}
