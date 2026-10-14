#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// Steer placement in the production iPhone chat (simulated streaming turn,
/// slowed down so a screen recording shows each beat). Captures one PNG per
/// beat into Documents/steer-shots and checks what the collection view draws:
/// the live card stays above the steer until the agent's next segment, then
/// moves below it with an animated move (same cell, no reload), and the reply
/// lands below the steer. The reader stays pinned to the bottom throughout.
@MainActor final class SteerPlacementListShots: XCTestCase {
    private let sid = "steer-shots"
    /// Seconds each beat stays on screen.
    private let beat = 1.8
    private let steer = "Also drop the emoji in headings."
    private var window: UIWindow?
    private var app: AppState!
    private var router: MessageRouter!
    private var root: URL?
    private var output: URL!
    private var shot = 0
    private var frames: [String: String] = [:]
    private var gaps: [CGFloat] = []
    /// Every overlap of two visible rows seen at any sample (should stay empty).
    private var overlaps: [String] = []

    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil; window = nil
        router = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    func testLiveCardStaysAboveSteerThenMovesBelowOnNewSegment() throws {
        try requireForegroundUITests()
        try openChat()
        stream("I'll read the script first. It builds the notes from merged PR titles and groups them by label.")
        try capture("streaming")
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: steer, delivery: .steer))
        try capture("steer-sent")
        stream("Unlabelled PRs currently fall into an Other section at the end.")
        try capture("same-segment-continues")
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        try route("user_message", seq: 18, ["content": steer, "clientId": clientId, "delivery": "steer"])
        try capture("steer-echoed")
        try newSegmentMovesCardBelow()
        try capture("new-segment-moves-below")
        stream("Headings now read Fixes, Features and Docs.")
        try capture("answering-steer")
        try route("agent_message", seq: 19, ["content": "Done: headings no longer carry emoji, and PRs are grouped by label."])
        try route("idle", ["usage": [:]])
        try capture("turn-ended")

        let card = "I'll read the script first. It builds the notes from merged PR titles and groups them by label."
        XCTAssertTrue(order("steer-sent").hasSuffix("Clean up the release notes script. | live: \(card) | user: \(steer)"), order("steer-sent"))
        XCTAssertTrue(order("same-segment-continues").hasSuffix("at the end. | user: \(steer)"), order("same-segment-continues"))
        XCTAssertTrue(order("steer-echoed").hasSuffix("at the end. | user: \(steer)"), order("steer-echoed"))
        XCTAssertTrue(order("new-segment-moves-below").hasSuffix("user: \(steer) | live: Got it, I'll remove the emoji from the headings too."),
                      order("new-segment-moves-below"))
        XCTAssertTrue(order("turn-ended").hasSuffix("user: \(steer) | agent: Done: headings no longer carry emoji, and PRs are grouped by label."),
                      order("turn-ended"))
        XCTAssertTrue(gaps.allSatisfy { abs($0) < 2 }, "the reader pinned at the bottom stays pinned: \(gaps)")
        XCTAssertEqual(overlaps, [], "a row below the growing card moves with it, nothing overlaps")
    }

    /// The agent's next segment (`reset`). Samples the move frame by frame:
    /// the same cell travels, animated, no row disappears, the bottom stays pinned.
    private func newSegmentMovesCardBelow() throws {
        let cellsBefore = collection?.visibleCells ?? []
        let rowCount = collection?.numberOfItems(inSection: 0) ?? -1
        app.messageStore.applyCardMessage(sid, "Got it, I'll remove the emoji from the headings too.", reset: true)
        var moving: [String] = []
        for _ in 0..<12 {
            drain(1.0 / 30.0)
            let animating = liveCellView()?.layer.animationKeys()?.isEmpty == false
            moving.append("\(collection?.numberOfItems(inSection: 0) ?? -1):\(animating):\(Int(bottomGap().rounded()))")
            noteOverlaps("move")
        }
        print("STEER_MOVE samples=\(moving.joined(separator: ","))")
        XCTAssertTrue(liveCellView().map { cell in cellsBefore.contains { $0 === cell } } == true,
                      "the cells on screen are reused in place (no reload, no delete + insert)")
        XCTAssertTrue(moving.contains { $0.contains(":true:") }, "the move is animated: \(moving)")
        XCTAssertTrue(moving.allSatisfy { $0.hasPrefix("\(rowCount):") }, "no row disappears during the move: \(moving)")
        XCTAssertTrue(moving.allSatisfy { $0.hasSuffix(":0") }, "the reader stays pinned through the move: \(moving)")
    }

    // MARK: Scenario plumbing

    /// Eight earlier turns (more than a screen, so the reader is pinned to the
    /// bottom), then the running turn's prompt, in the production ChatView.
    private func openChat() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("steer-shots-\(UUID().uuidString)")
        self.root = root
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let history = (0..<8).flatMap { turn -> [ChatMessage] in
            [ChatMessage(type: "user_message", seq: turn * 2 + 1, sessionId: sid, deviceId: "dev", timestamp: "2026-10-13T08:0\(turn):00Z",
                         payload: ["content": AnyCodable("Check release \(turn + 1) of the notes.")]),
             ChatMessage(type: "agent_message", seq: turn * 2 + 2, sessionId: sid, deviceId: "dev", timestamp: "2026-10-13T08:0\(turn):30Z",
                         payload: ["content": AnyCodable("Release \(turn + 1) looks right: every merged PR is listed once, "
                                                         + "grouped by label, and the links resolve.")])]
        }
        try db.insert(sid, history + [ChatMessage(type: "user_message", seq: 17, sessionId: sid, deviceId: "dev",
                                                  timestamp: "2026-10-13T09:00:00Z",
                                                  payload: ["content": AnyCodable("Clean up the release notes script.")])])
        let app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.deviceId = "steer-shots-app"
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Studio Mac", agent: "pi", title: "Release notes",
            state: .active, mode: .auto, lastSeq: 17, readSeq: 17, messageCount: 17, createdAt: Date(), pinned: false)
        app.deviceStore.devices["dev"] = DeviceSummary(id: "dev", name: "Studio Mac", role: .tentacle, kind: .desktop, online: true)
        app.sessionStore.activeSessionId = sid
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 17, deviceId: "dev")
        _ = app.messageStore.loadInitialWindow(sid)
        app.messageStore.beginCardTurn(sid)
        self.app = app
        router = MessageRouter(appState: app)

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = UIHostingController(rootView: ChatView(sessionId: sid).environment(app))
        window.makeKeyAndVisible()
        self.window = window
        drain(beat)
        output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("steer-shots")
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    }

    private func route(_ type: String, seq: Int? = nil, _ payload: [String: Any]) throws {
        var envelope: [String: Any] = ["type": type, "sessionId": sid, "deviceId": "dev",
                                       "timestamp": "2026-10-13T09:00:05Z", "payload": payload]
        if let seq { envelope["seq"] = seq }
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: envelope))
    }

    /// Live deltas word by word, as MessageRouter applies them for the
    /// subscribed session; continues the current draft segment.
    private func stream(_ words: String) {
        for (index, word) in words.split(separator: " ").enumerated() {
            let first = index == 0 && app.messageStore.cards[sid]?.text.isEmpty != false
            app.messageStore.applyCardMessage(sid, (first ? "" : " ") + word, reset: false)
            drain(0.09)
            noteOverlaps("stream \(word)")
        }
    }

    private func capture(_ phase: String) throws {
        guard let window else { return }
        drain(0.5)
        shot += 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: output.appendingPathComponent(String(format: "%02d-%@.png", shot, phase)))
        frames[phase] = drawnRows().joined(separator: " | ")
        gaps.append(bottomGap())
        noteOverlaps(phase)
        print("STEER_BEAT \(phase): \(frames[phase] ?? "") bottomGap=\(String(format: "%.1f", bottomGap()))")
        drain(beat - 0.5)
    }

    private func order(_ phase: String) -> String { frames[phase] ?? "" }
    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
    private var collection: UICollectionView? { window.flatMap { all($0).compactMap { $0 as? UICollectionView }.first } }

    /// Visible rows whose frames overlap (top to bottom, half a point slack).
    private func noteOverlaps(_ when: String) {
        guard let cv = collection else { return }
        let cells = cv.indexPathsForVisibleItems.sorted().compactMap { cv.cellForItem(at: $0) }
        for (upper, lower) in zip(cells, cells.dropFirst()) where lower.frame.minY < upper.frame.maxY - 0.5 {
            overlaps.append(String(format: "%@: %.1f over %.1f", when, lower.frame.minY, upper.frame.maxY))
        }
    }

    private func liveCellView() -> TKBubbleCell? {
        collection?.visibleCells.compactMap { $0 as? TKBubbleCell }.first { $0.contentSnapshot?.isLive == true }
    }

    /// Distance from the bottom-pinned offset (0 = pinned).
    private func bottomGap() -> CGFloat {
        guard let cv = collection else { return .nan }
        let pinned = max(-cv.adjustedContentInset.top, cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height)
        return pinned - cv.contentOffset.y
    }

    /// The rows the collection view draws, top to bottom.
    private func drawnRows() -> [String] {
        guard let cv = collection else { return [] }
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
