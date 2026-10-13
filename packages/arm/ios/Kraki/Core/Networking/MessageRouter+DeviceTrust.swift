/// Device trust (Core/Crypto/DeviceTrust.swift) and notification previews,
/// kept out of MessageRouter's main dispatch.

import Foundation

extension MessageRouter {
    /// Relay-forwarded encrypted push preview for an online Mac.
    func handleNotificationPreview(_ json: [String: Any]) {
        #if os(macOS)
        if let appState, let deviceId = appState.deviceId,
           let key = (json["payload"] as? [String: Any])?["key"] as? String,
           key.hasPrefix(DeviceTrustPush.prefix) {
            guard let agreementKey = try? DeviceIdentityKeys.shared.agreementKey(),
                  let text = try? DeviceTrustPush.open(key: key, selfId: deviceId, agreementKey: agreementKey) else {
                KLog.d("⚠️ notification_preview (device trust) rejected")
                return
            }
            Task { @MainActor in
                MacNotifications.shared.present(decryptedPreview: text, appState: appState, route: "head")
            }
            return
        }
        // Unsigned previews never once a computer is pinned (same rule as the
        // iOS Notification Service Extension); paired computers' previews also
        // reach this Mac signed, or over the local link.
        guard DeviceTrustPush.legacyPreviewAllowed() else {
            KLog.d("⛔️ device trust: dropped unsigned notification_preview")
            return
        }
        guard let appState, let deviceId = appState.deviceId,
              let payload = json["payload"] as? [String: Any],
              let blob = payload["blob"] as? String,
              let key = payload["key"] as? String,
              let envelope = try? JSONSerialization.data(withJSONObject: ["blob": blob, "keys": [deviceId: key]]),
              let decrypted = try? encryptionHandler.decryptInbound(envelope),
              let text = String(data: decrypted.message, encoding: .utf8) else {
            KLog.d("⚠️ notification_preview could not be decrypted")
            return
        }
        Task { @MainActor in
            MacNotifications.shared.present(decryptedPreview: text, appState: appState, route: "head")
        }
        #endif
    }

    /// A decrypted inner message and its type (logged).
    static func parseInner(_ json: Data) -> (dict: [String: Any], type: String)? {
        guard let dict = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let type = dict["type"] as? String else {
            KLog.d("⚠️ Failed to parse decrypted inner message")
            return nil
        }
        KLog.d("📨 Inner message: \(type)")
        return (dict, type)
    }

    /// Device-trust messages, and the rule that an unsigned message about a
    /// paired computer's session is forged. Returns true when handled.
    @MainActor
    func handleDeviceTrust(type: String, dict: [String: Any], appState: AppState) -> Bool {
        let unsigned = dict[DeviceTrustInbound.unsignedKey] as? Bool == true
        let signedBy = dict[DeviceTrustInbound.signedByKey] as? String
        if let signedBy { appState.noteSignedFrom(signedBy, type: type) }
        if unsigned, TentacleTrustStore.shared.hasPins {
            let store = TentacleTrustStore.shared
            for sid in Self.referencedSessionIds(dict) {
                guard let owner = appState.sessionStore.sessions[sid]?.deviceId
                        ?? appState.sessionStore.archivedSessionInfo(sid)?.deviceId else { continue }
                if store.pin(owner) != nil {
                    KLog.d("⛔️ device trust: dropped unsigned \(type) touching a pinned computer's session")
                    return true
                }
            }
        }
        if type == "session_list", let signedBy {
            Self.dropUnauthenticatedHistory(listedBy: signedBy, dict: dict, appState: appState)
        }
        switch type {
        case "pair_result", "trusted_devices":
            // Only from the pinned computer itself, signed.
            guard let signedBy, signedBy == dict["deviceId"] as? String else {
                KLog.d("⛔️ device trust: dropped unsigned \(type)")
                return true
            }
            if type == "pair_result" { appState.handlePairResult(dict) } else { appState.handleTrustedDevices(dict) }
        case "trust_revoked":
            // Only from the computer itself, signed.
            guard let signedBy, signedBy == dict["deviceId"] as? String else { return true }
            appState.handleTrustRevoked(dict)
        case "trust_required":
            appState.handleTrustRequired(dict, signed: signedBy != nil && signedBy == dict["deviceId"] as? String)
        default:
            return false
        }
        return true
    }

    /// A pinned computer's signed list takes back sessions an unpinned device
    /// claimed first: whatever that device supplied (history, preview, live
    /// state) is unauthenticated and must not appear as the computer's, so it
    /// is dropped and fetched again from the computer.
    @MainActor
    static func dropUnauthenticatedHistory(listedBy signer: String, dict: [String: Any], appState: AppState) {
        let store = TentacleTrustStore.shared
        for sid in referencedSessionIds(dict) {
            guard let owner = appState.sessionStore.sessions[sid]?.deviceId, owner != signer,
                  store.pin(owner) == nil else { continue }
            KLog.d("🔏 device trust: \(sid.prefix(12)) taken back from unpinned \(owner.prefix(12)) — dropping its history")
            appState.messageProvider?.resetSession(sid)
            appState.messageStore.deleteSessionMessages(sid)
            appState.sessionStore.sessionPreviews[sid] = nil
        }
    }

    /// Every session an inner message refers to, wherever it carries it.
    static func referencedSessionIds(_ dict: [String: Any]) -> [String] {
        var ids: [String] = []
        if let sid = dict["sessionId"] as? String { ids.append(sid) }
        let payload = dict["payload"] as? [String: Any]
        if let sid = payload?["sessionId"] as? String { ids.append(sid) }
        let lists = [payload?["sessions"], dict["sessions"]].compactMap { $0 as? [[String: Any]] }
        for list in lists { ids.append(contentsOf: list.compactMap { $0["id"] as? String ?? $0["sessionId"] as? String }) }
        if let preview = payload?["preview"] as? String,
           let object = try? JSONSerialization.jsonObject(with: Data(preview.utf8)) as? [String: Any],
           let sid = object["sessionId"] as? String { ids.append(sid) }
        return ids.filter { !$0.isEmpty }
    }
}
