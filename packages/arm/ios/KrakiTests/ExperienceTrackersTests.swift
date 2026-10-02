import XCTest
@testable import Kraki

final class SendTrackerTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000_000)
    private func tracker() -> SendTracker {
        let t = SendTracker()
        t.now = { [unowned self] in clock }
        return t
    }

    func testQuietDeliveryHasNoProblemShown() throws {
        let t = tracker()
        t.created("a", kind: .typed, textLength: 3, attachments: 0, pathUp: true)
        t.state("a", "sending")
        clock += 0.4
        t.finished("a", .delivered)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(s.shown, .none)
        XCTAssertEqual(try XCTUnwrap(s.confirmMs), 400, accuracy: 1)
        XCTAssertFalse(s.falseAlarm)
        XCTAssertFalse(s.offlineAtSend)
    }

    func testUnconfirmedThatLandsOnItsOwnIsAFalseAlarm() throws {
        let t = tracker()
        t.created("a", kind: .typed, textLength: 3, attachments: 0, pathUp: false)
        clock += 30; t.state("a", "unconfirmed", cause: "stalled")
        clock += 5; t.retried("a", manual: false); t.state("a", "sending")
        clock += 1; t.finished("a", .delivered)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(s.shown, .unconfirmed)
        XCTAssertEqual(s.shownMs, 5_000, accuracy: 1)
        XCTAssertTrue(s.falseAlarm)
        XCTAssertTrue(s.offlineAtSend)
        XCTAssertEqual(s.autoResends, 1)
    }

    func testFailedOutranksUnconfirmedAndKeepsItsCause() throws {
        let t = tracker()
        t.created("v", kind: .voice, textLength: 9, attachments: 0, pathUp: true)
        clock += 2; t.state("v", "unconfirmed", cause: "stalled")
        clock += 1; t.state("v", "failed", cause: "correction", inBackground: true)
        clock += 1; t.state("v", "unconfirmed", cause: "stalled")
        clock += 1; t.finished("v", .deleted)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(s.shown, .failed)
        XCTAssertEqual(s.cause, "stalled", "the last reason shown")
        XCTAssertTrue(s.failedInBackground)
        XCTAssertEqual(s.shownMs, 3_000, accuracy: 1)
        XCTAssertNil(s.confirmMs)
    }

    func testRestoredInputMeasuresFromItsOriginalSendTime() throws {
        let t = tracker()
        t.restored("r", kind: .typed, createdAt: clock - 120, failed: false)
        clock += 2; t.finished("r", .delivered)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertTrue(s.restored)
        XCTAssertEqual(try XCTUnwrap(s.confirmMs), 122_000, accuracy: 1)
        t.finished("r", .delivered)
        XCTAssertEqual(t.summaries.count, 1, "finishing twice records once")
    }

    func testVoiceCorrectionTime() throws {
        let t = tracker()
        t.created("v", kind: .voice, textLength: 20, attachments: 0, pathUp: true)
        clock += 1.8; t.dispatched("v")
        clock += 0.3; t.finished("v", .delivered)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(try XCTUnwrap(s.correctionMs), 1_800, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(s.confirmMs), 2_100, accuracy: 1)
    }
}

final class VoiceTrackerTests: XCTestCase {
    private var clock: TimeInterval = 100
    private func tracker() -> VoiceTracker {
        let t = VoiceTracker()
        t.now = { [unowned self] in clock }
        return t
    }

    func testSuccessfulRecordingTimesEachStep() throws {
        let t = tracker()
        t.begin(warm: false)
        t.stateChanged("obtainingLease")
        clock += 0.7; t.stateChanged("recording")
        clock += 6; t.stateChanged("finishing")
        clock += 1.2; t.finalReceived(textLength: 40, correctionConfirmed: true); t.stateChanged("idle")
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(s.outcome, .final)
        XCTAssertEqual(try XCTUnwrap(s.startMs), 700, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(s.recordMs), 6_000, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(s.finalizeMs), 1_200, accuracy: 1)
        XCTAssertTrue(s.correctionConfirmed)
        XCTAssertFalse(s.warm)
        XCTAssertNil(s.cause)
    }

    func testFailureRecordsStageAndCause() throws {
        let t = tracker()
        t.begin(warm: true)
        t.stateChanged("recording")
        clock += 3
        t.cause(VoiceTracker.classify(gatewayReason: "broker socket closed: network connection lost"))
        t.stateChanged("failed")
        t.stateChanged("idle") // clearFailure: no second record
        XCTAssertEqual(t.summaries.count, 1)
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertEqual(s.outcome, .failed)
        XCTAssertEqual(s.stage, "recording")
        XCTAssertEqual(s.cause, "network")
        XCTAssertEqual(try XCTUnwrap(s.recordMs), 3_000, accuracy: 1)
    }

    func testPreflightFailureAndDepartureAreDistinguished() throws {
        let t = tracker()
        t.begin(warm: false)
        t.cause(VoiceInputError.microphoneDenied.metricCause)
        t.stateChanged("failed")
        t.begin(warm: true)
        t.stateChanged("obtainingLease")
        t.outcome(.departed)
        t.outcome(.cancelled, overwrite: false) // cancel() after departure
        t.stateChanged("idle")
        XCTAssertEqual(t.summaries.map(\.outcome), [.failed, .departed])
        XCTAssertEqual(t.summaries.map(\.stage), ["preflight", "lease"])
        XCTAssertEqual(t.summaries.first?.cause, "permission")
    }

    func testCorrectionTurnedOffIsRecordedSoUnconfirmedIsNotAFailure() throws {
        let t = tracker()
        t.begin(warm: true, correctionEnabled: false)
        t.stateChanged("recording"); clock += 2; t.stateChanged("finishing")
        clock += 0.3; t.finalReceived(textLength: 10, correctionConfirmed: false); t.stateChanged("idle")
        let s = try XCTUnwrap(t.summaries.first)
        XCTAssertFalse(s.correctionEnabled)
        XCTAssertFalse(s.correctionConfirmed)
        XCTAssertEqual(s.outcome, .final)
    }

    func testCauseClassesNeverCarryText() {
        XCTAssertEqual(VoiceTracker.classify(gatewayReason: "quota_exhausted"), "quota")
        XCTAssertEqual(VoiceTracker.classify(gatewayReason: "lease_expired"), "lease_rejected")
        XCTAssertEqual(VoiceTracker.classify(gatewayReason: "The request timed out."), "timeout")
        XCTAssertEqual(VoiceTracker.classify(gatewayReason: "something odd"), "gateway")
        XCTAssertEqual(VoiceInputError.leaseDenied(.quotaExhausted, nil).metricCause, "lease_denied_quota_exhausted")
        XCTAssertEqual(VoiceInputError.gateway("The microphone audio session couldn't be started.").metricCause,
                       "audio_session")
    }
}

final class ForegroundExitMarkerTests: XCTestCase {
    func testUncleanExitIsReportedOnce() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kraki-exit-\(UUID().uuidString)"))
        let marker = ForegroundExitMarker(defaults: defaults)
        XCTAssertEqual(marker.previousExit(), "first")
        marker.enteredForeground()
        XCTAssertEqual(marker.previousExit(), "unclean", "died while on screen")
        marker.leftForeground()
        XCTAssertEqual(marker.previousExit(), "clean")
    }
}
