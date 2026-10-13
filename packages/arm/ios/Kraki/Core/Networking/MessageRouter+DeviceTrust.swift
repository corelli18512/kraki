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
        if dict[DeviceTrustInbound.unsignedKey] as? Bool == true,
           let sid = dict["sessionId"] as? String,
           let owner = appState.sessionStore.sessions[sid]?.deviceId ?? appState.sessionStore.archivedSessionInfo(sid)?.deviceId,
           TentacleTrustStore.shared.pairedPin(owner) != nil {
            KLog.d("⛔️ device trust: dropped unsigned \(type) for a paired computer's session")
            return true
        }
        switch type {
        case "pair_result": appState.handlePairResult(dict)
        case "trust_required": appState.handleTrustRequired(dict)
        case "trusted_devices": appState.handleTrustedDevices(dict)
        default: return false
        }
        return true
    }
}
