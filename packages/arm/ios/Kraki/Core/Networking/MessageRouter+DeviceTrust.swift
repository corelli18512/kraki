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
            // A paired computer signs its previews; an unsigned one about
            // its session was made by someone else (e.g. the relay).
            if let sid = (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])?["sessionId"] as? String,
               let owner = appState.sessionStore.sessions[sid]?.deviceId,
               TentacleTrustStore.shared.pairedPin(owner) != nil {
                KLog.d("⛔️ device trust: dropped unsigned notification for a paired computer")
                return
            }
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
        if type == "session_list" || type == "session_created" {
            // Sessions changed: refresh what the notification extension may show.
            DispatchQueue.main.async { [weak appState] in appState?.publishPushTrustPolicy() }
        }
        switch type {
        case "pair_result", "trusted_devices":
            // Only from the pinned computer itself, signed.
            guard let signedBy, signedBy == dict["deviceId"] as? String else {
                KLog.d("⛔️ device trust: dropped unsigned \(type)")
                return true
            }
            if type == "pair_result" { appState.handlePairResult(dict) } else { appState.handleTrustedDevices(dict) }
        case "trust_required":
            appState.handleTrustRequired(dict, signed: signedBy != nil && signedBy == dict["deviceId"] as? String)
        default:
            return false
        }
        return true
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
