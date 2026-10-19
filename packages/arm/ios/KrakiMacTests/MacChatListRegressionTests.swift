import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Production SwiftUI → AppKit list with an isolated SQLite/provider. The
/// window is never ordered front, so these regressions do not take focus.
@MainActor
class MacChatListTestCase: XCTestCase {
    let sid = "mac-list-regression"
    let dev = "mac-list-device"
    private var windows: [NSWindow] = []
    private var apps: [AppState] = []

    override func tearDown() async throws {
        windows.forEach { $0.contentView = nil }
        windows.removeAll()
        for app in apps {
            app.messageStore.heightForSeq = nil
            app.messageStore.retainedSeqRange = nil
        }
        apps.removeAll()
        // Let SwiftUI release its cancelled tasks and their database references.
        try await Task.sleep(for: .milliseconds(100))
        try await super.tearDown()
    }

    struct Fixture {
        let app: AppState
        let window: NSWindow
        let sv: MacChatScrollView
    }

    func fixture(total: Int, stopped: Bool = false, height: CGFloat = 760) async throws -> Fixture {
        // Retain SQLite alongside the isolated runner's evidence; the UI's
        // observation graph may outlive teardown, so never unlink an open DB.
        let base = ProcessInfo.processInfo.environment["KRAKI_DATA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent("mac-list-regression-\(UUID())")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        try db.insert(sid, (1...total).map { seq in
            let type: String
            let payload: [String: AnyCodable]
            if stopped {
                switch seq % 3 {
                case 1: type = "user_message"; payload = ["content": "Stop"]
                case 2: type = "turn_status"; payload = ["action": AnyCodable(["type": "user_abort", "payload": [:]] as [String: Any])]
                default: type = "idle"; payload = [:]
                }
            } else {
                type = seq.isMultiple(of: 2) ? "agent_message" : "user_message"
                payload = ["content": AnyCodable(String(repeating: "A normal, longer reply. ", count: 30))]
            }
            return ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-10-15T00:00:00Z", payload: payload)
        })
        let app = AppState(testDatabase: db)
        apps.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "test", agent: "claude", model: "test", title: "test",
            state: .idle, mode: .auto, lastSeq: total, readSeq: total, messageCount: total,
            createdAt: Date(), pinned: false)
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: total, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        XCTAssertEqual(app.messageStore.currentWindow(sid).count, 15)
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        let host = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: vm).environment(app))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: height),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        windows.append(window)
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
        func find(_ view: NSView) -> MacChatScrollView? {
            if let sv = view as? MacChatScrollView { return sv }
            return view.subviews.lazy.compactMap(find).first
        }
        return Fixture(app: app, window: window, sv: try XCTUnwrap(find(host)))
    }

    func settle(_ fx: Fixture) async {
        for _ in 0..<60 {
            fx.window.contentView?.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    func renderedAction(in cell: MacChatBubbleCell) throws -> MacBubbleActionSlot {
        func find(_ view: NSView) -> NSHostingView<MacBubbleActionSlot?>? {
            if let host = view as? NSHostingView<MacBubbleActionSlot?> { return host }
            return view.subviews.lazy.compactMap(find).first
        }
        let host = try XCTUnwrap(find(cell))
        XCTAssertFalse(host.isHidden)
        XCTAssertGreaterThan(host.frame.height, 0)
        XCTAssertTrue(cell.frame.intersects(try XCTUnwrap(cell.enclosingScrollView).contentView.bounds))
        // Headless SwiftUI does not expose Text's AX children. Read the exact
        // root view installed in the visible cell, not a freshly built action.
        return try XCTUnwrap(host.rootView)
    }
}

@MainActor
final class MacChatListRegressionTests: MacChatListTestCase {
    func testParallelToolCountUpdatesWithoutChangingTheText() async throws {
        let fx = try await fixture(total: 30)
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageStore.applyCardMessage(sid, "Checking the three packages.", reset: true)
        func batch(_ running: Int) -> ChatMessage {
            ChatMessage(type: "tool_batch", seq: 0, sessionId: sid, deviceId: dev,
                        timestamp: "2026-10-15T00:00:00Z", payload: ["running": AnyCodable(running)])
        }
        fx.app.messageStore.applyCardAction(sid, batch(3))
        await settle(fx)
        let before = try XCTUnwrap(fx.sv.chatDocumentView.automationVisibleCells.first { $0.key == "__live__" }?.cell)
        XCTAssertEqual(try renderedAction(in: before).parallelToolLabel, "3 tools running in parallel…")
        let text = before.content?.body?.string

        fx.app.messageStore.applyCardAction(sid, batch(2))
        await settle(fx)
        let after = try XCTUnwrap(fx.sv.chatDocumentView.automationVisibleCells.first { $0.key == "__live__" }?.cell)
        XCTAssertEqual(after.content?.body?.string, text, "only the action payload changes")
        XCTAssertEqual(try renderedAction(in: after).parallelToolLabel, "2 tools running in parallel…",
                       "the actual visible cell's SwiftUI action label must update")
    }

    func testOtherRenderedActionPayloadChangesRefreshTheVisibleSlot() async throws {
        let fx = try await fixture(total: 30)
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageStore.applyCardMessage(sid, "Unchanged body.", reset: true)
        let changes: [(String, String, AnyCodable, AnyCodable)] = [
            ("tool_start", "toolName", "old_tool", "new_tool"),
            ("permission", "description", "Old description", "New description"),
            ("permission", "args", AnyCodable(["command": "pwd"]), AnyCodable(["command": "ls"])),
            ("question", "choices", AnyCodable(["Before"]), AnyCodable(["After"])),
            ("failed", "message", "Old failure", "New failure"),
        ]
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        for (type, key, old, new) in changes {
            func action(_ value: AnyCodable) -> ChatMessage {
                ChatMessage(type: type, seq: 0, sessionId: sid, deviceId: dev,
                            timestamp: nil, payload: [key: value])
            }
            fx.app.messageStore.applyCardAction(sid, action(old))
            await settle(fx)
            fx.app.messageStore.applyCardAction(sid, action(new))
            await settle(fx)
            let cell = try XCTUnwrap(fx.sv.chatDocumentView.automationVisibleCells.first { $0.key == "__live__" }?.cell)
            let rendered = try renderedAction(in: cell).action
            XCTAssertEqual(try encoder.encode(rendered.payload[key]), try encoder.encode(new), "\(type).\(key)")
            XCTAssertEqual(cell.content?.body?.string, "Unchanged body.")
        }
    }
}
