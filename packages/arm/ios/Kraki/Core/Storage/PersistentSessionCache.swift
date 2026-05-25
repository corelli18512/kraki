/// PersistentSessionCache — Disk-backed snapshot of session metadata.
///
/// Mirrors the on-launch UX of WhatsApp/Telegram/iMessage: on cold launch
/// we hydrate the session list from this cache so the user lands on a
/// populated view rather than a blank screen while the WS reconnects.
/// The cache is overwritten by authoritative `session_list` data as soon
/// as it arrives.
///
/// Storage:
///   <ApplicationSupport>/SessionCache/state.json
///
/// Persisted fields:
///   - sessions: [String: SessionInfo]   (stable card metadata)
///   - previews: [String: SessionPreview] (preview text/type/timestamp)
///
/// Transient session fields (`activity`, `currentToolName`, etc.) are
/// intentionally NOT persisted: on cold launch the "what is this session
/// doing right now" state is stale by definition. They default to `.none`
/// / nil and the live message stream backfills them.
///
/// Saves are debounced (1s) to avoid disk-thrash during message bursts.
/// `flushNow()` forces a synchronous write on app background / logout.

import Foundation

final class PersistentSessionCache {

    // MARK: - Storage location

    private lazy var cacheFile: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("SessionCache", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("state.json", isDirectory: false)
    }()

    // MARK: - Debounce

    private var pendingSnapshot: Snapshot?
    private var saveTask: DispatchWorkItem?
    private static let saveDebounce: TimeInterval = 1.0

    // MARK: - Wire format

    struct Snapshot: Codable {
        var sessions: [String: SessionInfo]
        var previews: [String: SessionPreview]
    }

    // MARK: - Public API

    /// Synchronous load on init. Returns `nil` if nothing cached or
    /// the file is unreadable / malformed (treated as empty cache).
    func load() -> Snapshot? {
        guard FileManager.default.fileExists(atPath: cacheFile.path),
              let data = try? Data(contentsOf: cacheFile) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    /// Debounced save. Multiple calls within `saveDebounce` coalesce into
    /// a single write. Always uses the latest snapshot at the time the
    /// task fires.
    func save(_ snapshot: Snapshot) {
        pendingSnapshot = snapshot
        saveTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.flushNow()
        }
        saveTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDebounce, execute: task)
    }

    /// Force the pending snapshot to disk immediately. Called from
    /// `handleBackground` / `logout` so the cache is consistent even if
    /// the user kills the app before the debounce fires.
    func flushNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = pendingSnapshot else { return }
        pendingSnapshot = nil
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: cacheFile, options: .atomic)
    }

    /// Wipe the cache (called by logout/reset).
    func clear() {
        saveTask?.cancel()
        saveTask = nil
        pendingSnapshot = nil
        try? FileManager.default.removeItem(at: cacheFile)
    }
}
