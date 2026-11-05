#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// The open model picker follows the computer when it restates the session's
/// model after rejecting a change (K-010): the checkmark moves back, and a
/// later effort change asks for the restated model, not the rejected one.
@MainActor
final class ModelPickerScreenTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func segmentedControl(in view: UIView) -> UISegmentedControl? {
        if let control = view as? UISegmentedControl { return control }
        for sub in view.subviews { if let found = segmentedControl(in: sub) { return found } }
        return nil
    }

    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    }

    func testPickerFollowsTheModelRestatedAfterARejectedChange() throws {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("model-picker-\(UUID().uuidString).sqlite")))
        app.connectionStatus = .connected
        var sent: [[String: Any]] = []
        app.testOutboundMessageHandler = { message, _, _ in
            if message["type"] as? String == "set_session_model",
               let payload = message["payload"] as? [String: Any] { sent.append(payload) }
            return true
        }
        let dev = "dev-model-picker"
        app.deviceStore.setDevices([DeviceSummary(
            id: dev, name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
            online: true, lastSeen: nil, createdAt: "2026-09-01T00:00:00.000Z")])
        // Only "good" has a Thinking control, so its presence shows which
        // row carries the checkmark.
        let details = [
            ModelDetail(id: "good", name: "Good", supportsReasoningEffort: true,
                        supportedReasoningEfforts: [.low, .high]),
            ModelDetail(id: "rejected", name: "Rejected", supportsReasoningEffort: false),
        ]
        app.deviceStore.setGreeting(dev, name: "Mac",
                                    agents: [AgentCapabilities(type: "code", id: "pi", models: ["good", "rejected"],
                                                               modelDetails: details)],
                                    version: "0.38.10")
        // The user has just picked "rejected" (optimistic update).
        let session = SessionInfo(
            id: "s-model-picker", deviceId: dev, deviceName: "Mac", agent: "pi",
            model: "rejected", reasoningEffort: nil, title: "t",
            state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000), pinned: false
        )
        app.sessionStore.upsertSession(session)

        let host = UIHostingController(rootView: NavigationStack { ModelPickerScreen(session: session) }
            .environment(app))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        settle()
        XCTAssertNil(segmentedControl(in: host.view), "checkmark on the picked model, which has no Thinking control")

        // The computer rejects it and restates the previous model
        // (MessageRouter applies session_model_set this way).
        app.sessionStore.setSessionModel(session.id, model: "good", reasoningEffort: .high)
        settle()
        let control = try XCTUnwrap(segmentedControl(in: host.view), "checkmark back on the restated model")
        XCTAssertEqual(control.selectedSegmentIndex, 1, "shows the restated effort")

        control.selectedSegmentIndex = 0
        control.sendActions(for: .valueChanged)
        settle()
        XCTAssertEqual(sent.last?["model"] as? String, "good", "an effort change must not re-request the rejected model")
        XCTAssertEqual(sent.last?["reasoningEffort"] as? String, "low")
    }
}
#endif
