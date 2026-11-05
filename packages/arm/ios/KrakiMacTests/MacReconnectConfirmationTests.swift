import XCTest
@testable import Kraki_Dev

/// Restarting Kraki on this Mac stops every running turn here. The This Mac
/// menu asked first; Settings › This Mac › Reconnect and switching "Run agents
/// with" did not (K-116). Both go through MacReconnectConfirmation.
@MainActor
final class MacReconnectConfirmationTests: XCTestCase {
    private func session(_ id: String, device: String, state: SessionState) -> SessionInfo {
        SessionInfo(id: id, deviceId: device, deviceName: "d", agent: "pi", model: "m", title: id,
                    state: state, mode: .auto, lastSeq: 1, readSeq: 0, messageCount: 0,
                    createdAt: Date(), pinned: false)
    }

    func testOnlyRunningSessionsOnThisMacCount() {
        let sessions = [
            session("a", device: "here", state: .active),
            session("b", device: "here", state: .idle),
            session("c", device: "other", state: .active),
            session("d", device: "here", state: .compacting),
        ]
        XCTAssertEqual(MacReconnectConfirmation.runningSessions(in: sessions, deviceId: "here"), 2)
        XCTAssertEqual(MacReconnectConfirmation.runningSessions(in: sessions, deviceId: nil), 0)
    }

    func testNoQuestionWhileNothingRuns() {
        XCTAssertNil(MacReconnectConfirmation.prompt(for: .reconnect, running: 0))
        XCTAssertNil(MacReconnectConfirmation.prompt(for: .switchMode, running: 0))
    }

    func testReconnectAsksWhileATurnRuns() throws {
        let one = try XCTUnwrap(MacReconnectConfirmation.prompt(for: .reconnect, running: 1))
        XCTAssertEqual(one.title, "Reconnect this Mac?")
        XCTAssertEqual(one.confirmButton, "Reconnect")
        XCTAssertTrue(one.message.contains("stops it"))
        let two = try XCTUnwrap(MacReconnectConfirmation.prompt(for: .reconnect, running: 2))
        XCTAssertTrue(two.message.hasPrefix("2 sessions"))
    }

    func testSwitchingHowThisMacRunsAgentsAsksWhileATurnRuns() throws {
        let one = try XCTUnwrap(MacReconnectConfirmation.prompt(for: .switchMode, running: 1))
        XCTAssertEqual(one.title, "Switch how this Mac runs agents?")
        XCTAssertEqual(one.confirmButton, "Switch")
        XCTAssertTrue(one.message.contains("Switching restarts Kraki here and stops it"))
        let three = try XCTUnwrap(MacReconnectConfirmation.prompt(for: .switchMode, running: 3))
        XCTAssertTrue(three.message.hasPrefix("3 sessions"))
    }
}
