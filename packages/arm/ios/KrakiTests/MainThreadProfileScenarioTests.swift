import XCTest
import SwiftUI
@testable import Kraki

/// Manual profiling scenario (KRAKI_RUN_PERF_TESTS=1), driven with
/// `xcrun xctrace record --attach <pid>` by scripts/perf/profile-ios.sh.
/// Production SwiftUI tree (NavigationStack → SessionListView →
/// SessionDetailView/ChatView) with 56 sessions × 40 messages; one phase per
/// test so each trace isolates one workload.
@MainActor
final class MainThreadProfileScenarioTests: XCTestCase {
    @Observable final class Nav { var path = NavigationPath() }
    struct Harness: View {
        @Bindable var nav: Nav
        let app: AppState
        var body: some View {
            NavigationStack(path: $nav.path) {
                SessionListView(navigationPath: $nav.path)
                    .navigationDestination(for: SessionNavID.self) { r in
                        SessionDetailView(sessionId: r.id).id(r.id).environment(app)
                    }
            }
            .environment(app)
        }
    }

    static let device = "profile-tentacle"
    private var root: URL!
    private var app: AppState!
    private var nav = Nav()
    private var window: UIWindow!
    private var round = 0
    private var subscriptions: [String] = []

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private static let para = "这是一段比较典型的回答内容，包含 **加粗**、`inline code` 和一个[链接](https://example.com)。\n\n"
    private static let code = "```swift\nfunc load() async throws {\n    let (data, _) = try await session.data(for: req)\n    try decode(data)\n}\n```\n\n"

    private func digest(_ i: Int, lastSeq: Int, bump: Int) -> [String: Any] {
        let ts = String(format: "2026-10-%02dT%02d:%02d:00.000Z", 1 + i % 7, i % 24, bump % 60)
        return ["id": "s\(i)", "agent": "pi", "model": "deepseek-flash", "title": "会话 \(i) 标题比较长一点",
                "state": i % 9 == 0 ? "active" : "idle", "mode": "auto", "lastSeq": lastSeq, "readSeq": lastSeq - (i % 3),
                "messageCount": lastSeq, "createdAt": "2026-09-01T00:00:00.000Z", "pinned": i < 3,
                "lastActivityAt": ts,
                "preview": ["text": "最后一条消息的预览 \(bump) " + String(repeating: "文字", count: 20), "type": "agent_message", "timestamp": ts],
                "usage": ["inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 100, "cacheWriteTokens": 10,
                          "totalCost": 0.01, "totalDurationMs": 1000, "contextTokens": 12_000]]
    }

    private func applySessionList() throws {
        round += 1
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": Self.device, "seq": 1,
            "timestamp": ISO8601.withFractional.string(from: Date()),
            "payload": ["sessions": (0..<56).map { digest($0, lastSeq: $0 == 55 ? 400 : 40, bump: round) }, "archivedCount": 0, "autoArchiveDays": 14],
        ])
        app.messageRouter?.handleDataMessage(data)
    }

    override func setUpWithError() throws {
        try requireNativePerformanceTests()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("profile-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        for i in 0..<56 {
            try db.insert("s\(i)", (1...40).map { seq in
                let body = seq % 2 == 1 ? "帮我看看这个问题 \(seq)" : String(repeating: Self.para, count: 3) + Self.code + "\(seq)"
                return ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: "s\(i)",
                                   deviceId: Self.device, timestamp: "2026-10-08T10:00:00.000Z", payload: ["content": AnyCodable(body)])
            })
        }
        // One long conversation for the scroll phase.
        let longBody = String(repeating: Self.para, count: 8) + Self.code + "| 指标 | 之前 | 之后 |\n|---|---|---|\n| 冷启动 | 1.8s | 0.9s |\n\n"
        try db.insert("s55", (1...400).map { seq in
            ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: "s55",
                        deviceId: Self.device, timestamp: "2026-10-08T10:00:00.000Z",
                        payload: ["content": AnyCodable(seq % 2 == 1 ? "继续 \(seq)" : longBody + "\(seq)")])
        })
        app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { [weak self] msg, target, _ in
            if msg["type"] as? String == "set_session_subscription" {
                self?.subscriptions.append("\(target ?? "-"):\((msg["payload"] as? [String: Any])?["sessionId"] ?? "nil")")
            }
            return true
        }
        app.deviceStore.addDevice(DeviceSummary(id: Self.device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        try applySessionList()
        // Attach to the host's scene: a scene-less UIWindow never installs its
        // root view, so nothing would be laid out or drawn on screen.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView: Harness(nav: nav, app: app))
        window.makeKeyAndVisible()
        drain(1_500)
        // Signal the profiler and wait for it to attach.
        let ready = URL(fileURLWithPath: "/tmp/kraki-profile-ready")
        try? "\(getpid())".write(to: ready, atomically: true, encoding: .utf8)
        let go = URL(fileURLWithPath: "/tmp/kraki-profile-go")
        let deadline = Date().addingTimeInterval(90)
        while !FileManager.default.fileExists(atPath: go.path), Date() < deadline { drain(100) }
        try? FileManager.default.removeItem(at: go)
        try? FileManager.default.removeItem(at: ready)
    }

    override func tearDown() {
        window?.isHidden = true; window = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    private func open(_ i: Int) { nav.path.append(SessionNavID(id: "s\(i)")) }
    private func back() { if !nav.path.isEmpty { nav.path.removeLast() } }

    /// Open and close conversations, one per second.
    func testPhaseOpenSessions() throws {
        for n in 0..<24 { open(n * 3 % 56); drain(900); back(); drain(500) }
    }

    /// Reconnect-style session_list while the list is visible, then while a chat is open.
    func testPhaseSessionList() throws {
        for _ in 0..<15 { try applySessionList(); drain(400) }
        open(5); drain(1_000)
        for _ in 0..<15 { try applySessionList(); drain(400) }
    }

    /// Stream an answer into the open conversation (~30 deltas/s).
    func testPhaseStreaming() throws {
        open(7); drain(1_000)
        let sub = try XCTUnwrap(app.sessionSubscriptionController)
        // The Tentacle's reply to the subscription SessionDetailView issued.
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_subscription_set", "deviceId": Self.device,
            "payload": ["accepted": true, "sessionId": "s7"]]))
        drain(100)
        try? "subs=\(subscriptions) desired=\(String(describing: sub.desiredSessionId)) live=\(sub.acceptsLive("s7")) status=\(app.connectionStatus)".write(toFile: "/tmp/kraki-profile-sub.txt", atomically: true, encoding: .utf8)
        XCTAssertTrue(sub.acceptsLive("s7"), "subscription must be confirmed before streaming")
        app.messageStore.beginCardTurn("s7") // a turn is running (as after the user's message)
        var text = ""
        let source = (String(repeating: Self.para, count: 6) + Self.code) as NSString
        for k in 0..<400 {
            let chunk = source.substring(with: NSRange(location: (k * 7) % (source.length - 8), length: 7))
            text += chunk
            let data = try JSONSerialization.data(withJSONObject: [
                "type": "agent_message_delta", "sessionId": "s7", "deviceId": Self.device,
                "payload": ["content": chunk, "reset": false]])
            app.messageRouter?.handleDataMessage(data)
            drain(33)
        }
        let shown = app.messageStore.cards["s7"]?.text.count ?? 0
        try? "streamed=\(text.count) card=\(shown)".write(toFile: "/tmp/kraki-profile-streaming.txt", atomically: true, encoding: .utf8)
        XCTAssertGreaterThan(shown, text.count / 2, "deltas must reach the live card")
    }

    private func collectionView(in view: UIView) -> UICollectionView? {
        if let c = view as? UICollectionView, c.collectionViewLayout is ChatFlowLayout { return c }
        for sub in view.subviews { if let c = collectionView(in: sub) { return c } }
        return nil
    }

    /// Scroll up through a long history (older pages + cold rows), then back down.
    func testPhaseScroll() throws {
        open(55); drain(1_500)
        let list = try XCTUnwrap(collectionView(in: window))
        for direction in [-1.0, 1.0] {
            for _ in 0..<300 {   // ~5 s per direction at 60 Hz, 40 pt/frame
                var offset = list.contentOffset
                offset.y = max(-list.adjustedContentInset.top, offset.y + 40 * direction)
                list.setContentOffset(offset, animated: false)
                drain(16)
            }
        }
    }
}
