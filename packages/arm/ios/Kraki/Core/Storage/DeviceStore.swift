/// DeviceStore — Observable device state mirroring the device slice of useStore.ts.
///
/// Tracks online devices, their models, versions, and capabilities.
/// Tentacle devices are the ones that run agents.

import Foundation
import Observation

@Observable
final class DeviceStore {
    var devices: [String: DeviceSummary] = [:]
    /// Per-device list of agent capability slices. Each entry carries
    /// its own `models` / `modelDetails`. Tentacles can advertise
    /// multiple agents (e.g. Copilot + Claude). UI that wants a flat
    /// model list reads through the `models(for:)` /
    /// `modelDetails(for:)` helpers below — they collapse the slices
    /// to a single agent (single-agent device) or a per-agent slice
    /// (multi-agent device).
    var deviceAgents: [String: [AgentCapabilities]] = [:]
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

    /// On-disk snapshot of device metadata. Hydrated on init so the
    /// Devices tab and per-session device-name lookups have data on
    /// cold launch before the WS reconnects. All restored devices are
    /// forced `online = false` — authoritative online state arrives
    /// via `auth_ok` / `device_joined`. Stored at
    /// `<ApplicationSupport>/Kraki/devices.json`.
    ///
    /// Schema versioning: bumped to v2 with PR #134 (multi-agent).
    /// V1 snapshots are silently dropped on launch — model lists are
    /// not critical and the next `device_greeting` re-fills them.

    private struct Snapshot: Codable {
        /// Schema version. Absent / mismatched → snapshot ignored.
        var schemaVersion: Int?
        var devices: [String: DeviceSummary]
        var deviceAgents: [String: [AgentCapabilities]]
        var deviceVersions: [String: String]
    }

    private static let snapshotSchemaVersion = 2

    private static let saveDebounce: TimeInterval = 10.0
    private var saveTask: DispatchWorkItem?
    private var pendingSnapshot: Snapshot?

    private static let snapshotURL: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Kraki", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("devices.json", isDirectory: false)
    }()

    init() {
        guard FileManager.default.fileExists(atPath: Self.snapshotURL.path),
              let data = try? Data(contentsOf: Self.snapshotURL),
              var snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.schemaVersion == Self.snapshotSchemaVersion else {
            // Either no snapshot, or v1 (pre-multi-agent) — drop. Next
            // greeting will re-fill agent capabilities.
            try? FileManager.default.removeItem(at: Self.snapshotURL)
            return
        }
        // Force every restored device offline — authoritative online
        // state arrives later from auth_ok.
        for (id, var device) in snapshot.devices {
            device.online = false
            snapshot.devices[id] = device
        }
        self.devices = snapshot.devices
        self.deviceAgents = snapshot.deviceAgents
        self.deviceVersions = snapshot.deviceVersions
    }

    /// Debounced write of the current persistable state to disk.
    /// Called after any mutation that changes a persisted field.
    fileprivate func scheduleSave() {
        pendingSnapshot = Snapshot(
            schemaVersion: Self.snapshotSchemaVersion,
            devices: devices,
            deviceAgents: deviceAgents,
            deviceVersions: deviceVersions
        )
        saveTask?.cancel()
        let task = DispatchWorkItem { [weak self] in self?.flushCache() }
        saveTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDebounce, execute: task)
    }

    /// Force-flush the pending snapshot to disk immediately.
    func flushCache() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: Self.snapshotURL, options: .atomic)
    }

    /// Wipe the on-disk file. Logout / reset.
    func clearPersistentSnapshot() {
        saveTask?.cancel()
        saveTask = nil
        pendingSnapshot = nil
        try? FileManager.default.removeItem(at: Self.snapshotURL)
    }

    // MARK: - Computed

    /// Devices with role == .tentacle (the ones that run agents).
    var tentacleDevices: [DeviceSummary] {
        devices.values.filter { $0.role == .tentacle }
    }

    /// Union of all model IDs across all devices and agents.
    var allModels: [String] {
        var seen = Set<String>()
        for agents in deviceAgents.values {
            for agent in agents {
                for m in agent.models ?? [] { seen.insert(m) }
            }
        }
        return seen.sorted()
    }

    /// Agents advertised by the given device, in the order the
    /// tentacle reported them. Empty if the greeting hasn't landed
    /// yet (or the device went offline and we cleared its slice).
    func agents(for deviceId: String) -> [AgentCapabilities] {
        deviceAgents[deviceId] ?? []
    }

    /// Look up an agent slice by id within a device. Returns nil if
    /// the device doesn't currently advertise that agent — callers
    /// should fall back to the first slice or handle the empty case.
    func agent(_ agentId: AgentId, on deviceId: String) -> AgentCapabilities? {
        agents(for: deviceId).first { $0.id == agentId }
    }

    /// Models for the given device + agent. When `agentId` is nil
    /// (callsite hasn't been multi-agent-ified yet) returns the union
    /// across all agents on that device — a permissive default.
    func models(for deviceId: String, agentId: AgentId? = nil) -> [String] {
        let agents = agents(for: deviceId)
        if let agentId, let match = agents.first(where: { $0.id == agentId }) {
            return match.models ?? []
        }
        var seen = Set<String>(); var ordered: [String] = []
        for a in agents { for m in a.models ?? [] where !seen.contains(m) {
            seen.insert(m); ordered.append(m)
        } }
        return ordered
    }

    /// Model details for the given device + agent. Same fallback rule
    /// as `models(for:agentId:)`.
    func modelDetails(for deviceId: String, agentId: AgentId? = nil) -> [ModelDetail] {
        let agents = agents(for: deviceId)
        if let agentId, let match = agents.first(where: { $0.id == agentId }) {
            return match.modelDetails ?? []
        }
        var seen = Set<String>(); var ordered: [ModelDetail] = []
        for a in agents { for d in a.modelDetails ?? [] where !seen.contains(d.id) {
            seen.insert(d.id); ordered.append(d)
        } }
        return ordered
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
        deviceAgents.removeValue(forKey: id)
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

    /// Process a device_greeting: update name, agents, version.
    /// Both the new (`agents`) and legacy (`models`/`modelDetails`)
    /// shapes are accepted — see `MessageRouter.handleDeviceGreeting`
    /// for the synthesis rule when only legacy fields are present.
    func setGreeting(
        _ deviceId: String,
        name: String,
        agents: [AgentCapabilities]?,
        version: String?
    ) {
        devices[deviceId]?.name = name

        if let agents, !agents.isEmpty {
            deviceAgents[deviceId] = agents
        } else {
            deviceAgents.removeValue(forKey: deviceId)
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
        deviceAgents.removeAll()
        deviceVersions.removeAll()
        pendingGreetingIds.removeAll()
        clearPersistentSnapshot()
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

    /// Replace the agent slice list for a device (called from
    /// `MessageRouter.handleDeviceGreeting`). Pass an empty array to
    /// drop the device's agents (e.g. on `device_left`).
    func setDeviceAgents(_ id: String, agents: [AgentCapabilities]) {
        if agents.isEmpty {
            deviceAgents.removeValue(forKey: id)
        } else {
            deviceAgents[id] = agents
        }
        scheduleSave()
    }

    /// Drop a device's agent slices entirely (offline / removed).
    func clearDeviceAgents(_ id: String) {
        deviceAgents.removeValue(forKey: id)
        scheduleSave()
    }

    /// Set device version string.
    func setDeviceVersion(_ id: String, version: String) {
        deviceVersions[id] = version
        scheduleSave()
    }
}
