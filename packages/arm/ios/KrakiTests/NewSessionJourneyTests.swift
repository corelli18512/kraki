import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// End-to-end gate for the new-Session journey through production
/// MainTabView / NavigationStack / SessionDetailView / ChatView with a
/// scripted offline Tentacle (see IOSNewSessionScenario).
@MainActor
final class NewSessionJourneyTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    func testScriptedReplyRemainsStreamedAfterMainThreadStall() throws {
        let app = IOSNewSessionScenario.makeAppState()
        let sid = "scripted-stall"
        let dev = IOSNewSessionScenario.deviceID
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "Test", agent: "pi", title: "Test",
            state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(), pinned: false)
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 0, deviceId: dev)
        app.sessionSubscriptionController.onSessionList(tentacleId: dev)
        app.sessionSubscriptionController.setDesired(sid)
        app.sessionSubscriptionController.onAck(SessionSubscriptionAck(
            tentacleId: dev, sessionId: sid, accepted: true, snapshot: nil, errorMessage: nil))
        let tentacle = try XCTUnwrap(IOSNewSessionScenario.scriptedTentacle)
        tentacle.receive(["type": "send_input", "sessionId": sid, "payload": ["text": "Test"]], target: dev)
        // Fault injection, not a readiness wait: starve the main queue beyond
        // the old absolute-timer stream's entire lifetime, as a CI render did.
        Thread.sleep(forTimeInterval: 4)
        let deadline = Date().addingTimeInterval(5)
        while app.messageStore.cards[sid]?.text.isEmpty != false, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertFalse(app.messageStore.cards[sid]?.text.isEmpty ?? true,
                       "the scripted producer must yield between deltas, not catch up straight to final")
    }

    func testNewSessionJourney() throws {
        let app = IOSNewSessionScenario.makeAppState()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        IOSNewSessionScenario.forceAutorun = true
        defer {
            IOSNewSessionScenario.forceAutorun = false
            window.isHidden = true
            window.rootViewController = nil
            // Let torn-down pages, scripted deliveries and deferred
            // reconciliation finish here, so timing-sensitive tests that run
            // next do not inherit a busy main thread.
            RunLoop.main.run(until: Date().addingTimeInterval(2.5))
        }
        window.rootViewController = UIHostingController(
            rootView: IOSNewSessionScenarioView().environment(app))
        window.makeKeyAndVisible()
        let deadline = Date().addingTimeInterval(60)
        repeat {
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        } while !IOSNewSessionScenario.finished && Date() < deadline
        XCTAssertTrue(IOSNewSessionScenario.finished, "journey did not finish")
        let log = (try? String(contentsOf: IOSNewSessionScenario.logURL, encoding: .utf8)) ?? ""
        let checks = log.split(separator: "\n").filter { $0.contains("CHECK") }
        XCTAssertEqual(checks.count, 7, "expected all journey checks:\n\(log)")
        for check in checks {
            XCTAssertFalse(check.contains("BAD"), String(check))
        }
    }
}
#endif
