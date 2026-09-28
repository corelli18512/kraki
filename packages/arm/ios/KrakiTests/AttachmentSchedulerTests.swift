import XCTest
@testable import Kraki

/// Lazy, paced attachment loading: nothing transfers unless shown or opened,
/// at most one chunk is in flight, the user's report takes over between
/// chunks, and transfers pause/resume with the connection.
@MainActor
final class AttachmentSchedulerTests: XCTestCase {
    private var dir: URL!
    private var requests: [(id: String, session: String, index: Int)] = []

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
        }
    }

    private func chunk(_ store: AttachmentStore, _ id: String, _ index: Int, _ total: Int, _ text: String, paced: Bool = true) async {
        store.ingestChunk(id: id, index: index, total: total, mimeType: "text/plain",
                          data: Data(text.utf8).base64EncodedString(), error: nil, paced: paced)
        await settle()
    }

    private func settle(_ seconds: TimeInterval = 0.02) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    func testNothingTransfersUntilTheConnectionIsReady() async {
        let store = makeStore()
        store.requestIfNeeded(id: "r", sessionId: "s", priority: .userOpened)
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual(store.state(for: "r"), .fetching)
        store.setTransportReady(true)
        XCTAssertEqual(requests.map(\.index), [0])
        XCTAssertEqual(requests.first?.id, "r")
    }

    func testVisibleWaitsForDwellAndScrollingPastCancels() async {
        let store = makeStore(dwell: 0.1)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "passing", sessionId: "s")
        store.release(id: "passing")
        store.requestIfNeeded(id: "stays", sessionId: "s")
        XCTAssertTrue(requests.isEmpty, "no transfer during the dwell")
        await settle(0.25)
        XCTAssertEqual(requests.map(\.id), ["stays"])
        XCTAssertNil(store.state(for: "passing"))
    }

    func testOneChunkInFlightAndTheOpenedReportTakesOverBetweenChunks() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "image", sessionId: "s")
        await settle()
        XCTAssertEqual(requests.map(\.id), ["image"])

        store.requestIfNeeded(id: "report", sessionId: "s", priority: .userOpened)
        XCTAssertEqual(requests.count, 1, "never two chunks in flight")

        await chunk(store, "image", 0, 3, "a")
        XCTAssertEqual(requests.last?.id, "report", "user-opened report preempts between chunks")
        XCTAssertEqual(store.state(for: "image"), .awaitingChunks(received: 1, total: 3))

        await chunk(store, "report", 0, 1, "<p>r</p>")
        guard case .ready = store.state(for: "report") else { return XCTFail("report not ready") }
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, ["image", "1"], "image resumes at its first missing chunk")
        await chunk(store, "image", 1, 3, "b")
        await chunk(store, "image", 2, 3, "c")
        XCTAssertEqual(store.text(for: "image"), "abc")
        XCTAssertEqual(requests.count, 4)
    }

    func testLegacyTentacleStreamingWholeFileIsNotRequestedAgain() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "old", sessionId: "s", priority: .userOpened)
        await chunk(store, "old", 0, 3, "x", paced: false)
        await chunk(store, "old", 1, 3, "y", paced: false)
        XCTAssertEqual(requests.count, 1, "an unpaced stream is not re-requested chunk by chunk")
        await chunk(store, "old", 2, 3, "z", paced: false)
        XCTAssertEqual(store.text(for: "old"), "xyz")
    }

    func testConnectionLossPausesAndResumesAtTheMissingChunk() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "r", sessionId: "s", priority: .userOpened)
        await chunk(store, "r", 0, 3, "1")
        XCTAssertEqual(requests.last?.index, 1)
        store.setTransportReady(false)
        XCTAssertNil(store.inFlightForTesting)
        store.setTransportReady(true)
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, ["r", "1"])
        XCTAssertEqual(store.state(for: "r"), .awaitingChunks(received: 1, total: 3))
    }

    func testRepeatedTimeoutsSurfaceAnErrorAndARetryStartsOver() async {
        let store = makeStore(dwell: 0, timeout: 0.05)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "lost", sessionId: "s", priority: .userOpened)
        await settle(0.4)
        XCTAssertEqual(requests.count, AttachmentStore.maxAttempts)
        guard case .error = store.state(for: "lost") else { return XCTFail("expected an error state") }
        store.requestIfNeeded(id: "lost", sessionId: "s", priority: .userOpened)
        XCTAssertEqual(requests.count, AttachmentStore.maxAttempts + 1)
        XCTAssertEqual(store.state(for: "lost"), .fetching)
    }

    func testServerErrorIsTerminalForTheRequest() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "gone", sessionId: "s", priority: .userOpened)
        store.ingestChunk(id: "gone", index: 0, total: 0, mimeType: "", data: "", error: "not_found", paced: true)
        await settle()
        XCTAssertEqual(store.state(for: "gone"), .error(reason: "not_found"))
        XCTAssertNil(store.inFlightForTesting)
    }

    func testCachedBytesLoadFromDiskWithoutTheNetwork() async {
        let first = makeStore(dwell: 0)
        first.setTransportReady(true)
        first.requestIfNeeded(id: "c", sessionId: "s", priority: .userOpened)
        await chunk(first, "c", 0, 1, "cached")
        await settle(0.2) // disk write

        requests = []
        let second = makeStore(dwell: 0)
        second.setTransportReady(true)
        second.requestIfNeeded(id: "c", sessionId: "s")
        await settle(0.2)
        XCTAssertEqual(second.text(for: "c"), "cached")
        XCTAssertTrue(requests.isEmpty)
    }

    func testReleasedVisibleTransferKeepsItsChunksForLater() async {
        let store = makeStore(dwell: 0)
        store.setTransportReady(true)
        store.requestIfNeeded(id: "img", sessionId: "s")
        await settle()
        store.release(id: "img")
        await chunk(store, "img", 0, 2, "p")
        XCTAssertEqual(requests.count, 1, "a released image does not keep downloading")
        store.requestIfNeeded(id: "img", sessionId: "s")
        await settle()
        XCTAssertEqual(requests.last.map { [$0.id, String($0.index)] }, ["img", "1"])
    }
}
