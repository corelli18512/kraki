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
        let fx = try open(stored: 40, readSeq: 40, lastSeq: 41, overrides: [40: Self.longAnswer(4_000)])
        drain(1_200)
        XCTAssertEqual(try XCTUnwrap(screenY(fx, seq: 40)), landing, accuracy: 2, "the reply starts at the top")
        XCTAssertGreaterThan(distanceToBottom(fx), 300)
        XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
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

    // MARK: Fixture

    private func open(stored: Int, readSeq: Int, lastSeq: Int? = nil, fromNotification: Bool = false,
                      overrides: [Int: String] = [:]) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-unread-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, (1...stored).map { seq in
            let b = Self.body(seq)
            return ChatMessage(type: b.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-10-09T00:00:00.000Z",
                               payload: ["content": AnyCodable(overrides[seq] ?? b.text)])
        })
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "PC", agent: "claude", model: "m", title: "unread",
            state: .idle, mode: .auto, lastSeq: lastSeq ?? stored, readSeq: readSeq, messageCount: stored,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "PC", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: stored, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        // As MainWindowView does on selection, before marking the Session read.
        if fromNotification { app.sessionStore.notificationEntrySessions.insert(sid) }
        app.sessionStore.captureEntryUnreadBoundary(sid)
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
