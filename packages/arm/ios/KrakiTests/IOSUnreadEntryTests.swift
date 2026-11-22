import XCTest
@testable import Kraki

#if os(iOS)
/// Entering a Session that has new messages (ChatScrollPolicy.UnreadEntry),
/// through the production `ChatPerfListVC` on an isolated SQLite store:
///  1. Foreground: back in the list, a red dot, tap in.
///  2. Cold start from a notification: the cached list doesn't know about the
///     new messages yet; they arrive (and may still stream) after the chat
///     appeared.
/// Rule: the new part fits on one screen → newest tail as always; otherwise
/// the first new message's start under the top glass, and the list stops
/// following until the user scrolls.
@MainActor
final class IOSUnreadEntryTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    private var roots: [URL] = []
    private var windows: [UIWindow] = []
    private var states: [AppState] = []
    private let sid = "unread-entry"
    private let dev = "unread-entry-device"
    /// Where a message start lands: the ↑ control's landing below the glass.
    private let landingRange: ClosedRange<CGFloat> = 116...146

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        states.removeAll()
        drain(100)
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    // MARK: Scenario 1 — red dot in the session list, tap in

    func testRedDotWithALongNewReplyOpensAtItsStart() throws {
        let fx = try open(stored: 40, readSeq: 37, overrides: [39: long(2_500), 40: long(1_500)])
        drain(800)
        let firstNew = try XCTUnwrap(screenY(fx, seq: 38), "first new message on screen")
        XCTAssertTrue(landingRange.contains(firstNew), "first new message starts under the glass, got \(firstNew)")
        XCTAssertGreaterThan(distanceToBottom(fx.cv), 300, "not at the tail: the reader starts at what's new")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
        XCTAssertTrue(fx.vc.automationControlsVisible.down, "↓ offers the newest message")

        // More arrives while reading: the reader is not pulled away.
        try ingest(fx, seq: 41, type: "agent_message", text: "Done.")
        drain(600)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 38)), firstNew, accuracy: 1)

        // ↓ ends it and goes to the tail; later arrivals follow again.
        fx.vc.automationTapDown()
        XCTAssertEqual(fx.vc.automationUnreadEntry, .none)
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
    }

    /// What Tentacle really sends after "send, leave, the reply lands": the
    /// read cursor moved along with the reply (40) and only the turn's idle
    /// (41, no row) makes the red dot. Lands on the reply's start.
    func testRedDotWhoseCursorIsOnTheReplyOpensAtTheReplyStart() throws {
        let fx = try open(stored: 40, readSeq: 40, idleAt: 41, overrides: [40: long(4_000)])
        drain(800)
        let reply = try XCTUnwrap(screenY(fx, seq: 40), "the reply on screen")
        XCTAssertTrue(landingRange.contains(reply), "the reply starts under the glass, got \(reply)")
        XCTAssertGreaterThan(distanceToBottom(fx.cv), 300, "not at the tail")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
    }

    /// The dominant case: one short unread reply (cursor on it, the turn's
    /// idle unread). Main's window and main's landing: the tail.
    func testOneShortUnreadReplyOpensAtTheTailWithMainsWindow() throws {
        let fx = try open(stored: 40, readSeq: 40, idleAt: 41, overrides: [40: "短回复"])
        XCTAssertEqual(fx.app.messageStore.currentWindow(sid).map(\.seq), fx.mainWindow, "window untouched")
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 41)
        drain(800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5, "the tail, as on main")
        XCTAssertNotNil(screenY(fx, seq: 40), "the reply on screen")
        XCTAssertNotEqual(fx.vc.automationUnreadEntry, .anchored)
    }

    func testRedDotWithAShortNewReplyOpensAtTheTail() throws {
        let fx = try open(stored: 40, readSeq: 38, overrides: [39: "继续", 40: "好的，已经改好了。"])
        drain(800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5, "fits on one screen: the tail, as always")
        let firstNew = try XCTUnwrap(screenY(fx, seq: 39))
        XCTAssertGreaterThanOrEqual(firstNew, landingRange.lowerBound, "and its start is readable there")
    }

    func testAReadSessionOpensAtTheTailAndKeepsFollowingALongReply() throws {
        let fx = try open(stored: 40, readSeq: 40)
        drain(800)
        XCTAssertEqual(fx.vc.automationUnreadEntry, .none)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
        // Watching a reply arrive in a read Session: no landing, just follow.
        try ingest(fx, seq: 41, type: "agent_message", text: long(3_000))
        drain(1_000)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
    }

    /// K-042: more new messages than the entry window holds (inside the cap).
    /// The chat opens on the first one, not on whatever row starts the newest
    /// window, and the window still ends at the newest message.
    func testBacklogLargerThanTheWindowOpensAtTheFirstUnread() throws {
        let fx = try open(stored: 100, readSeq: 40)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 100, "the newest rows stay loaded")
        drain(1_000)
        let firstNew = try XCTUnwrap(screenY(fx, seq: 41), "first new message on screen: \(visible(fx))")
        XCTAssertTrue(landingRange.contains(firstNew), "first new message starts under the glass, got \(firstNew)")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
        XCTAssertTrue(fx.vc.automationControlsVisible.down, "↓ offers the newest message")

        // ↓ still reaches the newest message of the whole conversation.
        fx.vc.automationTapDown()
        drain(1_800)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 100)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
    }

    /// A backlog above the cap (60 unread rows above the newest window, more
    /// than 30) keeps main's window and main's landing: the first new row that
    /// window holds. Extended, those 93 rows passed the window's rendered-height
    /// cap and each live arrival trimmed the row under the reader.
    func testBacklogAboveTheCapOpensLikeMainAtTheNewestWindow() throws {
        let fx = try open(stored: 130, readSeq: 40)
        XCTAssertEqual(fx.app.messageStore.currentWindow(sid).map(\.seq), fx.mainWindow)
        XCTAssertEqual(fx.mainWindow.first, 101)
        drain(1_000)
        let top = try XCTUnwrap(screenY(fx, seq: 101), "window top on screen: \(visible(fx))")
        XCTAssertTrue(landingRange.contains(top), "lands where main lands, got \(top)")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
        for seq in 131...134 {
            try ingest(fx, seq: seq, type: seq % 2 == 1 ? "user_message" : "agent_message", text: "继续")
            drain(500)
            XCTAssertEqual(fx.app.messageStore.windowState(sid)?.topSeq, 101, "nothing trimmed above the reader")
            XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 101), "after \(seq): \(visible(fx))"), top, accuracy: 1)
        }
    }

    /// The agent is working (pending permission) when a backlog is opened:
    /// the live card survives the entry and sits under the newest row.
    func testBacklogWithARunningTurnKeepsItsLiveCardAtTheHead() throws {
        let fx = try open(stored: 99, readSeq: 40) { app in
            app.messageStore.beginCardTurn(self.sid)
            app.messageStore.applyCardMessage(self.sid, "我先看一下日志。", reset: false)
            app.messageStore.setCardAction(self.sid, ChatMessage(
                type: "permission", seq: 0, sessionId: self.sid, deviceId: self.dev, timestamp: nil,
                payload: ["id": AnyCodable("p1"), "toolName": AnyCodable("shell"), "description": AnyCodable("Run: ls")]))
        }
        drain(800)
        XCTAssertNotNil(fx.app.messageStore.visibleCard(sid), "the live card is still there")
        XCTAssertEqual(fx.vc.vm.permissions.map(\.id), ["p1"], "its permission can still be answered")
        XCTAssertEqual(fx.vc.items.last, ChatPerfListVC.liveCardID)
        XCTAssertEqual(fx.vc.message(fx.vc.items[fx.vc.items.count - 2])?.seq, 99, "right under the newest row")
        fx.app.messageStore.applyCardMessage(sid, "还在查。", reset: false)
        XCTAssertEqual(fx.app.messageStore.visibleCard(sid)?.text, "我先看一下日志。还在查。", "live frames still land")
    }

    /// The agent's last message asks a question: the composer answers it.
    func testBacklogEndingInAQuestionLetsTheComposerAnswerIt() throws {
        let fx = try open(stored: 99, readSeq: 40, questionAt: 100)
        drain(600)
        let composer = ChatViewModel(sessionId: sid, appState: fx.app)
        XCTAssertEqual(composer.questions.last?.id, "q1", "the reply goes out as the answer")
        XCTAssertEqual(fx.vc.vm.questions.last?.id, "q1")
    }

    /// Unread rows this device has not stored yet: nothing is skipped inside
    /// the window — main's window and landing.
    func testBacklogWithAHoleInTheCacheSkipsNoUnreadRow() throws {
        let fx = try open(stored: 100, readSeq: 30, missing: 31...60)
        let window = fx.app.messageStore.currentWindow(sid).map(\.seq)
        XCTAssertEqual(window, fx.mainWindow)
        XCTAssertTrue(zip(window, window.dropFirst()).allSatisfy { $1 == $0 + 1 }, "no hole inside the window: \(window)")
        drain(1_000)
        let top = try XCTUnwrap(screenY(fx, seq: 71), "window top on screen: \(visible(fx))")
        XCTAssertTrue(landingRange.contains(top), "lands where main lands, got \(top)")
    }

    /// Cold start before `session_list` (no Tentacle head known yet): the
    /// newest rows this device has are still loaded and reachable.
    func testBacklogBeforeTheSessionListArrivesStillHoldsTheNewestRows() throws {
        let fx = try open(stored: 100, readSeq: 40, knowsTentacle: false)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 100)
        drain(1_000)
        XCTAssertNotNil(screenY(fx, seq: 41), "lands on the first new message: \(visible(fx))")
        let bottom = fx.cv.contentSize.height + fx.cv.adjustedContentInset.bottom - fx.cv.bounds.height
        fx.cv.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        fx.vc.scrollViewDidScroll(fx.cv)
        drain(800)
        XCTAssertNotNil(screenY(fx, seq: 100), "scrolling down reaches the newest message: \(visible(fx))")
    }

    /// Messages arriving after a backlog entry at the cap (30 unread rows
    /// above the newest window) join the window at once, trim nothing above
    /// the reader and leave them where they are; ↓ reaches them.
    func testArrivalsAfterABacklogEntryJoinTheWindowWithoutMovingTheReader() throws {
        let fx = try open(stored: 100, readSeq: 40)
        drain(1_000)
        let firstNew = try XCTUnwrap(screenY(fx, seq: 41))
        for seq in 101...104 {
            try ingest(fx, seq: seq, type: seq % 2 == 1 ? "user_message" : "agent_message", text: "继续")
            drain(500)
            XCTAssertEqual(fx.app.messageStore.windowState(sid), MessageStore.WindowState(topSeq: 38, bottomSeq: seq),
                           "in the window, not held back as history; nothing trimmed above the reader")
            XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 41), "after \(seq): \(visible(fx))"), firstNew, accuracy: 1,
                           "the reader is not moved")
        }
        fx.vc.automationTapDown()
        drain(1_800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
        XCTAssertNotNil(screenY(fx, seq: 104), "↓ reaches them")
    }

    /// Backlog that already fits in the newest window keeps that window.
    func testBacklogInsideTheWindowKeepsTheNewestWindow() throws {
        let fx = try open(stored: 200, readSeq: 190, overrides: [191: long(2_500)])
        drain(800)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 200)
        XCTAssertNotNil(screenY(fx, seq: 191))
    }

    // MARK: Scenario 2 — killed in the background, notification tap

    /// The cached list is stale (it still thinks everything is read); the
    /// notification marks the entry, and the notified reply arrives by sync
    /// after the chat is already on screen.
    func testNotificationColdStartLandsOnTheReplyWhenItArrives() throws {
        let fx = try open(stored: 30, readSeq: 30, fromNotification: true)
        drain(800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5, "until the sync lands, the cached tail")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .armed(boundary: 30))

        try ingest(fx, seq: 31, type: "agent_message", text: long(3_000))
        drain(1_000)
        let start = try XCTUnwrap(screenY(fx, seq: 31))
        XCTAssertTrue(landingRange.contains(start), "the notified reply starts under the glass, got \(start)")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
    }

    /// Notification for a short message while the agent keeps working: follow
    /// while the new part fits, then stop with the first new message at the
    /// top — never scrolling past it, never jumping back.
    func testNotificationWhileTheAgentKeepsStreamingStopsAtTheFirstNewMessage() throws {
        let fx = try open(stored: 30, readSeq: 30, fromNotification: true)
        drain(800)
        try ingest(fx, seq: 31, type: "agent_message", text: "我先看一下日志。")
        drain(600)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5, "short so far: follow the tail")

        fx.app.messageStore.beginCardTurn(sid)
        let chars = Array(long(4_000))
        var previous: CGFloat?
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 60, chars.count)]), reset: false)
            i += 60
            fx.vc.syncLiveUpdates()
            drain(24)
            guard let y = screenY(fx, seq: 31) else { XCTFail("first new message scrolled away"); return }
            XCTAssertGreaterThanOrEqual(y, landingRange.lowerBound - 1, "never scrolls past the first new message")
            if let previous { XCTAssertLessThanOrEqual(y, previous + 1, "never jumps back down") }
            previous = y
        }
        drain(400)
        let held = try XCTUnwrap(screenY(fx, seq: 31))
        XCTAssertTrue(landingRange.contains(held), "held at the top once it no longer fits, got \(held)")
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)

        // The reply lands. The turn's earlier message folds into its Steps,
        // so the landed reply — the first new bubble still shown — takes the
        // same place, and later re-pins keep it there.
        try ingest(fx, seq: 32, type: "agent_message", text: String(chars))
        fx.app.messageStore.endCardTurn(sid)
        fx.vc.syncLiveUpdates()
        drain(800)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 32)), held, accuracy: 1)
        XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
        try ingest(fx, seq: 33, type: "user_message", text: "好的，继续。")
        drain(600)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 32)), held, accuracy: 1, "still held after more arrives")
    }

    // MARK: Entry capture (red dot / notification / read)

    func testEntryCaptureTakesTheReadPositionOnlyWhenThereIsSomethingNew() throws {
        let app = AppState(testDatabase: try db())
        states.append(app)
        app.sessionStore.sessions[sid] = session(lastSeq: 10, readSeq: 10)
        app.sessionStore.captureEntryUnreadBoundary(sid)
        XCTAssertNil(app.sessionStore.entryUnreadBoundaries[sid], "read: open at the tail")

        app.sessionStore.notificationEntrySessions.insert(sid)
        app.sessionStore.captureEntryUnreadBoundary(sid)
        XCTAssertEqual(app.sessionStore.entryUnreadBoundaries[sid], 10, "notification: what arrives next is new")
        XCTAssertTrue(app.sessionStore.notificationEntrySessions.isEmpty, "used once")

        app.sessionStore.sessions[sid] = session(lastSeq: 14, readSeq: 10)
        app.sessionStore.captureEntryUnreadBoundary(sid)
        XCTAssertEqual(app.sessionStore.entryUnreadBoundaries[sid], 10, "red dot")

        app.sessionStore.sessions[sid] = session(lastSeq: 14, readSeq: 14)
        app.sessionStore.captureEntryUnreadBoundary(sid)
        XCTAssertNil(app.sessionStore.entryUnreadBoundaries[sid], "a later read entry clears it")

        app.sessionStore.sessions[sid] = session(lastSeq: 14, readSeq: 0)
        app.sessionStore.captureEntryUnreadBoundary(sid)
        XCTAssertNil(app.sessionStore.entryUnreadBoundaries[sid], "unknown read position: never the top of history")
    }

    // MARK: Fixture

    /// `mainWindow`: the entry window's seqs before the first-unread anchor
    /// (what main opens).
    struct Fx { let vc: ChatPerfListVC; let cv: UICollectionView; let app: AppState; let mainWindow: [Int] }

    private func long(_ minimum: Int) -> String {
        var text = ""
        while text.count < minimum {
            text += ChatUXRegressionTests.zh + "\n\n" + ChatUXRegressionTests.code + "\n\n" + ChatUXRegressionTests.list + "\n\n"
        }
        return text
    }

    private func db() throws -> MessageDatabase {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("unread-entry-\(UUID().uuidString)")
        roots.append(root)
        return try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
    }

    private func session(lastSeq: Int, readSeq: Int) -> SessionInfo {
        SessionInfo(id: sid, deviceId: dev, deviceName: "Mac", agent: "claude", model: "m", title: "unread",
                    state: .idle, mode: .auto, lastSeq: lastSeq, readSeq: readSeq, messageCount: lastSeq,
                    createdAt: Date(), pinned: false)
    }

    /// The Session opened the way SessionDetailView does: capture the entry
    /// (before markRead), then the chat list appears.
    /// `idleAt`: the turn ended with Tentacle's `idle` row at that seq (no
    /// bubble; it is what leaves readSeq below lastSeq for a red dot).
    /// `questionAt`: the agent's ask_user (question `q1`) at that seq.
    /// `missing`: rows this device has not stored. `knowsTentacle`: false for
    /// a cold start before `session_list`. `beforeEntry`: state already there
    /// when the Session is opened (e.g. a running turn's live card).
    private func open(stored: Int, readSeq: Int, idleAt: Int? = nil, questionAt: Int? = nil,
                      missing: ClosedRange<Int>? = nil, knowsTentacle: Bool = true, fromNotification: Bool = false,
                      overrides: [Int: String] = [:], beforeEntry: (AppState) -> Void = { _ in }) throws -> Fx {
        let database = try db()
        let msgs = (1...stored).filter { !(missing?.contains($0) ?? false) }.map { seq -> ChatMessage in
            let base = ChatUXRegressionTests.body(seq)
            return ChatMessage(type: base.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-10-09T00:00:00.000Z",
                               payload: ["content": AnyCodable(overrides[seq] ?? base.text)])
        }
        try database.insert(sid, msgs)
        if let idleAt {
            try database.insert(sid, [ChatMessage(type: "idle", seq: idleAt, sessionId: sid, deviceId: dev,
                                               timestamp: "2026-10-09T00:00:01.000Z", payload: [:])])
        }
        if let questionAt {
            let question: [String: AnyCodable] = ["id": AnyCodable("q1"), "text": AnyCodable("要不要顺便把旧接口也删掉？"),
                                                  "choices": AnyCodable(["删掉", "先保留"])]
            try database.insert(sid, [ChatMessage(type: "agent_message", seq: questionAt, sessionId: sid, deviceId: dev,
                                               timestamp: "2026-10-09T00:00:01.000Z",
                                               payload: ["content": AnyCodable(""), "question": AnyCodable(question)])])
        }
        let lastSeq = max(stored, idleAt ?? 0, questionAt ?? 0)
        let app = AppState(testDatabase: database)
        states.append(app)
        app.sessionStore.sessions[sid] = session(lastSeq: lastSeq, readSeq: readSeq)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        if knowsTentacle { app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: lastSeq, deviceId: dev) }
        beforeEntry(app)
        _ = app.messageStore.loadInitialWindow(sid)
        let mainWindow = app.messageStore.currentWindow(sid).map(\.seq)
        if fromNotification { app.sessionStore.notificationEntrySessions.insert(sid) }
        app.sessionStore.captureEntryUnreadBoundary(sid)
        app.messageProvider?.anchorEntryWindowAtFirstUnread(sid)

        let vc = ChatPerfListVC(sessionId: sid, appState: app, agent: "claude", bottomContentInset: 54)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        window.rootViewController = vc
        window.makeKeyAndVisible()
        windows.append(window)
        vc.view.frame = window.bounds
        vc.loadViewIfNeeded()
        vc.viewWillAppear(false)
        vc.view.layoutIfNeeded()
        vc.viewDidAppear(false)
        let cv = try XCTUnwrap(find(vc.view))
        return Fx(vc: vc, cv: cv, app: app, mainWindow: mainWindow)
    }

    private func ingest(_ fx: Fx, seq: Int, type: String, text: String) throws {
        let json = try JSONSerialization.data(withJSONObject: [
            "type": type, "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-10-09T00:00:01.000Z", "payload": ["content": text],
        ])
        fx.app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: seq, deviceId: dev)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: json)
        fx.vc.syncLiveUpdates()
    }

    private func find(_ view: UIView) -> UICollectionView? {
        if let c = view as? UICollectionView { return c }
        for sub in view.subviews { if let c = find(sub) { return c } }
        return nil
    }

    private func drain(_ ms: Int) {
        RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000))
    }

    /// On-screen y of a message's start, or nil when it isn't on screen.
    private func screenY(_ fx: Fx, seq: Int) -> CGFloat? {
        fx.cv.layoutIfNeeded()
        for ip in fx.cv.indexPathsForVisibleItems.sorted() {
            guard let cell = fx.cv.cellForItem(at: ip) as? TKBubbleCell,
                  let content = cell.contentSnapshot, content.message.seq == seq else { continue }
            return (cell.frame.minY - fx.cv.contentOffset.y).rounded()
        }
        return nil
    }

    private func visible(_ fx: Fx) -> String {
        fx.cv.layoutIfNeeded()
        return fx.cv.indexPathsForVisibleItems.sorted().map { ip -> String in
            let cell = fx.cv.cellForItem(at: ip)
            let seq = (cell as? TKBubbleCell)?.contentSnapshot?.message.seq ?? -1
            return "\(ip.item):\(seq)@\(Int((cell?.frame.minY ?? 0) - fx.cv.contentOffset.y))"
        }.joined(separator: ",")
    }

    private func distanceToBottom(_ cv: UICollectionView) -> CGFloat {
        cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height - cv.contentOffset.y
    }
}
#endif
