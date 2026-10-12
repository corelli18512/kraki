/// AppState as the voice input host: leases and the relay connection for voice.

import SwiftUI
import Observation

// MARK: - Voice input host

extension AppState: KrakiVoiceInputHost {
    static let headPulseTarget = "@head"

    /// The only message types the head sends inside a plaintext
    /// `{from:"@head", msg}` Pulse wrapper (mirrors `HEAD_CONTROL_TYPES` in
    /// packages/protocol). Anything else arriving that way, notably `auth_ok`,
    /// `auth_error` and consumer/producer messages, is forged and dropped.
    static let headControlTypes: Set<String> = [
        "device_joined", "device_left", "device_removed", "device_pending",
        "preferences_updated", "push_token_registered", "notification_preview",
        "voice_lease_grant", "voice_lease_denied", "voice_vocabulary_updated",
    ]

    /// The inner message of a `{from:"@head", msg}` wrapper, or nil when it is
    /// not one of the head's own control types.
    static func headControlMessage(in wrapper: [String: Any]) -> [String: Any]? {
        guard wrapper["from"] as? String == headPulseTarget,
              let message = wrapper["msg"] as? [String: Any],
              let type = message["type"] as? String,
              headControlTypes.contains(type) else { return nil }
        return message
    }

    var voiceUserID: String? { user?.id }
    var voiceDeviceID: String? { deviceId }
    var voiceTransportReady: Bool { connectionStatus == .connected }

    @discardableResult
    func requestVoiceLease(resource: String) -> Bool {
        guard connectionStatus == .connected, let deviceId, let wsClient,
              JSONSerialization.isValidJSONObject([
                "type": "request_voice_lease",
                "deviceId": deviceId,
                "resource": resource,
              ]),
              let data = try? JSONSerialization.data(withJSONObject: [
                "type": "request_voice_lease",
                "deviceId": deviceId,
                "resource": resource,
              ]),
              let string = String(data: data, encoding: .utf8) else {
            KLog.d("🎙️ Voice lease request blocked: transport unavailable")
            return false
        }
        // Voice authorization is connection-scoped. The controller requests a
        // lease during foreground warm-up and reuses it across sequential
        // recordings until expiry or reconnect replacement.
        wsClient.sendRaw(string)
        KLog.d("🎙️ Voice lease request sent resource=\(resource)")
        return true
    }
}
