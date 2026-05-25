/// PersistentDeviceCache — Disk-backed snapshot of device metadata.
///
/// Companion to `PersistentSessionCache`. Hydrates the Devices tab and
/// per-session device-name lookups on cold launch so the user lands on a
/// populated UI rather than a blank screen while the WS reconnects.
///
/// On load every cached device is forced `online = false` — we don't
/// know its real online state until the relay's `auth_ok` device list
/// arrives. The cache exists to populate names/kinds/keys, not to claim
/// authoritative online status.
///
/// Storage:
///   <ApplicationSupport>/SessionCache/devices.json

import Foundation

final class PersistentDeviceCache {

    // MARK: - Storage location

    private lazy var cacheFile: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("SessionCache", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("devices.json", isDirectory: false)
    }()

    // MARK: - Debounce

    private var pendingSnapshot: Snapshot?
    private var saveTask: DispatchWorkItem?
    private static let saveDebounce: TimeInterval = 1.0

    // MARK: - Wire format

    struct Snapshot: Codable {
        var devices: [String: DeviceSummary]
        var deviceModels: [String: [String]]
        var deviceModelDetails: [String: [ModelDetail]]
        var deviceVersions: [String: String]
    }

    // MARK: - Public API

    /// Synchronous load on init. Returns `nil` on empty / malformed cache.
    /// All restored devices are forced `online = false` — authoritative
    /// online state is set by `auth_ok` / `device_joined`.
    func load() -> Snapshot? {
        guard FileManager.default.fileExists(atPath: cacheFile.path),
              let data = try? Data(contentsOf: cacheFile) else { return nil }
        guard var snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return nil }
        for (id, var device) in snapshot.devices {
            device.online = false
            snapshot.devices[id] = device
        }
        return snapshot
    }

    /// Debounced save. Multiple calls within `saveDebounce` coalesce.
    func save(_ snapshot: Snapshot) {
        pendingSnapshot = snapshot
        saveTask?.cancel()
        let task = DispatchWorkItem { [weak self] in self?.flushNow() }
        saveTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDebounce, execute: task)
    }

    /// Force pending snapshot to disk immediately.
    func flushNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: cacheFile, options: .atomic)
    }

    func clear() {
        saveTask?.cancel()
        saveTask = nil
        pendingSnapshot = nil
        try? FileManager.default.removeItem(at: cacheFile)
    }
}
