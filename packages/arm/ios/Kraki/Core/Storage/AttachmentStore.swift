#if os(iOS)
/// AttachmentStore — chunk reassembly + disk-backed cache for lazy
/// content referenced by `ContentRef`.
///
/// Mirrors the web client's `packages/arm/web/src/lib/attachments.ts`:
///
///   awaiting-chunks  ← message router calls markAwaitingPush() when a
///                       fresh tool_start / tool_complete / agent_message
///                       carrying a ContentRef arrives. Chunks land via
///                       `attachment_data` envelopes.
///   fetching         ← UI explicitly triggered a pull (e.g. cold replay,
///                       or a safety-timeout fallback after no push
///                       arrived in PUSH_TIMEOUT_MS).
///   ready            ← bytes assembled & persisted; available to UI.
///   error            ← chunk-level error or pull failed.
///
/// Storage:
///   - In-memory state machine + chunk buffers per id (this class).
///   - Disk cache at `<caches>/kraki-attachments/<id>` (raw bytes) +
///     `<id>.json` (mimeType, size, lastAccessed). Disk is a
///     content-addressed flat directory; ids are sha256 hex so collisions
///     across sessions are intentional (dedup).
///   - The OS may purge the caches directory under pressure; that's safe
///     since the tentacle still holds the source bytes and we can refetch.

import Foundation
import Observation

/// Public state surfaced to views.
enum AttachmentState: Equatable {
    case awaitingChunks(received: Int, total: Int?)
    case fetching
    case ready(mimeType: String, data: Data)
    case error(reason: String)
}

/// Observable store. Views read `store.state(for: id)` and SwiftUI
/// re-renders when the underlying dictionary mutates.
@Observable
final class AttachmentStore {

    // MARK: - Tunables

    /// Time we'll wait for the first chunk to arrive after marking a ref
    /// awaiting-push, before falling back to an explicit
    /// `request_attachment` pull. Matches the web client's value.
    private let pushTimeoutSeconds: TimeInterval = 10.0

    // MARK: - State

    /// Per-id public state observed by views.
    private(set) var states: [String: AttachmentState] = [:]

    /// Per-id chunk buffer during assembly. Map from chunk index → base64
    /// string. Kept separate from `states` so the observable dict isn't
    /// invalidated on every chunk arrival; we publish state transitions
    /// to `states` at coarser granularity.
    @ObservationIgnored private var pendingChunks: [String: [Int: String]] = [:]
    @ObservationIgnored private var pendingTotal: [String: Int] = [:]
    @ObservationIgnored private var pendingMimeType: [String: String] = [:]
    @ObservationIgnored private var pendingStartedAt: [String: Date] = [:]

    /// Per-id callbacks scheduled to fire if push timeout elapses with no
    /// chunks. Cancelled on first chunk / ingest / completion.
    @ObservationIgnored private var pushTimers: [String: DispatchSourceTimer] = [:]

    /// Closure used to issue `request_attachment` messages. Injected by
    /// `AppState` at construction time so AttachmentStore stays
    /// network-agnostic and easy to unit test.
    @ObservationIgnored private let requestPull: (String, String) -> Void

    /// Lock for the chunk buffers and timers. The store is owned by
    /// `@MainActor` `AppState`, so most calls are already main-actor;
    /// `attachment_data` may arrive on the WS thread, so we serialize
    /// chunk ingest defensively.
    @ObservationIgnored private let lock = NSLock()

    // MARK: - Disk layout

    @ObservationIgnored private let diskQueue = DispatchQueue(
        label: "cloud.corelli.kraki.attachments.disk",
        qos: .utility
    )

    @ObservationIgnored private let cacheDir: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("kraki-attachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// Construct with a `requestPull` closure that maps (id, sessionId)
    /// → outbound `request_attachment` envelope. Injected so we don't
    /// import AppState here.
    init(requestPull: @escaping (String, String) -> Void) {
        self.requestPull = requestPull
    }

    // MARK: - Public API

    /// Current state for an id. Views should use this; it triggers
    /// observation tracking via the `states` dict.
    func state(for id: String) -> AttachmentState? {
        return states[id]
    }

    /// Called by the router for every ContentRef encountered in a LIVE
    /// message (tool_start, tool_complete, agent_message with attachments).
    /// Schedules a push timeout; once chunks arrive the timeout is
    /// cancelled in `ingestChunk`.
    @MainActor
    func markAwaitingPush(id: String, sessionId: String) {
        if let existing = states[id],
           case .ready = existing { return }
        if let existing = states[id],
           case .awaitingChunks = existing { return }
        if let existing = states[id],
           case .fetching = existing { return }

        // If the bytes are already on disk, kick off an async hydrate
        // and skip the push timer. Reads of large images (multi-MB)
        // would otherwise stall the runloop if done synchronously.
        if hasOnDisk(id: id) {
            states[id] = .fetching
            hydrateFromDiskAsync(id: id)
            return
        }

        states[id] = .awaitingChunks(received: 0, total: nil)
        pendingChunks[id] = [:]
        pendingTotal.removeValue(forKey: id)
        pendingMimeType.removeValue(forKey: id)
        pendingStartedAt[id] = Date()

        schedulePushTimeout(id: id, sessionId: sessionId)
    }

    /// Called by the UI when it wants to display an attachment whose ref
    /// it just saw — typically on a tool-bubble expand, or when a session
    /// is replayed from cold storage. We:
    ///   1) hydrate from disk if cached, else
    ///   2) if not already in flight, dispatch a `request_attachment`.
    @MainActor
    func requestIfNeeded(id: String, sessionId: String) {
        if case .ready = states[id] { return }
        if case .awaitingChunks = states[id] { return }
        if case .fetching = states[id] { return }

        if hasOnDisk(id: id) {
            states[id] = .fetching
            hydrateFromDiskAsync(id: id)
            return
        }
        states[id] = .fetching
        requestPull(id, sessionId)
    }

    /// Process an inbound `attachment_data` chunk. May run on the WS
    /// thread; we bounce to MainActor before mutating observable state.
    nonisolated func ingestChunk(
        id: String,
        index: Int,
        total: Int,
        mimeType: String,
        data: String,
        error: String?
    ) {
        Task { @MainActor in
            self.handleChunk(id: id, index: index, total: total, mimeType: mimeType, data: data, error: error)
        }
    }

    // MARK: - Internals

    @MainActor
    private func handleChunk(
        id: String,
        index: Int,
        total: Int,
        mimeType: String,
        data: String,
        error: String?
    ) {
        cancelPushTimeout(id: id)

        if let error {
            states[id] = .error(reason: error)
            pendingChunks.removeValue(forKey: id)
            pendingTotal.removeValue(forKey: id)
            pendingMimeType.removeValue(forKey: id)
            pendingStartedAt.removeValue(forKey: id)
            return
        }

        lock.lock()
        var buf = pendingChunks[id] ?? [:]
        buf[index] = data
        pendingChunks[id] = buf
        pendingTotal[id] = total
        pendingMimeType[id] = mimeType
        let receivedCount = buf.count
        lock.unlock()

        if receivedCount < total {
            states[id] = .awaitingChunks(received: receivedCount, total: total)
            return
        }

        // Assemble bytes in order.
        lock.lock()
        let sorted = (pendingChunks[id] ?? [:]).sorted { $0.key < $1.key }
        lock.unlock()
        var assembled = Data()
        for (_, b64) in sorted {
            if let chunk = Data(base64Encoded: b64) {
                assembled.append(chunk)
            }
        }

        pendingChunks.removeValue(forKey: id)
        pendingTotal.removeValue(forKey: id)
        pendingMimeType.removeValue(forKey: id)
        pendingStartedAt.removeValue(forKey: id)

        states[id] = .ready(mimeType: mimeType, data: assembled)
        persistToDisk(id: id, mimeType: mimeType, data: assembled)
    }

    @MainActor
    private func schedulePushTimeout(id: String, sessionId: String) {
        cancelPushTimeout(id: id)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + pushTimeoutSeconds)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // Only pull if we're still waiting and have received no chunks.
            if case .awaitingChunks(let received, _) = self.states[id], received == 0 {
                KLog.d("⏱ attachment \(id.prefix(8)) push timeout — pulling")
                self.states[id] = .fetching
                self.requestPull(id, sessionId)
            }
        }
        timer.resume()
        pushTimers[id] = timer
    }

    @MainActor
    private func cancelPushTimeout(id: String) {
        if let t = pushTimers.removeValue(forKey: id) {
            t.cancel()
        }
    }

    // MARK: - Disk cache

    private struct DiskMeta: Codable {
        let mimeType: String
        let size: Int
        let lastAccessed: TimeInterval
    }

    private func bytesURL(_ id: String) -> URL {
        cacheDir.appendingPathComponent(id, isDirectory: false)
    }

    private func metaURL(_ id: String) -> URL {
        cacheDir.appendingPathComponent("\(id).json", isDirectory: false)
    }

    /// Quick cheap existence check that doesn't read any bytes.
    /// Safe to call on MainActor.
    private func hasOnDisk(id: String) -> Bool {
        FileManager.default.fileExists(atPath: bytesURL(id).path)
            && FileManager.default.fileExists(atPath: metaURL(id).path)
    }

    /// Read the cached attachment bytes on the disk queue and publish
    /// the result back to MainActor. Large images (multi-MB) can stall
    /// many frames if read synchronously on the main thread, so we
    /// offload the actual `Data(contentsOf:)` call.
    @MainActor
    private func hydrateFromDiskAsync(id: String) {
        let bytesPath = bytesURL(id)
        let metaPath = metaURL(id)
        diskQueue.async { [weak self] in
            guard let self else { return }
            let result: (mimeType: String, data: Data)?
            do {
                let data = try Data(contentsOf: bytesPath)
                let meta = try JSONDecoder().decode(DiskMeta.self, from: Data(contentsOf: metaPath))
                result = (meta.mimeType, data)
                // Touch lastAccessed for future eviction.
                let updated = DiskMeta(
                    mimeType: meta.mimeType,
                    size: meta.size,
                    lastAccessed: Date().timeIntervalSince1970
                )
                if let blob = try? JSONEncoder().encode(updated) {
                    try? blob.write(to: metaPath, options: .atomic)
                }
            } catch {
                result = nil
            }
            Task { @MainActor in
                guard let result else {
                    // Fall through to the network path — disk read
                    // failed mid-flight (corrupt cache, etc.).
                    self.states[id] = .fetching
                    return
                }
                self.states[id] = .ready(mimeType: result.mimeType, data: result.data)
            }
        }
    }

    /// Synchronous hydrate; bytes are usually small enough to read on
    /// MainActor without stuttering. Returns nil if absent. Retained
    /// for callers that genuinely need a synchronous result; for the
    /// hot UI path use `hydrateFromDiskAsync` instead.
    private func hydrateFromDisk(id: String) -> (mimeType: String, data: Data)? {
        let bytesPath = bytesURL(id)
        let metaPath = metaURL(id)
        guard FileManager.default.fileExists(atPath: bytesPath.path),
              FileManager.default.fileExists(atPath: metaPath.path) else { return nil }
        do {
            let data = try Data(contentsOf: bytesPath)
            let meta = try JSONDecoder().decode(DiskMeta.self, from: Data(contentsOf: metaPath))
            // Touch lastAccessed so eviction (when we add it) is honest.
            // Cheap fire-and-forget on disk queue.
            diskQueue.async { [metaPath, meta] in
                let updated = DiskMeta(
                    mimeType: meta.mimeType,
                    size: meta.size,
                    lastAccessed: Date().timeIntervalSince1970
                )
                if let blob = try? JSONEncoder().encode(updated) {
                    try? blob.write(to: metaPath, options: .atomic)
                }
            }
            return (meta.mimeType, data)
        } catch {
            return nil
        }
    }

    private func persistToDisk(id: String, mimeType: String, data: Data) {
        let bytesPath = bytesURL(id)
        let metaPath = metaURL(id)
        let meta = DiskMeta(
            mimeType: mimeType,
            size: data.count,
            lastAccessed: Date().timeIntervalSince1970
        )
        diskQueue.async {
            try? data.write(to: bytesPath, options: .atomic)
            if let blob = try? JSONEncoder().encode(meta) {
                try? blob.write(to: metaPath, options: .atomic)
            }
        }
    }

    // MARK: - Convenience

    /// UTF-8 decoded text for a ready attachment, else nil. Used by
    /// tool-args / tool-result expanded bodies.
    func text(for id: String) -> String? {
        if case .ready(_, let data) = states[id] {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}
#endif
