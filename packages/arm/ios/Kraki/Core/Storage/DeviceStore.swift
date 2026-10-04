/// DeviceStore — Observable device state mirroring the device slice of useStore.ts.
///
/// Tracks online devices, their models, versions, and capabilities.
/// Tentacle devices are the ones that run agents.

import Foundation
import Observation

@Observable
final class DeviceStore {
    var devices: [String: DeviceSummary] = [:]
    /// Pinned computer keys (see DeviceKeyPins). Not observed.
    @ObservationIgnored let keyPins = DeviceKeyPins()
    /// Computers whose key changed since they were pinned (UI warning).
    var keyMismatchDeviceIds: Set<String> = []
    /// Per-device list of agent capability slices. Each entry carries
    /// its own `models` / `modelDetails`. Tentacles can advertise
    /// multiple agents (e.g. Copilot + Claude). UI that wants a flat
    /// model list reads through the `models(for:)` /
    /// `modelDetails(for:)` helpers below — they collapse the slices
    /// to a single agent (single-agent device) or a per-agent slice
    /// (multi-agent device).
    var deviceAgents: [String: [AgentCapabilities]] = [:]
    var deviceVersions: [String: String] = [:]
    /// Latest subscription account quota per tentacle (`device_usage`).
    /// In-memory only: a fresh reading arrives on every connect.
    var deviceUsage: [String: DeviceUsageSnapshot] = [:]
    var usageRefreshes: [String: AccountUsageRefreshState] = [:]
    /// Per-device local-session catalog populated by `local_sessions_list`
    /// responses. Cleared and re-fetched by the import picker on open.
    var localSessions: [String: [LocalSessionSummary]] = [:]
    /// Per-device "we're awaiting a local_sessions_list response" flag,
    /// used by the import picker to show a spinner.
    var localSessionsLoading: Set<String> = []

    /// macOS-only flat model lists for the model picker. The new Core
    /// carries per-agent capability slices (`deviceAgents`); these flat
    /// projections keep the mac mock-data seeding working until the mac
    /// picker is ported to the agent-slice model. iOS never reads them.
    #if os(macOS)
    var deviceModels: [String: [String]] = [:]
    var deviceModelDetails: [String: [ModelDetail]] = [:]
    #endif

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
    private let persistenceEnabled: Bool
    private var saveTask: DispatchWorkItem?
    private var pendingSnapshot: Snapshot?

    private static let snapshotURL: URL = {
        KrakiDataPaths.persistentDirectory()
            .appendingPathComponent("devices.json", isDirectory: false)
    }()

    init(persistenceEnabled: Bool = true) {
        self.persistenceEnabled = persistenceEnabled
        guard persistenceEnabled else { return }
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
        guard persistenceEnabled else { return }
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
        guard persistenceEnabled else { return }
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: Self.snapshotURL, options: .atomic)
    }

    /// Wipe the on-disk file. Logout / reset.
    func clearPersistentSnapshot() {
        // Pinned computer keys are persisted device state too.
        keyPins.reset()
        keyMismatchDeviceIds.removeAll()
        guard persistenceEnabled else { return }
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
    /// Why a device does or doesn't offer agents right now. Lets the UI tell
    /// "still connecting" apart from "connected, but no coding agent is
    /// installed" instead of spinning on an empty picker forever.
    enum AgentAvailability: Equatable {
        case ready
        case connecting
        case offline
        case noAgents
    }

    func agentAvailability(for deviceId: String) -> AgentAvailability {
        if !agents(for: deviceId).isEmpty { return .ready }
        guard let device = devices[deviceId], device.online else { return .offline }
        return pendingGreetingIds.contains(deviceId) ? .connecting : .noAgents
    }

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
        let qrVerified = keyPins.verifyPendingQR(against: list)
        devices = Dictionary(uniqueKeysWithValues: list.map { ($0.id, keyPins.apply($0)) })
        keyMismatchDeviceIds = keyPins.mismatched.union(qrVerified ? [] : [Self.unmatchedQRMarker])
        // Refresh greeting freshness — every online device in the fresh
        // list is "connecting" until its `device_greeting` lands in this
        // session. Offline devices don't need to be tracked because
        // `isDeviceOnline=false` short-circuits the connecting check.
        pendingGreetingIds = Set(list.filter { $0.online }.map(\.id))
        scheduleSave()
    }

    func addDevice(_ device: DeviceSummary) {
        devices[device.id] = keyPins.apply(device)
        keyMismatchDeviceIds = keyPins.mismatched
        if device.online {
            pendingGreetingIds.insert(device.id)
        }
        scheduleSave()
    }

    func removeDevice(_ id: String) {
        keyPins.forget(id)
        keyMismatchDeviceIds.remove(id)
        devices.removeValue(forKey: id)
        deviceUsage.removeValue(forKey: id)
        usageRefreshes.removeValue(forKey: id)
        deviceFeatures.removeValue(forKey: id)
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
            if let request = usageRefreshes[id] {
                finishUsageRefresh(id, requestId: request.requestId, error: "offline")
            }
        }
        scheduleSave()
    }

    /// Process a device_greeting: update name, agents, version.
    /// Both the new (`agents`) and legacy (`models`/`modelDetails`)
    /// shapes are accepted — see `MessageRouter.handleDeviceGreeting`
    /// for the synthesis rule when only legacy fields are present.
    /// Features a Tentacle advertised in its greeting (in memory; re-sent on
    /// every connect). `idempotent_input` allows automatic input re-sends.
    private(set) var deviceFeatures: [String: Set<String>] = [:]

    func setDeviceFeatures(_ deviceId: String, features: [String]) {
        deviceFeatures[deviceId] = Set(features)
    }

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

    /// Marker in `keyMismatchDeviceIds` when the scanned QR matched no computer.
    static let unmatchedQRMarker = "__qr_unmatched__"

    func reset() {
        devices.removeAll()
        deviceAgents.removeAll()
        deviceVersions.removeAll()
        deviceUsage.removeAll()
        usageRefreshes.removeAll()
        deviceFeatures.removeAll()
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

    func setDeviceUsage(_ id: String, accounts: [AccountUsage], receivedAt: Date = Date()) {
        deviceUsage[id] = DeviceUsageSnapshot(accounts: accounts, receivedAt: receivedAt)
    }

    /// Pick a small set of online, refresh-capable devices covering the accounts.
    /// Replicated accounts do not cause a request to every machine. Devices with
    /// no snapshot are still queried so a newly signed-in account can appear.
    func usageRefreshTargets(deviceIds: Set<String>? = nil) -> [String] {
        let candidates = devices.values.filter {
            $0.role == .tentacle && $0.online && !pendingGreetingIds.contains($0.id)
                && deviceFeatures[$0.id]?.contains("account_usage_refresh") == true
                && (deviceIds == nil || deviceIds!.contains($0.id))
        }.map(\.id).sorted()
        if deviceIds != nil { return candidates }
        var remaining = Set(candidates.flatMap { deviceUsage[$0]?.accounts.map(\.id) ?? [] })
        var selected = candidates.filter { deviceUsage[$0]?.accounts.isEmpty ?? true }
        var pool = candidates.filter { !selected.contains($0) }
        while !remaining.isEmpty, !pool.isEmpty {
            func score(_ id: String) -> (Int, Int, TimeInterval) {
                let accounts = (deviceUsage[id]?.accounts ?? []).filter { remaining.contains($0.id) }
                let failedAt = usageRefreshes[id].flatMap { $0.error == nil ? nil : $0.startedAt } ?? .distantPast
                let healthy = accounts.filter { $0.error == nil && ($0.fetchedDate ?? .distantPast) > failedAt }
                return (healthy.count, accounts.count, healthy.compactMap(\.fetchedDate).max()?.timeIntervalSince1970 ?? 0)
            }
            // Prefer working replicas over an expired login (or a failed RPC).
            // Coverage then minimizes requests; freshness and ID break ties.
            let best = pool.max { a, b in
                let ac = score(a), bc = score(b)
                return ac == bc ? a > b : ac < bc
            }!
            selected.append(best)
            remaining.subtract(deviceUsage[best]?.accounts.map(\.id) ?? [])
            pool.removeAll { $0 == best }
        }
        return selected.sorted()
    }

    func canRefreshUsage(_ id: String, automatic: Bool = false, now: Date = Date()) -> Bool {
        if let state = usageRefreshes[id], !state.finished || now.timeIntervalSince(state.startedAt) < 60 { return false }
        guard automatic, let snapshot = deviceUsage[id], !snapshot.accounts.isEmpty else { return true }
        return snapshot.accounts.contains { account in
            if account.error == "rate_limited", let retry = account.retryDate, retry > now { return false }
            return account.error != nil || (account.fetchedDate.map { now.timeIntervalSince($0) >= 60 } ?? true)
        }
    }

    func beginUsageRefresh(_ id: String, requestId: String, now: Date = Date()) {
        usageRefreshes[id] = AccountUsageRefreshState(requestId: requestId, startedAt: now)
    }

    func finishUsageRefresh(_ id: String, requestId: String, error: String? = nil) {
        guard var state = usageRefreshes[id], state.requestId == requestId, !state.finished else { return }
        state.finished = true
        state.error = error
        usageRefreshes[id] = state
    }

    func interruptUsageRefreshes() {
        for (id, state) in usageRefreshes where !state.finished {
            finishUsageRefresh(id, requestId: state.requestId, error: "connection")
        }
    }

    /// Old targeted replies may not overwrite a newer request or clear its spinner.
    func receiveDeviceUsage(_ id: String, payload: DeviceUsagePayload) {
        if let requestId = payload.requestId {
            if let pending = usageRefreshes[id], pending.requestId != requestId { return }
            finishUsageRefresh(id, requestId: requestId, error: payload.refreshError)
        }
        // A transport/disabled error carries a cache, not a new successful reading.
        if payload.refreshError == nil { setDeviceUsage(id, accounts: payload.accounts) }
    }

    /// Online tentacles whose greeting says they predate account usage, so the app
    /// can name them instead of silently showing nothing for them.
    func devicesNeedingUsageUpdate() -> [DeviceSummary] {
        devices.values
            .filter { $0.role == .tentacle && $0.online && !pendingGreetingIds.contains($0.id) }
            .filter { device in
                guard let features = deviceFeatures[device.id] else { return false }
                return !features.contains("account_usage") && deviceUsage[device.id] == nil
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Every reported account merged across devices (quota is per account, not
    /// per device). Readings from devices that went offline stay listed and
    /// age into "stale" on their own.
    func mergedUsage() -> [MergedAccountUsage] {
        var byKey: [String: MergedAccountUsage] = [:]
        for (deviceId, snapshot) in deviceUsage {
            guard let device = devices[deviceId], device.role == .tentacle else { continue }
            for account in snapshot.accounts {
                if var merged = byKey[account.accountKey] {
                    merged.devices.append(device)
                    let newer = (account.fetchedDate ?? .distantPast) > (merged.account.fetchedDate ?? .distantPast)
                    // A fresh successful reading beats a newer failed one.
                    if (newer && (account.error == nil || merged.account.error != nil))
                        || (merged.account.error != nil && account.error == nil) {
                        merged.account = account
                    }
                    byKey[account.accountKey] = merged
                } else {
                    byKey[account.accountKey] = MergedAccountUsage(account: account, devices: [device])
                }
            }
        }
        return byKey.values.map { m in
            var m = m
            m.devices.sort { ($0.online ? 0 : 1, $0.name) < ($1.online ? 0 : 1, $1.name) }
            return m
        }
        .filter { !$0.allOffline || !$0.account.windows.isEmpty }
        .sorted { a, b in
            (a.allOffline ? 1 : 0, a.account.provider, a.account.label ?? "") < (b.allOffline ? 1 : 0, b.account.provider, b.account.label ?? "")
        }
    }

    /// The account a Session is spending: the one on its device signed in by its
    /// agent (and, for Pi, matching its model's provider). Nil when ambiguous.
    func accountKey(forSessionOn deviceId: String, agent: String, model: String?) -> String? {
        guard let accounts = deviceUsage[deviceId]?.accounts else { return nil }
        var candidates = accounts.filter { $0.agents?.contains(agent) ?? false }
        if let provider = AccountUsage.provider(forModel: model) {
            candidates = candidates.filter { $0.provider == provider }
        }
        return candidates.count == 1 ? candidates[0].accountKey : nil
    }
}
