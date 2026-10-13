import XCTest
@testable import Kraki

#if os(iOS)
/// A prompt sent while the session's turn is still running is echoed only when
/// it dispatches; it must not turn into "Awaiting confirmation" meanwhile.
extension ChatUXRegressionTests {
    func testPromptBehindARunningTurnDoesNotBecomeUnconfirmed() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        fx.app.sessionStore.sessions[sid]?.state = .active
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "next"))
        drain(800)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .sending)
        XCTAssertEqual(sends, 1, "no resend while the earlier turn runs")
        // The turn ends: the normal confirmation clock applies again.
        fx.app.sessionStore.sessions[sid]?.state = .idle
        drain(800)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed)
    }
}
#endif
