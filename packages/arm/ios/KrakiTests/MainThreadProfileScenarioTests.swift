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

    /// Main run-loop wake-to-sleep intervals, measured like production's
    /// `ui.busy` (DiagRunLoop), so a phase reports the numbers diagnostics
    /// report. `begin()` also counts work the test body itself triggers
    /// before the next drain (e.g. a navigation push).
    final class MainIntervals {
        private var observer: CFRunLoopObserver?
        private var started: TimeInterval?
        private var startedCPU: UInt64 = 0
        /// `ms` wall clock, `cpuMs` main-thread CPU (less sensitive to host load).
        private(set) var intervals: [(end: TimeInterval, ms: Double, cpuMs: Double)] = []
        private static var cpuNow: UInt64 { clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) }
        func start() {
            let activities: CFRunLoopActivity = [.afterWaiting, .beforeWaiting, .exit]
            observer = CFRunLoopObserverCreateWithHandler(nil, activities.rawValue, true, 0) { [weak self] _, activity in
                guard let self else { return }
                let now = ProcessInfo.processInfo.systemUptime
                if activity == .afterWaiting {
                    if self.started == nil { self.started = now; self.startedCPU = Self.cpuNow }
                } else if let start = self.started {
                    self.started = nil
                    self.intervals.append((now, (now - start) * 1000, Double(Self.cpuNow &- self.startedCPU) / 1e6))
                }
            }
            if let observer { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
        }
        func begin() { started = ProcessInfo.processInfo.systemUptime; startedCPU = Self.cpuNow }
        func stop() { if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }; observer = nil }
        func longest(since: TimeInterval) -> Double { intervals.filter { $0.end >= since }.map(\.ms).max() ?? 0 }
        /// Main-thread CPU of the longest interval since `since`.
        func longestCPU(since: TimeInterval) -> Double {
            intervals.filter { $0.end >= since }.max { $0.ms < $1.ms }?.cpuMs ?? 0
        }
        static func summary(_ name: String, _ values: [Double]) -> String {
            let s = values.sorted()
            guard !s.isEmpty else { return "\(name): n=0" }
            func q(_ p: Double) -> Double { s[min(s.count - 1, Int(Double(s.count) * p))] }
            return String(format: "%@: n=%d p50=%.0f p90=%.0f max=%.0f ms, >=50ms: %d, >=100ms: %d", name, s.count,
                          q(0.5), q(0.9), s[s.count - 1], s.filter { $0 >= 50 }.count, s.filter { $0 >= 100 }.count)
        }
    }
    private let intervals = MainIntervals()
    private func report(_ phase: String, _ lines: [String]) {
        let text = lines.joined(separator: "\n")
        NSLog("[main-intervals] %@\n%@", phase, text)
        try? text.write(toFile: "/tmp/kraki-profile-\(phase)-intervals.txt", atomically: true, encoding: .utf8)
    }

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
        // Full screen, as on a phone: a narrower window resizes every freshly
        // loaded chat list from screen width (and logs a FlowLayout warning
        // per row), work a real full-screen open never does.
        window.frame = scene.screen.bounds
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
        intervals.start()
    }

    override func tearDown() {
        intervals.stop()
        window?.isHidden = true; window = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    private func open(_ i: Int) { nav.path.append(SessionNavID(id: "s\(i)")) }
    private func back() { if !nav.path.isEmpty { nav.path.removeLast() } }

    /// Open and close conversations, one per second.
    func testPhaseOpenSessions() throws {
        var opens: [Double] = [], openCPU: [Double] = [], backs: [Double] = []
        for n in 0..<24 {
            let opened = ProcessInfo.processInfo.systemUptime
            intervals.begin(); open(n * 3 % 56); drain(900)
            opens.append(intervals.longest(since: opened))
            openCPU.append(intervals.longestCPU(since: opened))
            let closed = ProcessInfo.processInfo.systemUptime
            intervals.begin(); back(); drain(500)
            backs.append(intervals.longest(since: closed))
        }
        report("OpenSessions", [MainIntervals.summary("open (longest interval per open)", opens),
                                MainIntervals.summary("open, main-thread CPU of that interval", openCPU),
                                MainIntervals.summary("back (longest interval per back)", backs),
                                MainIntervals.summary("all intervals >= 16 ms", intervals.intervals.map(\.ms).filter { $0 >= 16 })])
    }

    /// Open and close the long (400-message, tables + code) conversation.
    func testPhaseOpenLongSession() throws {
        var opens: [Double] = [], openCPU: [Double] = [], backs: [Double] = []
        for _ in 0..<12 {
            let opened = ProcessInfo.processInfo.systemUptime
            intervals.begin(); open(55); drain(1_200)
            opens.append(intervals.longest(since: opened))
            openCPU.append(intervals.longestCPU(since: opened))
            let closed = ProcessInfo.processInfo.systemUptime
            intervals.begin(); back(); drain(600)
            backs.append(intervals.longest(since: closed))
        }
        report("OpenLongSession", [MainIntervals.summary("open (longest interval per open)", opens),
                                   MainIntervals.summary("open, main-thread CPU of that interval", openCPU),
                                   MainIntervals.summary("back (longest interval per back)", backs),
                                   MainIntervals.summary("all intervals >= 16 ms", intervals.intervals.map(\.ms).filter { $0 >= 16 })])
    }

    /// Reconnect-style session_list while the list is visible, then while a chat is open.
    func testPhaseSessionList() throws {
        var onList: [Double] = [], inChat: [Double] = []
        for _ in 0..<15 {
            let at = ProcessInfo.processInfo.systemUptime
            intervals.begin(); try applySessionList(); drain(400)
            onList.append(intervals.longest(since: at))
        }
        open(5); drain(1_000)
        for _ in 0..<15 {
            let at = ProcessInfo.processInfo.systemUptime
            intervals.begin(); try applySessionList(); drain(400)
            inChat.append(intervals.longest(since: at))
        }
        report("SessionList", [MainIntervals.summary("session_list, list visible (longest per list)", onList),
                               MainIntervals.summary("session_list, chat open (longest per list)", inChat)])
    }

    /// A new message in another session while the list is visible: only that
    /// session's digest changes and it moves to the top (as in reality; the
    /// session_list phase rewrites every row's timestamp).
    func testPhaseSessionReorder() throws {
        var lastSeqs = (0..<56).map { $0 == 55 ? 400 : 40 }
        var minutes = Array(repeating: 0, count: 56)
        func push(_ round: Int) throws {
            let sessions: [[String: Any]] = (0..<56).map { i in
                var d = digest(i, lastSeq: lastSeqs[i], bump: 0)
                let ts = String(format: "2026-10-%02dT%02d:%02d:00.000Z", 1 + i % 7, i % 24, 0)
                let bumped = minutes[i] > 0 ? String(format: "2026-10-09T%02d:%02d:00.000Z", minutes[i] / 60, minutes[i] % 60) : ts
                d["lastActivityAt"] = bumped
                d["preview"] = ["text": "最后一条消息的预览 \(minutes[i]) " + String(repeating: "文字", count: 20),
                                "type": "agent_message", "timestamp": bumped]
                return d
            }
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
                "type": "session_list", "deviceId": Self.device, "seq": 1,
                "timestamp": ISO8601.withFractional.string(from: Date()),
                "payload": ["sessions": sessions, "archivedCount": 0, "autoArchiveDays": 14]]))
        }
        var reorders: [Double] = [], reorderCPU: [Double] = []
        for round in 1...30 {
            // Alternate a row near the bottom of the first screen and one in the middle.
            let order = (0..<56).sorted { (minutes[$0], $0) > (minutes[$1], $1) }
            let pick = order[round.isMultiple(of: 2) ? 7 : 4]
            lastSeqs[pick] += 2
            minutes[pick] = 60 + round
            let at = ProcessInfo.processInfo.systemUptime
            intervals.begin(); try push(round); drain(400)
            reorders.append(intervals.longest(since: at))
            reorderCPU.append(intervals.longestCPU(since: at))
        }
        report("SessionReorder", [MainIntervals.summary("one session moves to the top (longest per update)", reorders),
                                  MainIntervals.summary("main-thread CPU of that interval", reorderCPU)])
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
        let streamStart = ProcessInfo.processInfo.systemUptime
        for k in 0..<400 {
            let chunk = source.substring(with: NSRange(location: (k * 7) % (source.length - 8), length: 7))
            text += chunk
            let data = try JSONSerialization.data(withJSONObject: [
                "type": "agent_message_delta", "sessionId": "s7", "deviceId": Self.device,
                "payload": ["content": chunk, "reset": false]])
            app.messageRouter?.handleDataMessage(data)
            drain(33)
        }
        report("Streaming", [MainIntervals.summary("streaming intervals >= 8 ms",
                                                   intervals.intervals.filter { $0.end >= streamStart }.map(\.ms).filter { $0 >= 8 })])
        let shown = app.messageStore.cards["s7"]?.text.count ?? 0
        try? "streamed=\(text.count) card=\(shown)".write(toFile: "/tmp/kraki-profile-streaming.txt", atomically: true, encoding: .utf8)
        XCTAssertGreaterThan(shown, text.count / 2, "deltas must reach the live card")
    }

    /// A whole turn in the open conversation, as the Tentacle sends it: the
    /// user's message lands, the agent works (tool actions, draft deltas),
    /// the answer lands and the session goes idle. Reports the longest
    /// main-thread interval after each step.
    func testPhaseReplyLifecycle() throws {
        open(7); drain(1_000)
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_subscription_set", "deviceId": Self.device,
            "payload": ["accepted": true, "sessionId": "s7"]]))
        drain(300)
        XCTAssertTrue(try XCTUnwrap(app.sessionSubscriptionController).acceptsLive("s7"))
        var steps: [String: [Double]] = [:]
        func send(_ type: String, seq: Int? = nil, _ payload: [String: Any], step: String, wait: Int) throws {
            var envelope: [String: Any] = ["type": type, "sessionId": "s7", "deviceId": Self.device, "payload": payload,
                                           "timestamp": ISO8601.withFractional.string(from: Date())]
            if let seq { envelope["seq"] = seq }
            let at = ProcessInfo.processInfo.systemUptime
            intervals.begin()
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: envelope))
            drain(wait)
            steps[step, default: []].append(intervals.longest(since: at))
        }
        let answer = String(repeating: Self.para, count: 4) + Self.code
        var seq = 40
        for turn in 0..<8 {
            seq += 1
            try send("user_message", seq: seq, ["content": "帮我再看一下这个问题 \(turn)"], step: "1 user message lands", wait: 400)
            try send("active", ["state": "active"], step: "2 active", wait: 200)
            for tool in 0..<3 {
                try send("card_action", ["action": ["type": "tool_start", "payload": [
                    "toolName": "bash", "toolCallId": "t\(turn)-\(tool)", "headline": "Run the tests \(tool)"]]],
                    step: "3 card action", wait: 250)
            }
            for k in 0..<12 {
                try send("agent_message_delta", ["content": String(answer.prefix(20 * (k + 1))), "reset": true],
                         step: "4 draft delta", wait: 33)
            }
            seq += 1
            try send("agent_message", seq: seq, ["content": answer + "\(turn)"], step: "5 answer lands", wait: 500)
            try send("idle", ["state": "idle"], step: "6 idle", wait: 400)
        }
        report("ReplyLifecycle", steps.keys.sorted().map { MainIntervals.summary($0, steps[$0] ?? []) })
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
        let scrollStart = ProcessInfo.processInfo.systemUptime
        defer {
            report("Scroll", [MainIntervals.summary("scroll intervals >= 16 ms",
                                                    intervals.intervals.filter { $0.end >= scrollStart }.map(\.ms).filter { $0 >= 16 })])
        }
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
