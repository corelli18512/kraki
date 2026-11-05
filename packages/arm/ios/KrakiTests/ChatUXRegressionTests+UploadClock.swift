import XCTest
@testable import Kraki

#if os(iOS)
/// K-197: while a large input (a photo) is still being uploaded on a slow
/// link, its missing echo is not a stall: no second copy, no "Awaiting
/// confirmation" before the upload has gone out.
extension ChatUXRegressionTests {
    func testInputStillUploadingIsNotResentOrUnconfirmed() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        let sender = try XCTUnwrap(fx.app.commandSender)
        sender.confirmationTimeout = .milliseconds(200)
        var uploading = true
        sender.testUploadProgress = { (queued: uploading, lastProgressAt: Date()) }
        drain(600)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "[image]"))
        drain(800)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .sending)
        XCTAssertEqual(sends, 1, "no second copy while the first is still uploading")
        // Uploaded: the normal confirmation clock applies again.
        uploading = false
        drain(800)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed)
        XCTAssertEqual(sends, 2, "one same-clientId resend once the clock runs")
    }

    /// A queued upload the Relay stopped acknowledging must not freeze the
    /// confirmation clock: the input still becomes unconfirmed.
    func testStalledUploadStillLetsTheInputBecomeUnconfirmed() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        let sender = try XCTUnwrap(fx.app.commandSender)
        sender.confirmationTimeout = .milliseconds(200)
        let stalledSince = Date().addingTimeInterval(-(PulseManager.uploadProgressWindowSeconds + 1))
        sender.testUploadProgress = { (queued: true, lastProgressAt: stalledSince) }
        drain(600)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "[image]"))
        drain(800)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed)
        XCTAssertEqual(sends, 2, "one same-clientId resend once the clock runs")
    }

    func testUploadCountsAsMovingOnlyWhileItMakesProgress() {
        let now = Date()
        let window = PulseManager.uploadProgressWindowSeconds
        XCTAssertTrue(PulseManager.isUploadMoving(queued: true, lastProgressAt: now.addingTimeInterval(-1), now: now))
        XCTAssertFalse(PulseManager.isUploadMoving(queued: true, lastProgressAt: now.addingTimeInterval(-window - 1), now: now))
        XCTAssertFalse(PulseManager.isUploadMoving(queued: true, lastProgressAt: nil, now: now))
        XCTAssertFalse(PulseManager.isUploadMoving(queued: false, lastProgressAt: now, now: now))
    }
}
#endif
