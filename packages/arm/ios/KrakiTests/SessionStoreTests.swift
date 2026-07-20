import XCTest
@testable import Kraki

final class SessionStoreTests: XCTestCase {

    private var store: SessionStore!

    override func setUp() {
        super.setUp()
        store = SessionStore()
        // Clear any state SessionStore hydrated from on-disk caches
        // so tests start from a clean slate.
        store.reset()
    }

    override func tearDown() {
        store?.reset()
        store = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeDigest(
        id: String = "sess-1",
        agent: String = "claude",
        model: String? = "claude-3",
        title: String? = nil,
        autoTitle: String? = nil,
        state: SessionState = .active,
        mode: SessionMode = .execute,
        lastSeq: Int = 10,
        readSeq: Int = 5,
        messageCount: Int = 8,
        pinned: Bool? = nil
    ) -> SessionDigest {
        SessionDigest(
            id: id, agent: agent, model: model, title: title,
            autoTitle: autoTitle, state: state, mode: mode,
            lastSeq: lastSeq, readSeq: readSeq, messageCount: messageCount,
            createdAt: "2024-01-01T00:00:00.000Z", usage: nil, pinned: pinned
        )
    }

    // MARK: - Upsert

    func testUpsertSession() {
        let digest = makeDigest()
        store.upsertSession(digest, deviceId: "dev-1", deviceName: "MacBook")

        let session = store.sessions["sess-1"]
        XCTAssertNotNil(session)
        XCTAssertEqual(session?.id, "sess-1")
        XCTAssertEqual(session?.agent, "claude")
        XCTAssertEqual(session?.model, "claude-3")
        XCTAssertEqual(session?.state, .active)
        XCTAssertEqual(session?.mode, .execute)
        XCTAssertEqual(session?.deviceId, "dev-1")
        XCTAssertEqual(session?.deviceName, "MacBook")
        XCTAssertEqual(store.sessionModes["sess-1"], .execute)
    }

    func testUpsertSessionUpdatesExisting() {
        store.upsertSession(makeDigest(), deviceId: "dev-1", deviceName: "MacBook")
        XCTAssertEqual(store.sessions["sess-1"]?.state, .active)

        let updated = makeDigest(state: .idle, mode: .safe, lastSeq: 20)
        store.upsertSession(updated, deviceId: "dev-1", deviceName: "MacBook")

        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertEqual(store.sessions["sess-1"]?.state, .idle)
        XCTAssertEqual(store.sessions["sess-1"]?.mode, .safe)
        XCTAssertEqual(store.sessions["sess-1"]?.lastSeq, 20)
    }

    // MARK: - Remove

    func testRemoveSession() {
        store.upsertSession(makeDigest(pinned: true), deviceId: "dev-1", deviceName: "MB")
        store.setPreview("sess-1", text: "hi")
        store.setDraft("sess-1", "draft")
        store.incrementUnread("sess-1")

        store.removeSession("sess-1")

        XCTAssertNil(store.sessions["sess-1"])
        XCTAssertFalse(store.pinnedSessions.contains("sess-1"))
        XCTAssertNil(store.unreadCounts["sess-1"])
        XCTAssertNil(store.sessionModes["sess-1"])
        XCTAssertNil(store.sessionPreviews["sess-1"])
        XCTAssertNil(store.drafts["sess-1"])
    }

    // MARK: - Properties

    func testSetMode() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setMode("sess-1", .safe)
        XCTAssertEqual(store.sessions["sess-1"]?.mode, .safe)
        XCTAssertEqual(store.sessionModes["sess-1"], .safe)
    }

    func testSetModel() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setModel("sess-1", "gpt-4")
        XCTAssertEqual(store.sessions["sess-1"]?.model, "gpt-4")
    }

    func testSetTitle() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setTitle("sess-1", title: "My Title", autoTitle: "Auto")
        XCTAssertEqual(store.sessions["sess-1"]?.title, "My Title")
        XCTAssertEqual(store.sessions["sess-1"]?.autoTitle, "Auto")
    }

    func testSetTitlePartial() {
        store.upsertSession(makeDigest(title: "Old"), deviceId: "d", deviceName: "n")
        store.setTitle("sess-1", title: nil, autoTitle: "New Auto")
        XCTAssertEqual(store.sessions["sess-1"]?.title, "Old")
        XCTAssertEqual(store.sessions["sess-1"]?.autoTitle, "New Auto")
    }

    func testSetState() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setState("sess-1", .idle)
        XCTAssertEqual(store.sessions["sess-1"]?.state, .idle)
    }

    // MARK: - Pin

    func testSetPinned() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")

        store.setPinned("sess-1", true)
        XCTAssertEqual(store.sessions["sess-1"]?.pinned, true)
        XCTAssertTrue(store.pinnedSessions.contains("sess-1"))

        store.setPinned("sess-1", false)
        XCTAssertEqual(store.sessions["sess-1"]?.pinned, false)
        XCTAssertFalse(store.pinnedSessions.contains("sess-1"))
    }

    // MARK: - Unread

    func testMarkRead() {
        // markRead clamps to lastSeq so the user can't accidentally
        // mark seqs that don't exist yet as read. After bumping
        // lastSeq three times we can mark up to the new lastSeq.
        store.upsertSession(makeDigest(lastSeq: 5, readSeq: 5), deviceId: "d", deviceName: "n")
        store.incrementUnread("sess-1") // lastSeq → 6
        XCTAssertEqual(store.unreadCounts["sess-1"], 1)

        store.markRead("sess-1", seq: 100)
        XCTAssertEqual(store.sessions["sess-1"]?.readSeq, 6) // clamped to lastSeq
        XCTAssertNil(store.unreadCounts["sess-1"])
    }

    func testIncrementUnread() {
        // The seq-based unread shim requires an existing session —
        // a counter without a session has nowhere to live in the
        // new model. Upsert first, then bump.
        store.upsertSession(makeDigest(lastSeq: 0, readSeq: 0), deviceId: "d", deviceName: "n")
        store.incrementUnread("sess-1")
        store.incrementUnread("sess-1")
        store.incrementUnread("sess-1")
        XCTAssertEqual(store.unreadCounts["sess-1"], 3)
    }

    func testClearUnread() {
        store.upsertSession(makeDigest(lastSeq: 0, readSeq: 0), deviceId: "d", deviceName: "n")
        store.incrementUnread("sess-1")
        store.clearUnread("sess-1")
        XCTAssertNil(store.unreadCounts["sess-1"])
    }

    // MARK: - Preview / Draft

    func testSetPreview() {
        store.setPreview("sess-1", text: "Hello", type: "message", timestamp: "2024-01-01T00:00:00Z")
        let preview = store.sessionPreviews["sess-1"]
        XCTAssertEqual(preview?.text, "Hello")
        XCTAssertEqual(preview?.type, "message")
        XCTAssertEqual(preview?.timestamp, "2024-01-01T00:00:00Z")
    }

    func testSetDraft() {
        store.setDraft("sess-1", "my draft")
        XCTAssertEqual(store.drafts["sess-1"], "my draft")

        store.setDraft("sess-1", "")
        XCTAssertNil(store.drafts["sess-1"])
    }

    func testSortedSessions() {
        store.upsertSession(makeDigest(id: "s1"), deviceId: "d", deviceName: "n")
        store.upsertSession(makeDigest(id: "s2", pinned: true), deviceId: "d", deviceName: "n")
        store.upsertSession(makeDigest(id: "s3"), deviceId: "d", deviceName: "n")

        // Set different preview timestamps to control ordering
        store.setPreview("s1", text: "a", timestamp: "2024-01-01T00:00:00Z")
        store.setPreview("s3", text: "c", timestamp: "2024-01-03T00:00:00Z")

        let sorted = store.sortedSessions
        // Pinned session (s2) should be first
        XCTAssertEqual(sorted[0].id, "s2")
        // Then s3 (later timestamp), then s1
        XCTAssertEqual(sorted[1].id, "s3")
        XCTAssertEqual(sorted[2].id, "s1")
    }

    // MARK: - Total Unread

    func testTotalUnread() {
        // Same constraint as testIncrementUnread — totalUnread sums
        // unread counts over existing sessions, so the test needs to
        // upsert them first.
        store.upsertSession(makeDigest(id: "s1", lastSeq: 0, readSeq: 0), deviceId: "d", deviceName: "n")
        store.upsertSession(makeDigest(id: "s2", lastSeq: 0, readSeq: 0), deviceId: "d", deviceName: "n")
        store.incrementUnread("s1")
        store.incrementUnread("s1")
        store.incrementUnread("s2")
        XCTAssertEqual(store.totalUnread, 3)
    }

    // MARK: - Reset

    func testReset() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.incrementUnread("sess-1")
        store.setPreview("sess-1", text: "hi")
        store.setDraft("sess-1", "draft")
        store.activeSessionId = "sess-1"

        store.reset()

        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.activeSessionId)
        XCTAssertTrue(store.pinnedSessions.isEmpty)
        XCTAssertTrue(store.unreadCounts.isEmpty)
        XCTAssertTrue(store.sessionModes.isEmpty)
        XCTAssertTrue(store.sessionPreviews.isEmpty)
        XCTAssertTrue(store.drafts.isEmpty)
        XCTAssertNil(store.navigateToSession)
    }

    // MARK: - Sync Sessions

    func testSyncSessions() {
        let digests = [
            makeDigest(id: "s1"),
            makeDigest(id: "s2"),
            makeDigest(id: "s3"),
        ]
        store.syncSessions(digests, deviceId: "dev-1", deviceName: "MB")
        XCTAssertEqual(store.sessions.count, 3)
        XCTAssertNotNil(store.sessions["s1"])
        XCTAssertNotNil(store.sessions["s2"])
        XCTAssertNotNil(store.sessions["s3"])
    }

    // MARK: - Convenience Methods

    func testUpdateState() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.updateState("sess-1", state: "idle")
        XCTAssertEqual(store.sessions["sess-1"]?.state, .idle)
    }

    func testUpdateStateEnded() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.updateState("sess-1", state: "ended")
        XCTAssertEqual(store.sessions["sess-1"]?.state, .idle)
    }

    func testSetSessionTitle() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setSessionTitle("sess-1", title: "Auto Name", autoTitle: true)
        XCTAssertEqual(store.sessions["sess-1"]?.autoTitle, "Auto Name")
        XCTAssertNil(store.sessions["sess-1"]?.title)
    }

    func testSessionDisplayTitle() {
        store.upsertSession(makeDigest(title: nil, autoTitle: nil), deviceId: "d", deviceName: "n")
        XCTAssertEqual(store.sessions["sess-1"]?.displayTitle, "New Session")

        store.setTitle("sess-1", title: nil, autoTitle: "Auto")
        XCTAssertEqual(store.sessions["sess-1"]?.displayTitle, "Auto")

        store.setTitle("sess-1", title: "Explicit", autoTitle: nil)
        XCTAssertEqual(store.sessions["sess-1"]?.displayTitle, "Explicit")
    }

    func testSetSessionUsageFromDict() {
        store.upsertSession(makeDigest(), deviceId: "d", deviceName: "n")
        store.setSessionUsage("sess-1", usage: [
            "inputTokens": 100,
            "outputTokens": 200,
            "cacheReadTokens": 50,
            "cacheWriteTokens": 25,
            "totalCost": 0.05,
            "totalDurationMs": 1500.0,
        ])
        let usage = store.sessionUsage["sess-1"]
        XCTAssertNotNil(usage)
        XCTAssertEqual(usage?.inputTokens, 100)
        XCTAssertEqual(usage?.outputTokens, 200)
    }

    func testUpsertSessionUnreadReconciliation() {
        // lastSeq > readSeq should set unread if not already larger
        let digest = makeDigest(lastSeq: 10, readSeq: 5)
        store.upsertSession(digest, deviceId: "d", deviceName: "n")
        XCTAssertEqual(store.unreadCounts["sess-1"], 5)
    }
}
