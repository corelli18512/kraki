#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// Steer placement with a live card several screens tall (a long essay), the
/// reader pinned at the bottom, as on a real Pi turn. When the agent starts
/// its next segment the card moves below the steer; at every sample the list
/// draws exactly its rows in order (no stale live cell, no hidden steer, no
/// blank frame), and once settled every row is opaque and untransformed.
@MainActor final class SteerPlacementTallCardTests: XCTestCase {
    private let sid = "steer-tall"
    private let prompt = "Write a 700-word essay about penguins, in plain paragraphs."
    private let steer = "Also end with one sentence about seals."
    private var window: UIWindow?
    private var app: AppState!
    private var router: MessageRouter!
    private var root: URL?
    private var problems: [String] = []

    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil; window = nil
        router = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    /// Tentacle persists a steer when the agent takes it: its echo arrives,
    /// then the new segment's first delta.
    func testEchoThenNewSegmentMovesTallCardBelowSteer() throws {
        try runTurn { clientId in
            try self.route("user_message", seq: 42, ["content": self.steer, "clientId": clientId, "delivery": "steer"])
            self.sample("echo", frames: 3)
            self.app.messageStore.applyCardMessage(self.sid, "Seals are marine mammals", reset: true)
        }
    }

    /// The echo and the first delta of the new segment in one update.
    func testEchoAndNewSegmentTogetherMoveTallCardBelowSteer() throws {
        try runTurn { clientId in
            try self.route("user_message", seq: 42, ["content": self.steer, "clientId": clientId, "delivery": "steer"])
            self.app.messageStore.applyCardMessage(self.sid, "Seals are marine mammals", reset: true)
        }
    }

    /// The new segment starts before the steer's echo.
    func testNewSegmentThenEchoMovesTallCardBelowSteer() throws {
        try runTurn { clientId in
            self.app.messageStore.applyCardMessage(self.sid, "Seals are marine mammals", reset: true)
            self.sample("reset", frames: 3)
            try self.route("user_message", seq: 42, ["content": self.steer, "clientId": clientId, "delivery": "steer"])
        }
    }

    private func runTurn(_ newSegment: (String) throws -> Void) throws {
        try requireForegroundUITests()
        try openChat()
        let essay = (0..<14).map { paragraph in
            "Paragraph \(paragraph + 1): penguins are flightless seabirds of the southern hemisphere; they swim with "
                + "flipper-like wings, breed in large colonies, and depend on krill and fish that a warming ocean moves away."
        }.joined(separator: "\n\n")
        stream(essay, chunk: 6)
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: steer, delivery: .steer))
        sample("steer-sent", frames: 20)
        stream("\n\nIn short, penguins are sentinels of the Southern Ocean.", chunk: 3)
        XCTAssertTrue(drawn().suffix(2).first?.hasPrefix("live:") == true, "card above the steer: \(drawn())")
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        try newSegment(clientId)
        sample("move", frames: 45)
        stream(" that share many penguin habitats, and some species, such as leopard seals, prey on penguins.", chunk: 3)
        settle("answering")
        XCTAssertEqual(Array(drawn().suffix(3)),
                       ["user: \(prompt)", "user: \(steer)",
                        "live: Seals are marine mammals that share many penguin habitats, and some species, such as leopard seals, prey on penguins."])
        try route("agent_message", seq: 43, ["content": "Seals are marine mammals that share many penguin habitats."])
        try route("idle", ["usage": [:]])
        settle("turn-ended")
        XCTAssertEqual(Array(drawn().suffix(3)),
                       ["user: \(prompt)", "user: \(steer)", "agent: Seals are marine mammals that share many penguin habitats."])
        XCTAssertEqual(problems, [], "the list draws exactly its rows at every sample")
    }

    // MARK: Invariants

    private var collection: UICollectionView? { window.flatMap { all($0).compactMap { $0 as? UICollectionView }.first } }
    private var list: ChatPerfListVC? { collection?.delegate as? ChatPerfListVC }

    /// After every frame: each visible index path draws its item (the live
    /// card cell for the live item, the row's message otherwise), no other
    /// bubble cell is on screen, and something is on screen.
    private func check(_ when: String) {
        guard let cv = collection, let list else { problems.append("\(when): no list"); return }
        let items = list.items
        guard cv.numberOfItems(inSection: 0) == items.count else {
            problems.append("\(when): collection has \(cv.numberOfItems(inSection: 0)) items, model \(items.count)")
            return
        }
        var tracked = Set<ObjectIdentifier>()
        for ip in cv.indexPathsForVisibleItems {
            guard let cell = cv.cellForItem(at: ip) as? TKBubbleCell, let content = cell.contentSnapshot else { continue }
            tracked.insert(ObjectIdentifier(cell))
            let id = items[ip.item]
            let drawsItem = id == ChatPerfListVC.liveCardID ? content.isLive : (!content.isLive && content.message.id == id)
            if !drawsItem { problems.append("\(when): row \(ip.item) \(id) draws \(content.isLive ? "live" : content.message.id)") }
        }
        let shown = cv.subviews.compactMap { $0 as? TKBubbleCell }.filter { !$0.isHidden && $0.alpha > 0.01 }
        for ghost in shown where !tracked.contains(ObjectIdentifier(ghost)) && ghost.frame.intersects(cv.bounds) {
            problems.append("\(when): untracked cell drawing \(ghost.contentSnapshot?.message.content?.prefix(30) ?? "?")")
        }
        // What the next frame draws: the committed layer tree.
        CATransaction.flush()
        let viewport = cv.layer.presentation()?.bounds ?? cv.bounds
        if !shown.contains(where: { ($0.layer.presentation()?.frame ?? $0.frame).intersects(viewport) }) {
            let frames = shown.map { "\(Int(($0.layer.presentation()?.frame ?? $0.frame).minY))/\(Int($0.frame.minY))+\(Int($0.frame.height))" }
            problems.append("\(when): blank frame anims=\(cv.layer.animationKeys() ?? []) viewport=\(Int(viewport.minY))/\(Int(cv.contentOffset.y))+\(Int(viewport.height)) cells=\(frames)")
        }
    }

    /// At rest: every visible row opaque, shown and in place.
    private func settle(_ when: String) {
        drain(1.0)
        check(when)
        guard let cv = collection else { return }
        for cell in cv.visibleCells where cell.isHidden || cell.alpha < 0.99 || !CATransform3DIsIdentity(cell.layer.transform) {
            problems.append("\(when): row \(cv.indexPath(for: cell)?.item ?? -1) hidden=\(cell.isHidden) alpha=\(cell.alpha)")
        }
        let live = cv.subviews.compactMap { $0 as? TKBubbleCell }.filter { !$0.isHidden && $0.contentSnapshot?.isLive == true }
        if live.count > 1 { problems.append("\(when): \(live.count) live cells") }
    }

    private func sample(_ when: String, frames: Int) {
        for frame in 0..<frames {
            drain(1.0 / 60.0)
            check("\(when)#\(frame)")
        }
    }

    // MARK: Scenario plumbing

    /// Forty earlier rows and the running turn's prompt in the production ChatView.
    private func openChat() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("steer-tall-\(UUID().uuidString)")
        self.root = root
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let history = (1...40).map { seq in
            ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: sid, deviceId: "dev",
                        timestamp: "2026-10-13T08:00:00Z",
                        payload: ["content": AnyCodable(seq % 2 == 1 ? "Question \(seq)." : "Answer \(seq): a short reply.")])
        }
        try db.insert(sid, history + [ChatMessage(type: "user_message", seq: 41, sessionId: sid, deviceId: "dev",
                                                  timestamp: "2026-10-13T09:00:00Z", payload: ["content": AnyCodable(prompt)])])
        let app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.deviceId = "steer-tall-app"
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: "dev", deviceName: "Studio Mac", agent: "pi", title: "Penguins",
            state: .active, mode: .auto, lastSeq: 41, readSeq: 41, messageCount: 41, createdAt: Date(), pinned: false)
        app.deviceStore.devices["dev"] = DeviceSummary(id: "dev", name: "Studio Mac", role: .tentacle, kind: .desktop, online: true)
        app.sessionStore.activeSessionId = sid
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 41, deviceId: "dev")
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
        drain(0.8)
    }

    private func route(_ type: String, seq: Int? = nil, _ payload: [String: Any]) throws {
        var envelope: [String: Any] = ["type": type, "sessionId": sid, "deviceId": "dev",
                                       "timestamp": "2026-10-13T09:00:05Z", "payload": payload]
        if let seq { envelope["seq"] = seq }
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: envelope))
    }

    /// Deltas of `chunk` words, continuing the current segment.
    private func stream(_ text: String, chunk: Int) {
        let words = text.split(separator: " ", omittingEmptySubsequences: false)
        var index = 0
        while index < words.count {
            let piece = words[index..<min(index + chunk, words.count)].joined(separator: " ")
            let lead = index == 0 ? "" : " "
            app.messageStore.applyCardMessage(sid, lead + piece, reset: false)
            index += chunk
            drain(1.0 / 60.0)
            check("stream")
        }
    }

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    private func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }

    /// The rows the collection view draws, top to bottom.
    private func drawn() -> [String] {
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
