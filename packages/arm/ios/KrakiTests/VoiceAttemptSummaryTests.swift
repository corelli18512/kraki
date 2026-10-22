import XCTest
@testable import Kraki

/// Every recording attempt gets a `voice.summary` (log audit 2026-10-22:
/// recording.begin → recording.cancel 3 ms later produced none). Uses the
/// fakes of KrakiVoiceInputTests: no microphone, no network.
@MainActor
final class VoiceAttemptSummaryTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    func testCancelBeforeTheAttemptLeftIdleStillReportsIt() async throws {
        let host = FakeVoiceHost() // the controller holds it weakly
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        let reached = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        audio.onActivation = { reached.signal(); release.wait() } // on the audio session queue
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
        let context = VoiceSessionContext(fields: ["sessionId": .string("session-1")], vocabulary: [])
        let start = Task { await controller.begin(sessionID: "session-1", context: context) { _ in } }
        try await waitBriefly { reached.wait(timeout: .now()) == .success }
        XCTAssertEqual(controller.state, .idle, "still activating audio")
        controller.cancel()
        release.signal()
        await start.value
        XCTAssertEqual(controller.metrics.summaries.map(\.outcome), [.cancelled])
        XCTAssertTrue(factory.sessions.isEmpty)
        controller.cancel() // nothing left to report
        XCTAssertEqual(controller.metrics.summaries.count, 1)
    }
}
