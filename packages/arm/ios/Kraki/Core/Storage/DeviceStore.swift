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
    /// Per-device local-session catalog populated by `local_sessions_list`
    /// responses. Cleared and re-fetched by the import picker on open.
    var localSessions: [String: [LocalSessionSummary]] = [:]
    /// Per-device "we're awaiting a local_sessions_list response" flag,
    /// used by the import picker to show a spinner.
    var localSessionsLoading: Set<String> = []

    /// Device IDs that the relay told us are online (via `auth_ok` or
    /// `device_joined`) but whose `device_greeting` we haven't yet
    /// received in the current connection session. Drives the amber
    /// "connecting" dot. Cleared on `setGreeting`. Not persisted —
    /// greeting freshness is a per-connection property.
    var pendingGreetingIds: Set<String> = []

    /// Cross-tab navigation request. Setting this asks the root tab
    /// view to (a) switch to the Devices tab and (b) push the named
    /// device's detail panel. Mirrors `SessionStore.navigateToSession`.
    var navigateToDeviceId: String?

    /// Disk-backed snapshot of device metadata. Hydrated on init so the
    /// Devices tab and per-session device-name lookups have data on cold
    /// launch before the WS reconnects. All restored devices are forced
    /// `online = false` — authoritative online state arrives via
    /// `auth_ok` / `device_joined`.
    let persistentCache = PersistentDeviceCache()

    init() {
        guard let snapshot = persistentCache.load() else { return }
        self.devices = snapshot.devices
        self.deviceModels = snapshot.deviceModels
        self.deviceModelDetails = snapshot.deviceModelDetails
        self.deviceVersions = snapshot.deviceVersions
    }

    /// Debounced write of the current persistable state to disk. Called
    /// after any mutation that changes a persisted field.
    fileprivate func scheduleSave() {
        persistentCache.save(.init(
            devices: devices,
            deviceModels: deviceModels,
            deviceModelDetails: deviceModelDetails,
            deviceVersions: deviceVersions
        ))
    }

    /// Force-flush the cache. Called from app background / logout.
    func flushCache() {
        persistentCache.flushNow()
    }

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
        // Refresh greeting freshness — every online device in the fresh
        // list is "connecting" until its `device_greeting` lands in this
        // session. Offline devices don't need to be tracked because
        // `isDeviceOnline=false` short-circuits the connecting check.
        pendingGreetingIds = Set(list.filter { $0.online }.map(\.id))
        scheduleSave()
    }

    func addDevice(_ device: DeviceSummary) {
        devices[device.id] = device
        if device.online {
            pendingGreetingIds.insert(device.id)
        }
        scheduleSave()
    }

    func removeDevice(_ id: String) {
        devices.removeValue(forKey: id)
        deviceModels.removeValue(forKey: id)
        deviceModelDetails.removeValue(forKey: id)
        deviceVersions.removeValue(forKey: id)
        pendingGreetingIds.remove(id)
        scheduleSave()
    }

    func setOnline(_ id: String, _ online: Bool) {
        devices[id]?.online = online
        if online {
            // Coming online → mark pending. The greeting we expect to
            // follow this `device_joined` will clear it.
            pendingGreetingIds.insert(id)
        } else {
            // Going offline → not connecting, just gray.
            pendingGreetingIds.remove(id)
        }
        scheduleSave()
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
        // Greeting received — device is no longer "connecting".
        pendingGreetingIds.remove(deviceId)
        scheduleSave()
    }

    // MARK: - Reset

    func reset() {
        devices.removeAll()
        deviceModels.removeAll()
        deviceModelDetails.removeAll()
        deviceVersions.removeAll()
        pendingGreetingIds.removeAll()
        persistentCache.clear()
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

    /// Mark a device as having delivered its greeting in the current
    /// connection session — clears the amber "connecting" dot.
    /// Called by `MessageRouter.handleDeviceGreeting` after the
    /// individual setters land the new models/version/etc., so the
    /// `setDeviceOnline(true)` inside the same handler (which would
    /// otherwise re-insert the id) is correctly cancelled out.
    func markGreeted(_ id: String) {
        pendingGreetingIds.remove(id)
    }

    /// Set device models list.
    func setDeviceModels(_ id: String, models: [String]) {
        deviceModels[id] = models
        scheduleSave()
    }

    /// Set device model details from raw JSON dictionaries.
    func setDeviceModelDetails(_ id: String, details: [[String: Any]]) {
        let parsed = details.compactMap { dict -> ModelDetail? in
            guard let mid = dict["id"] as? String,
                  let name = dict["name"] as? String else { return nil }
            let supportsRE = dict["supportsReasoningEffort"] as? Bool ?? false
            let supportedREs = (dict["supportedReasoningEfforts"] as? [String])?.compactMap { ReasoningEffort(rawValue: $0) }
            let defaultRE = (dict["defaultReasoningEffort"] as? String).flatMap { ReasoningEffort(rawValue: $0) }
            let contextWindow = dict["contextWindow"] as? Int
            return ModelDetail(
                id: mid, name: name,
                supportsReasoningEffort: supportsRE,
                supportedReasoningEfforts: supportedREs,
                defaultReasoningEffort: defaultRE,
                contextWindow: contextWindow
            )
        }
        deviceModelDetails[id] = parsed
        scheduleSave()
    }

    /// Set device version string.
    func setDeviceVersion(_ id: String, version: String) {
        deviceVersions[id] = version
        scheduleSave()
    }
}
