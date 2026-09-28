/// AttachmentStore — lazy, low-priority loading of `ContentRef` bytes
/// (images, HTML reports, tool arguments/results).
///
/// Attachments share one relay connection with chat messages and liveness
/// pings, and the relay link can be only a few Mbps. Bytes are therefore
/// never pulled speculatively: something must be on screen (`.visible`) or
/// explicitly opened by the user (`.userOpened`). Transfers are paced —
/// one chunk per request, at most one chunk in flight — so a transfer can
/// never queue megabytes in front of chat traffic, and a higher-priority
/// request (the report the user just opened) takes over between chunks.
///
///   nil            ← nothing wanted (or released while off-screen)
///   fetching       ← wanted; waiting for its turn / disk / first chunk
///   awaitingChunks ← partially received (partial chunks survive pauses,
///                    reconnects and scrolling away)
///   ready          ← assembled and cached on disk
///   error          ← server error or repeated timeouts; a new request retries
///
/// Disk cache: `<caches>/kraki-attachments/<id>` + `<id>.json`. Ids are
/// content hashes, so the cache is shared across sessions; the OS may purge
/// it and the tentacle still holds the source bytes.

import Foundation
import Observation

/// Public state surfaced to views.
enum AttachmentState: Equatable {
    case awaitingChunks(received: Int, total: Int?)
    case fetching
    case ready(mimeType: String, data: Data)
    case error(reason: String)
}

/// Why a view wants an attachment. Higher values are served first.
enum AttachmentPriority: Int, Comparable {
    /// On screen (an inline image). Starts after a short dwell so fast
    /// scrolling does not start transfers; released when it scrolls away.
    case visible = 1
    /// The user opened it (a report, an expanded tool step).
    case userOpened = 2

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum HTMLArtifactSecurity {
    static let maxBytes = 10 * 1024 * 1024

    private static let csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; connect-src 'none'; media-src 'none'; manifest-src 'none'; worker-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;\">"

    static func securedHTML(_ html: String) -> String {
        let cspPattern = #"<meta[^>]+http-equiv\s*=\s*[\"']Content-Security-Policy[\"'][^>]*>"#
        if let regex = try? NSRegularExpression(pattern: cspPattern, options: [.caseInsensitive]),
           regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)) != nil {
            return regex.stringByReplacingMatches(
                in: html,
                range: NSRange(html.startIndex..., in: html),
                withTemplate: NSRegularExpression.escapedTemplate(for: csp)
            )
        }

        let headPattern = #"<head(?:\s[^>]*)?>"#
        if let regex = try? NSRegularExpression(pattern: headPattern, options: [.caseInsensitive]),
           let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
           let range = Range(match.range, in: html) {
            var result = html
            result.insert(contentsOf: csp, at: range.upperBound)
            return result
        }
        return csp + html
    }
}

/// Observable store. Views read `store.state(for: id)` and SwiftUI
/// re-renders when the underlying dictionary mutates.
@Observable
final class AttachmentStore {

    // MARK: - Tunables

    /// Dwell before a merely-visible attachment starts transferring.
    @ObservationIgnored private let visibleDwell: TimeInterval
    /// A paced chunk that has not arrived by then is re-requested.
    @ObservationIgnored private let chunkTimeout: TimeInterval
    /// Consecutive timeouts before surfacing an error (the user can retry).
    static let maxAttempts = 3

    // MARK: - State

    /// Per-id public state observed by views.
    private(set) var states: [String: AttachmentState] = [:]

    private struct Want {
        var sessionId: String
        var priority: AttachmentPriority
        var order: Int
    }

    private struct InFlight {
        let id: String
        let index: Int
        let generation: Int
    }

    @ObservationIgnored private var wants: [String: Want] = [:]
    @ObservationIgnored private var nextOrder = 0
    @ObservationIgnored private var dwellWork: [String: DispatchWorkItem] = [:]
    @ObservationIgnored private var inFlight: InFlight?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var timeoutWork: DispatchWorkItem?
    @ObservationIgnored private var attempts: [String: Int] = [:]
    /// Ids an older tentacle is streaming whole (it ignores `paced`); wait
    /// for the stream instead of requesting more chunks.
    @ObservationIgnored private var streamingWhole: Set<String> = []
    @ObservationIgnored private var hydrating: Set<String> = []
    @ObservationIgnored private(set) var transportReady = false

    /// Chunk buffers (index → base64) kept across pauses so a transfer
    /// resumes where it stopped.
    @ObservationIgnored private var pendingChunks: [String: [Int: String]] = [:]
    @ObservationIgnored private var pendingTotal: [String: Int] = [:]

    /// Sends `request_attachment {mode: paced, index}` for (id, sessionId,
    /// index); false when it could not be handed to the transport.
    @ObservationIgnored private let requestChunk: (String, String, Int) -> Bool
    @ObservationIgnored private var retryWork: DispatchWorkItem?

    /// Ready bytes kept in memory for views that released them (LRU,
    /// oldest first). Views still showing an attachment are never evicted;
    /// evicted entries reload from the disk cache when shown again.
    @ObservationIgnored private var releasedReady: [String] = []
    @ObservationIgnored private var persisted: Set<String> = []
    static let memoryBudgetBytes = 64 * 1024 * 1024
    static let diskBudgetBytes: Int64 = 512 * 1024 * 1024

    // MARK: - Disk layout

    @ObservationIgnored private let diskQueue = DispatchQueue(
        label: "cloud.corelli.kraki.attachments.disk",
        qos: .utility
    )

    @ObservationIgnored private let cacheDir: URL

    init(
        cacheDirectory: URL = KrakiDataPaths.attachmentCacheDirectory(),
        visibleDwell: TimeInterval = 0.3,
        chunkTimeout: TimeInterval = 30,
        requestChunk: @escaping (String, String, Int) -> Bool
    ) {
        self.cacheDir = cacheDirectory
        self.visibleDwell = visibleDwell
        self.chunkTimeout = chunkTimeout
        self.requestChunk = requestChunk
        let dir = cacheDirectory
        diskQueue.async { Self.trimDiskCache(dir, budget: Self.diskBudgetBytes) }
    }

    // MARK: - Public API

    /// Current state for an id; views observe it.
    func state(for id: String) -> AttachmentState? {
        states[id]
    }

    /// A view needs these bytes. Cached bytes load from disk; otherwise the
    /// attachment joins the paced transfer queue at `priority` (raising the
    /// priority of an existing request). A request after an error retries.
    @MainActor
    func requestIfNeeded(id: String, sessionId: String, priority: AttachmentPriority = .visible) {
        releasedReady.removeAll { $0 == id }
        if case .ready = states[id] { return }
        if hydrating.contains(id) { return }
        if case .error = states[id] {
            attempts[id] = nil
            states[id] = nil
        }
        if wants[id] == nil, hasOnDisk(id: id) {
            if states[id] == nil { states[id] = .fetching }
            hydrateFromDiskAsync(id: id, sessionId: sessionId, priority: priority)
            return
        }
        if priority == .visible, wants[id] == nil {
            guard dwellWork[id] == nil else { return }
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.dwellWork[id] = nil
                self.want(id: id, sessionId: sessionId, priority: .visible)
            }
            dwellWork[id] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + visibleDwell, execute: work)
            return
        }
        dwellWork.removeValue(forKey: id)?.cancel()
        want(id: id, sessionId: sessionId, priority: priority)
    }

    /// The view that wanted `id` went away (scrolled off, closed). Merely
    /// visible requests stop; received chunks are kept for later.
    @MainActor
    func release(id: String, priority: AttachmentPriority = .visible) {
        dwellWork.removeValue(forKey: id)?.cancel()
        if case .ready = states[id] {
            releasedReady.removeAll { $0 == id }
            releasedReady.append(id)
            evictMemoryIfNeeded()
        }
        guard let want = wants[id], want.priority <= priority else { return }
        wants[id] = nil
        switch states[id] {
        case .fetching:
            states[id] = nil
        default:
            break
        }
    }

    /// Transfers run only on an authenticated connection. Losing it drops
    /// the in-flight marker (the chunk may be lost); partial chunks stay.
    @MainActor
    func setTransportReady(_ ready: Bool) {
        guard ready != transportReady else { return }
        transportReady = ready
        if !ready {
            clearInFlight()
            streamingWhole.removeAll()
        }
        pump()
    }

    /// Process an inbound `attachment_data` chunk. May be called off the
    /// main thread; state changes hop to the main actor. `paced` is the
    /// tentacle's echo that it served exactly this chunk on request.
    nonisolated func ingestChunk(
        id: String,
        index: Int,
        total: Int,
        mimeType: String,
        data: String,
        error: String?,
        paced: Bool = false
    ) {
        Task { @MainActor in
            self.handleChunk(id: id, index: index, total: total, mimeType: mimeType, data: data, error: error, paced: paced)
        }
    }

    #if DEBUG
    /// Test introspection: the chunk currently requested, if any.
    var inFlightForTesting: (id: String, index: Int)? {
        inFlight.map { ($0.id, $0.index) }
    }
    #endif

    // MARK: - Scheduling

    @MainActor
    private func want(id: String, sessionId: String, priority: AttachmentPriority) {
        if var existing = wants[id] {
            if priority > existing.priority {
                existing.priority = priority
                wants[id] = existing
            }
        } else {
            nextOrder += 1
            wants[id] = Want(sessionId: sessionId, priority: priority, order: nextOrder)
            if states[id] == nil { states[id] = .fetching }
        }
        pump()
    }

    /// Request the next chunk of the most important wanted attachment.
    @MainActor
    private func pump() {
        guard transportReady, inFlight == nil else { return }
        guard let (id, want) = wants
            .filter({ !hydrating.contains($0.key) })
            .max(by: { a, b in
                a.value.priority != b.value.priority
                    ? a.value.priority < b.value.priority
                    : a.value.order > b.value.order
            }) else { return }
        let received = pendingChunks[id] ?? [:]
        var index = 0
        while received[index] != nil { index += 1 }
        if let total = pendingTotal[id], index >= total { return }
        generation += 1
        let flight = InFlight(id: id, index: index, generation: generation)
        inFlight = flight
        armTimeout(for: flight)
        guard requestChunk(id, want.sessionId, index) else {
            // Not handed to the transport (e.g. the session's tentacle is
            // unknown right now). Retry shortly without spending an attempt.
            clearInFlight()
            scheduleRetry()
            return
        }
    }

    @MainActor
    private func scheduleRetry() {
        guard retryWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.retryWork = nil
            self?.pump()
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    @MainActor
    private func evictMemoryIfNeeded() {
        var total = releasedReady.reduce(0) { sum, id in
            if case .ready(_, let data) = states[id] { return sum + data.count }
            return sum
        }
        var index = 0
        while total > Self.memoryBudgetBytes, index < releasedReady.count {
            let id = releasedReady[index]
            guard persisted.contains(id), case .ready(_, let data) = states[id] else { index += 1; continue }
            total -= data.count
            states[id] = nil
            releasedReady.remove(at: index)
        }
    }

    @MainActor
    private func armTimeout(for flight: InFlight) {
        timeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.chunkTimedOut(flight)
        }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + chunkTimeout, execute: work)
    }

    @MainActor
    private func clearInFlight() {
        inFlight = nil
        timeoutWork?.cancel()
        timeoutWork = nil
    }

    @MainActor
    private func chunkTimedOut(_ flight: InFlight) {
        guard inFlight?.generation == flight.generation else { return }
        clearInFlight()
        streamingWhole.remove(flight.id)
        let count = (attempts[flight.id] ?? 0) + 1
        attempts[flight.id] = count
        if count >= Self.maxAttempts {
            wants[flight.id] = nil
            attempts[flight.id] = nil
            states[flight.id] = .error(reason: "Timed out loading this attachment")
        }
        pump()
    }

    // MARK: - Chunks

    @MainActor
    private func handleChunk(
        id: String,
        index: Int,
        total: Int,
        mimeType: String,
        data: String,
        error: String?,
        paced: Bool
    ) {
        let wasInFlight = inFlight?.id == id
        if let error {
            if wasInFlight { clearInFlight() }
            wants[id] = nil
            attempts[id] = nil
            streamingWhole.remove(id)
            pendingChunks[id] = nil
            pendingTotal[id] = nil
            states[id] = .error(reason: error)
            pump()
            return
        }
        if case .ready = states[id] { return }

        var buffer = pendingChunks[id] ?? [:]
        buffer[index] = data
        pendingChunks[id] = buffer
        pendingTotal[id] = total
        attempts[id] = nil

        if buffer.count >= total {
            var assembled = Data()
            for i in 0..<total {
                if let b64 = buffer[i], let chunk = Data(base64Encoded: b64) {
                    assembled.append(chunk)
                }
            }
            pendingChunks[id] = nil
            pendingTotal[id] = nil
            wants[id] = nil
            streamingWhole.remove(id)
            states[id] = .ready(mimeType: mimeType, data: assembled)
            persistToDisk(id: id, mimeType: mimeType, data: assembled)
            if wasInFlight { clearInFlight() }
            pump()
            return
        }

        if wants[id] != nil || wasInFlight {
            states[id] = .awaitingChunks(received: buffer.count, total: total)
        }
        guard wasInFlight, let flight = inFlight else { return }
        if paced {
            // Exactly the requested chunk: choose the next (possibly a
            // higher-priority attachment) now.
            clearInFlight()
            pump()
        } else {
            // An older tentacle streams the whole file for one request. Do
            // not request more; keep waiting while chunks keep coming.
            streamingWhole.insert(id)
            armTimeout(for: flight)
        }
    }

    // MARK: - Disk cache

    fileprivate struct DiskMeta: Codable {
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

    /// Read cached bytes off the main thread. A corrupt or purged cache
    /// entry falls back to the network queue at the caller's priority.
    @MainActor
    private func hydrateFromDiskAsync(id: String, sessionId: String, priority: AttachmentPriority) {
        hydrating.insert(id)
        let bytesPath = bytesURL(id)
        let metaPath = metaURL(id)
        diskQueue.async { [weak self] in
            guard let self else { return }
            let result: (mimeType: String, data: Data)?
            do {
                let data = try Data(contentsOf: bytesPath)
                let meta = try JSONDecoder().decode(DiskMeta.self, from: Data(contentsOf: metaPath))
                result = (meta.mimeType, data)
                let updated = DiskMeta(
                    mimeType: meta.mimeType,
                    size: meta.size,
                    lastAccessed: Date().timeIntervalSince1970
                )
                if let blob = try? JSONEncoder().encode(updated) {
                    try? blob.write(to: metaPath, options: .atomic)
                }
            } catch {
                try? FileManager.default.removeItem(at: bytesPath)
                try? FileManager.default.removeItem(at: metaPath)
                result = nil
            }
            Task { @MainActor in
                self.hydrating.remove(id)
                guard let result else {
                    self.states[id] = nil
                    self.requestIfNeeded(id: id, sessionId: sessionId, priority: priority)
                    return
                }
                self.persisted.insert(id)
                self.states[id] = .ready(mimeType: result.mimeType, data: result.data)
            }
        }
    }

    /// Keeps the disk cache under `budget`, dropping least recently used
    /// entries (by recorded access time, else file date).
    static func trimDiskCache(_ dir: URL, budget: Int64) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        var entries: [(id: String, size: Int64, used: TimeInterval)] = []
        var total: Int64 = 0
        for name in names where !name.hasSuffix(".json") {
            let bytes = dir.appendingPathComponent(name)
            let attrs = try? fm.attributesOfItem(atPath: bytes.path)
            let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
            var used = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            if let data = try? Data(contentsOf: dir.appendingPathComponent(name + ".json")),
               let meta = try? JSONDecoder().decode(DiskMeta.self, from: data) {
                used = meta.lastAccessed
            }
            entries.append((name, size, used))
            total += size
        }
        guard total > budget else { return }
        for entry in entries.sorted(by: { $0.used < $1.used }) where total > budget {
            try? fm.removeItem(at: dir.appendingPathComponent(entry.id))
            try? fm.removeItem(at: dir.appendingPathComponent(entry.id + ".json"))
            total -= entry.size
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
        diskQueue.async { [weak self] in
            try? data.write(to: bytesPath, options: .atomic)
            if let blob = try? JSONEncoder().encode(meta) {
                try? blob.write(to: metaPath, options: .atomic)
            }
            Task { @MainActor in self?.persisted.insert(id) }
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
