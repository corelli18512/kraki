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

    // MARK: K-034: a prompt that is not on its way to start a turn

    /// An idle session whose composer has just sent a prompt (the latch the
    /// composer sets after Send).
    private struct SentPromptProbe: View {
        let sessionId: String
        let latches: Latches
        @State private var awaitingActive = true
        @State private var abortPending = false
        var body: some View {
            Color.clear
                .settlesComposerLatches(sessionId: sessionId, state: .idle,
                                        awaitingActive: $awaitingActive, abortPending: $abortPending)
                .onChange(of: awaitingActive, initial: true) { _, value in latches.awaitingActive = value }
        }
    }

    private let promptSession = "latch-prompt"
    private let promptDevice = "latch-device"

    private func makePromptApp(computerOnline: Bool) throws -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("latch-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.sessionStore.sessions[promptSession] = SessionInfo(
            id: promptSession, deviceId: promptDevice, deviceName: "Desk", agent: "claude", model: "m", title: "t",
            state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        app.deviceStore.devices[promptDevice] = DeviceSummary(
            id: promptDevice, name: "Desk", role: .tentacle, kind: .desktop, online: computerOnline)
        app.testOutboundMessageHandler = { _, _, _ in true }
        return app
    }

    private func mount(_ app: AppState, _ latches: Latches) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        window.rootViewController = UIHostingController(
            rootView: SentPromptProbe(sessionId: promptSession, latches: latches).environment(app))
        window.makeKeyAndVisible()
        return window
    }

    func testPromptQueuedForAnOfflineComputerDoesNotKeepTheComposerSteering() throws {
        let app = try makePromptApp(computerOnline: false)
        XCTAssertTrue(app.commandSender?.sendInput(sessionId: promptSession, text: "queued") == true)
        let latches = Latches()
        let window = mount(app, latches)
        defer { window.isHidden = true; window.rootViewController = nil }
        drain(300)
        XCTAssertFalse(latches.awaitingActive, "a queued prompt cannot start a turn: the next message is a prompt")
    }

    func testUnconfirmedPromptEndsTheLatch() throws {
        let app = try makePromptApp(computerOnline: true)
        let sender = try XCTUnwrap(app.commandSender)
        sender.confirmationTimeout = .milliseconds(300)
        XCTAssertTrue(sender.sendInput(sessionId: promptSession, text: "lost echo"))
        let latches = Latches()
        let window = mount(app, latches)
        defer { window.isHidden = true; window.rootViewController = nil }
        drain(100)
        XCTAssertTrue(latches.awaitingActive, "a prompt on its way still waits for its turn")
        drain(900)
        XCTAssertEqual(sender.pendingInputs(promptSession).first.map(sender.pendingState), .unconfirmed)
        XCTAssertFalse(latches.awaitingActive, "an unconfirmed prompt no longer holds the composer in Steer")
    }

    func testEchoedPromptKeepsTheLatchUntilTheTurnStarts() throws {
        let app = try makePromptApp(computerOnline: true)
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: promptSession, text: "delivered"))
        let clientId = try XCTUnwrap(sender.pendingInputs(promptSession).first?.payload["clientId"]?.stringValue)
        let latches = Latches()
        let window = mount(app, latches)
        defer { window.isHidden = true; window.rootViewController = nil }
        drain(100)
        sender.clearPending(promptSession, clientId: clientId)
        app.deviceStore.devices[promptDevice]?.online = false
        drain(300)
        XCTAssertTrue(latches.awaitingActive, "the echo arrived: the turn is about to start")
    }
}
