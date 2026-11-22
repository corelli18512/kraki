import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// ↓ and a send return to the newest message (MacChatView.reanchorNewest),
/// through the production MacChatView in a real window.
@MainActor
final class MacReanchorNewestTests: MacChatUXTestCase {
    /// K-016 on the Mac: from deep history (the window's bottom 250 stored rows
    /// above the newest one), ↓ reaches the newest message of the whole
    /// conversation even when the gap exceeds the slide's page cap.
    func testDownFromDeepHistoryReachesTheHead() throws {
        let fx = try openInHistory(total: 400, newerRowsBelowWindow: 250)
        drain(1_200)
        XCTAssertLessThanOrEqual(fx.app.messageStore.windowState(sid)?.bottomSeq ?? .max, 150, "entered in history mode")

        fx.sv.automationTapDown()
        // The re-anchor itself (synchronous) must reach the head: newer edge
        // paging afterwards is not guaranteed to run.
        XCTAssertEqual(fx.app.messageStore.windowState(sid)?.bottomSeq, 400,
                       "the window must reach the head, not stop after the slide cap")
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1.5)
        XCTAssertNotNil(fx.doc.frame(forSeq: 400), "the newest message is laid out")
    }

    /// A Session whose window was left in history mode: its bottom at least
    /// `newerRowsBelowWindow` stored rows above the newest one (older paging
    /// trimmed them), as after reading far back.
    private func openInHistory(total: Int, newerRowsBelowWindow: Int) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-reanchor-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, (1...total).map { seq in
            let b = Self.body(seq)
            return ChatMessage(type: b.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-09-01T00:00:00.000Z", payload: ["content": AnyCodable(b.text)])
        })
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "gate", agent: "claude", model: "m", title: "gate",
            state: .idle, mode: .auto, lastSeq: total, readSeq: total, messageCount: total,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "gate", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: total, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        let store = app.messageStore
        store.heightForSeq = { _, _ in 100 }
        store.maxWindowPx = 3_000
        while let state = store.windowState(sid), state.bottomSeq > total - newerRowsBelowWindow, state.topSeq > 1 {
            let page = store.dbMessagesBefore(sid, beforeSeq: state.topSeq, limit: 10)
            guard !page.isEmpty else { break }
            store.prependOlderPage(sid, page)
        }
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
}
