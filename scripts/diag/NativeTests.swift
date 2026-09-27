// Standalone, no app/UI/keychain/production network. Compile with run-native-tests.sh.
import Foundation
import zlib

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}
func decodeGzip(_ input: Data) throws -> Data {
    var stream = z_stream()
    check(inflateInit2_(&stream, MAX_WBITS + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK, "inflate init")
    defer { inflateEnd(&stream) }
    var out = Data(count: 262144)
    let result = input.withUnsafeBytes { i in
        out.withUnsafeMutableBytes { o in
            stream.next_in = UnsafeMutablePointer(mutating: i.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(i.count)
            stream.next_out = o.bindMemory(to: Bytef.self).baseAddress
            stream.avail_out = uInt(o.count)
            return inflate(&stream, Z_FINISH)
        }
    }
    check(result == Z_STREAM_END, "gzip roundtrip")
    out.count = Int(stream.total_out)
    return out
}
final class FakeHTTP: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var posts: [Data] = []
    static var postStatus = 204
    static var configEnabled = true
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let isConfig = request.url!.path.hasSuffix("config")
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 8192)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer[..<count])
            }
        } else { body = request.httpBody ?? Data() }
        if !isConfig { Self.posts.append(body) }
        let status = isConfig ? 200 : Self.postStatus
        let response = isConfig ? Data("{\"schema\":1,\"enabled\":\(Self.configEnabled)}".utf8) : Data()
        Self.lock.unlock()
        check(request.value(forHTTPHeaderField: "X-Kraki-Signature") == "test-only-signature", "signature attached")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct NativeTests {
    static func wait(_ client: DiagClient) {
        for _ in 0..<1000 {
            if !client.testSnapshot().task { return }
            Thread.sleep(forTimeInterval: 0.002)
        }
        fatalError("HTTP task did not settle")
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-diag-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let r = DiagRecorder(capacity: 3, perSecond: 100)
        for _ in 0..<5 { r.record(.launch) }
        let drain = r.drain()
        check(drain.events.count == 3 && drain.dropped == 2, "bounded queue drops")
        check(drain.events.map(\.seq) == [1, 2, 3], "monotonic sequence")
        r.setEnabled(false); r.record(.launch)
        check(r.drain().events.isEmpty, "off means no event")
        let limited = DiagRecorder(capacity: 10, perSecond: 1)
        for _ in 0..<5 { limited.record(.launch) }
        check(limited.drain().events.count <= 2, "rate cap (allow second boundary)")
        let concurrent = DiagRecorder(capacity: 2048, perSecond: 20000)
        DispatchQueue.concurrentPerform(iterations: 1000) { _ in concurrent.record(.launch) }
        let values = concurrent.drain().events.map(\.seq)
        check(!values.isEmpty && values == values.sorted() && Set(values).count == values.count, "concurrent ordering")
        let encoded = try JSONEncoder().encode(DiagBatch(batchId: UUID().uuidString, processId: r.processId,
            platform: "test", version: "1", build: "1", events: drain.events))
        let compressed = try diagGzip(encoded)
        let expanded = try decodeGzip(compressed)
        check(encoded == expanded, "gzip data equality")
        check(!String(decoding: expanded, as: UTF8.self).contains("private content"), "no content field")
        let spoolDir = root.appendingPathComponent("spool")
        let spool = try DiagSpool(directory: spoolDir, maxBytes: 100, maxFiles: 2)
        for _ in 0..<4 { try spool.append(Data(repeating: 1, count: 40), batchId: UUID().uuidString) }
        check(spool.segments.count == 2 && spool.bytes == 80 && spool.evicted == 2, "disk cap")
        let restored = try DiagSpool(directory: spoolDir, maxBytes: 100, maxFiles: 2)
        check(restored.segments.count == 2, "spool relaunch")
        restored.clear(); check(restored.segments.isEmpty, "clear spool")
        do { try spool.append(Data(count: 16385), batchId: UUID().uuidString); fatalError("oversize accepted") }
        catch DiagError.size { }

        let suite = "kraki.diag.test.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeHTTP.self]
        let recorder = DiagRecorder()
        let client = DiagClient(recorder: recorder, root: root.appendingPathComponent("http"), defaults: defaults, sessionConfiguration: config)
        defer { client.testStop() }
        client.configure(relay: "wss://diag.invalid", device: "test-device") { _ in "test-only-signature" }
        recorder.record(.input, [.clientId: .id(UUID().uuidString), .textLength: .int(12)])
        client.testTick(); wait(client)
        check(client.testSnapshot().remote, "authenticated config enables uploads")
        check(client.testSnapshot().count == 1, "pre-upload spool persisted")
        FakeHTTP.lock.lock(); FakeHTTP.postStatus = 503; FakeHTTP.lock.unlock()
        client.testTick(); wait(client)
        check(client.testSnapshot().count >= 1, "failed upload retains batch")
        FakeHTTP.lock.lock(); FakeHTTP.postStatus = 204; FakeHTTP.lock.unlock()
        client.testTick(); wait(client)
        FakeHTTP.lock.lock(); let posts = FakeHTTP.posts; FakeHTTP.lock.unlock()
        check(posts.count == 2 && posts[0] == posts[1], "retry preserves batch bytes and id")
        let payload = try JSONSerialization.jsonObject(with: decodeGzip(posts[0])) as! [String: Any]
        check(payload["schema"] as? Int == 1, "native HTTP wire schema")
        recorder.record(.launch)
        client.setEnabled(false); client.testTick()
        check(client.testSnapshot().count == 0 && !client.testSnapshot().task, "off purges queued batches")
        check(!recorder.record(.launch), "off also stops collection")
        recorder.setEnabled(true); client.setEnabled(true)
        client.testTick(); wait(client)
        recorder.record(.launch)
        client.logout(); client.testTick()
        check(client.testSnapshot().count == 0 && !client.testSnapshot().task, "logout clears and stops upload")
        FakeHTTP.lock.lock(); FakeHTTP.configEnabled = false; FakeHTTP.lock.unlock()
        client.configure(relay: "wss://diag.invalid", device: "second-device") { _ in "test-only-signature" }
        client.testTick(); wait(client)
        check(!client.testSnapshot().remote && !recorder.record(.launch), "remote kill stops collection")
        FakeHTTP.lock.lock(); FakeHTTP.configEnabled = true; FakeHTTP.lock.unlock()
        client.testTick(); wait(client)
        check(client.testSnapshot().remote && recorder.record(.launch), "remote recovery")
        client.setForeground(false); client.testTick()
        check(!client.testSnapshot().task && client.testSnapshot().count == 1, "background saves locally without HTTP")

        // Optional real local HTTP receiver: uses ephemeral RSA keys, never Keychain.
        if let relay = ProcessInfo.processInfo.environment["KRAKI_DIAG_E2E_RELAY"],
           let publicKeyPath = ProcessInfo.processInfo.environment["KRAKI_DIAG_E2E_PUBLIC_KEY"] {
            check(relay.hasPrefix("ws://127.0.0.1:"), "E2E must remain loopback-only")
            let crypto = CryptoManager()
            let keys = try crypto.generateKeyPair()
            try Data(crypto.exportPublicKeySPKI(keys.publicKey).utf8).write(to: URL(fileURLWithPath: publicKeyPath), options: .atomic)
            let realRecorder = DiagRecorder()
            let real = DiagClient(recorder: realRecorder, root: root.appendingPathComponent("real-http"), defaults: defaults)
            defer { real.testStop() }
            real.configure(relay: relay, device: "native-e2e-device") { try crypto.signChallenge($0, privateKey: keys.privateKey) }
            realRecorder.record(.answer, session: "e2e-session", [.questionId: .id("e2e-question"), .textLength: .int(10)])
            real.testTick(); wait(real)
            check(real.testSnapshot().remote, "Swift device signature accepted by real Head")
            real.testTick(); wait(real) // receiver injects one 503
            check(real.testSnapshot().count == 1, "real HTTP failure retains batch")
            real.testTick(); wait(real) // retry same signed compressed bytes
            check(real.testSnapshot().count == 1, "real ACK removes first batch (one upload-failure health batch remains)")
            print("PASS: real Swift RSA -> URLSession -> local Head API, including retry")
        }

        // Optimized-build microbenchmark, not an assertion about whole-app CPU/battery.
        let bench = DiagRecorder(capacity: 256, perSecond: Int.max)
        let count = 100_000
        let start = ProcessInfo.processInfo.systemUptime
        for n in 0..<count {
            bench.record(.input, [.clientId: .id("01234567-0123-0123-0123-012345678901"), .textLength: .int(n)])
            if n % 100 == 99 { _ = bench.drain() }
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        print("PASS: recorder, concurrency, gzip, disk cap/relaunch, HTTP retry, toggle/logout (15 groups)")
        print(String(format: "record+periodic-drain microbenchmark: %.3f us/event, %d events", elapsed * 1_000_000 / Double(count), count))
        if let path = ProcessInfo.processInfo.environment["KRAKI_DIAG_TEST_BATCH"] { try posts[0].write(to: URL(fileURLWithPath: path)) }
    }
}
