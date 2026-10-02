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
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

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

    static let zh = "\u{597D}\u{7684}\u{FF0C}\u{6211}\u{6765}\u{5E2E}\u{4F60}\u{770B}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{95EE}\u{9898}\u{3002}\u{9996}\u{5148}\u{6211}\u{4EEC}\u{9700}\u{8981}\u{786E}\u{8BA4}\u{670D}\u{52A1}\u{7AEF}\u{7684}\u{914D}\u{7F6E}\u{662F}\u{5426}\u{6B63}\u{786E}\u{FF0C}\u{7136}\u{540E}\u{518D}\u{68C0}\u{67E5}\u{5BA2}\u{6237}\u{7AEF}\u{7684}\u{7F51}\u{7EDC}\u{8BF7}\u{6C42}\u{662F}\u{5426}\u{5E26}\u{4E0A}\u{4E86}\u{6B63}\u{786E}\u{7684}\u{9274}\u{6743}\u{5934}\u{3002}\u{5982}\u{679C}\u{4E24}\u{8FB9}\u{90FD}\u{6CA1}\u{6709}\u{95EE}\u{9898}\u{FF0C}\u{90A3}\u{5F88}\u{53EF}\u{80FD}\u{662F}\u{7F13}\u{5B58}\u{5BFC}\u{81F4}\u{7684}\u{FF0C}\u{5EFA}\u{8BAE}\u{5148}\u{6E05}\u{4E00}\u{4E0B}\u{672C}\u{5730}\u{7F13}\u{5B58}\u{518D}\u{91CD}\u{8BD5}\u{3002}"
    static let en = "Sure — I checked the relay configuration and the client request path. Both look correct, so the stale state is most likely coming from the local cache layer; clearing it and retrying should confirm."
    static let code = "\u{8FD9}\u{662F}\u{4FEE}\u{6539}\u{540E}\u{7684}\u{4EE3}\u{7801}\u{FF1A}\n\n```swift\nfunc load() async throws {\n    let url = URL(string: base)!\n    var req = URLRequest(url: url)\n    req.setValue(token, forHTTPHeaderField: \"Auth\")\n    let (data, _) = try await session.data(for: req)\n    cache.store(data)\n    try decode(data)\n}\n```\n\n\u{6539}\u{5B8C}\u{540E}\u{91CD}\u{65B0}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}\u{3002}"
    static let list = "\u{4E3B}\u{8981}\u{6539}\u{52A8}\u{FF1A}\n\n1. \u{4FEE}\u{590D}\u{767B}\u{5F55}\u{6001}\u{8FC7}\u{671F}\n2. \u{4F18}\u{5316}\u{5217}\u{8868}\u{6EDA}\u{52A8}\n3. \u{65B0}\u{589E}\u{91CD}\u{8BD5}\u{903B}\u{8F91}\n4. \u{5220}\u{9664}\u{65E7}\u{63A5}\u{53E3}\n5. \u{66F4}\u{65B0}\u{6587}\u{6863}\n\n- \u{98CE}\u{9669}\u{FF1A}\u{4F4E}\n- \u{9700}\u{8981}\u{56DE}\u{5F52}\u{FF1A}\u{662F}"
    static let table = "| \u{6307}\u{6807} | \u{4E4B}\u{524D} | \u{4E4B}\u{540E} |\n|---|---|---|\n| \u{51B7}\u{542F}\u{52A8} | 1.8s | 0.9s |\n| \u{9996}\u{5C4F} | 620ms | 310ms |\n| \u{6389}\u{5E27} | 12% | 2% |"
    static let user = "\u{5E2E}\u{6211}\u{770B}\u{770B}\u{4E3A}\u{4EC0}\u{4E48}\u{5217}\u{8868}\u{6EDA}\u{52A8}\u{7684}\u{65F6}\u{5019}\u{4F1A}\u{8DF3}\u{FF0C}\u{5C24}\u{5176}\u{662F}\u{5F80}\u{4E0A}\u{7FFB}\u{5386}\u{53F2}\u{6D88}\u{606F}\u{7684}\u{65F6}\u{5019}"

    static func body(_ seq: Int) -> (type: String, text: String) {
        if seq % 2 == 1 { return ("user_message", [user, "\u{597D}\u{7684}", "\u{7EE7}\u{7EED}", en][seq / 2 % 4]) }
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

    /// `onScreen`: attach the window to the simulator's real UIWindowScene so
    /// Core Animation actually renders (needed to sample presentation layers;
    /// a scene-less window never composites and finishes animations at once).
    private func makeFixture(total: Int, onScreen: Bool = false,
                             outbound: (([String: Any]) -> Bool)? = nil) throws -> Fx {
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
            state: .idle, mode: .auto, lastSeq: total, readSeq: total, messageCount: total,
            createdAt: Date(), pinned: false)
        app.deviceStore.devices[dev] = DeviceSummary(
            id: dev, name: "gate", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { msg, _, _ in outbound?(msg) ?? true }
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: total, deviceId: dev)
        _ = app.messageStore.loadInitialWindow(sid)
        let vc = ChatPerfListVC(sessionId: sid, appState: app, agent: "claude", bottomContentInset: 54)
        let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        let window: UIWindow
        if onScreen, let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            window = UIWindow(windowScene: scene)
            window.frame = frame
            window.windowLevel = .alert + 1
        } else {
            window = UIWindow(frame: frame)
        }
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
            "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "\u{7EE7}\u{7EED}"],
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
        for i in 1...14 { rowsText += "| \u{6307}\u{6807}\(i) | \u{8986}\u{76D6}\u{8BBE}\u{5907} iOS\u{3001}Android \u{4EE5}\u{53CA}\u{66F4}\u{591A}\u{5E73}\u{53F0} \(i) |\n" }
        let full = Self.zh + "\n\n" + Self.zh + "\n\n| \u{9879}\u{76EE} | \u{8BF4}\u{660E} |\n|---|---|\n" + rowsText
            + "\n**H5 \u{548C}\u{5C0F}\u{7A0B}\u{5E8F}\u{4E5F}\u{80FD}\u{505A}\u{7CBE}\u{81F4}\u{3002}** \u{6700}\u{7EC8}\u{5DEE}\u{5F02}\u{4ECD}\u{662F}\u{8BBE}\u{8BA1}\u{4E0E}\u{5B9E}\u{73B0}\u{8D28}\u{91CF}\u{3002}\n\n## \u{4E3A}\u{4EC0}\u{4E48}\u{504F}\u{5411}\u{539F}\u{751F}\n\n" + Self.list + "\n\n" + Self.zh
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
        try requireNativePerformanceTests()
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
        try requireNativePerformanceTests()
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
        try requireNativePerformanceTests()
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

    // MARK: New bubble entrance (Mac parity)

    private func entranceAnimation(_ fx: Fx, id: String) -> CAAnimationGroup? {
        guard let index = fx.vc.automationItemIDs.firstIndex(of: id),
              let cell = fx.cv.cellForItem(at: IndexPath(item: index, section: 0)) else { return nil }
        return cell.layer.animation(forKey: "kraki.entrance") as? CAAnimationGroup
    }

    private func slideFrom(_ group: CAAnimationGroup?) -> CGFloat? {
        let slide = group?.animations?.first { ($0 as? CABasicAnimation)?.keyPath == "transform.translation.x" } as? CABasicAnimation
        return (slide?.fromValue as? NSNumber).map { CGFloat($0.doubleValue) }
    }

    /// Each new bubble enters once from its own side while the list glides up;
    /// pending → echo and live → landed are replacements, not new bubbles.
    func testNewBubblesSlideInFromTheirSideOnce() throws {
        let fx = try makeFixture(total: 60, onScreen: true)
        drain(1_000)
        XCTAssertTrue(fx.vc.entranceLog.isEmpty, "session entry has no entrances")

        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "\u{5E2E}\u{6211}\u{518D}\u{770B}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{95EE}\u{9898}"))
        fx.vc.returnToNewestAfterLocalSubmit()
        let pendingID = try XCTUnwrap(fx.vc.automationItemIDs.last)
        XCTAssertTrue(pendingID.contains(":pending:"))
        XCTAssertEqual(fx.vc.entranceLog.map(\.id), [pendingID])
        XCTAssertEqual(fx.vc.entranceLog.last?.fromTrailing, true, "the user's bubble enters from the right")
        XCTAssertEqual(slideFrom(entranceAnimation(fx, id: pendingID)), 48)
        XCTAssertEqual(fx.vc.arrivalGlideLog.count, 1, "the list glides up to make room")
        XCTAssertGreaterThan(fx.vc.arrivalGlideLog.last ?? 0, 20)
        XCTAssertNotNil(fx.cv.layer.animation(forKey: "kraki.arrivalGlide"))
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1, "the real offset is pinned at once")
        // Rendered motion, sampled from the presentation layers: the bubble
        // slides left into place and the list settles upward, monotonically.
        let pendingCell = try XCTUnwrap(fx.vc.automationItemIDs.firstIndex(of: pendingID)
            .flatMap { fx.cv.cellForItem(at: IndexPath(item: $0, section: 0)) })
        var slideX: [CGFloat] = [], glideY: [CGFloat] = []
        for _ in 0..<30 {
            drain(16)
            slideX.append(pendingCell.layer.presentation()?.transform.m41 ?? 0)
            glideY.append(fx.cv.layer.presentation()?.sublayerTransform.m42 ?? 0)
        }
        XCTAssertGreaterThan(slideX.first ?? 0, 5, "the bubble starts offset to the right")
        XCTAssertEqual(slideX.last ?? 1, 0, accuracy: 0.5)
        XCTAssertTrue(zip(slideX, slideX.dropFirst()).allSatisfy { $1 <= $0 + 0.01 }, "slide is monotonic: \(slideX)")
        XCTAssertGreaterThan(glideY.first ?? 0, 5, "the list starts below and glides up")
        XCTAssertEqual(glideY.last ?? 1, 0, accuracy: 0.5)
        XCTAssertTrue(zip(glideY, glideY.dropFirst()).allSatisfy { $1 <= $0 + 0.01 }, "glide never steps back: \(glideY)")
        drain(100)

        let clientId = try XCTUnwrap(sender.pendingInputs(sid).last?.payload["clientId"]?.stringValue)
        fx.app.messageStore.beginCardTurn(sid)
        try ingestSpine(fx, ["type": "user_message", "seq": 61, "sessionId": sid, "deviceId": dev,
                             "timestamp": "2026-09-01T00:00:05.000Z",
                             "payload": ["content": "\u{5E2E}\u{6211}\u{518D}\u{770B}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{95EE}\u{9898}", "clientId": clientId]])
        drain(300)
        XCTAssertEqual(fx.vc.entranceLog.count, 1, "the echo replaces the pending bubble without a second entrance")

        fx.app.messageStore.applyCardMessage(sid, "\u{597D}\u{7684}\u{FF0C}\u{6211}\u{5148}\u{770B}\u{4E00}\u{4E0B}\u{76F8}\u{5173}\u{4EE3}\u{7801}\u{3002}", reset: false)
        fx.vc.syncLiveUpdates()
        XCTAssertEqual(fx.vc.entranceLog.count, 2)
        XCTAssertEqual(fx.vc.entranceLog.last?.id, "__live_card__")
        XCTAssertEqual(fx.vc.entranceLog.last?.fromTrailing, false, "the AI bubble enters from the left")
        XCTAssertEqual(slideFrom(entranceAnimation(fx, id: "__live_card__")), -48)
        XCTAssertEqual(fx.vc.arrivalGlideLog.count, 2)
        var worstHidden: CGFloat = 0, downShown = fx.vc.automationControlsVisible.down
        for k in 0..<20 {
            fx.app.messageStore.applyCardMessage(sid, "\u{7B2C}\(k)\u{6BB5}\u{8865}\u{5145}\u{8BF4}\u{660E}\u{FF0C}\u{8BA9}\u{56DE}\u{590D}\u{7EE7}\u{7EED}\u{53D8}\u{957F}\u{3002}", reset: false)
            fx.vc.syncLiveUpdates()
            drain(33)
            worstHidden = max(worstHidden, hiddenBelowComposer(fx.cv))
            downShown = downShown || fx.vc.automationControlsVisible.down
        }
        XCTAssertEqual(fx.vc.entranceLog.count, 2, "the reply enters once, not per token")
        XCTAssertFalse(downShown, "a reply arriving at the followed bottom never flashes ↓")
        XCTAssertTrue(fx.vc.automationControlsVisible.up, "an AI reply is newest: ↑ in the low slot")
        XCTAssertLessThanOrEqual(worstHidden, 1, "the streaming reply stays followed during and after the glide")

        try land(fx, seq: 62, text: Self.zh + Self.zh)
        drain(500)
        XCTAssertEqual(fx.vc.entranceLog.count, 2, "landing the answer is not a new bubble")
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
    }

    func testCatchUpBurstAndOlderHistoryDoNotAnimate() throws {
        let fx = try makeFixture(total: 120)
        drain(1_000)
        let sender = try XCTUnwrap(fx.app.commandSender)
        for text in ["\u{4E00}", "\u{4E8C}", "\u{4E09}"] { XCTAssertTrue(sender.sendInput(sessionId: sid, text: text)) }
        fx.vc.syncLiveUpdates()
        drain(300)
        XCTAssertTrue(fx.vc.entranceLog.isEmpty, "three rows at once are a catch-up, not a conversation beat")
        XCTAssertTrue(fx.vc.arrivalGlideLog.isEmpty)

        fx.vc.scrollViewWillBeginDragging(fx.cv)
        for _ in 0..<40 {
            fx.cv.contentOffset.y -= 200
            fx.vc.scrollViewDidScroll(fx.cv)
            drain(16)
        }
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
        drain(1_500)
        XCTAssertTrue(fx.vc.entranceLog.isEmpty, "older pages never animate")
    }

    // MARK: Send keeps the bottom; ↑/↓ rules (Mac #330 parity)

    private func scrollUp(_ fx: Fx, by distance: CGFloat) {
        fx.vc.automationUserScrollActive = true
        defer { fx.vc.automationUserScrollActive = false }
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        var moved: CGFloat = 0
        while moved < distance {
            fx.cv.contentOffset.y -= 200; moved += 200
            fx.vc.scrollViewDidScroll(fx.cv)
            drain(16)
        }
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
    }

    private func submit(_ fx: Fx, _ text: String) {
        _ = fx.app.commandSender?.sendInput(sessionId: sid, text: text)
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
    }

    /// Sending while an answer streams keeps following the growing reply.
    func testSendDuringStreamingKeepsFollowingTheBottom() throws {
        let fx = try makeFixture(total: 60)
        drain(1_000)
        try startTurn(fx, seq: 61)
        let chars = Array(Self.longAnswer(2_500))
        var i = 0, sent = false, worst: CGFloat = 0
        var sentAt = CACurrentMediaTime()
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 30, chars.count)]), reset: false)
            i += 30
            fx.vc.syncLiveUpdates()
            if !sent, i > 900 { submit(fx, "\u{5148}\u{505C}\u{4E00}\u{4E0B}\u{FF0C}\u{6362}\u{4E2A}\u{65B9}\u{5411}\u{3002}"); sent = true; sentAt = CACurrentMediaTime() }
            drain(33)
            if sent, CACurrentMediaTime() - sentAt > 0.45 { worst = max(worst, distanceToBottom(fx.cv)) }
        }
        drain(600)
        XCTAssertLessThanOrEqual(worst, 1, "after the send the Chat keeps following the streaming reply")
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
        XCTAssertFalse(fx.vc.automationControlsVisible.down)
    }

    /// Scrolling away after a send stops following; the reader's place is kept.
    func testUserScrollAfterSendStopsFollowing() throws {
        let fx = try makeFixture(total: 60)
        drain(1_000)
        submit(fx, "\u{7EE7}\u{7EED}")
        drain(700)
        try startTurn(fx, seq: 61)
        scrollUp(fx, by: 600)
        drain(500)
        let offset = fx.cv.contentOffset.y
        for k in 0..<30 {
            fx.app.messageStore.applyCardMessage(sid, "\u{7B2C}\(k)\u{6BB5}\u{FF1A}\u{7EE7}\u{7EED}\u{8865}\u{5145}\u{4E00}\u{4E9B}\u{8BF4}\u{660E}\u{6587}\u{5B57}\u{FF0C}\u{8BA9}\u{56DE}\u{590D}\u{53D8}\u{957F}\u{3002}", reset: false)
            fx.vc.syncLiveUpdates()
            drain(33)
        }
        drain(400)
        XCTAssertEqual(fx.cv.contentOffset.y, offset, accuracy: 1, "the reader's position is kept")
        XCTAssertGreaterThan(distanceToBottom(fx.cv), 200)
        XCTAssertTrue(fx.vc.automationControlsVisible.down)
    }

    /// Controls never ride over the message being sent. At the bottom ↑ is
    /// hidden while the newest item is the user's own message and is shown
    /// (in ↓'s slot, below the last bubble) once an AI reply is newest.
    func testSendHidesControlsAndUpFollowsTheLatestItem() throws {
        let fx = try makeFixture(total: 60)
        drain(1_000)
        scrollUp(fx, by: 2_400)
        drain(900)
        XCTAssertTrue(fx.vc.automationControlsVisible.down)
        submit(fx, "\u{4E0A}\u{9762}\u{90A3}\u{4E2A}\u{95EE}\u{9898}\u{6211}\u{518D}\u{8865}\u{5145}\u{4E00}\u{4E0B}\u{3002}")
        XCTAssertFalse(fx.vc.automationControlsVisible.down, "↓ leaves as soon as the send starts")
        XCTAssertFalse(fx.vc.automationControlsVisible.up, "↑ does not cover the message being sent")
        var covered = 0
        for _ in 0..<60 {
            drain(10)
            let frames = fx.vc.automationControlFrames, visible = fx.vc.automationControlsVisible
            for cell in fx.cv.visibleCells.compactMap({ $0 as? TKBubbleCell })
            where cell.contentSnapshot?.message.type == "pending_input" {
                let bubble = cell.convert(cell.bounds, to: fx.vc.view)
                if (visible.up && bubble.intersects(frames.up)) || (visible.down && bubble.intersects(frames.down)) { covered += 1 }
            }
        }
        XCTAssertEqual(covered, 0, "no control overlaps the sent bubble during the glide")
        drain(800)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
        XCTAssertFalse(fx.vc.automationControlsVisible.up, "latest is the user's message: no ↑ at the bottom")
        let clientId = fx.app.commandSender?.pendingInputs(sid).last?.payload["clientId"]?.stringValue ?? ""
        fx.app.messageStore.beginCardTurn(sid)
        try ingestSpine(fx, ["type": "user_message", "seq": 61, "sessionId": sid, "deviceId": dev,
                             "timestamp": "2026-09-01T00:00:05.000Z",
                             "payload": ["content": "\u{4E0A}\u{9762}\u{90A3}\u{4E2A}\u{95EE}\u{9898}\u{6211}\u{518D}\u{8865}\u{5145}\u{4E00}\u{4E0B}\u{3002}", "clientId": clientId]])
        drain(400)
        XCTAssertFalse(fx.vc.automationControlsVisible.up, "still the user's message after its echo")
        try land(fx, seq: 62, text: Self.zh)
        drain(900)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1)
        XCTAssertTrue(fx.vc.automationControlsVisible.up, "an AI reply is newest: ↑ is available at the bottom")
        XCTAssertFalse(fx.vc.automationControlsVisible.down)
        let frames = fx.vc.automationControlFrames
        XCTAssertEqual(frames.up.minY, frames.down.minY, accuracy: 0.5, "↑ rests in ↓'s slot")
        // At the bottom ↑ rests in ↓'s slot. It may cover the trailing corner
        // of a full-width AI reply (accepted); it never covers a user bubble.
        for cell in fx.cv.visibleCells.compactMap({ $0 as? TKBubbleCell })
        where ["user_message", "pending_input"].contains(cell.contentSnapshot?.message.type ?? "") {
            XCTAssertFalse(cell.convert(cell.bubbleFrameForRegression, to: fx.vc.view).intersects(frames.up))
        }
    }

    func testSendReturnsToNewestAndKeepsOrder() throws {
        let fx = try makeFixture(total: 80)
        drain(1_000)
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        fx.cv.contentOffset.y -= 2_400
        fx.vc.scrollViewDidScroll(fx.cv)
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
        drain(600)
        XCTAssertGreaterThan(distanceToBottom(fx.cv), 1_000)
        for text in ["\u{7B2C}\u{4E00}\u{6761}", "\u{7B2C}\u{4E8C}\u{6761}", "\u{7B2C}\u{4E09}\u{6761}"] {
            XCTAssertTrue(fx.app.commandSender?.sendInput(sessionId: sid, text: text) == true)
        }
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1, "sending returns to the newest edge")
        let visible = rows(fx.cv).map(\.id).filter { $0.contains(":pending:") }
        XCTAssertEqual(visible.count, 3, "all optimistic messages visible after sending")
        let order = fx.app.commandSender?.pendingInputs(sid).compactMap(\.content)
        XCTAssertEqual(order, ["\u{7B2C}\u{4E00}\u{6761}", "\u{7B2C}\u{4E8C}\u{6761}", "\u{7B2C}\u{4E09}\u{6761}"])
    }

    func testPendingDeliveryStateRemainsUnconfirmedRetriesAndDeduplicates() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let pending = try XCTUnwrap(sender.pendingInputs(sid).first)
        XCTAssertEqual(sender.pendingState(pending), .sending)
        drain(600)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed,
                       "missing echo cannot prove delivery failure")
        XCTAssertEqual(sends, 2, "one silent same-clientId resend halfway through the window")
        fx.vc.syncLiveUpdates()
        drain(100)
        let failedCell = fx.cv.visibleCells.compactMap { $0 as? TKBubbleCell }
            .first { $0.contentSnapshot?.message.type == "pending_input" }
        XCTAssertEqual(failedCell?.deliveryStatusForRegression, "Awaiting confirmation. Tap to retry",
                       "the visible bubble must state uncertainty, not false failure")
        let clientId = try XCTUnwrap(pending.payload["clientId"]?.stringValue)
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: clientId))
        XCTAssertEqual(sends, 3, "retry resends with the same clientId")
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

    // MARK: Send summaries (send.summary)

    func testSendSummaryRecordsTheWholeDeliveryJourney() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "hello"))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        drain(600) // silent resend, then shown unconfirmed
        XCTAssertTrue(fx.app.sendMetrics.summaries.isEmpty, "still in flight")
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: clientId))
        drain(50)
        sender.clearPending(sid, clientId: clientId) // the echo landed

        let summary = try XCTUnwrap(fx.app.sendMetrics.summaries.last)
        XCTAssertEqual(summary.kind, .typed)
        XCTAssertEqual(summary.outcome, .delivered)
        XCTAssertEqual(summary.shown, .unconfirmed)
        XCTAssertEqual(summary.cause, "stalled")
        XCTAssertEqual(summary.autoResends, 1)
        XCTAssertEqual(summary.manualRetries, 1)
        XCTAssertFalse(summary.falseAlarm, "the user had to retry")
        XCTAssertGreaterThan(summary.shownMs, 0)
        XCTAssertGreaterThan(try XCTUnwrap(summary.confirmMs), 400)
        XCTAssertEqual(summary.textLength, 5)
    }

    func testSendSummaryForAVoiceInputWhoseCorrectionFailedAndWasDeleted() throws {
        let fx = try makeFixture(total: 10) { _ in true }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "spoken words"))
        sender.failStagedInput(sessionId: sid, clientId: clientId, text: "spoken words")
        drain(50)
        sender.discardPending(sessionId: sid, clientId: clientId)

        let summary = try XCTUnwrap(fx.app.sendMetrics.summaries.last)
        XCTAssertEqual(summary.kind, .voice)
        XCTAssertEqual(summary.outcome, .deleted)
        XCTAssertEqual(summary.shown, .failed)
        XCTAssertEqual(summary.cause, "correction")
        XCTAssertNil(summary.confirmMs)
        XCTAssertEqual(fx.app.sendMetrics.summaries.count, 1, "deleting then clearing is one record")
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
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}"))
        XCTAssertTrue(sent.isEmpty, "a correcting voice message has not been transmitted")
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .correcting)
        fx.vc.syncLiveUpdates(); drain(150)
        XCTAssertEqual(pendingCell(fx)?.deliveryStatusForRegression, "Correcting transcript before sending")
        let before = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })

        // Correction streams in and grows the bubble; its row must stay exact.
        let long = String(repeating: "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{9519}\u{8BEF}\u{63D0}\u{793A}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{FF0C}\u{5E76}\u{68C0}\u{67E5}\u{6CE8}\u{518C}\u{6D41}\u{7A0B}\u{91CC}\u{90AE}\u{7BB1}\u{6821}\u{9A8C}\u{7684}\u{8FB9}\u{754C}\u{60C5}\u{51B5}\u{3002}", count: 4)
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: long)
        fx.vc.syncLiveUpdates(); drain(150)
        let after = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })
        XCTAssertGreaterThan(after.h, before.h + 20)
        XCTAssertEqual(after.h, after.exact, accuracy: 1, "streamed correction keeps an exact row height")
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx.cv)), 1, "a growing bubble stays in view")
        // While correcting, the bubble keeps its size: it never shrinks back.
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: "\u{77ED}")
        fx.vc.syncLiveUpdates(); drain(150)
        let shorter = try XCTUnwrap(rows(fx.cv).first { $0.id.contains(":pending:") })
        XCTAssertEqual(shorter.h, after.h, accuracy: 0.5, "a correcting bubble does not jump smaller")

        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "\u{6539}\u{597D}\u{4E86}\u{3002}"))
        XCTAssertFalse(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "again"))
        XCTAssertEqual(sent.count, 1)
        let payload = try XCTUnwrap(sent.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["text"] as? String, "\u{6539}\u{597D}\u{4E86}\u{3002}")
        XCTAssertEqual(payload["clientId"] as? String, clientId)
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .sending)
    }

    func testStagedVoiceAnswerDispatchesWithAnswerTo() throws {
        var sent: [[String: Any]] = []
        let fx = try makeFixture(total: 4) { msg in sent.append(msg); return true }
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "\u{9009}\u{4E8C}", answerTo: "q-7"))
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(sender.pendingInputs(sid).first?.payload["answerTo"]?.stringValue, "q-7")
        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{3002}"))
        let payload = try XCTUnwrap(sent.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["answerTo"] as? String, "q-7")
        XCTAssertEqual(payload["text"] as? String, "\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{3002}")
        XCTAssertNil(payload["delivery"], "an answer is never a steer")
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

    func testStagedVoiceSurvivesRelaunchAsRetryableOriginal() async throws {
        let fx = try makeFixture(total: 2)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let first = CommandSender(appState: fx.app, outboxURL: url)
        let clientId = try XCTUnwrap(first.stageInput(sessionId: sid, text: "original"))
        first.updateStagedInput(sessionId: sid, clientId: clientId, text: "corrected partial", original: "original")
        _ = first.sendInput(sessionId: sid, text: "other")   // persists the whole outbox
        await first.waitForOutboxWritesForTesting()
        let restored = CommandSender(appState: fx.app, outboxURL: url)
        let voice = try XCTUnwrap(restored.pendingInputs(sid).first { $0.payload["clientId"]?.stringValue == clientId })
        XCTAssertEqual(restored.pendingState(voice), .failed)
        XCTAssertEqual(voice.content, "original")
    }

    func testSentOutboxRestoresAsSendingAndOrderedClearDoesNotResurrect() async throws {
        let fx = try makeFixture(total: 2)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let first = CommandSender(appState: fx.app, outboxURL: url)
        XCTAssertTrue(first.sendInput(sessionId: sid, text: "synthetic"))
        let id = try XCTUnwrap(first.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        await first.waitForOutboxWritesForTesting()
        let restored = CommandSender(appState: fx.app, outboxURL: url)
        XCTAssertEqual(restored.pendingState(try XCTUnwrap(restored.pendingInputs(sid).first)), .sending,
                       "restored after relaunch and re-sent automatically on connect")
        for _ in 0..<20 { _ = first.sendInput(sessionId: sid, text: "synthetic") }
        first.clearAllPending(sid)
        await first.waitForOutboxWritesForTesting()
        XCTAssertTrue(CommandSender(appState: fx.app, outboxURL: url).pendingInputs(sid).isEmpty)
        restored.clearPending(sid, clientId: id) // late authoritative echo
        XCTAssertTrue(restored.pendingInputs(sid).isEmpty)
        await restored.waitForOutboxWritesForTesting()
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
        var timers: [(TimeInterval, DispatchWorkItem)] = []
        TKBubbleCell.pendingDimSchedulerForTesting = { timers.append(($0, $1)) }
        defer { TKBubbleCell.pendingDimSchedulerForTesting = nil }
        let fx = try makeFixture(total: 6)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "\u{770B}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{62A5}\u{9519}", attachments: [pngAttachment()]))
        let clientId = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        fx.vc.syncLiveUpdates(); drain(150)
        let early = try XCTUnwrap(cell(fx, clientId: clientId)?.pendingDimForRegression)
        XCTAssertEqual(early.text, 1, accuracy: 0.05, "a fast confirmation must not flash a dim")
        XCTAssertFalse(timers.isEmpty)
        XCTAssertTrue(timers.allSatisfy { $0.0 == 0.8 }, "production delay remains 0.8 seconds")
        timers.forEach { $0.1.perform() }
        drain(1_200)
        let pendingCell = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertEqual(pendingCell.pendingDimForRegression.text, 0.6, accuracy: 0.05)
        XCTAssertEqual(pendingCell.pendingDimForRegression.image, 0.6, accuracy: 0.05, "the image is part of the sending message")
        XCTAssertEqual(pendingCell.deliveryStatusForRegression, "Sending")

        let echo = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 7, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": ["content": "\u{770B}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{62A5}\u{9519}", "clientId": clientId],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: echo)
        sender.clearPending(sid, clientId: clientId)
        fx.vc.syncLiveUpdates(); drain(500)
        let delivered = try XCTUnwrap(cell(fx, clientId: clientId))
        XCTAssertNil(delivered.deliveryStatusForRegression)
        XCTAssertEqual(delivered.pendingDimForRegression.text, 1, accuracy: 0.05)
        XCTAssertEqual(delivered.pendingDimForRegression.image, 1, accuracy: 0.05)
    }

    func testEchoBeforeDimDeadlineCannotBeDimmedByRetiredTimer() throws {
        var timers: [DispatchWorkItem] = []
        TKBubbleCell.pendingDimSchedulerForTesting = { _, work in timers.append(work) }
        defer { TKBubbleCell.pendingDimSchedulerForTesting = nil }
        let fx = try makeFixture(total: 6)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "fast echo", attachments: [pngAttachment()]))
        let id = try XCTUnwrap(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue)
        fx.vc.syncLiveUpdates(); drain(150)
        XCTAssertFalse(timers.isEmpty)
        let echo = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 7, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z", "payload": ["content": "fast echo", "clientId": id],
        ])
        fx.app.messageProvider?.ingestTailCandidate(sid, json: echo)
        sender.clearPending(sid, clientId: id)
        fx.vc.syncLiveUpdates(); drain(500)
        timers.forEach { $0.perform() }
        drain(400)
        let delivered = try XCTUnwrap(cell(fx, clientId: id))
        XCTAssertNil(delivered.deliveryStatusForRegression)
        XCTAssertEqual(delivered.pendingDimForRegression.text, 1, accuracy: 0.05)
        XCTAssertEqual(delivered.pendingDimForRegression.image, 1, accuracy: 0.05)
    }

    func testCorrectingVoiceShowsUncorrectedLightAndCorrectedSolidWithoutDimming() throws {
        let fx = try makeFixture(total: 6)
        drain(400)
        let sender = try XCTUnwrap(fx.app.commandSender)
        let clientId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "\u{628A}\u{767B}\u{5165}\u{9875}\u{6539}\u{6210}\u{4E2D}\u{6587}", attachments: [pngAttachment()]))
        sender.updateStagedInput(sessionId: sid, clientId: clientId, text: "\u{628A}\u{767B}\u{5F55}\u{9875}\u{6539}\u{6210}\u{4E2D}\u{6587}",
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

        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: clientId, text: "\u{628A}\u{767B}\u{5F55}\u{9875}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{3002}"))
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
        XCTAssertEqual(failed.deliveryStatusForRegression, "Awaiting confirmation. Tap to retry")
        XCTAssertTrue(failed.bubbleHiddenForRegression, "image-only: no text bubble")
        let image = failed.imageFrameForRegression, status = failed.deliveryStatusFrameForRegression
        XCTAssertGreaterThan(image.height, 0)
        XCTAssertGreaterThanOrEqual(status.minY, image.minY, "status is not above the image")
        XCTAssertLessThanOrEqual(status.maxY, image.maxY + 0.5)
        XCTAssertLessThanOrEqual(status.maxX, image.minX, "status sits beside the image")
        XCTAssertEqual(failed.pendingDimForRegression.image, 1, accuracy: 0.05, "unconfirmed is shown normally with its status")
    }

    // MARK: Jump controls

    /// At the bottom ↓ is hidden; ↑ stays in ↓'s slot because the newest item
    /// is an AI reply (Mac #330 rule). Controls change only once motion settles.
    func testUpRestsInDownSlotAtBottomAndControlsChangeOnlyAfterMotionSettles() throws {
        let fx = try makeFixture(total: 80)
        drain(900)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false, "at the newest edge")
        XCTAssertEqual(fx.vc.automationControlsVisible.up, true, "the newest item is an AI reply: ↑ stays available")
        XCTAssertEqual(fx.vc.automationJumpControlFrames.up, fx.vc.automationJumpControlFrames.down, "↑ rests in ↓'s slot")
        guard fx.vc.automationUpTargetItem != nil else { throw XCTSkip("no earlier reply to jump to") }
        let rest = fx.vc.automationJumpControlFrames

        fx.vc.automationTapUp()
        drain(30)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false, "controls keep their state mid-glide")
        XCTAssertEqual(fx.vc.automationControlsVisible.up, true)

        drain(1_800)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, true, "re-evaluated once the glide settles")
        XCTAssertEqual(fx.vc.automationControlsVisible.up, true)
        let moved = fx.vc.automationJumpControlFrames
        XCTAssertEqual(moved.down.minY - moved.up.maxY, 8, accuracy: 0.5, "↓ appearing pushes ↑ up")

        fx.vc.automationTapDown()
        drain(1_800)
        XCTAssertEqual(fx.vc.automationControlsVisible.down, false)
        XCTAssertEqual(fx.vc.automationControlsVisible.up, true, "↑ drops back into ↓'s slot at the bottom")
        XCTAssertEqual(fx.vc.automationJumpControlFrames.down.maxY, rest.down.maxY, accuracy: 0.5)
        XCTAssertEqual(fx.vc.automationJumpControlFrames.up.maxY, rest.down.maxY, accuracy: 0.5)
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

    /// An older Tentacle (no `idempotent_input`) could run a queued input
    /// twice, so an input that was already handed to transport is never
    /// re-sent automatically; the user can still retry explicitly.
    func testNoAutomaticResendToATentacleWithoutIdempotentInput() throws {
        var sends = 0
        let fx = try makeFixture(total: 10) { _ in sends += 1; return true }
        fx.app.commandSender?.confirmationTimeout = .milliseconds(200)
        drain(600)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "legacy"))
        drain(600)
        sender.resendPendingInputs(reason: "reconnected")
        drain(100)
        XCTAssertEqual(sends, 1, "no silent or reconnect re-send without idempotent_input")
        XCTAssertEqual(sender.pendingState(try XCTUnwrap(sender.pendingInputs(sid).first)), .unconfirmed)
        fx.app.deviceStore.setDeviceFeatures(dev, features: ["idempotent_input"])
        sender.resendPendingInputs(reason: "greeting")
        XCTAssertEqual(sends, 2, "re-sent once the Tentacle advertises idempotent_input")
    }

    /// A transient transport refusal (reconnecting, Tentacle key not known
    /// yet) must not drop what the user typed: it stays queued as sending and
    /// goes out as soon as transport accepts it — with the same clientId.
    func testTransientSendFailureQueuesAndDispatchesLater() throws {
        var accept = false
        var sent: [String] = []
        let fx = try makeFixture(total: 4) { msg in
            guard accept else { return false }
            sent.append(((msg["payload"] as? [String: Any])?["clientId"] as? String) ?? "")
            return true
        }
        fx.app.commandSender?.confirmationTimeout = .seconds(10)
        drain(300)
        let sender = try XCTUnwrap(fx.app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: sid, text: "x"))
        let pending = try XCTUnwrap(sender.pendingInputs(sid).first)
        XCTAssertEqual(sender.pendingState(pending), .sending)
        accept = true
        drain(1_500)
        XCTAssertEqual(sent, [pending.payload["clientId"]?.stringValue ?? "?"], "dispatched once the path accepts it")
    }

    // MARK: Questions (on the spine)

    /// Tentacle's `ask_user`: an agent_message carrying `question`, lead-in
    /// prose as its content. The router closes the live card on it.
    private func ask(_ fx: Fx, seq: Int, id: String, lead: String = "\u{6211}\u{770B}\u{4E86}\u{4E00}\u{4E0B}\u{FF0C}\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\u{3002}",
                     choices: [String] = ["A", "B"]) throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "agent_message", "seq": seq, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-09-01T00:00:03.000Z",
            "payload": ["content": lead, "question": ["id": id, "text": "\u{9009}\u{54EA}\u{4E2A}\u{FF1F}", "choices": choices]],
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
        fx.app.messageStore.applyCardMessage(sid, "\u{6211}\u{770B}\u{4E86}\u{4E00}\u{4E0B}\u{FF0C}\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\u{3002}", reset: true)
        fx.vc.syncLiveUpdates(); drain(80)
        try ask(fx, seq: 12, id: "q1")
        drain(200)
        XCTAssertFalse(fx.vc.automationItemIDs.contains("__live_card__"), "the draft graduated into the question bubble")
        XCTAssertEqual(questionRow(fx, seq: 12), "\(sid):12#q-open")
        let vm = ChatViewModel(sessionId: sid, appState: fx.app)
        vm.refreshMessageCache()
        XCTAssertEqual(vm.questions.map(\.id), ["q1"])
        let bubble = try XCTUnwrap(vm.displayMessages.first { $0.seq == 12 })
        XCTAssertEqual(bubble.content, "\u{6211}\u{770B}\u{4E86}\u{4E00}\u{4E0B}\u{FF0C}\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\u{3002}")
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
                                      payload: ["content": AnyCodable("\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}"),
                                                "question": AnyCodable(["id": "q1", "text": "\u{5220}\u{65E7}\u{63A5}\u{53E3}\u{FF1F}", "choices": ["\u{5220}", "\u{7559}"]])])
            message.questionPresentation = QuestionPresentation(state: state)
            return message
        }
        XCTAssertEqual(m(.open).frozenCard?.text, "\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\n\n**\u{5220}\u{65E7}\u{63A5}\u{53E3}\u{FF1F}**")
        XCTAssertEqual(m(.answered).frozenCard?.text, m(.open).frozenCard?.text)
        XCTAssertEqual(m(.open).frozenCard?.action?.choices, ["\u{5220}", "\u{7559}"])
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

    /// An answer the transport cannot take right now is queued like any
    /// message (never lost); it carries answerTo and goes out once possible.
    func testAnswerDuringTransportRefusalIsQueuedWithAnswerTo() throws {
        let fx = try makeFixture(total: 4) { msg in (msg["type"] as? String) != "send_input" }
        drain(300)
        try startTurn(fx, seq: 5)
        try ask(fx, seq: 6, id: "q2")
        XCTAssertTrue(fx.app.commandSender?.answer(sessionId: sid, questionId: "q2", answer: "B") == true)
        let pending = try XCTUnwrap(fx.app.commandSender?.pendingInputs(sid).first)
        XCTAssertEqual(pending.payload["answerTo"]?.stringValue, "q2")
        XCTAssertEqual(fx.app.commandSender?.pendingState(pending), .sending)
    }

    /// Projection keeps a question that an aborted turn's terminal status
    /// follows (terminal segments normally drop their agent_messages).
    func testQuestionSurvivesATerminalTurnStatus() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("user_message", 1, ["content": "\u{8FC1}\u{79FB}\u{63A5}\u{53E3}"]),
            m("agent_message", 2, ["content": "\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}", "question": ["id": "q1", "text": "\u{5220}\u{65E7}\u{63A5}\u{53E3}\u{FF1F}"]]),
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
            m("user_message", 1, ["content": "\u{8FC1}\u{79FB}\u{63A5}\u{53E3}"]),
            m("agent_message", 2, ["content": "\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}", "question": ["id": "q1", "text": "\u{5220}\u{65E7}\u{63A5}\u{53E3}\u{FF1F}", "choices": ["\u{5220}"]]]),
            m("turn_status", 3, ["draft": "", "action": ["type": "user_abort", "payload": ["abortedAt": "x"]]]),
            m("idle", 4, [:]),
        ]
        let projected = TurnSpineProjection.project(ChatViewModel.presentingQuestions(raw, pending: [], atHead: true))
            .filter(ChatViewModel.shouldRender)
        XCTAssertNil(projected.first { $0.seq == 3 }, "no separate User aborted bubble")
        let card = projected.first { $0.seq == 2 }?.frozenCard
        XCTAssertEqual(card?.action?.type, "user_abort")
        XCTAssertEqual(card?.text, "\u{6709}\u{4E24}\u{4E2A}\u{65B9}\u{6848}\n\n**\u{5220}\u{65E7}\u{63A5}\u{53E3}\u{FF1F}**")
    }

    /// The fallback draft of a draft-less terminal status is the turn's last
    /// output; when that is the question, no older reply is pulled in.
    func testAbortAfterQuestionNeverBorrowsAnOlderReply() {
        func m(_ type: String, _ seq: Int, _ payload: [String: Any]) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: dev, timestamp: nil,
                        payload: payload.mapValues(AnyCodable.init))
        }
        let raw = [
            m("agent_message", 1, ["content": "\u{4E0A}\u{4E00}\u{8F6E}\u{7684}\u{56DE}\u{590D}"]),
            m("user_message", 2, ["content": "\u{7EE7}\u{7EED}"]),
            m("agent_message", 3, ["content": "", "question": ["id": "q1", "text": "\u{5220}\u{FF1F}"]]),
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
            m("agent_message", 1, ["content": "", "question": ["id": "q1", "text": "\u{4E00}\u{FF1F}"]]),
            m("agent_message", 2, ["content": "", "question": ["id": "q2", "text": "\u{4E8C}\u{FF1F}"]]),
            m("user_message", 3, ["content": "\u{597D}", "answerTo": "q2"]),
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
            "timestamp": "2026-09-01T00:00:05.000Z", "payload": ["content": "\u{65B0}\u{7684}\u{56DE}\u{590D}"],
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
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

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
