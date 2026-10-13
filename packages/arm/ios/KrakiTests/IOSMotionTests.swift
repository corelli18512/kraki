import XCTest
import UIKit
@testable import Kraki

#if os(iOS)
/// Motion of the conversation while new content arrives at the followed
/// bottom, sampled from what is on screen (presentation layers, every display
/// frame) in a real window: the screen position of an older bubble.
@MainActor
final class IOSMotionTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    private var roots: [URL] = []
    private var windows: [UIWindow] = []
    private var states: [AppState] = []
    private let sid = "motion"
    private let dev = "motion-device"

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll(); states.removeAll()
        drain(100)
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    struct Sample { let t: CFTimeInterval; let y: CGFloat }

    final class Sampler: NSObject {
        private(set) var samples: [Sample] = []
        private var link: CADisplayLink?
        let read: () -> CGFloat?
        init(_ read: @escaping () -> CGFloat?) { self.read = read }
        func start() {
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        func stop() { link?.invalidate(); link = nil }
        @objc private func tick() {
            if let y = read() { samples.append(Sample(t: CACurrentMediaTime(), y: y)) }
        }
        /// Largest move between two consecutive on-time frames (a stall —
        /// a gap over 25 ms — is counted apart).
        var worstFrameStep: CGFloat {
            samples.indices.dropFirst().reduce(0) { worst, i in
                samples[i].t - samples[i - 1].t > 0.025 ? worst : max(worst, abs(samples[i].y - samples[i - 1].y))
            }
        }
        var worstReversal: CGFloat {
            samples.indices.dropFirst().reduce(0) { max($0, samples[$1].y - samples[$1 - 1].y) }
        }
        /// Total distance travelled (first to last sample).
        var travel: CGFloat { abs((samples.first?.y ?? 0) - (samples.last?.y ?? 0)) }
        var stalls: Int { samples.indices.dropFirst().filter { samples[$0].t - samples[$0 - 1].t > 0.025 }.count }
    }

    struct Fx { let vc: ChatPerfListVC; let cv: UICollectionView; let app: AppState }

    /// On-screen position of a message's cell as composited (scroll offset
    /// and the arrival glide's additive transform included).
    private func screenY(_ fx: Fx, seq: Int) -> () -> CGFloat? {
        { [weak cv = fx.cv] in
            guard let cv else { return nil }
            for ip in cv.indexPathsForVisibleItems {
                guard let cell = cv.cellForItem(at: ip) as? TKBubbleCell,
                      cell.contentSnapshot?.message.seq == seq else { continue }
                // Everything as composited in the last frame: the cell's own
                // presentation too. Mixing its model frame (already moved by a
                // layout pass mid-frame) with the presentation scroll offset
                // read a half-applied layout as a jump on slow CI machines.
                let layer = cv.layer.presentation() ?? cv.layer
                let cellLayer = cell.layer.presentation() ?? cell.layer
                return cellLayer.frame.minY - layer.bounds.minY + layer.sublayerTransform.m42
            }
            return nil
        }
    }

    func testStreamingGrowthMovesTheConversationSmoothly() throws {
        let fx = try open(stored: 40)
        drain(1_000)
        try ingest(fx, seq: 41, type: "user_message", text: "继续")
        fx.app.messageStore.beginCardTurn(sid)
        drain(600)
        let sampler = Sampler(screenY(fx, seq: 41))
        sampler.start()
        let chars = Array(ChatUXRegressionTests.zh + ChatUXRegressionTests.zh + ChatUXRegressionTests.zh + "\n\n"
                          + ChatUXRegressionTests.list + "\n\n" + ChatUXRegressionTests.zh + ChatUXRegressionTests.en)
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 8, chars.count)]), reset: false)
            i += 8
            fx.vc.syncLiveUpdates()
            drain(40)
        }
        drain(600)
        sampler.stop()
        print(String(format: "IOSMOTION stream frames=%d worstFrameStep=%.1f reversal=%.1f stalls=%d dist=%.1f",
                     sampler.samples.count, sampler.worstFrameStep, sampler.worstReversal, sampler.stalls, distanceToBottom(fx.cv)))
        // ~2–4 pt a frame; a jump moves a whole line (≥ 18 pt) in one frame.
        XCTAssertLessThanOrEqual(sampler.worstFrameStep, 16, "a new line glides the conversation up, it never jumps")
        XCTAssertLessThanOrEqual(sampler.worstReversal, 0.5, "never pulled back down")
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5, "settles at the bottom")
    }

    func testAReplyArrivingWholeGlidesIn() throws {
        let fx = try open(stored: 40)
        drain(1_000)
        let sampler = Sampler(screenY(fx, seq: 40))
        sampler.start()
        try ingest(fx, seq: 41, type: "user_message", text: "继续")
        drain(700)
        try ingest(fx, seq: 42, type: "agent_message", text: ChatUXRegressionTests.zh + "\n\n" + ChatUXRegressionTests.list)
        drain(900)
        sampler.stop()
        print(String(format: "IOSMOTION arrive frames=%d worstFrameStep=%.1f reversal=%.1f stalls=%d",
                     sampler.samples.count, sampler.worstFrameStep, sampler.worstReversal, sampler.stalls))
        // An ease-out glide covers ≤ ~20% of its travel in its fastest frame.
        XCTAssertLessThanOrEqual(sampler.worstFrameStep, sampler.travel * 0.3, "an arrival glides, it never jumps")
        XCTAssertLessThanOrEqual(sampler.worstReversal, 0.5)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1.5)
    }

    // MARK: Fixture

    private func open(stored: Int) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("motion-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, (1...stored).map { seq in
            let b = ChatUXRegressionTests.body(seq)
            return ChatMessage(type: b.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-10-09T00:00:00.000Z", payload: ["content": AnyCodable(b.text)])
        })
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "Mac", agent: "claude", model: "m", title: "motion",
            state: .idle, mode: .auto, lastSeq: stored, readSeq: stored, messageCount: stored,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: stored, deviceId: dev)
        _ = app.messageStore.loadInitialWindow(sid)
        let vc = ChatPerfListVC(sessionId: sid, appState: app, agent: "claude", bottomContentInset: 54)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.windowLevel = .alert + 1
        window.rootViewController = vc
        window.makeKeyAndVisible()
        windows.append(window)
        vc.view.frame = window.bounds
        vc.loadViewIfNeeded()
        vc.viewWillAppear(false)
        vc.view.layoutIfNeeded()
        vc.viewDidAppear(false)
        let cv = try XCTUnwrap(find(vc.view))
        return Fx(vc: vc, cv: cv, app: app)
    }

    private func ingest(_ fx: Fx, seq: Int, type: String, text: String) throws {
        let json = try JSONSerialization.data(withJSONObject: [
            "type": type, "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-10-09T00:00:01.000Z", "payload": ["content": text],
        ])
        fx.app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: seq, deviceId: dev)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: json)
        fx.vc.syncLiveUpdates()
    }

    private func find(_ view: UIView) -> UICollectionView? {
        if let c = view as? UICollectionView { return c }
        for sub in view.subviews { if let c = find(sub) { return c } }
        return nil
    }

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func distanceToBottom(_ cv: UICollectionView) -> CGFloat {
        cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height - cv.contentOffset.y
    }
}
#endif
