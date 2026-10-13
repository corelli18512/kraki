import XCTest
import SwiftUI
@testable import Kraki

/// 2-14 (review group 2, 2026-10-13): a rejected Stop or an undeliverable
/// prompt (an `error` reply, session state unchanged) must not leave the
/// composer's Stop spinner or "busy" latch on.
@MainActor
final class ComposerLatchSettlingTests: XCTestCase {
    final class Latches { var awaitingActive = true; var abortPending = true }

    private struct Probe: View {
        let sessionId: String
        let latches: Latches
        @State private var awaitingActive = true
        @State private var abortPending = true
        var body: some View {
            Color.clear
                .settlesComposerLatches(sessionId: sessionId, state: .active,
                                        awaitingActive: $awaitingActive, abortPending: $abortPending)
                .onChange(of: awaitingActive) { _, value in latches.awaitingActive = value }
                .onChange(of: abortPending) { _, value in latches.abortPending = value }
        }
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    func testErrorReplyEndsStopAndBusyLatches() throws {
        let sid = "latch-session"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("latch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        func row(_ type: String, _ seq: Int, _ text: String) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: nil, timestamp: nil,
                        payload: [type == "error" ? "message" : "content": AnyCodable(text)])
        }
        app.messageStore.ingestBatch(sid, [row("user_message", 1, "go")])
        _ = app.messageStore.loadInitialWindow(sid)

        let latches = Latches()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        window.rootViewController = UIHostingController(rootView: Probe(sessionId: sid, latches: latches).environment(app))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        drain(200)
        XCTAssertTrue(latches.awaitingActive && latches.abortPending)

        app.messageStore.ingestBatch(sid, [row("error", 2, "Failed to abort session: busy")])
        drain(300)
        XCTAssertFalse(latches.awaitingActive, "the composer is no longer waiting for the turn")
        XCTAssertFalse(latches.abortPending, "Stop can be pressed again")
    }
}
