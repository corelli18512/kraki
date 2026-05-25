/// PersistentMessageCache — Disk-backed cache for replayed and live messages.
///
/// Mirrors web's IndexedDB `message-db.ts` contract: per-session storage
/// keyed by `(sessionId, seq)` so the warm-up path can answer
/// "do I already have the last 50 messages for this session?" without
/// hitting tentacle. Without it every cold-launch would re-fetch every
/// session listed in `session_list`.
///
/// Storage format mirrors tentacle's `messages.jsonl`: one append-only
/// JSONL file per session, lines are the same `ChatMessage` shape that
/// the in-memory store uses. Loading a session reads the whole file in
/// one go and decodes it; that's an O(n) cost that only happens on
/// demand. The cap (`MAX_PERSISTED_PER_SESSION`) keeps the worst case
/// bounded so the on-disk footprint can't grow forever.
///
/// File layout:
///   <ApplicationSupport>/MessageCache/<sessionId>.jsonl
///
/// Disk writes (append + truncation) are dispatched to a serial
/// background queue so the main actor never blocks on file I/O during
/// message bursts. Reads (`getMessages`, etc.) remain synchronous —
/// they're only invoked off the hot path (warm-up, hydration).
import Foundation

final class PersistentMessageCache {

    /// Hard upper bound on lines kept per session, to keep on-disk
    /// footprint bounded. When exceeded we rewrite the file with only
    /// the newest N lines. Tuned to comfortably hold any realistic
    /// session length the user might want to scroll through offline.
    private static let MAX_PERSISTED_PER_SESSION = 2000

    /// Whether on-disk files are valid JSONL. Set to true once the cache
    /// directory has been ensured. Subsequent writes skip the check.
    private var directoryReady = false

    /// All disk writes (append + truncation) run on this serial queue
    /// so the main actor never blocks on file I/O — important during
    /// live message/tool bursts where truncation can otherwise rewrite
    /// the full file synchronously on the runloop.
    private let ioQueue = DispatchQueue(label: "kraki.MessageCache.io", qos: .utility)

    /// Per-session line count, maintained in memory so `truncateIfNeeded`
    /// doesn't have to read the full file just to count newlines. Reset
    /// (re-counted from disk) lazily on first append per session per
    /// process.
    private var lineCounts: [String: Int] = [:]

    private lazy var cacheDir: URL = {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base.appendingPathComponent("MessageCache", isDirectory: true)
    }()

    // MARK: - Public API

    /// Append a single message to the on-disk log. Caller must guarantee
    /// `seq` is unique for this session. Duplicate seqs in the file are
    /// tolerated — `getMessages` dedupes on read by keeping the latest
    /// entry per seq.
    func appendMessage(_ sessionId: String, _ message: ChatMessage) {
        guard message.seq > 0 else { return }
        appendLines(sessionId, messages: [message])
    }

    /// Append a batch of messages in a single write.
    func appendMessages(_ sessionId: String, _ messages: [ChatMessage]) {
        let valid = messages.filter { $0.seq > 0 }
        guard !valid.isEmpty else { return }
        appendLines(sessionId, messages: valid)
    }

    /// Highest persisted seq for a session, or 0 if nothing cached.
    func getLastSeq(_ sessionId: String) -> Int {
        getMessages(sessionId).last?.seq ?? 0
    }

    /// Highest persisted timestamp for the session, used by warm-up to
    /// classify "eager vs rest" by recency without paying the cost of
    /// loading the full message stream into the in-memory store first.
    /// Returns `nil` if nothing usable is cached.
    func getLastTimestamp(_ sessionId: String) -> Date? {
        let msgs = getMessages(sessionId)
        for m in msgs.reversed() {
            if let ts = m.timestamp, let d = Self.parseISO(ts) { return d }
        }
        return nil
    }

    /// All messages for a session, sorted ascending by seq. Dedupes by
    /// seq (keeps the latest entry written for a given seq).
    func getMessages(_ sessionId: String) -> [ChatMessage] {
        let url = fileURL(sessionId)
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return [] }
        return decodeLines(data)
    }

    /// Messages in [fromSeq, toSeq], sorted ascending by seq. Used by
    /// the future per-session-open gap-load path.
    func getMessagesInRange(_ sessionId: String, fromSeq: Int, toSeq: Int) -> [ChatMessage] {
        let all = getMessages(sessionId)
        return all.filter { $0.seq >= fromSeq && $0.seq <= toSeq }
    }

    /// Count unread-worthy messages in (afterSeq, lastSeq]. Mirrors web's
    /// `checkUnreadFromDb`: only `error`, `permission`, `question`, and
    /// `idle`-following-an-`agent_message` flip the badge. Other types
    /// (active, tool_*, attachment_data, …) silently advance readSeq
    /// without producing a phantom unread.
    func hasUnreadWorthy(_ sessionId: String, afterSeq: Int) -> Bool {
        let msgs = getMessages(sessionId)
        var lastNonTransientWasAgent = false
        for m in msgs where m.seq > afterSeq {
            switch m.type {
            case "error", "permission", "question":
                return true
            case "idle":
                if lastNonTransientWasAgent { return true }
            case "agent_message":
                lastNonTransientWasAgent = true
            case "user_message":
                lastNonTransientWasAgent = false
            default:
                break
            }
        }
        return false
    }

    /// Remove a session's entire cache file. Called on session deletion.
    func deleteSession(_ sessionId: String) {
        let url = fileURL(sessionId)
        try? FileManager.default.removeItem(at: url)
    }

    /// Drop every message in this session's cache file whose seq is
    /// strictly greater than `seq`. Used by tentacle-restart recovery
    /// so we don't re-hydrate stale tail entries on next launch.
    /// Reads the file, filters, rewrites — cheap because the file is
    /// capped at MAX_PERSISTED_PER_SESSION lines.
    func dropMessagesAboveSeq(_ sessionId: String, seq: Int) {
        let url = fileURL(sessionId)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        guard let data = try? Data(contentsOf: url) else { return }
        let all = decodeLines(data)
        let kept = all.filter { $0.seq <= seq }
        guard kept.count != all.count else { return }
        let encoder = JSONEncoder()
        let lines = kept.compactMap { msg -> String? in
            guard let payload = try? encoder.encode(msg),
                  let str = String(data: payload, encoding: .utf8) else { return nil }
            return str
        }.joined(separator: "\n")
        let payload = lines.isEmpty ? Data() : (lines + "\n").data(using: .utf8) ?? Data()
        try? payload.write(to: url, options: .atomic)
    }

    /// Drop every cached file. Called on logout / reset.
    func deleteAll() {
        try? FileManager.default.removeItem(at: cacheDir)
        directoryReady = false
    }

    /// Block until every queued write on the I/O queue has finished.
    /// Used by `AppState.handleBackground()` so messages written
    /// during a burst right before backgrounding aren't lost if iOS
    /// suspends the process before the async writes flush.
    /// Callers should wrap this in a `beginBackgroundTask` so iOS
    /// gives us the few extra seconds needed to complete the
    /// dispatch.
    func drainSync() {
        ioQueue.sync { /* drain — empty body runs after all pending async work */ }
    }

    // MARK: - Internal

    private func fileURL(_ sessionId: String) -> URL {
        ensureDirectory()
        return cacheDir.appendingPathComponent("\(sessionId).jsonl", isDirectory: false)
    }

    private func ensureDirectory() {
        guard !directoryReady else { return }
        try? FileManager.default.createDirectory(
            at: cacheDir, withIntermediateDirectories: true, attributes: nil
        )
        directoryReady = true
    }

    private func appendLines(_ sessionId: String, messages: [ChatMessage]) {
        let encoder = JSONEncoder()
        var blob = Data()
        var lineCount = 0
        for m in messages {
            guard let line = try? encoder.encode(m) else { continue }
            blob.append(line)
            blob.append(0x0A)  // newline
            lineCount += 1
        }
        guard !blob.isEmpty else { return }

        let url = fileURL(sessionId)
        // Off-load the actual file write + truncation pass to the
        // serial I/O queue so the main actor doesn't pay the cost of
        // a potentially full-file rewrite during message bursts.
        ioQueue.async { [weak self] in
            guard let self else { return }
            let fm = FileManager.default
            if !fm.fileExists(atPath: url.path) {
                try? blob.write(to: url, options: .atomic)
            } else if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                do {
                    try handle.seekToEnd()
                    try handle.write(contentsOf: blob)
                } catch {
                    // Fallback: rewrite the whole file by appending in memory.
                    var existing = (try? Data(contentsOf: url)) ?? Data()
                    existing.append(blob)
                    try? existing.write(to: url, options: .atomic)
                }
            }
            self.updateLineCountAndMaybeTruncate(sessionId, url: url, addedLines: lineCount)
        }
    }

    /// Bound the on-disk file at MAX_PERSISTED_PER_SESSION lines,
    /// reading the existing file only when we cross the cap. The
    /// per-session line count is cached so we don't re-scan the file
    /// on every append; we only re-count from disk once per process
    /// (lazy bootstrap).
    private func updateLineCountAndMaybeTruncate(_ sessionId: String, url: URL, addedLines: Int) {
        let current: Int
        if let cached = lineCounts[sessionId] {
            current = cached + addedLines
        } else if let data = try? Data(contentsOf: url) {
            var n = 0
            for byte in data where byte == 0x0A { n += 1 }
            current = n
        } else {
            current = addedLines
        }
        lineCounts[sessionId] = current
        guard current > Self.MAX_PERSISTED_PER_SESSION else { return }

        // Cap exceeded: rewrite with only the newest N lines.
        guard let data = try? Data(contentsOf: url) else { return }
        let parsed = decodeLines(data)
        let keep = Array(parsed.suffix(Self.MAX_PERSISTED_PER_SESSION))
        let encoder = JSONEncoder()
        var rewritten = Data()
        for m in keep {
            guard let line = try? encoder.encode(m) else { continue }
            rewritten.append(line)
            rewritten.append(0x0A)
        }
        try? rewritten.write(to: url, options: .atomic)
        lineCounts[sessionId] = keep.count
    }

    private func decodeLines(_ data: Data) -> [ChatMessage] {
        let decoder = JSONDecoder()
        var bySeq: [Int: ChatMessage] = [:]
        // Iterate newline-delimited slices in place to avoid the cost of
        // a String(data:) conversion on large blobs.
        var start = data.startIndex
        for i in data.indices {
            if data[i] == 0x0A {
                if i > start {
                    let slice = data[start..<i]
                    if let msg = try? decoder.decode(ChatMessage.self, from: slice), msg.seq > 0 {
                        bySeq[msg.seq] = msg
                    }
                }
                start = data.index(after: i)
            }
        }
        // Trailing line without newline
        if start < data.endIndex {
            let slice = data[start..<data.endIndex]
            if let msg = try? decoder.decode(ChatMessage.self, from: slice), msg.seq > 0 {
                bySeq[msg.seq] = msg
            }
        }
        return bySeq.values.sorted { $0.seq < $1.seq }
    }

    private static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
