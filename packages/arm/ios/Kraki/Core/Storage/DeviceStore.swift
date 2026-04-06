/// DeviceStore — Observable device state mirroring the device slice of useStore.ts.
///
/// Tracks online devices, their models, versions, and capabilities.
/// Tentacle devices are the ones that run agents.

import Foundation
import Observation

@Observable
final class DeviceStore {
    var devices: [String: DeviceSummary] = [:]
    var deviceModels: [String: [String]] = [:]
    var deviceModelDetails: [String: [ModelDetail]] = [:]
    var deviceVersions: [String: String] = [:]

    // MARK: - Computed

    /// Devices with role == .tentacle (the ones that run agents).
    var tentacleDevices: [DeviceSummary] {
        devices.values.filter { $0.role == .tentacle }
    }

    /// Union of all model IDs across all devices.
    var allModels: [String] {
        Array(Set(deviceModels.values.flatMap { $0 })).sorted()
    }

    /// Encryption key for a device (falls back to publicKey if encryptionKey absent).
    func encryptionKeyFor(_ deviceId: String) -> String? {
        guard let device = devices[deviceId] else { return nil }
        return device.encryptionKey ?? device.publicKey
    }

    /// Find the device that hosts a given session.
    func deviceForSession(_ sessionId: String, sessions: [String: SessionInfo]) -> DeviceSummary? {
        guard let session = sessions[sessionId] else { return nil }
        return devices[session.deviceId]
    }

    // MARK: - Device CRUD

    func setDevices(_ list: [DeviceSummary]) {
        devices = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    func addDevice(_ device: DeviceSummary) {
        devices[device.id] = device
    }

    func removeDevice(_ id: String) {
        devices.removeValue(forKey: id)
        deviceModels.removeValue(forKey: id)
        deviceModelDetails.removeValue(forKey: id)
        deviceVersions.removeValue(forKey: id)
    }

    func setOnline(_ id: String, _ online: Bool) {
        devices[id]?.online = online
    }

    /// Process a device_greeting: update name, models, version.
    func setGreeting(
        _ deviceId: String,
        name: String,
        models: [String]?,
        modelDetails: [ModelDetail]?,
        version: String?
    ) {
        devices[deviceId]?.name = name

        if let models, !models.isEmpty {
            deviceModels[deviceId] = models
        } else {
            deviceModels.removeValue(forKey: deviceId)
        }

        if let modelDetails, !modelDetails.isEmpty {
            deviceModelDetails[deviceId] = modelDetails
        } else {
            deviceModelDetails.removeValue(forKey: deviceId)
        }

        if let version {
            deviceVersions[deviceId] = version
        }
    }

    // MARK: - Reset

    func reset() {
        devices.removeAll()
        deviceModels.removeAll()
        deviceModelDetails.removeAll()
        deviceVersions.removeAll()
    }

    // MARK: - Convenience Methods (called by MessageRouter)

    /// Look up a device by ID (alias for devices[id]).
    func device(for id: String) -> DeviceSummary? {
        devices[id]
    }

    /// All devices as an array.
    func allDevices() -> [DeviceSummary] {
        Array(devices.values)
    }

    /// Set device online status (named alias for setOnline).
    func setDeviceOnline(_ id: String, online: Bool) {
        setOnline(id, online)
    }

    /// Set device models list.
    func setDeviceModels(_ id: String, models: [String]) {
        deviceModels[id] = models
    }

    /// Set device model details from raw JSON dictionaries.
    func setDeviceModelDetails(_ id: String, details: [[String: Any]]) {
        let parsed = details.compactMap { dict -> ModelDetail? in
            guard let mid = dict["id"] as? String,
                  let name = dict["name"] as? String else { return nil }
            let supportsRE = dict["supportsReasoningEffort"] as? Bool ?? false
            let supportedREs = (dict["supportedReasoningEfforts"] as? [String])?.compactMap { ReasoningEffort(rawValue: $0) }
            let defaultRE = (dict["defaultReasoningEffort"] as? String).flatMap { ReasoningEffort(rawValue: $0) }
            return ModelDetail(
                id: mid, name: name,
                supportsReasoningEffort: supportsRE,
                supportedReasoningEfforts: supportedREs,
                defaultReasoningEffort: defaultRE
            )
        }
        deviceModelDetails[id] = parsed
    }

    /// Set device version string.
    func setDeviceVersion(_ id: String, version: String) {
        deviceVersions[id] = version
    }
}
