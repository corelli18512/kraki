import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// The entry window for a Session with unread messages
/// (MessageStore+UnreadEntryWindow, K-042), on both platforms' window sizes.
///
/// Main opens every Session on its newest `initialWindowSize` rows (30 on
/// iPhone, 15 on Mac). A backlog that starts above them keeps those rows and
/// gains the unread rows above, down to the first unread one (plus up to three
/// read rows), at most 30 of them. Every other entry — one unread reply,
/// nothing unread, a few unread, a backlog above that cap, a hole in this
/// device's cache — keeps exactly main's window.
@MainActor
final class MessageStoreUnreadEntryWindowTests: XCTestCase {
    private let sid = "unread-window"
    private let dev = "unread-window-device"
    private var roots: [URL] = []
    private var states: [AppState] = []
    /// Main's entry window: the newest rows.
    private var tail: Int { MessageStore.initialWindowSize }
    /// Most unread rows added above the newest window (both platforms).
    private let cap = 30

    override func tearDown() async throws {
        states.removeAll()
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    // MARK: Entries that keep main's window

    /// The dominant case: the read cursor moved along with the reply and only
    /// the turn's `idle` is unread.
    func testOneShortUnreadReplyKeepsMainsWindow() throws {
        let entry = try enter(stored: Array(1...40), readSeq: 40, idleAt: 41, texts: [40: "短回复"])
        XCTAssertEqual(entry.app.sessionStore.entryUnreadBoundaries[sid], 40, "a real red dot")
        XCTAssertEqual(entry.window, entry.mainWindow)
        XCTAssertEqual(entry.window, Array((41 - tail + 1)...41))
        XCTAssertEqual(entry.state, MessageStore.WindowState(topSeq: 41 - tail + 1, bottomSeq: 41))
    }

    func testNothingUnreadKeepsMainsWindow() throws {
        let entry = try enter(stored: Array(1...40), readSeq: 40)
        XCTAssertNil(entry.app.sessionStore.entryUnreadBoundaries[sid])
        XCTAssertEqual(entry.window, entry.mainWindow)
        XCTAssertEqual(entry.state?.bottomSeq, 40)
    }

    func testAFewUnreadKeepMainsWindow() throws {
        let entry = try enter(stored: Array(1...40), readSeq: 37)
        XCTAssertEqual(entry.window, entry.mainWindow)
        XCTAssertEqual(entry.state?.bottomSeq, 40)
    }

    /// A notification tap on a Session the list still thinks is read: what
    /// arrives next is new, and the cached rows stay as they are.
    func testNotificationOnAReadSessionKeepsMainsWindow() throws {
        let entry = try enter(stored: Array(1...40), readSeq: 40, fromNotification: true)
        XCTAssertEqual(entry.app.sessionStore.entryUnreadBoundaries[sid], 40)
        XCTAssertEqual(entry.window, entry.mainWindow)
    }

    func testBacklogAboveTheCapKeepsMainsWindow() throws {
        let stored = 20 + cap + 1 + tail
        let entry = try enter(stored: Array(1...stored), readSeq: 20)
        XCTAssertEqual(entry.window, entry.mainWindow)
        XCTAssertEqual(entry.window, Array((stored - tail + 1)...stored))
    }

    /// Rows right after the read position are not on this device yet (the
    /// latest turn was fetched first, the gap bridge is still running).
    func testHoleRightAfterTheReadPositionKeepsMainsWindow() throws {
        let stored = Array(1...20) + Array(31...(30 + tail + 10))
        let entry = try enter(stored: stored, readSeq: 20)
        XCTAssertEqual(entry.window, entry.mainWindow, "no unread row is skipped inside the window")
    }

    func testHoleInsideTheUnreadRowsKeepsMainsWindow() throws {
        let last = 20 + tail + 20
        let stored = Array(1...30) + Array(36...last)
        let entry = try enter(stored: stored, readSeq: 20)
        XCTAssertEqual(entry.window, entry.mainWindow, "no unread row is skipped inside the window")
        XCTAssertTrue(isDense(entry.window))
    }

    /// Pre-pure-spine logs can be sparse (retired transient rows consumed
    /// seqs): a gap there is indistinguishable from a hole, so main's window.
    func testLegacySparseSeqsKeepMainsWindow() throws {
        let stored = Array(stride(from: 1, through: 2 * (tail + 20), by: 2))
        let entry = try enter(stored: stored, readSeq: 21)
        XCTAssertEqual(entry.window, entry.mainWindow)
    }

    /// The list knows newer rows than this device stored (before sync).
    func testReadPositionPastTheStoredRowsKeepsMainsWindow() throws {
        let entry = try enter(stored: Array(1...40), readSeq: 45, lastSeq: 60)
        XCTAssertEqual(entry.window, entry.mainWindow)
    }

    func testClearedCacheKeepsMainsEmptyWindow() throws {
        let entry = try enter(stored: [], readSeq: 10, lastSeq: 20)
        XCTAssertEqual(entry.window, [])
        XCTAssertEqual(entry.state, MessageStore.WindowState(topSeq: 0, bottomSeq: 0))
    }

    // MARK: Backlog inside the cap

    func testBacklogInsideTheCapKeepsTheNewestRowsAndAddsTheUnreadAbove() throws {
        let stored = 20 + 10 + tail
        let entry = try enter(stored: Array(1...stored), readSeq: 20)
        XCTAssertEqual(entry.window, Array(18...stored), "three read rows, every unread row, the newest row")
        XCTAssertEqual(entry.state, MessageStore.WindowState(topSeq: 18, bottomSeq: stored))
        XCTAssertTrue(entry.app.messageProvider?.atHead(sid) ?? false, "still the conversation's newest end")
    }

    func testBacklogOfExactlyTheCapIsStillAdded() throws {
        let stored = 20 + cap + tail
        let entry = try enter(stored: Array(1...stored), readSeq: 20)
        XCTAssertEqual(entry.window, Array(18...stored))
    }

    /// Read context stops at a hole: rows above it are not shown next to the
    /// first unread row as if they were adjacent.
    func testReadContextStopsAtAHole() throws {
        let stored = Array(1...15) + Array(19...(20 + 5 + tail))
        let entry = try enter(stored: stored, readSeq: 20)
        XCTAssertEqual(entry.window.first, 19)
        XCTAssertTrue(isDense(entry.window))
        XCTAssertEqual(entry.window.last, stored.last)
    }

    /// The read position's own row is not stored (e.g. trimmed): the window
    /// starts at the first unread row.
    func testMissingReadRowStartsAtTheFirstUnread() throws {
        let stored = Array(1...17) + Array(21...(20 + 5 + tail))
        let entry = try enter(stored: stored, readSeq: 20)
        XCTAssertEqual(entry.window.first, 21)
        XCTAssertEqual(entry.window.last, stored.last)
    }

    // MARK: Fixture

    private struct Entry {
        let app: AppState
        /// Window main opens (before the anchor), seqs.
        let mainWindow: [Int]
        /// Window after the anchor, seqs.
        let window: [Int]
        let state: MessageStore.WindowState?
    }

    private func isDense(_ seqs: [Int]) -> Bool {
        zip(seqs, seqs.dropFirst()).allSatisfy { $1 == $0 + 1 }
    }

    /// Stores `stored` (user/agent alternating, `idle` at `idleAt`) and enters
    /// the Session as SessionDetailView / MainWindowView do: open at the tail,
    /// capture the read position, anchor.
    private func enter(stored: [Int], readSeq: Int, idleAt: Int? = nil, lastSeq: Int? = nil,
                       fromNotification: Bool = false, texts: [Int: String] = [:]) throws -> Entry {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("unread-window-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        var rows = stored.map { seq in
            ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: sid, deviceId: dev,
                        timestamp: "2026-11-20T00:00:00.000Z", payload: ["content": AnyCodable(texts[seq] ?? "row \(seq)")])
        }
        if let idleAt {
            rows.append(ChatMessage(type: "idle", seq: idleAt, sessionId: sid, deviceId: dev,
                                    timestamp: "2026-11-20T00:00:01.000Z", payload: [:]))
        }
        if !rows.isEmpty { try db.insert(sid, rows) }
        let head = lastSeq ?? rows.map(\.seq).max() ?? 0
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "Mac", agent: "claude", model: "m", title: "unread",
            state: .idle, mode: .auto, lastSeq: head, readSeq: readSeq, messageCount: head,
            createdAt: Date(), pinned: false)
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: head, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        let mainWindow = app.messageStore.currentWindow(sid).map(\.seq)
        if fromNotification { app.sessionStore.notificationEntrySessions.insert(sid) }
        app.sessionStore.captureEntryUnreadBoundary(sid)
        app.messageProvider?.anchorEntryWindowAtFirstUnread(sid)
        return Entry(app: app, mainWindow: mainWindow, window: app.messageStore.currentWindow(sid).map(\.seq),
                     state: app.messageStore.windowState(sid))
    }
}
