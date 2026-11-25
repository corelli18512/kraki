import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Entering a Session with new messages on the Mac (ChatScrollPolicy.UnreadEntry,
/// same rule as iPhone), through the production MacChatView in a real window:
/// a red dot in the sidebar, and a notification click whose new messages
/// arrive (and may still stream) after the chat appeared.
@MainActor
final class MacUnreadEntryTests: MacChatUXTestCase {
    private var landing: CGFloat { MacChatHeaderMetrics.listTopInset }

    func testRedDotWithALongNewReplyOpensAtItsStart() throws {
        let fx = try open(stored: 40, readSeq: 37, overrides: [39: Self.longAnswer(2_500), 40: Self.longAnswer(1_500)])
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 38)), landing, accuracy: 2, "first new message at the top")
        XCTAssertGreaterThan(distanceToBottom(fx), 300)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)

        try ingest(fx, ["type": "user_message", "seq": 41, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-10-09T00:00:03.000Z", "payload": ["content": "继续"]])
        drain(600)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 38)), landing, accuracy: 2, "not pulled away by arrivals")

        fx.sv.automationTapDown()
        XCTAssertEqual(fx.sv.automationUnreadEntry, .none)
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
    }

    /// What Tentacle really sends after "send, leave, the reply lands": the
    /// read cursor moved along with the reply (40) and only the turn's idle
    /// (41, no row) makes the red dot. Lands on the reply's start.
    func testRedDotWhoseCursorIsOnTheReplyOpensAtTheReplyStart() throws {
        let fx = try open(stored: 40, readSeq: 40, idleAt: 41, overrides: [40: Self.longAnswer(4_000)])
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 40)), landing, accuracy: 2, "the reply starts at the top")
        XCTAssertGreaterThan(distanceToBottom(fx), 300)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
    }

    /// The dominant case: one short unread reply (cursor on it, the turn's
    /// idle unread). Main's window and main's landing: the tail.
    func testOneShortUnreadReplyOpensAtTheTailWithMainsWindow() throws {
        let fx = try open(stored: 40, readSeq: 40, idleAt: 41, overrides: [40: "短回复"])
        XCTAssertEqual(fx.app.messageStore.currentWindow(sid).map(\.seq), mainWindow, "window untouched")
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 41)
        drain(1_200)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5, "the tail, as on main")
        XCTAssertNotNil(screenY(fx, seq: 40), "the reply on screen")
        XCTAssertNotEqual(fx.sv.automationUnreadEntry, .anchored)
    }

    func testRedDotWithAShortNewReplyOpensAtTheTail() throws {
        let fx = try open(stored: 40, readSeq: 38, overrides: [39: "继续", 40: "好的，已经改好了。"])
        drain(1_200)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
        XCTAssertNotEqual(fx.sv.automationUnreadEntry, .anchored, "fits: still following the tail")
        // So a new reply arriving is followed, as in any read Session.
        try ingest(fx, ["type": "agent_message", "seq": 41, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-10-09T00:00:03.000Z", "payload": ["content": "补充：测试也过了。"]])
        drain(800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
    }

    /// K-042: more new messages than the 15-row entry window holds (inside the
    /// cap). The chat opens on the first one, not on whatever row starts the
    /// newest window, and the window still ends at the newest message.
    func testBacklogLargerThanTheWindowOpensAtTheFirstUnread() throws {
        let fx = try open(stored: 60, readSeq: 20)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 60, "the newest rows stay loaded")
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 21), "first new message on screen"), landing, accuracy: 2)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
        XCTAssertGreaterThan(distanceToBottom(fx), 300)
    }

    /// A backlog above the cap (30 rows above the newest window) keeps main's
    /// window and main's landing: the first new row that window holds.
    func testBacklogAboveTheCapOpensLikeMainAtTheNewestWindow() throws {
        let fx = try open(stored: 200, readSeq: 10)
        XCTAssertEqual(fx.app.messageStore.currentWindow(sid).map(\.seq), mainWindow)
        XCTAssertEqual(mainWindow.first, 186)
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 186), "window top on screen"), landing, accuracy: 2)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
    }

    /// ↓ and a send after a large-backlog entry reach the conversation's
    /// newest message.
    func testDownAndSendAfterALargeBacklogEntryReachTheNewestMessage() throws {
        let fx = try open(stored: 200, readSeq: 10)
        drain(1_200)
        fx.sv.automationTapDown()
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 200, "↓ re-anchors at the head")
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
        XCTAssertNotNil(screenY(fx, seq: 200))

        XCTAssertTrue(fx.app.commandSender?.sendInput(sessionId: sid, text: "继续") ?? false)
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
        drain(1_500)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 200)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5, "the sent message at the bottom")
    }

    /// The agent is working when a backlog is opened: the live card sits
    /// under the newest row, not under an old one in the middle.
    func testBacklogWithARunningTurnShowsItsLiveCardAtTheHead() throws {
        let fx = try open(stored: 61, readSeq: 20) { app in
            app.messageStore.beginCardTurn(self.sid)
            app.messageStore.applyCardMessage(self.sid, "我先看一下日志。", reset: false)
        }
        drain(1_200)
        XCTAssertNotNil(fx.app.messageStore.visibleCard(sid))
        XCTAssertEqual(fx.doc.contents.last?.key, "__live__")
        XCTAssertEqual(fx.doc.contents.dropLast().last?.seq, 61, "right under the newest row")
    }

    /// The agent's last message asks a question: the composer answers it.
    func testBacklogEndingInAQuestionLetsTheComposerAnswerIt() throws {
        let fx = try open(stored: 60, readSeq: 20, questionAt: 61)
        drain(800)
        XCTAssertEqual(fx.vm.questions.last?.id, "q1", "the reply goes out as the answer")
    }

    /// Unread rows this device has not stored yet: nothing is skipped inside
    /// the window — main's window and landing.
    func testBacklogWithAHoleInTheCacheSkipsNoUnreadRow() throws {
        let fx = try open(stored: 60, readSeq: 20, missing: 21...35)
        let window = fx.app.messageStore.currentWindow(sid).map(\.seq)
        XCTAssertEqual(window, mainWindow)
        XCTAssertTrue(zip(window, window.dropFirst()).allSatisfy { $1 == $0 + 1 }, "no hole inside the window: \(window)")
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 46), "window top on screen"), landing, accuracy: 2)
    }

    /// Window restore before `session_list` (no Tentacle head known yet): the
    /// newest rows this device has are still loaded.
    func testBacklogBeforeTheSessionListArrivesStillHoldsTheNewestRows() throws {
        let fx = try open(stored: 60, readSeq: 20, knowsTentacle: false)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 60)
        drain(1_200)
        XCTAssertNotNil(screenY(fx, seq: 21), "lands on the first new message")
    }

    /// Six short unread turns: more raw rows (with their idles) than the
    /// entry window holds, yet they fit on one screen — the conversation's
    /// newest end, as for any unread part that fits.
    func testShortUnreadTurnsThatFitEndAtTheNewestMessage() throws {
        var types: [Int: String] = [:]
        var texts: [Int: String] = [:]
        for turn in 0..<6 {
            let seq = 23 + turn * 3
            types[seq] = "user_message"; texts[seq] = "继续"
            types[seq + 1] = "agent_message"; texts[seq + 1] = "好的。"
            types[seq + 2] = "idle"
        }
        let fx = try open(stored: 40, readSeq: 22, overrides: texts, types: types)
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 40)
        drain(1_200)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5, "fits: the newest end")
        XCTAssertNotNil(screenY(fx, seq: 39), "the newest reply on screen")
        XCTAssertNotNil(screenY(fx, seq: 23), "and the first new message")
    }

    func testAReadSessionOpensAtTheTail() throws {
        let fx = try open(stored: 40, readSeq: 40)
        drain(1_200)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .none)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
    }

    func testNotificationLandsOnTheReplyWhenItArrives() throws {
        let fx = try open(stored: 30, readSeq: 30, fromNotification: true)
        drain(1_200)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5, "cached tail until the sync lands")
        try ingest(fx, ["type": "agent_message", "seq": 31, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-10-09T00:00:03.000Z", "payload": ["content": Self.longAnswer(3_000)]])
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 31)), landing, accuracy: 2)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
    }

    func testNotificationWhileTheAgentKeepsStreamingStopsAtTheFirstNewMessage() throws {
        let fx = try open(stored: 30, readSeq: 30, fromNotification: true)
        drain(1_200)
        try ingest(fx, ["type": "agent_message", "seq": 31, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-10-09T00:00:03.000Z", "payload": ["content": "我先看一下日志。"]])
        drain(600)
        fx.app.messageStore.beginCardTurn(sid)
        let chars = Array(Self.longAnswer(4_000))
        var previous: CGFloat?
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 60, chars.count)]), reset: false)
            i += 60
            drain(30)
            guard let y = screenY(fx, seq: 31) else { XCTFail("first new message scrolled away"); return }
            XCTAssertGreaterThanOrEqual(y, landing - 1, "never scrolls past the first new message")
            if let previous { XCTAssertLessThanOrEqual(y, previous + 1, "never jumps back down") }
            previous = y
        }
        drain(500)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 31)), landing, accuracy: 2)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
    }

    /// Messages arriving after a backlog entry join the window at once and
    /// leave the reader where they are; ↓ reaches them.
    func testArrivalsAfterABacklogEntryJoinTheWindowWithoutMovingTheReader() throws {
        let fx = try open(stored: 60, readSeq: 20)
        drain(1_200)
        let firstNew = try XCTUnwrap(screenY(fx, seq: 21))
        for seq in 61...64 {
            try ingest(fx, ["type": seq % 2 == 1 ? "user_message" : "agent_message", "seq": seq, "sessionId": sid,
                            "deviceId": dev, "timestamp": "2026-10-09T00:00:03.000Z", "payload": ["content": "继续"]])
            drain(500)
            XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, seq, "in the window, not held back as history")
            XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 21), "after \(seq)"), firstNew, accuracy: 2, "the reader is not moved")
        }
        fx.sv.automationTapDown()
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
        XCTAssertNotNil(screenY(fx, seq: 64), "↓ reaches them")
    }

    // MARK: Fixture

    /// Seqs of the last opened entry window before the first-unread anchor
    /// (what main opens).
    private var mainWindow: [Int] = []

    /// `idleAt`: the turn ended with Tentacle's `idle` row at that seq (no
    /// bubble; it is what leaves readSeq below lastSeq for a red dot).
    /// `questionAt`: the agent's ask_user (question `q1`) at that seq.
    /// `missing`: rows this device has not stored. `knowsTentacle`: false for
    /// a launch before `session_list`. `types`: row types other than the
    /// alternating user/agent ones. `beforeEntry`: state already there when the
    /// Session is selected (e.g. a running turn's live card).
    private func open(stored: Int, readSeq: Int, idleAt: Int? = nil, questionAt: Int? = nil,
                      missing: ClosedRange<Int>? = nil, knowsTentacle: Bool = true, fromNotification: Bool = false,
                      overrides: [Int: String] = [:], types: [Int: String] = [:],
                      beforeEntry: (AppState) -> Void = { _ in }) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-unread-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, (1...stored).filter { !(missing?.contains($0) ?? false) }.map { seq in
            let b = Self.body(seq)
            let type = types[seq] ?? b.type
            return ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-10-09T00:00:00.000Z",
                               payload: type == "idle" ? [:] : ["content": AnyCodable(overrides[seq] ?? b.text)])
        })
        if let idleAt {
            try db.insert(sid, [ChatMessage(type: "idle", seq: idleAt, sessionId: sid, deviceId: dev,
                                               timestamp: "2026-10-09T00:00:01.000Z", payload: [:])])
        }
        if let questionAt {
            let question: [String: AnyCodable] = ["id": AnyCodable("q1"), "text": AnyCodable("要不要顺便把旧接口也删掉？"),
                                                  "choices": AnyCodable(["删掉", "先保留"])]
            try db.insert(sid, [ChatMessage(type: "agent_message", seq: questionAt, sessionId: sid, deviceId: dev,
                                               timestamp: "2026-10-09T00:00:01.000Z",
                                               payload: ["content": AnyCodable(""), "question": AnyCodable(question)])])
        }
        let lastSeq = max(stored, idleAt ?? 0, questionAt ?? 0)
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "PC", agent: "claude", model: "m", title: "unread",
            state: .idle, mode: .auto, lastSeq: lastSeq, readSeq: readSeq, messageCount: stored,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "PC", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        if knowsTentacle { app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: lastSeq, deviceId: dev) }
        beforeEntry(app)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        mainWindow = app.messageStore.currentWindow(sid).map(\.seq)
        // As MainWindowView does on selection, before marking the Session read.
        if fromNotification { app.sessionStore.notificationEntrySessions.insert(sid) }
        app.sessionStore.captureEntryUnreadBoundary(sid)
        app.messageProvider?.anchorEntryWindowAtFirstUnread(sid)
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        let host = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: vm).environment(app))
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 900, height: 760),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.level = .floating
        window.orderFrontRegardless()
        windows.append(window)
        drain(50)
        let sv = try XCTUnwrap(find(host), "MacChatScrollView not mounted")
        return Fx(app: app, vm: vm, window: window, sv: sv)
    }

    private func screenY(_ fx: Fx, seq: Int) -> CGFloat? {
        guard let frame = fx.doc.frame(forSeq: seq) else { return nil }
        let y = frame.minY - fx.sv.contentView.bounds.minY
        return (y + frame.height > 0 && y < fx.sv.contentView.bounds.height) ? y.rounded() : nil
    }
}
