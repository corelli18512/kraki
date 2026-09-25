import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Behavioral gates for the macOS chat surface, driven through the production
/// `MacChatView` (SwiftUI) → `MacChatListRepresentable` → `MacChatScrollView`
/// in a real on-screen NSWindow with realistic mixed content. Isolated
/// temporary SQLite + test outbound handler: no network, Relay, Tentacle or
/// production data.
@MainActor
class MacChatUXTestCase: XCTestCase {
    var roots: [URL] = []
    var windows: [NSWindow] = []
    var states: [AppState] = []
    let sid = "mac-ux-gate"
    let dev = "mac-ux-gate-device"

    override func tearDown() async throws {
        windows.forEach { $0.orderOut(nil); $0.contentView = nil }
        windows.removeAll()
        states.removeAll()
        drain(100)
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    // MARK: Corpus (same as iOS ChatUXRegressionTests)

    static let zh = "好的，我来帮你看一下这个问题。首先我们需要确认服务端的配置是否正确，然后再检查客户端的网络请求是否带上了正确的鉴权头。如果两边都没有问题，那很可能是缓存导致的，建议先清一下本地缓存再重试。"
    static let en = "Sure — I checked the relay configuration and the client request path. Both look correct, so the stale state is most likely coming from the local cache layer; clearing it and retrying should confirm."
    static let code = "这是修改后的代码：\n\n```swift\nfunc load() async throws {\n    let url = URL(string: base)!\n    var req = URLRequest(url: url)\n    req.setValue(token, forHTTPHeaderField: \"Auth\")\n    let (data, _) = try await session.data(for: req)\n    cache.store(data)\n    try decode(data)\n}\n```\n\n改完后重新跑一下测试。"
    static let list = "主要改动：\n\n1. 修复登录态过期\n2. 优化列表滚动\n3. 新增重试逻辑\n4. 删除旧接口\n5. 更新文档\n\n- 风险：低\n- 需要回归：是"
    static let table = "| 指标 | 之前 | 之后 |\n|---|---|---|\n| 冷启动 | 1.8s | 0.9s |\n| 首屏 | 620ms | 310ms |\n| 掉帧 | 12% | 2% |"
    static let user = "帮我看看为什么列表滚动的时候会跳，尤其是往上翻历史消息的时候"

    static func body(_ seq: Int) -> (type: String, text: String) {
        if seq % 2 == 1 { return ("user_message", [user, "好的", "继续", en][seq / 2 % 4]) }
        let pool = [zh + "\n\n" + zh, code, list, en + " " + en, table, zh + zh + zh, code + "\n\n" + list]
        return ("agent_message", pool[(seq / 2) % pool.count])
    }

    static func longAnswer(_ minimum: Int) -> String {
        var text = ""
        while text.count < minimum {
            text += code + "\n\n" + zh + "\n\n" + list + "\n\n" + table + "\n\n" + en + "\n\n"
        }
        return text
    }

    // MARK: Fixture

    struct Fx {
        let app: AppState
        let vm: ChatViewModel
        let window: NSWindow
        let sv: MacChatScrollView
        var doc: MacChatDocumentView { sv.chatDocumentView }
    }

    func makeFixture(
        total: Int,
        size: NSSize = NSSize(width: 900, height: 760),
        outbound: (([String: Any]) -> Bool)? = nil
    ) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-ux-gate-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let msgs = (1...max(total, 1)).prefix(total).map { seq -> ChatMessage in
            let b = Self.body(seq)
            return ChatMessage(type: b.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-09-01T00:00:00.000Z", payload: ["content": AnyCodable(b.text)])
        }
        if !msgs.isEmpty { try db.insert(sid, Array(msgs)) }
        let app = AppState(testDatabase: db)
        states.append(app)
        app.sessionStore.sessions[sid] = SessionInfo(
            id: sid, deviceId: dev, deviceName: "gate", agent: "claude", model: "m", title: "gate",
            state: .idle, mode: .discuss, lastSeq: total, readSeq: total, messageCount: total,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "gate", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { msg, _, _ in outbound?(msg) ?? true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: total, deviceId: dev)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        let root2 = MacChatView(sessionId: sid, prebuiltViewModel: vm).environment(app)
        let host = NSHostingView(rootView: root2)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 40, y: 40), size: size),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        // Visible on top (without taking keyboard focus) so AppKit performs the
        // real display/compositing work; an occluded window skips drawing and
        // under-reports main-thread cost.
        window.level = .floating
        window.orderFrontRegardless()
        windows.append(window)
        drain(50)
        let sv = try XCTUnwrap(find(host), "MacChatScrollView not mounted")
        return Fx(app: app, vm: vm, window: window, sv: sv)
    }

    func find(_ view: NSView) -> MacChatScrollView? {
        if let s = view as? MacChatScrollView { return s }
        for sub in view.subviews { if let s = find(sub) { return s } }
        return nil
    }

    func drain(_ ms: Int) {
        RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000))
    }

    // MARK: Geometry probes

    func diag(_ fx: Fx) -> [String: Any] {
        fx.doc.layoutDiagnostics(viewport: fx.sv.contentView.bounds)
    }

    struct Cell { let seq: Int; let screenY: CGFloat; let h: CGFloat; let configured: CGFloat; let live: Bool; let placeholder: Bool }

    func cells(_ fx: Fx) -> [Cell] {
        let frames = diag(fx)["cellFrames"] as? [[String: Any]] ?? []
        return frames.map {
            Cell(seq: $0["seq"] as? Int ?? 0,
                 screenY: CGFloat($0["screenY"] as? Double ?? 0),
                 h: CGFloat($0["height"] as? Double ?? 0),
                 configured: CGFloat($0["configuredHeight"] as? Double ?? 0),
                 live: $0["live"] as? Bool ?? false,
                 placeholder: $0["placeholder"] as? Bool ?? false)
        }.sorted { $0.screenY < $1.screenY }
    }

    /// Positive: the latest item's bottom is hidden below the reserved
    /// composer footprint. Negative: an empty gap above it.
    func hiddenBelowComposer(_ fx: Fx) -> CGFloat {
        guard let last = fx.doc.latestItemFrame() else { return 0 }
        let d = diag(fx)
        let safe = CGFloat(d["bottomSafeArea"] as? Double ?? 0)
        let viewport = fx.sv.contentView.bounds
        return last.maxY - (viewport.maxY - safe)
    }

    func distanceToBottom(_ fx: Fx) -> CGFloat {
        fx.doc.frame.height - fx.sv.contentView.bounds.maxY
    }

    // MARK: Turn helpers

    func ingest(_ fx: Fx, _ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: data)
    }

    func startTurn(_ fx: Fx, seq: Int, text: String = "继续") throws {
        fx.app.messageStore.beginCardTurn(sid)
        try ingest(fx, ["type": "user_message", "seq": seq, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": text]])
        drain(200)
    }

    func land(_ fx: Fx, seq: Int, text: String) throws {
        try ingest(fx, ["type": "agent_message", "seq": seq, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:02.000Z", "payload": ["content": text]])
        fx.app.messageStore.endCardTurn(sid)
    }

    struct ScrollStats {
        var steps = 0, jumps = 0, worstJump: CGFloat = 0, placeholderFrames = 0, estimatedFrames = 0
        var restJump: CGFloat = 0, pagesLoaded = 0, blockedSteps = 0
        var log: [String] = []
    }

    /// Scrolls with precise packets (px per packet, ms between packets) and
    /// tracks the bubble at the viewport middle: it must move exactly by the
    /// applied scroll delta. Anything else is an unexpected jump.
    func scrollAndTrack(_ fx: Fx, packets: Int, px: CGFloat, intervalMs: Int, restMs: Int = 1_500,
                        burst: Int = .max, pauseMs: Int = 0,
                        during: ((Int) -> Void)? = nil) -> ScrollStats {
        var st = ScrollStats()
        let startTop = fx.app.messageStore.windows[sid]?.topSeq ?? 0
        func anchor() -> Cell? {
            let mid = fx.sv.contentView.bounds.height / 2
            return cells(fx).filter { !$0.placeholder }.min { abs($0.screenY + $0.h / 2 - mid) < abs($1.screenY + $1.h / 2 - mid) }
        }
        for step in 0..<packets {
            if step > 0, step % burst == 0 {
                // Fingers lifted: the gesture ends; track stillness meanwhile.
                if let a = anchor() {
                    for _ in 0..<max(1, pauseMs / 25) {
                        during?(step)
                        drain(25)
                        if let b = cells(fx).first(where: { $0.seq == a.seq }), abs(b.screenY - a.screenY) > 1 {
                            st.jumps += 1; st.worstJump = max(st.worstJump, abs(b.screenY - a.screenY))
                            if st.log.count < 12 { st.log.append(String(format: "pause@%d seq %d moved %.0f", step, a.seq, b.screenY - a.screenY)) }
                            break
                        }
                    }
                }
            }
            during?(step)
            guard let a = anchor() else { drain(intervalMs); continue }
            let r = fx.sv.automationPreciseScrollPacket(deltaY: px)
            let applied = r.before - r.after
            if applied < px - 0.5 { st.blockedSteps += 1 }
            drain(intervalMs)
            st.steps += 1
            let now = cells(fx)
            if let b = now.first(where: { $0.seq == a.seq }) {
                let err = b.screenY - (a.screenY + applied)
                if abs(err) > 1 {
                    st.jumps += 1
                    st.worstJump = max(st.worstJump, abs(err))
                    if st.log.count < 12 { st.log.append(String(format: "step %d seq %d err %.0f (applied %.0f)", step, a.seq, err, applied)) }
                }
            }
            let d = diag(fx)
            if (d["intersectingPlaceholderCount"] as? Int ?? 0) > 0 { st.placeholderFrames += 1 }
            if let bad = now.first(where: { !$0.placeholder && abs($0.configured - $0.h) > 1 }) {
                st.estimatedFrames += 1
                if st.log.count < 12 { st.log.append(String(format: "step %d mismatch seq %d live=%@ frame %.0f content %.0f", step, bad.seq, bad.live ? "Y" : "N", bad.h, bad.configured)) }
            }
        }
        // At rest: nothing may move.
        if let a = anchor() {
            var worst: CGFloat = 0
            for _ in 0..<(restMs / 50) {
                drain(50)
                if let b = cells(fx).first(where: { $0.seq == a.seq }) { worst = max(worst, abs(b.screenY - a.screenY)) }
            }
            st.restJump = worst
        }
        st.pagesLoaded = max(0, startTop - (fx.app.messageStore.windows[sid]?.topSeq ?? 0))
        return st
    }

    func dumpCost(_ tag: String) {
        for (k, v) in MacChatCost.buckets.sorted(by: { $0.value.total > $1.value.total }) {
            print(String(format: "UXCOST %@ %-22@ n=%4d total=%7.1fms avg=%5.2fms max=%5.1fms", tag, k, v.count, v.total, v.total / Double(max(v.count, 1)), v.max))
        }
    }

    /// Main-thread responsiveness: longest gap between 1ms heartbeats while
    /// `body` runs (≈ worst hitch the user would feel).
    final class Heartbeat {
        private var timer: Timer?
        private var last = CACurrentMediaTime()
        private(set) var gaps: [Double] = []
        func start() {
            last = CACurrentMediaTime()
            let t = Timer(timeInterval: 0.001, repeats: true) { [weak self] _ in
                guard let self else { return }
                let now = CACurrentMediaTime()
                self.gaps.append((now - self.last) * 1000)
                self.last = now
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
        func stop() { timer?.invalidate(); timer = nil }
        var worst: Double { gaps.max() ?? 0 }
        func over(_ ms: Double) -> Int { gaps.filter { $0 > ms }.count }
    }
}

@MainActor
final class MacChatUXProbeTests: MacChatUXTestCase {
    /// Baseline probe (no assertions): streaming follow, clipping, hitches.
    func testProbeStreaming() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        print("UXPROBE entry distance=\(distanceToBottom(fx)) hidden=\(hiddenBelowComposer(fx)) items=\(diag(fx)["itemCount"] ?? 0)")
        try startTurn(fx, seq: 41)
        let chars = Array(Self.longAnswer(6_000))
        var worstHidden: CGFloat = -.infinity, worstGap: CGFloat = 0, worstClip: CGFloat = 0
        MacChatCost.enabled = true
        MacChatCost.buckets = [:]
        let hb = Heartbeat(); hb.start()
        var i = 0
        var steps = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 30, chars.count)]), reset: false)
            i += 30
            drain(33)
            steps += 1
            let h = hiddenBelowComposer(fx)
            worstHidden = max(worstHidden, h)
            worstGap = max(worstGap, -h)
            if let live = cells(fx).first(where: { $0.live }) {
                worstClip = max(worstClip, live.configured - live.h)
                if live.configured - live.h > 5, steps % 5 == 0 {
                    print(String(format: "UXPROBE clip step=%d len=%d frameH=%.0f contentH=%.0f anim=%@", steps, i, live.h, live.configured, "\(diag(fx)["liveHeightAnimating"] ?? "")"))
                }
            }
            if i == 1500 || i == 6000 {
                dumpCost("len<=\(i)")
                MacChatCost.buckets = [:]
            }
            if steps % 25 == 0 {
                print(String(format: "UXPROBE step=%d len=%d hidden=%.0f dist=%.0f", steps, i, h, distanceToBottom(fx)))
            }
        }
        hb.stop()
        drain(800)
        print(String(format: "UXPROBE stream worstHidden=%.0f worstGap=%.0f worstClip=%.0f hitchMax=%.0fms >33ms=%d >16ms=%d",
                     worstHidden, worstGap, worstClip, hb.worst, hb.over(33), hb.over(16.7)))
        let liveBefore = cells(fx).last
        print("UXPROBE land-before \(String(describing: liveBefore)) docH=\(fx.doc.frame.height)")
        try land(fx, seq: 42, text: String(chars))
        let t0 = CACurrentMediaTime()
        for _ in 0..<60 {
            drain(16)
            let c = cells(fx)
            let desc = c.suffix(2).map { String(format: "[%d y=%.0f h=%.0f cfg=%.0f%@]", $0.seq, $0.screenY, $0.h, $0.configured, $0.placeholder ? " PH" : "") }.joined()
            print(String(format: "UXPROBE land t=%.0fms dist=%.0f hidden=%.0f %@", (CACurrentMediaTime() - t0) * 1000, distanceToBottom(fx), hiddenBelowComposer(fx), desc))
        }
    }

    func testProbeHistoryScroll() throws {
        for (name, px, ms, stream) in [("fast", CGFloat(40), 8, false), ("slow", CGFloat(6), 8, false), ("fast+stream", CGFloat(40), 8, true)] {
            let fx = try makeFixture(total: 300)
            drain(1_500)
            var streamed = 0
            if stream { try startTurn(fx, seq: 301) }
            let chars = Array(Self.longAnswer(4_000))
            MacChatCost.enabled = true; MacChatCost.buckets = [:]
            let hb = Heartbeat(); hb.start()
            let st = scrollAndTrack(fx, packets: name == "slow" ? 1_500 : 900, px: px, intervalMs: ms,
                                    burst: name == "slow" ? 120 : 40, pauseMs: 800) { _ in
                guard stream, streamed < chars.count else { return }
                fx.app.messageStore.applyCardMessage(self.sid, String(chars[streamed..<min(streamed + 12, chars.count)]), reset: false)
                streamed += 12
            }
            hb.stop()
            print(String(format: "UXPROBE scroll-%@ blocked=%d steps=%d jumps=%d worst=%.0f placeholderFrames=%d estimatedFrames=%d restJump=%.0f pagedMsgs=%d hitch=%.0fms >33=%d >16=%d",
                         name, st.blockedSteps, st.steps, st.jumps, st.worstJump, st.placeholderFrames, st.estimatedFrames, st.restJump, st.pagesLoaded, hb.worst, hb.over(33), hb.over(16.7)))
            st.log.forEach { print("UXPROBE   \($0)") }
            dumpCost(name)
            let w = fx.app.messageStore.windows[sid]
            print("UXPROBE   window top=\(w?.topSeq ?? -1) bottom=\(w?.bottomSeq ?? -1) count=\(fx.app.messageStore.messages[sid]?.count ?? 0) atStart=\(fx.vm.atHistoryStart) loadingOlder=\(fx.vm.isLoadingOlder) offset=\(fx.sv.contentView.bounds.minY) diag.older=\(diag(fx)["olderSpinnerVisible"] ?? "") paging=\(fx.sv.edgePagingDiagnostics.filter { ["olderEdgeArmed","olderPageConsumed","policyInteractionActive","loadingOlder","liveScrollActive","allowsEdgePaging"].contains($0.key) })")
            windows.forEach { $0.orderOut(nil) }
        }
    }

    func testProbeSendWhileScrolledUp() throws {
        let fx = try makeFixture(total: 60)
        drain(1_200)
        for _ in 0..<30 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(900)
        print("UXPROBE send before dist=\(distanceToBottom(fx))")
        _ = fx.app.commandSender?.sendInput(sessionId: sid, text: "新的问题：这个怎么修？")
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
        for t in [50, 150, 400, 900] {
            drain(t == 50 ? 50 : t - [50, 150, 400, 900][[50, 150, 400, 900].firstIndex(of: t)! - 1])
            let last = cells(fx).last
            print(String(format: "UXPROBE send t=%dms dist=%.0f hidden=%.0f lastSeq=%d lastY=%.0f", t, distanceToBottom(fx), hiddenBelowComposer(fx), last?.seq ?? -1, last?.screenY ?? -1))
        }
    }

    func testProbeAnimatedScrollInHost() throws {
        let fx = try makeFixture(total: 60)
        drain(1_200)
        for _ in 0..<30 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(900)
        print("UXPROBE anim active=\(NSApp.isActive) policy=\(NSApp.activationPolicy().rawValue) key=\(fx.window.isKeyWindow) visible=\(fx.window.isVisible) occl=\(fx.window.occlusionState.contains(.visible))")
        fx.sv.scrollToBottom(animated: true)
        for i in 0..<10 { drain(60); print("UXPROBE anim t=\(i*60) y=\(fx.sv.contentView.bounds.minY) dist=\(distanceToBottom(fx))") }
    }

    func testProbeNavigation() throws {
        let fx = try makeFixture(total: 120)
        drain(1_200)
        for _ in 0..<12 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(900)
        print("UXPROBE nav controls=\(fx.sv.automationControlsVisible) frames=\(fx.sv.automationControlFrames)")
        var previousSeq = Int.max
        for step in 0..<14 {
            let key = fx.sv.automationUpTargetKey
            fx.sv.automationTapUp()
            drain(900)
            let seq = key.flatMap { k in fx.app.messageStore.messages[sid]?.first { "\($0.id)" == k }?.seq } ?? -1
            let frame = key.flatMap { fx.doc.frame(forKey: $0) }
            let screenY = (frame?.minY ?? 0) - fx.sv.contentView.bounds.minY
            let type = fx.app.messageStore.messages[sid]?.first { $0.seq == seq }?.type ?? "?"
            print(String(format: "UXPROBE nav up#%d target=%@ seq=%d type=%@ landedScreenY=%.0f monotonic=%@ win=%d..%d", step, key ?? "nil", seq, type, screenY, seq < previousSeq ? "yes" : "NO", fx.app.messageStore.windows[sid]?.topSeq ?? 0, fx.app.messageStore.windows[sid]?.bottomSeq ?? 0))
            if seq > 0 { previousSeq = seq }
        }
        // New reply while away → red dot; ↓ → bottom, dot cleared.
        try startTurn(fx, seq: 121)
        try land(fx, seq: 122, text: Self.zh)
        drain(500)
        print("UXPROBE nav unseenDot=\(fx.sv.automationUnseenDotVisible) controls=\(fx.sv.automationControlsVisible)")
        fx.sv.automationTapDown()
        drain(1_500)
        print("UXPROBE nav afterDown dist=\(distanceToBottom(fx)) unseenDot=\(fx.sv.automationUnseenDotVisible) controls=\(fx.sv.automationControlsVisible)")
    }

    func testProbePendingStates() throws {
        var outboundOK = true
        let fx = try makeFixture(total: 20, outbound: { _ in outboundOK })
        fx.app.commandSender?.confirmationTimeout = .milliseconds(400)
        drain(1_000)
        _ = fx.app.commandSender?.sendInput(sessionId: sid, text: "这条会发送失败")
        func pendingStatus() -> String? {
            fx.doc.automationVisibleCells.last { $0.cell.content?.pendingClientId != nil }?.cell.deliveryStatusForRegression
        }
        drain(100)
        print("UXPROBE pending t=100 status=\(pendingStatus() ?? "nil")")
        drain(900)
        print("UXPROBE pending t=1000 status=\(pendingStatus() ?? "nil") hidden=\(hiddenBelowComposer(fx))")
        let clientId = fx.doc.automationVisibleCells.last { $0.cell.content?.pendingClientId != nil }?.cell.content?.pendingClientId
        fx.doc.onPendingAction?(clientId ?? "", .retry)
        drain(100)
        print("UXPROBE pending retry status=\(pendingStatus() ?? "nil")")
        drain(900)
        print("UXPROBE pending retry-timeout status=\(pendingStatus() ?? "nil")")
        fx.doc.onPendingAction?(clientId ?? "", .edit)
        drain(200)
        print("UXPROBE pending edit status=\(pendingStatus() ?? "nil") draft=\(fx.app.sessionStore.drafts[sid] ?? "nil")")
        _ = outboundOK
    }

    func testProbeScrollInsideStreamingReply() throws {
        let fx = try makeFixture(total: 30)
        drain(1_000)
        try startTurn(fx, seq: 31)
        let chars = Array(Self.longAnswer(9_000))
        var streamed = 0
        func push(_ n: Int) {
            guard streamed < chars.count else { return }
            fx.app.messageStore.applyCardMessage(sid, String(chars[streamed..<min(streamed + n, chars.count)]), reset: false)
            streamed += n
        }
        while streamed < 3_000 { push(40); drain(20) }
        drain(500)
        var revisions = Set<String>()
        let hb = Heartbeat(); hb.start()
        let st = scrollAndTrack(fx, packets: 240, px: 6, intervalMs: 8, burst: 80, pauseMs: 300) { step in
            push(10)
            if let live = fx.doc.automationVisibleCells.first(where: { $0.key == "__live__" }) { revisions.insert(live.cell.renderRevision) }
        }
        hb.stop()
        print(String(format: "UXPROBE inside-stream jumps=%d worst=%.0f placeholderFrames=%d estimatedFrames=%d restJump=%.0f liveRevisionsSeenWhileScrolling=%d hitch=%.0fms >33=%d >16=%d",
                     st.jumps, st.worstJump, st.placeholderFrames, st.estimatedFrames, st.restJump, revisions.count, hb.worst, hb.over(33), hb.over(16.7)))
        st.log.forEach { print("UXPROBE   \($0)") }
    }
}
