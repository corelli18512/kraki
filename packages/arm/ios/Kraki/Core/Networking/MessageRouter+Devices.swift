/// MessageRouter — device lifecycle from the relay: a device joined, left,
/// was removed, was renamed, or is pending a pong.

import Foundation

extension MessageRouter {
    func handleDeviceLifecycle(_ type: String, _ json: [String: Any]) {
        switch type {
        case "device_joined":
            if let deviceDict = json["device"] as? [String: Any],
               let summary = DeviceSummary(json: deviceDict) {
                appState?.deviceStore.addDevice(summary)
                appState?.sessionStore.relabelSessions(deviceId: summary.id, deviceName: summary.name)
                // A Tentacle that was away may have missed inputs the Relay
                // could not hold; re-send what is still waiting for it.
                if summary.role == .tentacle {
                    appState?.deviceTrustDevicesChanged()
                    // A Tentacle that (re)connected forgot this app's features.
                    if appState?.deviceStore.deviceFeatures[summary.id]?.contains(PayloadFragments.feature) == true {
                        declareClientFeatures(to: summary.id)
                    }
                    appState?.commandSender?.resendPendingInputs(deviceId: summary.id, reason: "tentacle_online")
                }
            }

        case "device_left":
            if let deviceId = json["deviceId"] as? String {
                appState?.deviceStore.setDeviceOnline(deviceId, online: false)
                appState?.sessionSubscriptionController.onTentacleUnavailable(deviceId)
            }

        case "device_removed":
            if let deviceId = json["deviceId"] as? String {
                appState?.deviceStore.removeDevice(deviceId)
                appState?.sessionSubscriptionController.onTentacleUnavailable(deviceId)
            }

        case "device_renamed":
            if let deviceId = json["deviceId"] as? String, let name = json["name"] as? String {
                appState?.deviceStore.renameDevice(deviceId, name: name, defaultName: json["defaultName"] as? String)
                appState?.sessionStore.relabelSessions(deviceId: deviceId, deviceName: name)
            }

        case "device_pending":
            // Transient liveness signal: the relay sent a ping but hasn't had
            // a pong back within the grace period. Resolved by a follow-up
            // device_joined (recovered) or device_left (gone), so leave the
            // device's online state untouched and just acknowledge.
            break
        default:
            break
        }
    }
}
