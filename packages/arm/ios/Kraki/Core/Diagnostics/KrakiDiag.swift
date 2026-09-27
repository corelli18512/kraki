#if KRAKI_DIAG
import Foundation
import CryptoKit

/// Facade is compiled out in ordinary Debug/Release, as are all call sites.
/// No E2E message, text hash, transcript, URL, token or localized error is recorded.
enum KrakiDiag {
    static let recorder = DiagRecorder()
    private static let client = DiagClient(recorder: recorder)
    private static let contextKey = "KrakiDiag.interaction"
    private static let answerLock = NSLock()
    private static var answers: [String: TimeInterval] = [:]

    private static let once: Void = {
        client.start(); record(.launch)
        DispatchQueue.main.async { DiagRunLoop.shared.start() }
    }()
    static func start() { _ = once }
    static func record(_ name: DiagEventName, session: String? = nil, _ fields: [DiagField: DiagValue] = [:]) {
        guard recorder.record(name, session: session, fields) else { return }
        switch name {
        case .answer, .input, .handoff, .outbox, .echo, .phase, .busy, .marker: client.requestFlush()
        default: break
        }
    }
    static func configure(relay: String, device: String, sign: @escaping (String) throws -> String) {
        client.configure(relay: relay, device: device, sign: sign)
    }
    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "kraki.diag.enabled")
        recorder.setEnabled(enabled)
        client.setEnabled(enabled)
    }
    static func phase(_ phase: String, pending: Int = 0) {
        record(.phase, [.phase: .tag(phase), .pending: .int(pending)])
        if phase == "active" {
            client.setForeground(true)
            DispatchQueue.main.async { DiagRunLoop.shared.setActive(true) }
        }
        if phase == "background" || phase == "inactive" {
            client.setForeground(false)
            DispatchQueue.main.async { DiagRunLoop.shared.setActive(false) }
        }
        if phase == "logout" { client.logout() }
    }
    static func beginWork() -> TimeInterval? {
        recorder.isEnabled ? ProcessInfo.processInfo.systemUptime : nil
    }
    static func endWork(_ start: TimeInterval?, source: String, session: String? = nil, seq: Int? = nil) {
        guard let start else { return }
        let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
        guard ms >= 8 else { return }
        var fields: [DiagField: DiagValue] = [.source: .tag(source), .durationMs: .number(ms)]
        if let seq { fields[.messageSeq] = .int(seq) }
        record(.slowWork, session: session, fields)
    }
    static var interaction: String? { Thread.current.threadDictionary[contextKey] as? String }
    static var stack: String {
        guard recorder.isEnabled else { return "0x0" }
        return Thread.callStackReturnAddresses.prefix(12).map { "0x" + String($0.uint64Value, radix: 16) }.joined(separator: ",")
    }

    /// Scoped only over the existing synchronous callback. No gesture is added;
    /// no association is guessed for unrelated layouts in the following 500 ms.
    @discardableResult
    static func withAnswerInteraction<T>(session: String, question: String, origin: String,
                                         body: () throws -> T) rethrows -> T {
        guard recorder.isEnabled else { return try body() }
        let previous = Thread.current.threadDictionary[contextKey]
        let id = UUID().uuidString
        Thread.current.threadDictionary[contextKey] = id
        defer { Thread.current.threadDictionary[contextKey] = previous }
        record(.uiAnswer, session: session, [.questionId: .id(question), .origin: .tag(origin), .ix: .id(id)])
        client.userActivity()
        return try body()
    }
    /// Diagnostics only: detects repeated *calls*, never rejects an answer.
    static func answer(session: String, question: String, length: Int, pending: Int, source: String) {
        guard recorder.isEnabled else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let key = "\(session):\(question)"
        guard answerLock.try() else { return }
        let duplicate = answers[key] != nil
        if answers.count >= 1024 { answers = answers.filter { now - $0.value < 300 } }
        if answers.count >= 1024 { answers.removeAll(keepingCapacity: true) }
        answers[key] = now
        answerLock.unlock()
        var fields: [DiagField: DiagValue] = [
            .questionId: .id(question), .textLength: .int(length), .pending: .int(pending),
            .duplicate: .bool(duplicate), .source: .tag(source),
            // Current-thread return addresses only; symbolicate offline with the matching dSYM.
            // Never suspend another thread or call Thread.callStackSymbols on the hot path.
            .stack: .tag(stack),
        ]
        if let interaction { fields[.ix] = .id(interaction) }
        record(.answer, session: session, fields)
        client.userActivity()
    }
}

/// Single utility queue + one HTTP task. Foreground-only in v1: no promise of
/// background delivery. On suspension logs remain on disk until next use.
/// Separate HTTP avoids Pulse HOL, not contention on the physical network.
final class DiagClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "chat.kraki.diag", qos: .utility)
    private let recorder: DiagRecorder
    private let root: URL
    private let defaults: UserDefaults
    private let sessionConfiguration: URLSessionConfiguration?
    private var timer: DispatchSourceTimer?
    private let flushLock = NSLock()
    private var flushScheduled = false
    private var spool: DiagSpool?
    private var credentials: (base: URL, device: String, sign: (String) throws -> String)?
    private var realm: String?
    private var task: URLSessionDataTask?
    private var generation = 0
    private var localEnabled: Bool
    private var remoteEnabled = false // fail closed until endpoint config explicitly opts in
    private var foreground = true
    private var nextUpload = Date.distantPast
    private var nextConfig = Date.distantPast
    private var failures = 0
    private var configFailures = 0
    private var dailyDay = ""
    private var dailyBytes = 0
    private lazy var session: URLSession = {
        let config = sessionConfiguration ?? URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpShouldSetCookies = false
        config.httpMaximumConnectionsPerHost = 1
        config.allowsCellularAccess = false
        config.allowsExpensiveNetworkAccess = false
        config.allowsConstrainedNetworkAccess = false
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.networkServiceType = .background
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    init(recorder: DiagRecorder, root: URL? = nil, defaults: UserDefaults = .standard,
         sessionConfiguration: URLSessionConfiguration? = nil) {
        self.recorder = recorder
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Kraki Diag/diagnostics", isDirectory: true)
        self.defaults = defaults
        self.sessionConfiguration = sessionConfiguration
        localEnabled = defaults.object(forKey: "kraki.diag.enabled") as? Bool ?? true
        super.init()
        recorder.setEnabled(localEnabled)
    }
    func start() {
        queue.async {
            guard self.timer == nil else { return }
            if !self.localEnabled { self.clearStoredRealms() }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 5, repeating: 5, leeway: .seconds(1))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer; timer.resume()
        }
    }
    func configure(relay: String, device: String, sign: @escaping (String) throws -> String) {
        queue.async {
            guard var url = URLComponents(string: relay), url.user == nil, url.password == nil,
                  let host = url.host else { return }
            if url.scheme == "wss" { url.scheme = "https" }
            else if url.scheme == "ws", ["localhost", "127.0.0.1", "::1"].contains(host) { url.scheme = "http" }
            else { return }
            url.path = ""; url.query = nil; url.fragment = nil
            guard let base = url.url else { return }
            let realm = SHA256.hash(data: Data("\(base.absoluteString)\n\(device)".utf8)).map { String(format: "%02x", $0) }.joined()
            if self.realm != nil && self.realm != realm {
                self.task?.cancel(); self.task = nil; self.generation += 1
                self.spool?.clear(); _ = self.recorder.drain()
                self.defaults.removeObject(forKey: "kraki.diag.lastSuccess")
            }
            self.generation += 1; self.task?.cancel(); self.task = nil
            self.recorder.setEnabled(self.localEnabled)
            self.realm = realm
            self.credentials = (base, device, sign)
            self.remoteEnabled = false
            let root = self.root
            // Never send a previous account/relay's spool to this one. Own directory only.
            if let oldRealms = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) {
                for old in oldRealms where old.lastPathComponent != realm && old.lastPathComponent.count == 64
                    && old.lastPathComponent.allSatisfy({ $0.isHexDigit }) {
                    try? FileManager.default.removeItem(at: old)
                }
            }
            self.spool = try? DiagSpool(directory: root.appendingPathComponent(realm, isDirectory: true))
            if !self.localEnabled { self.spool?.clear() }
            self.nextConfig = Date().addingTimeInterval(5)
            self.nextUpload = Date().addingTimeInterval(15)
            self.dailyDay = self.defaults.string(forKey: "kraki.diag.day") ?? ""
            self.dailyBytes = self.defaults.integer(forKey: "kraki.diag.bytes")
        }
    }
    func setEnabled(_ enabled: Bool) {
        recorder.setEnabled(enabled)
        queue.async {
            self.localEnabled = enabled
            // Reapply on the serial queue too: an older config completion may
            // have run between the immediate UI-side off and this queued block.
            self.recorder.setEnabled(enabled)
            self.generation += 1; self.task?.cancel(); self.task = nil
            if !enabled {
                self.spool?.clear(); _ = self.recorder.drain()
                // Also covers turning off before authentication in a new process.
                self.clearStoredRealms()
                self.publishQueueHealth()
            } else { self.nextConfig = .distantPast }
        }
    }
    private func clearStoredRealms() {
        guard let realms = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        for dir in realms where dir.lastPathComponent.count == 64 && dir.lastPathComponent.allSatisfy({ $0.isHexDigit }) {
            // Keep the current directory itself alive for a later re-enable.
            if let spool = try? DiagSpool(directory: dir) { spool.clear() }
        }
    }
    func logout() {
        recorder.setEnabled(false)
        queue.async {
            self.recorder.setEnabled(false)
            self.generation += 1; self.task?.cancel(); self.task = nil
            self.spool?.clear(); self.spool = nil
            self.credentials = nil; self.realm = nil; self.remoteEnabled = false
            _ = self.recorder.drain()
            self.defaults.removeObject(forKey: "kraki.diag.lastSuccess")
            self.publishQueueHealth()
        }
    }
    func setForeground(_ value: Bool) {
        queue.async {
            self.foreground = value
            if !value {
                self.flush()
                self.generation += 1; self.task?.cancel(); self.task = nil
            } else { self.nextUpload = max(self.nextUpload, Date().addingTimeInterval(15)) }
        }
    }
    func userActivity() { queue.async { self.nextUpload = max(self.nextUpload, Date().addingTimeInterval(10)) } }
    /// One coalesced local flush for important low-frequency events. This does
    /// NOT trigger an upload or allocate an unbounded Dispatch task per event.
    func requestFlush() {
        guard flushLock.try() else { return }
        guard !flushScheduled else { flushLock.unlock(); return }
        flushScheduled = true; flushLock.unlock()
        queue.asyncAfter(deadline: .now() + 0.25) {
            self.flushLock.lock(); self.flushScheduled = false; self.flushLock.unlock()
            self.flush()
        }
    }

    private func tick() {
        guard localEnabled else { return }
        if spool == nil, let realm {
            spool = try? DiagSpool(directory: root.appendingPathComponent(realm, isDirectory: true))
        }
        flush()
        guard foreground, task == nil, credentials != nil else { return }
        // Don't compete with thermal/power recovery. Resume via the next tick.
        guard ProcessInfo.processInfo.thermalState == .nominal || ProcessInfo.processInfo.thermalState == .fair,
              !ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
        if Date() >= nextConfig { sendConfig(); return }
        guard remoteEnabled, Date() >= nextUpload, let spool else { return }
        do { try spool.compact() }
        catch {
            // Complete any crash-safe merge before considering another upload.
            self.spool = try? DiagSpool(directory: spool.directory)
            nextUpload = Date().addingTimeInterval(30)
            defaults.set("local_io", forKey: "kraki.diag.uploadState")
            return
        }
        publishQueueHealth()
        guard let segment = spool.segments.first else { return }
        let today = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        if dailyDay != today { dailyDay = today; dailyBytes = 0 }
        guard dailyBytes + segment.bytes <= 20 * 1024 * 1024 else { return }
        guard let bytes = try? Data(contentsOf: segment.url), bytes.count <= 16 * 1024,
              let id = segment.url.deletingPathExtension().lastPathComponent.split(separator: "_").last else {
            spool.remove(segment.url); return
        }
        do { try spool.markAttempted(segment.url) }
        catch { defaults.set("local_io", forKey: "kraki.diag.uploadState"); return }
        // Count attempted uploads, not just successful bytes, across relaunches.
        dailyBytes += bytes.count
        defaults.set(dailyDay, forKey: "kraki.diag.day")
        defaults.set(dailyBytes, forKey: "kraki.diag.bytes")
        send(path: "batch", body: bytes, id: String(id)) { status, _ in
            // Success counters stay local: logging every successful upload would
            // perpetually generate another batch while the app is idle.
            if status != 204 { self.recorder.record(.upload, [.status: .int(status), .bytes: .int(bytes.count)]) }
            if status == 204 {
                self.spool?.remove(segment.url); self.failures = 0
                self.defaults.set(Date().timeIntervalSince1970, forKey: "kraki.diag.lastSuccess")
            }
            else if [400, 409, 413, 415].contains(status) { self.spool?.remove(segment.url) }
            else { self.failures = min(8, self.failures + 1) }
            if [401, 403, 404, 410].contains(status) {
                self.remoteEnabled = false; self.recorder.setEnabled(false); self.spool?.clear()
                self.nextConfig = Date().addingTimeInterval(900)
            }
            self.defaults.set(status == 204 ? "ok" : "http_\(status)", forKey: "kraki.diag.uploadState")
            self.publishQueueHealth()
            // Bounded catch-up, at most one request per 5s worker tick (<30/min
            // including config). Errors retain exponential backoff/identical bytes.
            let delay = status == 204 ? 5.0 : min(3600, 60 * pow(2, Double(self.failures))) + Double.random(in: 0...10)
            self.nextUpload = Date().addingTimeInterval(delay)
        }
    }
    private func flush() {
        guard localEnabled, let spool else { return } // keep bounded pre-auth records in memory
        let drained = recorder.drain()
        if drained.dropped > 0 { recorder.record(.health, [.dropped: .number(Double(drained.dropped))]) }
        if !drained.events.isEmpty { persist(drained.events, to: spool) }
        publishQueueHealth()
    }
    private func publishQueueHealth() {
        let values: [(String, Int)] = [("kraki.diag.pendingBytes", spool?.bytes ?? 0),
                                      ("kraki.diag.pendingBatches", spool?.segments.count ?? 0)]
        for (key, value) in values where defaults.integer(forKey: key) != value { defaults.set(value, forKey: key) }
        let oldest = spool?.segments.first?.url.lastPathComponent.split(separator: "_").first.flatMap { Double($0) }.map { $0 / 1000 } ?? 0
        if defaults.double(forKey: "kraki.diag.oldestBatch") != oldest { defaults.set(oldest, forKey: "kraki.diag.oldestBatch") }
    }
    private func persist(_ events: [DiagEvent], to spool: DiagSpool) {
        let id = UUID().uuidString
        #if os(iOS)
        let platform = "ios"
        #else
        let platform = "mac"
        #endif
        let batch = DiagBatch(batchId: id, processId: recorder.processId, platform: platform,
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0", events: events)
        do {
            let data = try JSONEncoder().encode(batch)
            let compressed = try diagGzip(data)
            if data.count > 48 * 1024 || compressed.count > 16 * 1024 {
                guard events.count > 1 else { return }
                let middle = events.count / 2
                persist(Array(events[..<middle]), to: spool); persist(Array(events[middle...]), to: spool)
            } else { try spool.append(compressed, batchId: id) }
        } catch { /* diagnostics failure must never break normal functionality */ }
    }
    private func sendConfig() {
        nextConfig = Date().addingTimeInterval(900)
        send(path: "config", body: Data(), id: UUID().uuidString) { status, data in
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if status == 200, json?["schema"] as? Int == 1, let enabled = json?["enabled"] as? Bool {
                self.configFailures = 0
                self.defaults.set(enabled ? "ready" : "remote_disabled", forKey: "kraki.diag.uploadState")
                self.remoteEnabled = enabled
                self.recorder.setEnabled(self.localEnabled && enabled)
                if !enabled { self.spool?.clear() }
            } else if [401, 403, 404, 410].contains(status) {
                self.remoteEnabled = false
                self.recorder.setEnabled(false)
                self.spool?.clear()
                self.defaults.set("config_\(status)", forKey: "kraki.diag.uploadState")
            } else {
                self.configFailures = min(5, self.configFailures + 1)
                self.nextConfig = Date().addingTimeInterval(min(300, 15 * pow(2, Double(self.configFailures))) + Double.random(in: 0...5))
                self.defaults.set("config_\(status)", forKey: "kraki.diag.uploadState")
            }
            self.publishQueueHealth()
        }
    }
    private func send(path: String, body: Data, id: String, completion: @escaping (Int, Data) -> Void) {
        guard let credentials else { return }
        let path = "/api/diag/v1/\(path)"
        let method = body.isEmpty ? "GET" : "POST"
        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1000))
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let message = ["kraki-diag-v1", method, path, credentials.device, timestamp, id, digest].joined(separator: "\n")
        guard let signature = try? credentials.sign(message) else {
            completion(0, Data()) // bounded retry; don't silently wait 15 minutes
            return
        }
        var req = URLRequest(url: credentials.base.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod = method
        req.setValue(credentials.device, forHTTPHeaderField: "X-Kraki-Device")
        req.setValue(timestamp, forHTTPHeaderField: "X-Kraki-Time")
        req.setValue(id, forHTTPHeaderField: "X-Kraki-Request")
        req.setValue(signature, forHTTPHeaderField: "X-Kraki-Signature")
        if !body.isEmpty {
            req.setValue("gzip", forHTTPHeaderField: "Content-Encoding")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let generation = self.generation
        task = session.dataTask(with: req) { data, response, _ in
            self.queue.async {
                guard self.generation == generation else { return }
                self.task = nil
                completion((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data())
            }
        }
        task?.priority = URLSessionTask.lowPriority
        task?.resume()
    }
    #if KRAKI_DIAG_TESTING
    // No test hooks are compiled into the diagnostic app itself.
    func testTick() { queue.sync { nextConfig = credentials != nil && !remoteEnabled ? .distantPast : nextConfig; nextUpload = .distantPast; tick() } }
    func testSnapshot() -> (count: Int, task: Bool, remote: Bool, configDelay: Double, uploadDelay: Double) {
        queue.sync { (spool?.segments.count ?? 0, task != nil, remoteEnabled, nextConfig.timeIntervalSinceNow, nextUpload.timeIntervalSinceNow) }
    }
    func testStop() { queue.sync { timer?.cancel(); task?.cancel(); session.invalidateAndCancel() } }
    #endif
    // A redirect must not disclose signed credentials to another origin.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
#endif
