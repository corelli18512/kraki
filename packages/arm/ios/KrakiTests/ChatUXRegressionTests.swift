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

    func testSendFailureKeepsNothingOptimistic() throws {
        let fx = try makeFixture(total: 4) { _ in false }
        drain(300)
        XCTAssertFalse(fx.app.commandSender?.sendInput(sessionId: sid, text: "x") == true)
        XCTAssertTrue(fx.app.commandSender?.pendingInputs(sid).isEmpty == true)
    }

    // MARK: Questions

    private func question(_ id: String, answer: String? = nil) -> ChatMessage {
        var payload: [String: AnyCodable] = [
            "id": AnyCodable(id), "question": AnyCodable("选哪个？"),
            "choices": AnyCodable(["A", "B"]),
        ]
        if let answer { payload["answer"] = AnyCodable(answer) }
        return ChatMessage(type: "question", seq: 0, sessionId: sid, deviceId: dev, timestamp: nil, payload: payload)
    }

    func testAnsweredQuestionStaysVisibleUntilReplyArrives() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try startTurn(fx, seq: 11)
        let store = fx.app.messageStore
        store.applyCardAction(sid, question("q1"))
        fx.vc.syncLiveUpdates(); drain(100)
        XCTAssertTrue(fx.vc.automationItemIDs.contains("__live_card__"))

        XCTAssertTrue(fx.app.commandSender?.answer(sessionId: sid, questionId: "q1", answer: "A") == true)
        XCTAssertEqual(store.cards[sid]?.action?.answer, "A", "answer shows immediately")
        XCTAssertEqual(store.cards[sid]?.action?.payload["localPending"]?.boolValue, true)

        // Tentacle confirms, then retires the settled prompt BEFORE the first
        // narration delta (card-manager onDelta order).
        store.applyCardAction(sid, question("q1", answer: "A"))
        store.applyCardAction(sid, nil)
        fx.vc.syncLiveUpdates(); drain(50)
        XCTAssertTrue(fx.vc.automationItemIDs.contains("__live_card__"),
                      "the live bubble must not disappear between the answer and the reply")
        store.applyCardMessage(sid, "好的，继续。", reset: false)
        fx.vc.syncLiveUpdates(); drain(50)
        XCTAssertNil(store.cards[sid]?.action, "narration supersedes the retained prompt")
        XCTAssertEqual(store.cards[sid]?.text, "好的，继续。")
    }

    func testAnsweredQuestionKeepsPreviousNarrationContextUntilReplacement() throws {
        let fx = try makeFixture(total: 10)
        drain(600)
        try startTurn(fx, seq: 11)
        let store = fx.app.messageStore
        store.applyCardMessage(sid, "我先确认一下签名方式。", reset: false)
        store.applyCardAction(sid, question("q9"))
        fx.vc.syncLiveUpdates(); drain(100)
        XCTAssertTrue(fx.app.commandSender?.answer(sessionId: sid, questionId: "q9", answer: "A") == true)
        store.applyCardAction(sid, question("q9", answer: "A"))
        // Tentacle: settled-tail null, then the replacing reset delta.
        store.applyCardAction(sid, nil)
        XCTAssertEqual(store.cards[sid]?.action?.answer, "A",
                       "the answered question must not be stripped, exposing only the old narration")
        XCTAssertEqual(store.cards[sid]?.text, "我先确认一下签名方式。")
        store.applyCardMessage(sid, "好的，用 API Key 签名。", reset: true)
        XCTAssertNil(store.cards[sid]?.action)
        XCTAssertEqual(store.cards[sid]?.text, "好的，用 API Key 签名。")
        // A tool also supersedes a retained prompt.
        store.applyCardAction(sid, question("q10", answer: "B"))
        store.applyCardAction(sid, nil)
        store.applyCardAction(sid, ChatMessage(type: "tool_start", seq: 0, sessionId: sid, deviceId: dev,
                                               timestamp: nil, payload: ["toolName": AnyCodable("bash")]))
        XCTAssertEqual(store.cards[sid]?.action?.type, "tool_start")
    }

    /// Sending, echo and landing must not reload the list: visible cells keep
    /// their identity (no re-dequeue flash), and bubble backgrounds never run
    /// an implicit color/shape animation.
    func testSendEchoAndLandingKeepVisibleCellsInPlace() throws {
        let fx = try makeFixture(total: 30)
        drain(1_000)
        func cellsByID() -> [String: ObjectIdentifier] {
            var map: [String: ObjectIdentifier] = [:]
            for cell in fx.cv.visibleCells.compactMap({ $0 as? TKBubbleCell }) {
                if let id = cell.contentSnapshot?.message.id { map[id] = ObjectIdentifier(cell) }
            }
            return map
        }
        func assertNoBackgroundAnimations(_ label: String) {
            for cell in fx.cv.visibleCells.compactMap({ $0 as? TKBubbleCell }) {
                XCTAssertTrue(cell.bubbleBackgroundAnimationKeysForRegression.isEmpty,
                              "\(label): bubble background animating \(cell.bubbleBackgroundAnimationKeysForRegression)")
            }
        }
        assertNoBackgroundAnimations("entry")
        let before = cellsByID()
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "新消息"))
        fx.vc.syncLiveUpdates()
        let afterSend = cellsByID()
        for (id, cell) in before where afterSend[id] != nil {
            XCTAssertEqual(afterSend[id], cell, "send must not re-dequeue existing row \(id)")
        }
        assertNoBackgroundAnimations("send")
        let pending = try XCTUnwrap(sender.pendingInputs(sid).first)
        let pendingCell = try XCTUnwrap(afterSend[pending.id])
        let clientId = try XCTUnwrap(pending.payload["clientId"]?.stringValue)
        let echo = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 31, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": ["content": "新消息", "clientId": clientId],
        ])
        fx.app.messageStore.beginCardTurn(sid)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: echo)
        sender.clearPending(sid, clientId: clientId)
        fx.vc.syncLiveUpdates()
        XCTAssertEqual(cellsByID()["\(sid):31"], pendingCell, "echo must reuse the optimistic bubble's cell")
        assertNoBackgroundAnimations("echo")

        fx.app.messageStore.applyCardMessage(sid, "回复内容", reset: false)
        fx.vc.syncLiveUpdates(); drain(100)
        let liveCell = fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
            .first { $0.contentSnapshot?.isLive == true }
        try land(fx, seq: 32, text: "回复内容")
        XCTAssertNotNil(liveCell)
        XCTAssertEqual(cellsByID()["\(sid):32"], liveCell.map(ObjectIdentifier.init),
                       "landing must reuse the live bubble's cell")
        assertNoBackgroundAnimations("landing")
    }

    /// A rendered cell that is reused for another Session's bubble (or re-
    /// resolved for its trait) must switch color/shape immediately, without the
    /// shape layer's implicit fade.
    func testReusedBubbleBackgroundChangesWithoutImplicitAnimation() throws {
        // Must be a scene-attached window: layers of a scene-less window are
        // never committed to the render tree and never animate implicitly.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.makeKeyAndVisible()
        windows.append(window)
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 100, width: 402, height: 120))
        window.addSubview(cell)
        func content(_ session: String, _ text: String) -> TKBubbleContent {
            TKBubbleContent.make(message: ChatMessage(type: "agent_message", seq: 1, sessionId: session, deviceId: dev,
                                                      timestamp: nil, payload: ["content": AnyCodable(text)]),
                                 sessionId: session, agent: "claude")
        }
        cell.configure(content("session-a", "第一条"), cellWidth: 402)
        cell.layoutIfNeeded()
        CATransaction.flush()
        drain(400) // rendered and settled
        let first = cell.bubbleFillForRegression
        cell.prepareForReuse()
        cell.configure(content("session-zz-different-hue", "第二条，更长一些的内容，让形状也变化"), cellWidth: 402)
        cell.frame.size.height = 160
        cell.layoutIfNeeded()
        XCTAssertNotEqual(cell.bubbleFillForRegression, first)
        XCTAssertTrue(cell.bubbleBackgroundAnimationKeysForRegression.isEmpty,
                      "reused bubble animated: \(cell.bubbleBackgroundAnimationKeysForRegression)")
    }

    func testAnswerTransportFailureRevertsWithError() throws {
        let fx = try makeFixture(total: 4) { msg in (msg["type"] as? String) != "answer" }
        drain(300)
        try startTurn(fx, seq: 5)
        fx.app.messageStore.applyCardAction(sid, question("q2"))
        XCTAssertFalse(fx.app.commandSender?.answer(sessionId: sid, questionId: "q2", answer: "B") == true)
        let action = try XCTUnwrap(fx.app.messageStore.cards[sid]?.action)
        XCTAssertNil(action.answer, "failed answer must return the question to answerable")
        XCTAssertNotNil(action.payload["localError"]?.stringValue)
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
            fx.vc.automationTapUp()
            XCTAssertFalse(fx.vc.automationControlsVisible.up || fx.vc.automationControlsVisible.down,
                           "controls hide during the glide")
            drain(1_500)
            let frame = try XCTUnwrap(fx.cv.layoutAttributesForItem(at: IndexPath(item: target, section: 0))?.frame)
            XCTAssertEqual(frame.minY - fx.cv.contentOffset.y, 118, accuracy: 2, "lands at the reply start")
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
        fx.vc.automationTapDown()
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
        XCTAssertEqual(fx.vc.automationUnseenArrivals, 0)
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
