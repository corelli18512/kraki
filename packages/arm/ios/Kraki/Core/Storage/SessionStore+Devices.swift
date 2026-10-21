import Foundation

extension SessionStore {
    /// A device was renamed (`device_renamed`): its sessions show the new name.
    func relabelSessions(deviceId: String, deviceName: String) {
        let ids = sessions.filter { $0.value.deviceId == deviceId && $0.value.deviceName != deviceName }.map(\.key)
        for id in ids { sessions[id]?.deviceName = deviceName }
        if !ids.isEmpty { scheduleSave() }
    }
}
