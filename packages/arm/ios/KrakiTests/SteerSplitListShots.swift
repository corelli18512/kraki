#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// Steer display in the production iPhone chat (simulated streaming turn).
/// Captures one PNG per beat into Documents/steer-shots and checks the order
/// the collection view draws: earlier agent words → steer → later words.
@MainActor final class SteerSplitListShots: XCTestCase {
    private let sid = "steer-shots"
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil; window = nil
        super.tearDown()
    }

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }

    func testSteerDuringStreamingKeepsEarlierWordsAboveIt() throws {
        try requireForegroundUITests()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("steer-shots-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, [ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "dev",
                                        timestamp: "2026-10-13T09:00:00Z",
                                        payload: ["content": AnyCodable("Clean up the release notes script.")])])
        let app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.deviceId = "steer-shots-app"
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Studio Mac", agent: "pi", title: "Release notes",
            state: .active, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1, createdAt: Date(), pinned: false)
        app.deviceStore.devices["dev"] = DeviceSummary(id: "dev", name: "Studio Mac", role: .tentacle, kind: .desktop, online: true)
        app.sessionStore.activeSessionId = sid
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 1, deviceId: "dev")
        _ = app.messageStore.loadInitialWindow(sid)
        app.messageStore.beginCardTurn(sid)
        let router = MessageRouter(appState: app)
        func route(_ type: String, seq: Int? = nil, _ payload: [String: Any]) throws {
            var envelope: [String: Any] = ["type": type, "sessionId": sid, "deviceId": "dev",
                                           "timestamp": "2026-10-13T09:00:05Z", "payload": payload]
            if let seq { envelope["seq"] = seq }
            router.handleDataMessage(try JSONSerialization.data(withJSONObject: envelope))
        }

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = UIHostingController(rootView: ChatView(sessionId: sid).environment(app))
        window.makeKeyAndVisible()
        self.window = window
        drain(0.8)

        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("steer-shots")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var beat = 0
        var frames: [String] = []
        func capture(_ phase: String) throws {
            drain(0.35)
            beat += 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try XCTUnwrap(image.pngData()).write(to: output.appendingPathComponent(String(format: "%02d-%@.png", beat, phase)))
            frames.append("\(phase): \(drawnRows().joined(separator: " | "))")
        }
        // Live deltas as MessageRouter applies them for the subscribed session.
        func stream(_ words: String) throws {
            for word in words.split(separator: " ", omittingEmptySubsequences: false) {
                app.messageStore.applyCardMessage(sid, word + " ", reset: false)
                drain(0.03)
            }
        }

        try stream("I'll read the script first. It builds the notes from merged PR titles and groups them by label.")
        try capture("streaming")
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "Also drop the emoji in headings.", delivery: .steer))
        try capture("steer-sent")
        try stream("Unlabelled PRs currently fall into an Other section at the end.")
        try capture("after-steer-same-segment")
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        try route("user_message", seq: 2, ["content": "Also drop the emoji in headings.",
                                           "clientId": clientId, "delivery": "steer"])
        try capture("steer-echoed")
        app.messageStore.applyCardMessage(sid, "Got it, I'll remove the emoji from the headings too.", reset: true)
        try capture("answering-steer")
        try route("agent_message", seq: 3, ["content": "Done: headings no longer carry emoji, and PRs are grouped by label."])
        try route("idle", ["usage": [:]])
        try capture("turn-ended")
        print("STEER_FRAMES\n" + frames.joined(separator: "\n"))

        let ordered = frames.first { $0.hasPrefix("after-steer-same-segment") } ?? ""
        XCTAssertTrue(ordered.contains("agent: I'll read the script first. It builds the notes from merged PR titles and groups them by label. | user: Also drop the emoji in headings. | live: Unlabelled PRs"),
                      ordered)
    }

    /// The rows the collection view draws, top to bottom.
    private func drawnRows() -> [String] {
        guard let window, let cv = all(window).compactMap({ $0 as? UICollectionView }).first else { return [] }
        cv.layoutIfNeeded()
        return cv.indexPathsForVisibleItems.sorted().compactMap { ip in
            guard let cell = cv.cellForItem(at: ip) as? TKBubbleCell, let content = cell.contentSnapshot else { return nil }
            let text = content.body?.string ?? content.message.content ?? ""
            let who = content.isLive ? "live" : content.kind == .user ? "user" : "agent"
            return "\(who): \(text.trimmingCharacters(in: .whitespacesAndNewlines))"
        }
    }
}
#endif
