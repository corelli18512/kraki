import XCTest
import SwiftUI
@testable import Kraki

#if os(iOS)
/// Behavioral gates for the iOS chat surface, driven through the production
/// `ChatPerfListVC` with realistic mixed content (Chinese prose, fenced code,
/// lists, tables). Isolated temporary SQLite + test outbound handler: no
/// network, Relay, Tentacle or production data.
@MainActor
final class ChatUXRegressionTests: XCTestCase {
    private var roots: [URL] = []
    private var windows: [UIWindow] = []
    private var states: [AppState] = []
    private let sid = "ux-gate"
    private let dev = "ux-gate-device"

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        states.removeAll()
        drain(100)
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    // MARK: Corpus

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

    struct Fx { let vc: ChatPerfListVC; let cv: UICollectionView; let app: AppState }

    private func makeFixture(total: Int, outbound: (([String: Any]) -> Bool)? = nil) throws -> Fx {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ux-gate-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let msgs = (1...total).map { seq -> ChatMessage in
            let b = Self.body(seq)
            return ChatMessage(type: b.type, seq: seq, sessionId: sid, deviceId: dev,
                               timestamp: "2026-09-01T00:00:00.000Z", payload: ["content": AnyCodable(b.text)])
        }
        try db.insert(sid, msgs)
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
        _ = app.messageStore.loadInitialWindow(sid)
        let vc = ChatPerfListVC(sessionId: sid, appState: app, agent: "claude", bottomContentInset: 54)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
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

    private func find(_ view: UIView) -> UICollectionView? {
        if let c = view as? UICollectionView { return c }
        for sub in view.subviews { if let c = find(sub) { return c } }
        return nil
    }

    private func drain(_ ms: Int) {
        RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000))
    }

    struct Row { let id: String; let y: CGFloat; let h: CGFloat; let exact: CGFloat }

    private func rows(_ cv: UICollectionView) -> [Row] {
        cv.layoutIfNeeded()
        return cv.indexPathsForVisibleItems.sorted().compactMap { ip in
            guard let cell = cv.cellForItem(at: ip) as? TKBubbleCell, let c = cell.contentSnapshot else { return nil }
            return Row(id: c.message.id, y: cell.frame.minY - cv.contentOffset.y,
                       h: cell.frame.height, exact: c.cellHeight(cellWidth: cv.bounds.width))
        }
    }

    private func distanceToBottom(_ cv: UICollectionView) -> CGFloat {
        cv.contentSize.height + cv.adjustedContentInset.bottom - cv.bounds.height - cv.contentOffset.y
    }

    private func hiddenBelowComposer(_ cv: UICollectionView) -> CGFloat {
        guard let last = rows(cv).last else { return 0 }
        return last.y + last.h - (cv.bounds.height - cv.adjustedContentInset.bottom)
    }

    private func startTurn(_ fx: Fx, seq: Int) throws {
        let user = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "继续"],
        ])
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: user)
        fx.vc.syncLiveUpdates()
        drain(200)
    }

    private func land(_ fx: Fx, seq: Int, text: String) throws {
        let agent = try JSONSerialization.data(withJSONObject: [
            "type": "agent_message", "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:02.000Z", "payload": ["content": text],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: agent)
        fx.app.messageStore.endCardTurn(sid)
        fx.vc.syncLiveUpdates()
    }

    // MARK: Streaming

    func testStreamingTailStaysVisibleAndHandoffIsExact() throws {
        let fx = try makeFixture(total: 40)
        drain(1_000)
        try startTurn(fx, seq: 41)
        let full = Self.longAnswer(3_000)
        let chars = Array(full)
        var worstHidden: CGFloat = 0
        var upToggles = 0
        var lastUp: Bool?
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 40, chars.count)]), reset: false)
            i += 40
            fx.vc.syncLiveUpdates()
            drain(24)
            worstHidden = max(worstHidden, hiddenBelowComposer(fx.cv))
            XCTAssertLessThanOrEqual(abs(fx.vc.automationContentSizeMismatch), 0.5, "scroll content size must match layout")
            let up = fx.vc.automationControlsVisible.up
            if let lastUp, lastUp != up { upToggles += 1 }
            lastUp = up
        }
        drain(300)
        XCTAssertLessThanOrEqual(worstHidden, 1, "streaming tail must stay above the composer")
        XCTAssertLessThanOrEqual(upToggles, 1, "tail growth alone must not make the ↑ control flicker")

        let live = try XCTUnwrap(rows(fx.cv).last)
        try land(fx, seq: 42, text: full)
        // Synchronously, before any frame: the landed bubble is exact and in place.
        let landed = try XCTUnwrap(rows(fx.cv).last)
        XCTAssertEqual(landed.h, landed.exact, accuracy: 0.5, "landed answer must not be composited at an estimate")
        XCTAssertEqual(landed.h, live.h, accuracy: 1, "live → landed must keep the same geometry")
        XCTAssertEqual(landed.y, live.y, accuracy: 1, "live → landed must not move")
        drain(1_500)
        let settled = try XCTUnwrap(rows(fx.cv).last)
        XCTAssertEqual(settled.y, landed.y, accuracy: 0.5)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
    }

    /// A table streamed row by row (the answer continues after it) must keep
    /// the live bubble exactly as tall as its content and pinned to the tail.
    func testStreamingTableKeepsBubbleHeightAndTailGap() throws {
        let fx = try makeFixture(total: 20)
        drain(800)
        try startTurn(fx, seq: 21)
        var rowsText = ""
        for i in 1...14 { rowsText += "| 指标\(i) | 覆盖设备 iOS、Android 以及更多平台 \(i) |\n" }
        let full = Self.zh + "\n\n" + Self.zh + "\n\n| 项目 | 说明 |\n|---|---|\n" + rowsText
            + "\n**H5 和小程序也能做精致。** 最终差异仍是设计与实现质量。\n\n## 为什么偏向原生\n\n" + Self.list + "\n\n" + Self.zh
        let chars = Array(full)
        var worst: (hidden: CGFloat, gap: CGFloat, clip: CGFloat, shrink: CGFloat) = (0, 0, 0, 0)
        var previousHeight: CGFloat = 0
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 9, chars.count)]), reset: false)
            i += 9
            fx.vc.syncLiveUpdates()
            drain(24)
            guard let live = rows(fx.cv).last else { continue }
            let visibleBottom = fx.cv.bounds.height - fx.cv.adjustedContentInset.bottom
            worst.hidden = max(worst.hidden, live.y + live.h - visibleBottom)
            worst.gap = max(worst.gap, visibleBottom - (live.y + live.h))
            worst.shrink = max(worst.shrink, previousHeight - live.h)
            previousHeight = live.h
            // Independent truth: TextKit measurement of every chunk, no caches.
            let content = TKBubbleContent.live(card: fx.app.messageStore.cards[sid]!, agent: "claude",
                                               sessionId: sid, steps: 1)
            let width = content.bodyTextWidth(cellWidth: fx.cv.bounds.width)
            var truth: CGFloat = 0
            if let body = content.body {
                for chunk in TKBodyChunks.chunks(body) {
                    truth += chunk.gapBefore + TKMeasure.height(body.attributedSubstring(from: chunk.range), width: width)
                }
            }
            worst.clip = max(worst.clip, abs(content.bodyTextHeight(cellWidth: fx.cv.bounds.width) - ceil(truth)))
            worst.gap = max(worst.gap, abs(fx.vc.automationContentSizeMismatch))
            // Concurrent idle height refreshes (warming) interleaved with growth.
            if i % 45 == 0 { NotificationCenter.default.post(name: .tkCodeHighlightReady, object: nil) }
        }
        print(String(format: "UXGATE table hidden=%.0f gap=%.0f heightErr=%.0f", worst.hidden, worst.gap, worst.clip))
        XCTAssertLessThanOrEqual(worst.hidden, 1, "tail must stay above the composer")
        XCTAssertLessThanOrEqual(worst.gap, 1, "no empty gap between the live bubble and the composer")
        XCTAssertLessThanOrEqual(worst.clip, 1, "live bubble height must match a fresh measurement")
        // Small shrinks are legitimate markdown reflow (a raw `| a | b |` line
        // or `**` markers collapsing once parsed). The stale table geometry
        // bug oscillated by ~190pt.
        XCTAssertLessThanOrEqual(worst.shrink, 20, "a growing answer must not collapse its bubble")
    }

    /// Incremental streaming parse must render exactly what a full parse of
    /// the same text renders (block ids aside), at every growth step.
    func testIncrementalLiveBodyMatchesFullParse() {
        let full = Self.longAnswer(4_000) + "\n\n```\nunterminated fence\nline"
        let live = TKLiveBody.forSession("inc-\(UUID().uuidString)")
        var cursor = 0
        var steps = 0
        let stripped: (NSAttributedString) -> NSAttributedString = { attr in
            let copy = NSMutableAttributedString(attributedString: attr)
            copy.removeAttribute(.tkBlockID, range: NSRange(location: 0, length: copy.length))
            copy.removeAttribute(.attachment, range: NSRange(location: 0, length: copy.length))
            return copy
        }
        while cursor < full.count {
            cursor = min(full.count, cursor + 37)
            let prefix = String(full.prefix(cursor))
            live.update(prefix)
            steps += 1
            guard steps % 9 == 0 || cursor == full.count else { continue }
            let expected = TKMarkdown.attributed(prefix, cacheKey: "full-\(UUID().uuidString)", allowHighlighting: false)
            let actual = live.body ?? NSAttributedString()
            XCTAssertEqual(actual.string, expected.string, "text diverged at \(cursor)")
            let a = stripped(actual), e = stripped(expected)
            if !a.isEqual(to: e) {
                var i = 0
                while i < a.length {
                    var ra = NSRange(), re = NSRange()
                    let aa = a.attributes(at: i, effectiveRange: &ra) as NSDictionary
                    let ee = e.attributes(at: i, effectiveRange: &re) as NSDictionary
                    if !aa.isEqual(to: ee as! [AnyHashable: Any]) || ra != re {
                        print("UXGATE-DIFF at \(i) ra=\(ra) re=\(re) char=\((a.string as NSString).substring(with: NSRange(location: i, length: 1)).debugDescription)\nA=\(aa)\nE=\(ee)")
                        break
                    }
                    i = NSMaxRange(ra)
                }
            }
            XCTAssertTrue(a.isEqual(to: e), "attributes diverged at \(cursor)")
        }
    }

    /// Chunk boundaries depend only on the text before them, so settled chunks
    /// never re-layout as the answer grows.
    func testChunkBoundariesAreStableWhileGrowing() {
        let full = TKMarkdown.attributed(Self.longAnswer(6_000), cacheKey: "chunks-\(UUID())", allowHighlighting: false)
        let final = TKBodyChunks.chunks(full).map(\.range)
        XCTAssertGreaterThan(final.count, 4)
        for length in stride(from: 900, to: full.length, by: 311) {
            let prefix = full.attributedSubstring(from: NSRange(location: 0, length: length))
            let partial = TKBodyChunks.chunks(prefix).map(\.range)
            for range in partial.dropLast() {
                XCTAssertTrue(final.contains(range), "boundary \(range) at length \(length) moved later")
            }
        }
    }

    func testLongStreamRenderCostDoesNotGrowWithLength() throws {
        let fx = try makeFixture(total: 20)
        drain(800)
        try startTurn(fx, seq: 21)
        let chars = Array(Self.longAnswer(9_000))
        var early: [Double] = []
        var late: [Double] = []
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 24, chars.count)]), reset: false)
            i += 24
            fx.vc.syncLiveUpdates()
            drain(20)
            let cost = fx.vc.automationLastLiveRenderCostMs
            if i < 2_500 { early.append(cost) } else if i > 7_000 { late.append(cost) }
        }
        let earlyAvg = early.reduce(0, +) / Double(max(early.count, 1))
        let lateAvg = late.reduce(0, +) / Double(max(late.count, 1))
        print(String(format: "UXGATE render early=%.1fms late=%.1fms", earlyAvg, lateAvg))
        XCTAssertLessThan(lateAvg, max(earlyAvg * 2.2, earlyAvg + 6),
                          "per-update render cost must stay roughly flat as the answer grows")
    }

    // MARK: Scrolling

    /// Continuous, aggressive upward scrolling straight through several older
    /// pages (with and without page latency, with a live answer streaming
    /// below): history keeps loading, and every step the rows on screen move
    /// exactly with the finger, none vanish, none use an estimated height.
    func testContinuousUpwardScrollKeepsLoadingWithoutFlicker() throws {
        for (latencyMs, stream) in [(0, false), (200, false), (0, true)] {
            let fx = try makeFixture(total: 400)
            drain(1_500)
            if stream { try startTurn(fx, seq: 401) }
            let answer = Array(Self.longAnswer(5_000))
            var streamed = 0
            let top0 = fx.app.messageStore.windows[sid]?.topSeq ?? 0
            fx.vc.scrollViewWillBeginDragging(fx.cv)
            fx.vc.automationUserScrollActive = true
            defer { fx.vc.automationUserScrollActive = false }
            var shifts = 0, vanished = 0, estimated = 0, worst: CGFloat = 0, log: [String] = []
            for step in 0..<420 {
                if stream, streamed < answer.count, step % 3 == 0 {
                    fx.app.messageStore.applyCardMessage(sid, String(answer[streamed..<min(streamed + 30, answer.count)]), reset: false)
                    streamed += 30
                    fx.vc.syncLiveUpdates()
                }
                let before = rows(fx.cv)
                let minY = -fx.cv.adjustedContentInset.top
                let target = max(minY, fx.cv.contentOffset.y - 70)
                let applied = fx.cv.contentOffset.y - target
                fx.cv.contentOffset.y = target
                fx.vc.scrollViewDidScroll(fx.cv)
                drain(latencyMs > 0 && step % 25 == 0 ? latencyMs : 16)
                let after = rows(fx.cv)
                let height = fx.cv.bounds.height
                for row in before {
                    let expected = row.y + applied
                    if let now = after.first(where: { $0.id == row.id }) {
                        if abs(now.y - expected) > 1.5 {
                            shifts += 1; worst = max(worst, abs(now.y - expected))
                            if log.count < 6 { log.append(String(format: "step %d %@ moved %.0f vs finger %.0f", step, row.id, now.y - row.y, applied)) }
                        }
                    } else if expected >= 0, expected + row.h <= height, !row.id.contains("live") {
                        vanished += 1
                        if log.count < 6 { log.append("step \(step) \(row.id) vanished") }
                    }
                }
                let bad = after.filter { abs($0.h - $0.exact) > 1 }
                estimated += bad.count
            }
            fx.vc.automationUserScrollActive = false
            fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
            drain(1_200)
            let paged = top0 - (fx.app.messageStore.windows[sid]?.topSeq ?? 0)
            print("UXGATE ios-continuous latency=\(latencyMs) stream=\(stream) paged=\(paged) shifts=\(shifts)(\(Int(worst))pt) vanished=\(vanished) estimated=\(estimated)")
            log.forEach { print("UXGATE   \($0)") }
            XCTAssertGreaterThanOrEqual(paged, 60, "continuous upward scrolling keeps loading history")
            XCTAssertEqual(shifts, 0, "rows must move exactly with the finger")
            XCTAssertEqual(vanished, 0)
            XCTAssertEqual(estimated, 0)
            windows.forEach { $0.isHidden = true }
        }
    }

    func testFlingNeverExposesEstimatedHeightsOrJumpsAtRest() throws {
        let fx = try makeFixture(total: 200)
        drain(1_500)
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        var wrong = 0
        for _ in 0..<45 {
            fx.cv.contentOffset.y = max(-fx.cv.adjustedContentInset.top, fx.cv.contentOffset.y - 90)
            fx.vc.scrollViewDidScroll(fx.cv)
            wrong += rows(fx.cv).filter { abs($0.h - $0.exact) > 1 }.count
        }
        let mid = fx.cv.bounds.height / 2
        let before = rows(fx.cv)
        let anchor = try XCTUnwrap(before.min { abs($0.y + $0.h / 2 - mid) < abs($1.y + $1.h / 2 - mid) })
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
        drain(1_500)
        XCTAssertEqual(wrong, 0, "no visible row may use an estimated height")
        if let after = rows(fx.cv).first(where: { $0.id == anchor.id }) {
            XCTAssertEqual(after.y, anchor.y, accuracy: 2, "reading position must not move at rest")
        }
    }

    func testEstimatesAreCloseForRealContentShapes() {
        let width: CGFloat = 402
        for text in [Self.zh + "\n\n" + Self.zh, Self.en, Self.code, Self.list, Self.table, Self.zh + Self.zh + Self.zh] {
            let m = ChatMessage(type: "agent_message", seq: 1, sessionId: sid, deviceId: dev,
                                timestamp: nil, payload: ["content": AnyCodable(text)])
            let usable = width - TKMetrics.outerH * 2 - width * TKMetrics.trailingGapFraction
            let estimate = ChatHeightEstimator.bodyHeight(text, bodyWidth: usable - TKMetrics.msgPadH * 2) + 32
            let exact = TKBubbleContent.make(message: m, sessionId: sid, agent: "claude").cellHeight(cellWidth: width)
            XCTAssertEqual(estimate / exact, 1, accuracy: 0.2, "estimate for \(text.prefix(12)) off: \(estimate) vs \(exact)")
        }
    }

    // MARK: Sending

    func testSendReturnsToNewestAndKeepsOrder() throws {
        let fx = try makeFixture(total: 80)
        drain(1_000)
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        fx.cv.contentOffset.y -= 2_400
        fx.vc.scrollViewDidScroll(fx.cv)
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
        drain(600)
        XCTAssertGreaterThan(distanceToBottom(fx.cv), 1_000)
        for text in ["第一条", "第二条", "第三条"] {
            XCTAssertTrue(fx.app.commandSender?.sendInput(sessionId: sid, text: text) == true)
        }
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1, "sending returns to the newest edge")
        let visible = rows(fx.cv).map(\.id).filter { $0.contains(":pending:") }
        XCTAssertEqual(visible.count, 3, "all optimistic messages visible after sending")
        let order = fx.app.commandSender?.pendingInputs(sid).compactMap(\.content)
        XCTAssertEqual(order, ["第一条", "第二条", "第三条"])
    }

    func testPendingDeliveryStateFailsRetriesAndDeduplicates() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let pending = try XCTUnwrap(sender.pendingInputs(sid).first)
        XCTAssertEqual(sender.pendingState(pending), .sending)
        drain(600)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .failed,
                       "unconfirmed input must surface as failed, not hang forever")
        fx.vc.syncLiveUpdates()
        drain(100)
        let failedCell = fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
            .first { $0.contentSnapshot?.message.type == "pending_input" }
        XCTAssertEqual(failedCell?.deliveryStatusForRegression, "Not delivered. Tap to retry",
                       "the visible bubble must show the failed state")
        let clientId = try XCTUnwrap(pending.payload["clientId"]?.stringValue)
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: clientId))
        XCTAssertEqual(sends, 2, "retry resends with the same clientId")
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .sending)

        // Tentacle deduplicates retries and may not re-echo; the persisted
        // user_message carrying the clientId must hide the optimistic bubble.
        let echo = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 11, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": ["content": "hello", "clientId": clientId],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: echo)
        fx.vc.syncLiveUpdates()
        let vm = ChatViewModel(sessionId: sid, appState: fx.app)
        vm.refreshMessageCache()
        XCTAssertTrue(vm.pendingMessages.isEmpty, "landed clientId must suppress its optimistic twin")
    }

    // MARK: Voice: sent bubble corrected in place

    private func pendingCell(_ fx: Fx) -> TKBubbleCell? {
        fx.cv.layoutIfNeeded()
        return fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
            .first { $0.contentSnapshot?.message.type == "pending_input" }
    }

    func testStagedVoiceBubbleCorrectsInPlaceThenSendsCorrectedTextOnce() throws {
        var sent: [[String: Any]] = []
        let fx = try makeFixture(total: 10) { msg in sent.append(msg); return true }
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "把登录页的报错改成中文"))
        XCTAssertTrue(sent.isEmpty, "a correcting voice message has not been transmitted")
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .correcting)
        fx.vc.syncLiveUpdates(); drain(150)
        XCTAssertEqual(pendingCell(fx)?.deliveryStatusForRegression, "Correcting transcript before sending")
        let before = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })

        // Correction streams in and grows the bubble; its row must stay exact.
        let long = String(repeating: "把登录页的错误提示改成中文，并检查注册流程里邮箱校验的边界情况。", count: 4)
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: long)
        fx.vc.syncLiveUpdates(); drain(150)
        let after = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })
        XCTAssertGreaterThan(after.h, before.h + 20)
        XCTAssertEqual(after.h, after.exact, accuracy: 1, "streamed correction keeps an exact row height")
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1, "a growing bubble stays in view")
        // While correcting, the bubble keeps its size: it never shrinks back.
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: "短")
        fx.vc.syncLiveUpdates(); drain(150)
        let shorter = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })
        XCTAssertEqual(shorter.h, after.h, accuracy: 0.5, "a correcting bubble does not jump smaller")

        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "改好了。"))
        XCTAssertFalse(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "again"))
        XCTAssertEqual(sent.count, 1)
        let payload = try XCTUnwrap(sent.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["text"] as? String, "改好了。")
        XCTAssertEqual(payload["clientId"] as? String, clientId)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .sending)
    }

    func testStagedVoiceFailureRetriesOriginalAndDeleteWins() throws {
        var texts: [String] = []
        let fx = try makeFixture(total: 4) { msg in
            texts.append((msg["payload"] as? [String: Any])?["text"] as? String ?? ""); return true
        }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "raw words"))
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: "half corr", original: "raw words")
        sender.failStagedInput(sessionId: sid, clientId: clientId, text: "raw words")
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .failed)
        XCTAssertTrue(texts.isEmpty, "an unconfirmed correction is never sent automatically")
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: clientId))
        XCTAssertEqual(texts, ["raw words"], "Retry sends the original transcript")

        let other = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "said this"))
        sender.updateStagedInput(sessionId: sid, clientId: other, text: "said thi", original: "said this")
        sender.discardPending(sessionId: sid, clientId: other)   // Delete while correcting
        XCTAssertFalse(sender.dispatchStagedInput(sessionId: sid, clientId: other, text: "late"),
                       "a deleted voice message is never sent by a late correction")
        XCTAssertEqual(texts.count, 1)
    }

    func testStagedVoiceSurvivesRelaunchAsRetryableOriginal() throws {
        let fx = try makeFixture(total: 2)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let first = CommandSender(appState: fx.app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "original"))
        first.updateStagedInput(sessionId: sid, clientId: clientId, text: "corrected partial", original: "original")
        _ = first.sendInput(sessionId: sid, text: "other")   // persists the whole outbox
        drain(300)
        let restored = CommandSender(appState: fx.app, outboxURL: url)
        let voice = try XCTUnwrap(restored.pendingInputs(sid).first { $0.payload["clientId"]?.stringValue == clientId })
        XCTAssertEqual(restored.pendingState(voice), .failed)
        XCTAssertEqual(voice.content, "original")
    }

    // MARK: Delivery dim (text + image) and status placement

    private func pngAttachment() -> ImageAttachment {
        let data = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).pngData { ctx in
            UIColor.systemBlue.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        return ImageAttachment(type: "image", mimeType: "image/png", data: data.base64EncodedString())
    }

    private func cell(_ fx: Fx, clientId: String) -> TKBubbleCell? {
        fx.cv.layoutIfNeeded()
        return fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
            .first { $0.contentSnapshot?.message.payload["clientId"]?.stringValue == clientId }
    }

    func testSendingMessageDimsTextAndImageTogetherWithoutFlashUntilDelivered() throws {
        let fx = try makeFixture(total: 6)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "看一下这个报错", attachments: [pngAttachment()]))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        fx.vc.syncLiveUpdates(); drain(150)
        let early = try XCTUnwrap(cell(fx, clientId: clientId)?.pendingDimForRegression)
        XCTAssertEqual(early.text, 1, accuracy: 0.05, "a fast confirmation must not flash a dim")
        drain(1_200)
        let pendingCell = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertEqual(pendingCell.pendingDimForRegression.text, 0.6, accuracy: 0.05)
        XCTAssertEqual(pendingCell.pendingDimForRegression.image, 0.6, accuracy: 0.05, "the image is part of the sending message")
        XCTAssertEqual(pendingCell.deliveryStatusForRegression, "Sending")

        let echo = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 7, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": ["content": "看一下这个报错", "clientId": clientId],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: echo)
        sender.clearPending(sid, clientId: clientId)
        fx.vc.syncLiveUpdates(); drain(500)
        let delivered = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertNil(delivered.deliveryStatusForRegression)
        XCTAssertEqual(delivered.pendingDimForRegression.text, 1, accuracy: 0.05)
        XCTAssertEqual(delivered.pendingDimForRegression.image, 1, accuracy: 0.05)
    }

    func testCorrectingVoiceShowsUncorrectedLightAndCorrectedSolidWithoutDimming() throws {
        let fx = try makeFixture(total: 6)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "把登入页改成中文", attachments: [pngAttachment()]))
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: "把登录页改成中文",
                                 uncorrected: NSRange(location: 4, length: 4))
        fx.vc.syncLiveUpdates(); drain(150)
        let correcting = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertEqual(correcting.deliveryStatusForRegression, "Correcting transcript before sending")
        XCTAssertEqual(correcting.pendingDimForRegression.text, 1, accuracy: 0.05, "correcting is not a whole-message dim")
        XCTAssertEqual(correcting.pendingDimForRegression.image, 1, accuracy: 0.05)
        let body = try XCTUnwrap(correcting.contentSnapshot?.body)
        func alpha(at index: Int) -> CGFloat {
            (body.attribute(.foregroundColor, at: index, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? 1
        }
        XCTAssertEqual(alpha(at: 1), 1, accuracy: 0.01, "corrected words are solid")
        XCTAssertEqual(alpha(at: 5), 0.5, accuracy: 0.01, "words not yet corrected are light")

        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "把登录页改成中文。"))
        fx.vc.syncLiveUpdates(); drain(150)
        let sent = try XCTUnwrap(cell(fx, clientId: clientId)?.contentSnapshot?.body)
        XCTAssertEqual((sent.attribute(.foregroundColor, at: 5, effectiveRange: nil) as? UIColor)?.cgColor.alpha ?? 1, 1,
                       accuracy: 0.01, "fully solid once corrected")
    }

    func testImageOnlyMessageStatusSitsBesideTheImage() throws {
        let fx = try makeFixture(total: 6)
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "[image]", attachments: [pngAttachment()]))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        drain(700)
        fx.vc.syncLiveUpdates(); drain(200)
        let failed = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertEqual(failed.deliveryStatusForRegression, "Not delivered. Tap to retry")
        XCTAssertTrue(failed.bubbleHiddenForRegression, "image-only: no text bubble")
        let image = failed.imageFrameForRegression, status = failed.deliveryStatusFrameForRegression
        XCTAssertGreaterThan(image.height, 0)
        XCTAssertGreaterThanOrEqual(status.minY, image.minY, "status is not above the image")
        XCTAssertLessThanOrEqual(status.maxY, image.maxY + 0.5)
        XCTAssertLessThanOrEqual(status.maxX, image.minX, "status sits beside the image")
        XCTAssertEqual(failed.pendingDimForRegression.image, 1, accuracy: 0.05, "failed is shown normally with its !")
    }

    // MARK: Jump controls

    func testUpControlRestsInDownSlotAndIsPushedUpOnlyAfterMotionSettles() throws {
        let fx = try makeFixture(total: 80)
        drain(900)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false, "at the newest edge")
        guard fx.vc.automationControlsVisible.up else { throw XCTSkip("no earlier reply to jump to") }
        let rest = fx.vc.automationJumpControlFrames
        XCTAssertEqual(rest.up.maxY, rest.down.maxY, accuracy: 0.5, "↑ sits in ↓'s slot while ↓ is hidden")

        fx.vc.automationTapUp()
        drain(30)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false, "controls keep their state mid-glide")
        XCTAssertEqual(fx.vc.automationControlsVisible.up, true)
        XCTAssertEqual(fx.vc.automationJumpControlFrames.up.maxY, rest.up.maxY, accuracy: 0.5)

        drain(1_800)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, true, "re-evaluated once the glide settles")
        let moved = fx.vc.automationJumpControlFrames
        XCTAssertEqual(moved.down.minY - moved.up.maxY, 8, accuracy: 0.5, "↓ appearing pushes ↑ up")

        fx.vc.automationTapDown()
        drain(1_800)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false)
        XCTAssertEqual(fx.vc.automationJumpControlFrames.up.maxY, moved.down.maxY, accuracy: 0.5, "↑ drops back down")
    }

    func testDictationBoxMinimumReachesTheControlAboveSend() {
        // box bottom → send circle (centred on the one-line row) → 9 pt → 44 pt control
        XCTAssertEqual(IOSComposerMetrics.recordingMinHeight, 2 + 44 + 9 + 44)
    }

    func testVoiceLevelMeterMapsSpeechPeaksAcrossTheBarRange() {
        XCTAssertEqual(VoiceLevelBars.loudness(0), 0)
        XCTAssertEqual(VoiceLevelBars.loudness(0.002), 0, "room noise stays flat")
        let quiet = VoiceLevelBars.loudness(0.03), normal = VoiceLevelBars.loudness(0.15), loud = VoiceLevelBars.loudness(0.6)
        XCTAssertGreaterThan(quiet, 0.3, "ordinary speech peaks visibly move the bars")
        XCTAssertGreaterThan(normal, quiet + 0.2)
        XCTAssertEqual(loud, 1, accuracy: 0.01)
    }

    func testSendFailureKeepsNothingOptimistic() throws {
        let fx = try makeFixture(total: 4) { _ in false }
        drain(300)
        XCTAssertFalse(fx.app.commandSender?.sendInput(sessionId: sid, text: "x") == true)
        XCTAssertTrue(fx.app.commandSender?.pendingInputs(sid).isEmpty == true)
    }

    // MARK: Questions (on the spine)

    /// Tentacle's `ask_user`: an agent_message carrying `question`, lead-in
    /// prose as its content. The router closes the live card on it.
    private func ask(_ fx: Fx, seq: Int, id: String, lead: String = "我看了一下，有两个方案。",
                     choices: [String] = ["A", "B"]) throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "agent_message", "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z",
            "payload": ["content": lead, "question": ["id": id, "text": "选哪个？", "choices": choices]],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: data)
        fx.app.messageStore.endCardTurn(sid)
        fx.vc.syncLiveUpdates()
    }

    private func ingestSpine(_ fx: Fx, _ object: [String: Any]) throws {
        fx.app.messageProvider?.ingestTailCandidate(sid, json: try JSONSerialization.data(withJSONObject: object))
        fx.vc.syncLiveUpdates()
    }

    /// The list row of the question at `seq` (its id carries the drawing
    /// variant: `#q-open`, `#q-user_abort`, or nothing once settled).
    private func questionRow(_ fx: Fx, seq: Int) -> String? {
        fx.vc.automationItemIDs.first { $0 == "\(sid):\(seq)" || $0.hasPrefix("\(sid):\(seq)#q-") }
    }

    func testQuestionIsOneBubbleWithItsLeadInAndIsAnswerable() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try startTurn(fx, seq: 11)
        fx.app.messageStore.applyCardMessage(sid, "我看了一下，有两个方案。", reset: true)
        fx.vc.syncLiveUpdates(); drain(80)
        try ask(fx, seq: 12, id: "q1")
        drain(200)
        XCTAssertFalse(fx.vc.automationItemIDs.contains("__live_card__"), "the draft graduated into the question bubble")
        XCTAssertEqual(questionRow(fx, seq: 12), "\(sid):12#q-open")
        let vm = ChatViewModel(sessionId: sid, appState: fx.app)
        vm.refreshMessageCache()
        XCTAssertEqual(vm.questions.map(\.id), ["q1"])
        let bubble = try XCTUnwrap(vm.displayMessages.first { $0.seq == 12 })
        XCTAssertEqual(bubble.content, "我看了一下，有两个方案。")
        XCTAssertEqual(bubble.frozenCard?.action?.choices, ["A", "B"])
    }

    /// Opening a session whose head only becomes known after its window was
    /// drawn (a cold open: database first, session_list later) must still show
    /// the trailing question as open with the same store revision.
    func testQuestionOpensWhenTheHeadBecomesKnownAfterTheWindow() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try startTurn(fx, seq: 11)
        try ask(fx, seq: 12, id: "q1")
        drain(200)
        let vm = ChatViewModel(sessionId: sid, appState: fx.app)
        // The Tentacle reports a newer head than the loaded window: not at head.
        fx.app.messageProvider?.observeLiveMessageSeq(sid, seq: 40, kind: "test")
        let before = vm.displayMessages(spineRevision: 7).first { $0.seq == 12 }
        XCTAssertNil(before?.frozenCard?.action, "undetermined away from the head")
        // The window catches up to the head without a new store revision.
        fx.app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 12, deviceId: dev)
        let after = vm.displayMessages(spineRevision: 7).first { $0.seq == 12 }
        XCTAssertEqual(after?.frozenCard?.action?.choices, ["A", "B"], "open once the head is known")
    }

    func testPickingAChoiceSendsAUserMessageAndClosesTheQuestion() throws {
        var sent: [[String: Any]] = []
        let fx = try makeFixture(total: 10) { msg in sent.append(msg); return true }
        drain(600)
        try startTurn(fx, seq: 11)
        try ask(fx, seq: 12, id: "q1")
        drain(100)
        XCTAssertTrue(fx.app.commandSender?.answer(sessionId: sid, questionId: "q1", answer: "A") == true)
        let input = try XCTUnwrap(sent.last { $0["type"] as? String == "send_input" }?["payload"] as? [String: Any])
        XCTAssertEqual(input["text"] as? String, "A")
        XCTAssertEqual(input["answerTo"] as? String, "q1")
        fx.vc.syncLiveUpdates(); drain(100)
        XCTAssertEqual(questionRow(fx, seq: 12), "\(sid):12", "choices go away at once")
        XCTAssertTrue(fx.vc.automationItemIDs.contains { $0.contains(":pending:") }, "the answer is the user's own bubble")
        // Tentacle echoes the answer; the turn continues and concludes.
        let clientId = try XCTUnwrap(input["clientId"] as? String)
        fx.app.messageStore.beginCardTurn(sid)
        try ingestSpine(fx, ["type": "user_message", "seq": 13, "sessionId": sid, "deviceId": dev,
                             "timestamp": "2026-09-01T00:00:04.000Z",
                             "payload": ["content": "A", "clientId": clientId, "answerTo": "q1"]])
        fx.app.commandSender?.clearPending(sid, clientId: clientId)
        try land(fx, seq: 14, text: Self.zh)
        drain(200)
        XCTAssertEqual(questionRow(fx, seq: 12), "\(sid):12")
        XCTAssertTrue(fx.vc.automationItemIDs.contains("\(sid):13"))
        XCTAssertTrue(fx.vc.automationItemIDs.contains("\(sid):14"))
        XCTAssertFalse(fx.vc.automationItemIDs.contains { $0.contains(":pending:") })
    }

    /// Tentacle's abort while asking: turn_status(user_abort, no draft), idle.
    /// The list shows one bubble — the question with "User aborted" inside.
    func testAbortWhileAskingShowsUserAbortedInsideTheQuestion() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try startTurn(fx, seq: 11)
        try ask(fx, seq: 12, id: "q1")
        drain(100)
        XCTAssertEqual(fx.vc.automationItemIDs.last, "\(sid):12#q-open")
        try ingestSpine(fx, ["type": "turn_status", "seq": 13, "sessionId": sid, "deviceId": dev,
                             "timestamp": "2026-09-01T00:00:05.000Z",
                             "payload": ["draft": "", "action": ["type": "user_abort", "payload": [String: Any]()]]])
        try ingestSpine(fx, ["type": "idle", "seq": 14, "sessionId": sid, "deviceId": dev,
                             "timestamp": "2026-09-01T00:00:05.000Z", "payload": [String: Any]()])
        drain(200)
        XCTAssertEqual(questionRow(fx, seq: 12), "\(sid):12#q-user_abort")
        XCTAssertFalse(fx.vc.automationItemIDs.contains { $0.hasPrefix("\(sid):13") }, "no separate User aborted bubble")
        let ids = fx.vc.automationItemIDs
        XCTAssertEqual(ids.last, "\(sid):12#q-user_abort", "the question stays the last bubble")
        let vm = ChatViewModel(sessionId: sid, appState: fx.app)
        vm.refreshMessageCache()
        XCTAssertEqual(vm.displayMessages.first { $0.seq == 12 }?.frozenCard?.action?.type, "user_abort")
        XCTAssertTrue(vm.questions.isEmpty, "the composer is no longer in answer mode")
    }

    /// The question text is body text (bold), identical before and after it
    /// is answered; only an open question adds the choice slot.
    func testQuestionTextIsTheSameOpenAndClosed() {
        func m(_ state: QuestionPresentation.State) -> ChatMessage {
            var message = ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: dev, timestamp: nil,
                                      payload: ["content": AnyCodable("有两个方案"),
                                                "question": AnyCodable(["id": "q1", "text": "删旧接口？", "choices": ["删", "留"]])])
            message.questionPresentation = QuestionPresentation(state: state)
            return message
        }
        XCTAssertEqual(m(.open).frozenCard?.text, "有两个方案\n\n**删旧接口？**")
        XCTAssertEqual(m(.answered).frozenCard?.text, m(.open).frozenCard?.text)
        XCTAssertEqual(m(.open).frozenCard?.action?.choices, ["删", "留"])
        XCTAssertNil(m(.answered).frozenCard?.action)
        XCTAssertEqual(m(.unanswered).frozenCard?.text, m(.open).frozenCard?.text)
        XCTAssertEqual(m(.answered).id, m(.unanswered).id, "states that draw the same keep one identity")
        XCTAssertNotEqual(m(.open).id, m(.answered).id)
    }

    /// Choices narrower than the question do not widen the bubble, so it is
    /// the same width open and answered (the choices simply go away).
    func testOpenAndAnsweredQuestionBubblesAreTheSameWidth() {
        func width(_ state: QuestionPresentation.State) -> CGFloat {
            var message = ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: dev, timestamp: nil,
                                      payload: ["content": AnyCodable("I will ask you a question."),
                                                "question": AnyCodable(["id": "q1", "text": "Which color do you prefer?",
                                                                        "choices": ["Red", "Blue"]])])
            message.questionPresentation = QuestionPresentation(state: state)
            let content = TKBubbleContent.live(card: message.frozenCard!, agent: "pi", sessionId: sid,
                                               steps: 0, isFrozen: true)
            return content.bubbleWidth(cellWidth: 402)
        }
        XCTAssertEqual(width(.open), width(.answered), accuracy: 0.5)
    }

    func testFailedAnswerKeepsTheQuestionAnswerable() throws {
        let fx = try makeFixture(total: 4) { msg in (msg["type"] as? String) != "send_input" }
        drain(300)
        try startTurn(fx, seq: 5)
        try ask(fx, seq: 6, id: "q2")
        XCTAssertFalse(fx.app.commandSender?.answer(sessionId: sid, questionId: "q2", answer: "B") == true)
        fx.vc.syncLiveUpdates(); drain(100)
        XCTAssertEqual(questionRow(fx, seq: 6), "\(sid):6#q-open")
    }

    /// Projection keeps a question that an aborted turn's terminal status
    /// follows (terminal segments normally drop their agent_messages).
    func testQuestionSurvivesATerminalTurnStatus() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("user_message", 1, ["content": "迁移接口"]),
            m("agent_message", 2, ["content": "有两个方案", "question": ["id": "q1", "text": "删旧接口？"]]),
            m("agent_message", 3, ["content": "partial"]),
            m("turn_status", 4, ["draft": "", "action": ["type": "user_abort", "payload": ["abortedAt": "x"]]]),
            m("idle", 5, [:]),
        ]
        let presented = ChatViewModel.presentingQuestions(raw, pending: [], atHead: true)
        let projected = TurnSpineProjection.project(presented).filter(ChatViewModel.shouldRender)
        let q = projected.first { $0.seq == 2 }
        XCTAssertEqual(q?.questionPresentation?.state, .unanswered)
        XCTAssertNotNil(projected.first { $0.seq == 4 }, "a terminal card with its own draft still renders")
        XCTAssertNil(q?.frozenCard?.action, "outcome stays on the terminal card that has a draft")
    }

    /// Aborted while asking with nothing streamed after the question: the
    /// "User aborted" outcome sits inside the question bubble (as in a normal
    /// aborted turn) — no separate bubble.
    func testAbortWhileAskingShowsOutcomeInsideTheQuestionBubble() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("user_message", 1, ["content": "迁移接口"]),
            m("agent_message", 2, ["content": "有两个方案", "question": ["id": "q1", "text": "删旧接口？", "choices": ["删"]]]),
            m("turn_status", 3, ["draft": "", "action": ["type": "user_abort", "payload": ["abortedAt": "x"]]]),
            m("idle", 4, [:]),
        ]
        let projected = TurnSpineProjection.project(ChatViewModel.presentingQuestions(raw, pending: [], atHead: true))
            .filter(ChatViewModel.shouldRender)
        XCTAssertNil(projected.first { $0.seq == 3 }, "no separate User aborted bubble")
        let card = projected.first { $0.seq == 2 }?.frozenCard
        XCTAssertEqual(card?.action?.type, "user_abort")
        XCTAssertEqual(card?.text, "有两个方案\n\n**删旧接口？**")
    }

    /// The fallback draft of a draft-less terminal status is the turn's last
    /// output; when that is the question, no older reply is pulled in.
    func testAbortAfterQuestionNeverBorrowsAnOlderReply() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("agent_message", 1, ["content": "上一轮的回复"]),
            m("user_message", 2, ["content": "继续"]),
            m("agent_message", 3, ["content": "", "question": ["id": "q1", "text": "删？"]]),
            m("turn_status", 4, ["draft": "", "action": ["type": "user_abort", "payload": [String: Any]()]]),
            m("idle", 5, [:]),
        ]
        let projected = TurnSpineProjection.project(ChatViewModel.presentingQuestions(raw, pending: [], atHead: true))
            .filter(ChatViewModel.shouldRender)
        XCTAssertEqual(projected.map(\.seq), [2, 3], "no separate bubble, the older reply is not repeated")
        XCTAssertEqual(projected.last?.frozenCard?.action?.type, "user_abort")
    }

    /// An abort card without a draft still fits "User aborted" on one line.
    func testUserAbortedCardFitsOnOneLine() throws {
        let action = ChatMessage(type: "user_abort", seq: 0, sessionId: sid, deviceId: dev, timestamp: nil,
                                 payload: ["abortedAt": AnyCodable("x")])
        let content = TKBubbleContent.live(card: MessageStore.SessionCard(text: "", action: action),
                                           agent: "claude", sessionId: sid, steps: 0, isFrozen: true)
        let width = content.bodyTextWidth(cellWidth: 402)
        let height = TKActionMeasure.height(action: action, width: width)
        XCTAssertLessThan(height, 30, "one line (was wrapped into two)")
    }

    func testTwoOpenQuestionsAnswerIndependently() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("agent_message", 1, ["content": "", "question": ["id": "q1", "text": "一？"]]),
            m("agent_message", 2, ["content": "", "question": ["id": "q2", "text": "二？"]]),
            m("user_message", 3, ["content": "好", "answerTo": "q2"]),
        ]
        let presented = ChatViewModel.presentingQuestions(raw, pending: [], atHead: true)
        XCTAssertEqual(presented[0].questionPresentation?.state, .open)
        XCTAssertEqual(presented[1].questionPresentation?.state, .answered)
        XCTAssertEqual(ChatViewModel.presentingQuestions(raw, pending: [], atHead: false)[0].questionPresentation?.state,
                       .undetermined)
    }

    // MARK: Navigation controls

    func testUpStepsThroughReplyStartsAndDownShowsAwayFromBottom() throws {
        let fx = try makeFixture(total: 120)
        drain(1_500)
        XCTAssertFalse(fx.vc.automationControlsVisible.down, "↓ hidden at the conversation bottom")
        var previousIndex = Int.max
        for _ in 0..<5 {
            let target = try XCTUnwrap(fx.vc.automationUpTargetItem)
            let id = fx.vc.automationItemIDs[target]
            let type = fx.app.messageStore.currentWindow(sid).first { "\(sid):\($0.seq)" == id }?.type
            XCTAssertEqual(type, "agent_message", "↑ targets AI replies only")
            XCTAssertLessThan(target, previousIndex, "each ↑ steps further back")
            previousIndex = target
            let before = fx.vc.automationControlsVisible
            fx.vc.automationTapUp()
            XCTAssertTrue(fx.vc.automationControlsVisible == before,
                          "controls keep their pre-glide state during the glide")
            drain(1_500)
            let frame = try XCTUnwrap(fx.cv.layoutAttributesForItem(at: IndexPath(item: target, section: 0))?.frame)
            XCTAssertEqual(frame.minY - fx.cv.contentOffset.y, 124, accuracy: 2, "lands at the reply start")
        }
        XCTAssertTrue(fx.vc.automationControlsVisible.down, "↓ shown whenever not at the bottom")

        // New content while away is counted on ↓.
        let arrival = try JSONSerialization.data(withJSONObject: [
            "type": "agent_message", "seq": 121, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:05.000Z", "payload": ["content": "新的回复"],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: arrival)
        fx.vc.syncLiveUpdates()
        XCTAssertEqual(fx.vc.automationUnseenArrivals, 1)
        XCTAssertTrue(fx.vc.automationUnseenDotVisible, "unseen reply shows as a red dot (no count)")
        let round = fx.vc.automationJumpControlSizes
        XCTAssertEqual(round.down, CGSize(width: 44, height: 44), "↓ is a 44pt circle even with a count")
        XCTAssertEqual(round.up, CGSize(width: 44, height: 44))
        fx.vc.automationTapDown()
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
        XCTAssertEqual(fx.vc.automationUnseenArrivals, 0)
        XCTAssertFalse(fx.vc.automationUnseenDotVisible)
        XCTAssertFalse(fx.vc.automationControlsVisible.down)
    }
}

/// End-to-end gate for the new-Session journey through production
/// MainTabView / NavigationStack / SessionDetailView / ChatView with a
/// scripted offline Tentacle (see IOSNewSessionScenario).
@MainActor
final class NewSessionJourneyTests: XCTestCase {
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
