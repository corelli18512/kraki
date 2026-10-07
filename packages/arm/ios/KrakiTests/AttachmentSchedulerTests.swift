import CryptoKit
import XCTest
@testable import Kraki

/// Lazy, paced attachment loading: nothing transfers unless shown or opened,
/// at most one chunk is in flight, the user's report takes over between
/// chunks, and transfers pause/resume with the connection.
@MainActor
final class AttachmentSchedulerTests: XCTestCase {
    private var dir: URL!
    private var requests: [(id: String, session: String, index: Int)] = []
    private var sendSucceeds = true

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-attach-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        requests = []
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func makeStore(dwell: TimeInterval = 0.05, timeout: TimeInterval = 30) -> AttachmentStore {
        AttachmentStore(cacheDirectory: dir, visibleDwell: dwell, chunkTimeout: timeout) { [weak self] id, session, index in
            self?.requests.append((id, session, index))
            return self?.sendSucceeds ?? true
        }
    }

    private func chunk(_ store: AttachmentStore, _ id: String, _ index: Int, _ total: Int, _ text: String, paced: Bool = true) async {
        store.ingestChunk(id: id, index: index, total: total, mimeType: "text/plain",
                          data: Data(text.utf8).base64EncodedString(), error: nil, paced: paced)
        await settle()
    }

    /// Polls until `condition` holds (bounded), so slow CI disks are not a guess.
    private func waitUntil(_ timeout: TimeInterval = 10, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { await settle(0.02) }
    }

    /// Attachment ids are the SHA-256 prefix of the content (the store verifies
    /// it), so a test names each attachment by the bytes it will deliver.
    private func id(_ content: String) -> String {
        SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    private func settle(_ seconds: TimeInterval = 0.02) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    func testNothingTransfersUntilTheConnectionIsReady() async {
        let r = id("r")
        let store = makeStore()
        store.requestIfNeeded(id: r, sessionId: "s", priority: .userOpened)
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual(store.state(for: r), .fetching)
        store.setTransportReady(true)
        XCTAssertEqual(requests.map(\.index), [0])
        XCTAssertEqual(requests.first?.id, r)
    }

    func testVisibleWaitsForDwellAndScrollingPastCancels() async {
        let passing = id("passing")
        let stays = id("stays")
        let store = makeStore(dwell: 0.1)
        store.setTransportReady(true)
        store.requestIfNeeded(id: passing, sessionId: "s")
        store.release(id: passing)
        store.requestIfNeeded(id: stays, sessionId: "s")
        XCTAssertTrue(requests.isEmpty, "no transfer during the dwell")
        await settle(0.25)
        XCTAssertEqual(requests.map(\.id), [stays])
        XCTAssertNil(store.state(for: passing))
    }

    func testOneChunkInFlightAndTheOpenedReportTakesOverBetweenChunks() async {
        let image = id("abc")
        let report = id("<p>r</p>")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: image, sessionId: "s")
        await settle()
        XCTAssertEqual(requests.map(\.id), [image])

        store.requestIfNeeded(id: report, sessionId: "s", priority: .userOpened)
        XCTAssertEqual(requests.count, 1, "never two chunks in flight")

        await chunk(store, image, 0, 3, "a")
        XCTAssertEqual(requests.last?.id, report, "user-opened report preempts between chunks")
        XCTAssertEqual(store.state(for: image), .awaitingChunks(received: 1, total: 3))

        await chunk(store, report, 0, 1, "<p>r</p>")
        guard case .ready = store.state(for: report) else { return XCTFail("report not ready") }
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, [image, "1"], "image resumes at its first missing chunk")
        await chunk(store, image, 1, 3, "b")
        await chunk(store, image, 2, 3, "c")
        XCTAssertEqual(store.text(for: image), "abc")
        XCTAssertEqual(requests.count, 4)
    }

    func testLegacyTentacleStreamingWholeFileIsNotRequestedAgain() async {
        let old = id("xyz")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: old, sessionId: "s", priority: .userOpened)
        await chunk(store, old, 0, 3, "x", paced: false)
        await chunk(store, old, 1, 3, "y", paced: false)
        XCTAssertEqual(requests.count, 1, "an unpaced stream is not re-requested chunk by chunk")
        await chunk(store, old, 2, 3, "z", paced: false)
        XCTAssertEqual(store.text(for: old), "xyz")
    }

    func testConnectionLossPausesAndResumesAtTheMissingChunk() async {
        let r = id("r")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: r, sessionId: "s", priority: .userOpened)
        await chunk(store, r, 0, 3, "1")
        XCTAssertEqual(requests.last?.index, 1)
        store.setTransportReady(false)
        XCTAssertNil(store.inFlightForTesting)
        store.setTransportReady(true)
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, [r, "1"])
        XCTAssertEqual(store.state(for: r), .awaitingChunks(received: 1, total: 3))
    }

    func testRepeatedTimeoutsSurfaceAnErrorAndARetryStartsOver() async {
        let lost = id("lost")
        let store = makeStore(dwell: 0, timeout: 0.05)
        store.setTransportReady(true)
        store.requestIfNeeded(id: lost, sessionId: "s", priority: .userOpened)
        await settle(0.4)
        XCTAssertEqual(requests.count, AttachmentStore.maxAttempts)
        guard case .error = store.state(for: lost) else { return XCTFail("expected an error state") }
        store.requestIfNeeded(id: lost, sessionId: "s", priority: .userOpened)
        XCTAssertEqual(requests.count, AttachmentStore.maxAttempts + 1)
        XCTAssertEqual(store.state(for: lost), .fetching)
    }

    func testServerErrorIsTerminalForTheRequest() async {
        let gone = id("gone")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: gone, sessionId: "s", priority: .userOpened)
        store.ingestChunk(id: gone, index: 0, total: 0, mimeType: "", data: "", error: "not_found", paced: true)
        await settle()
        XCTAssertEqual(store.state(for: gone), .error(reason: "not_found"))
        XCTAssertNil(store.inFlightForTesting)
    }

    func testCachedBytesLoadFromDiskWithoutTheNetwork() async {
        let c = id("cached")
        let first = makeStore(dwell: 0)
        first.setTransportReady(true)
        first.requestIfNeeded(id: c, sessionId: "s", priority: .userOpened)
        await chunk(first, c, 0, 1, "cached")
        await first.waitForDiskForTesting()

        requests = []
        let second = makeStore(dwell: 0)
        second.setTransportReady(true)
        second.requestIfNeeded(id: c, sessionId: "s")
        await second.waitForDiskForTesting()
        await waitUntil { second.text(for: c) != nil }
        XCTAssertEqual(second.text(for: c), "cached")
        XCTAssertTrue(requests.isEmpty)
    }

    func testReleasedVisibleTransferKeepsItsChunksForLater() async {
        let img = id("img")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: img, sessionId: "s")
        await settle()
        store.release(id: img)
        await chunk(store, img, 0, 2, "p")
        XCTAssertEqual(requests.count, 1, "a released image does not keep downloading")
        store.requestIfNeeded(id: img, sessionId: "s")
        await settle()
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, [img, "1"])
    }

    func testFailedSendRetriesSoonWithoutSpendingAnAttempt() async {
        let r = id("r")
        let store = makeStore(dwell: 0, timeout: 30)
        store.setTransportReady(true)
        sendSucceeds = false
        store.requestIfNeeded(id: r, sessionId: "s", priority: .userOpened)
        XCTAssertNil(store.inFlightForTesting)
        sendSucceeds = true
        await settle(2.3)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(store.inFlightForTesting?.id, r)
        XCTAssertEqual(store.state(for: r), .fetching)
    }

    func testReleasedReadyBytesAreEvictedToDiskAndReloadWithoutNetwork() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        let big = String(repeating: "x", count: 40 * 1024 * 1024)
        let bigB = String(repeating: "y", count: 40 * 1024 * 1024)
        let a = id(big), b = id(bigB)
        for (key, content) in [(a, big), (b, bigB)] {
            store.requestIfNeeded(id: key, sessionId: "s", priority: .userOpened)
            await chunk(store, key, 0, 1, content)
        }
        await store.waitForDiskForTesting()
        await settle() // persisted flags hop back to the main actor
        store.release(id: a, priority: .userOpened)
        store.release(id: b, priority: .userOpened)
        XCTAssertNil(store.state(for: a), "oldest released entry evicted over the memory budget")
        guard case .ready = store.state(for: b) else { return XCTFail("recent entry kept") }
        let before = requests.count
        store.requestIfNeeded(id: a, sessionId: "s")
        await store.waitForDiskForTesting()
        await waitUntil { store.text(for: a) != nil }
        XCTAssertEqual(store.text(for: a)?.count, big.count)
        XCTAssertEqual(requests.count, before, "reloaded from disk, not the network")
    }

    func testDiskCacheTrimDropsLeastRecentlyUsed() throws {
        let enc = JSONEncoder()
        for (id, used) in [("old", 1.0), ("new", 2.0)] {
            try Data(count: 600).write(to: dir.appendingPathComponent(id))
            try enc.encode(["mimeType": "a/b"]).write(to: dir.appendingPathComponent(id + ".json"))
            let meta = "{\"mimeType\":\"a/b\",\"size\":600,\"lastAccessed\":\(used)}"
            try Data(meta.utf8).write(to: dir.appendingPathComponent(id + ".json"))
        }
        AttachmentStore.trimDiskCache(dir, budget: 1000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("old").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("new").path))
    }

    func testSameImageInTwoMessagesStaysWantedUntilTheLastViewLeaves() async {
        let shared = id("ab")
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: shared, sessionId: "s")
        store.requestIfNeeded(id: shared, sessionId: "s")
        await settle()
        XCTAssertEqual(requests.map(\.id), [shared])
        store.release(id: shared)
        await chunk(store, shared, 0, 2, "a")
        XCTAssertEqual(requests.map(\.index), [0, 1], "still on screen in the other message")
        store.release(id: shared)
        await chunk(store, shared, 1, 2, "b")
        XCTAssertEqual(store.text(for: shared), "ab", "an in-flight chunk still completes the transfer")
    }

    func testUnsolicitedAndMalformedChunksAreIgnored() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        let never = id("never-requested")
        await chunk(store, never, 0, 1, "never-requested")
        XCTAssertNil(store.state(for: never), "a chunk nobody asked for is dropped")
        await chunk(store, "../../Library/Preferences/x", 0, 1, "evil")
        XCTAssertNil(store.state(for: "../../Library/Preferences/x"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("../../Library/Preferences/x").path))
    }

    func testBytesThatDoNotMatchTheirIdAreRejected() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        let claimed = id("the real report")
        store.requestIfNeeded(id: claimed, sessionId: "s", priority: .userOpened)
        await chunk(store, claimed, 0, 1, "a forged report")
        XCTAssertEqual(store.state(for: claimed), .error(reason: "This attachment failed verification"))
        await store.waitForDiskForTesting()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(claimed).path))
    }

}
