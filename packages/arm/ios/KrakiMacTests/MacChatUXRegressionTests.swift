import XCTest
import AppKit
@testable import Kraki_Dev

/// Behavioral gates for the macOS Chat (parity with iOS ChatUXRegressionTests),
/// driven through the production MacChatView in a real window.
@MainActor
final class MacChatUXRegressionTests: MacChatUXTestCase {

    // MARK: Streaming

    func testStreamingTailStaysVisibleUnclippedAndSmooth() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        try startTurn(fx, seq: 41)
        let chars = Array(Self.longAnswer(6_000))
        var worstHidden: CGFloat = 0, worstClip: CGFloat = 0
        let hb = Heartbeat(); hb.start()
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 30, chars.count)]), reset: false)
            i += 30
            drain(33)
            worstHidden = max(worstHidden, hiddenBelowComposer(fx))
            if let live = cells(fx).first(where: { $0.live }) {
                worstClip = max(worstClip, live.configured - live.h)
            }
        }
        hb.stop()
        print(String(format: "UXGATE stream hidden=%.0f clip=%.0f hitch=%.0fms >33=%d", worstHidden, worstClip, hb.worst, hb.over(33)))
        XCTAssertLessThanOrEqual(worstHidden, 1, "the streaming tail must stay above the composer")
        XCTAssertLessThanOrEqual(worstClip, 1, "the live bubble frame must never clip its newest lines")
        XCTAssertLessThanOrEqual(hb.over(33), 4, "streaming a long answer with tables must not stall the main thread")
    }

    /// Streaming re-parses the body on every token; table views must be
    /// reused by content, not rebuilt (display-independent cost metric).
    func testStreamingReusesTableViews() throws {
        let fx = try makeFixture(total: 10)
        drain(800)
        try startTurn(fx, seq: 11)
        let chars = Array(Self.longAnswer(4_000))
        let before = MacTableScrollView.debugInstanceCount
        var i = 0, updates = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 30, chars.count)]), reset: false)
            i += 30; updates += 1
            drain(30)
        }
        drain(500)
        let tables = Self.longAnswer(4_000).components(separatedBy: "|---|").count - 1
        let created = MacTableScrollView.debugInstanceCount - before
        print("UXGATE tables=\(tables) updates=\(updates) tableViewsCreated=\(created)")
        // Each table is created once, plus once per row it gains while it is
        // the streaming tail (its content changes).
        XCTAssertLessThanOrEqual(created, tables * 6, "table views must not be rebuilt on every token")
    }

    func testLandingKeepsLiveGeometryWithoutPlaceholderFrame() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        try startTurn(fx, seq: 41)
        let full = Self.longAnswer(3_000)
        let chars = Array(full)
        var i = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 60, chars.count)]), reset: false)
            i += 60
            drain(20)
        }
        drain(600)
        let live = try XCTUnwrap(cells(fx).last)
        XCTAssertTrue(live.live)
        try land(fx, seq: 42, text: full)
        for frame in 0..<30 {
            drain(16)
            let last = try XCTUnwrap(cells(fx).last, "frame \(frame)")
            XCTAssertFalse(last.placeholder, "landed answer must never show as a placeholder (frame \(frame))")
            XCTAssertEqual(last.screenY, live.screenY, accuracy: 1, "live → landed must not move (frame \(frame))")
            XCTAssertEqual(last.h, live.h, accuracy: 1, "live → landed must keep its height (frame \(frame))")
        }
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1)
    }

    // MARK: Scrolling

    func testHistoryFlingNeverJumpsOrShowsPlaceholders() throws {
        let fx = try makeFixture(total: 300)
        drain(1_500)
        let st = scrollAndTrack(fx, packets: 600, px: 40, intervalMs: 8, burst: 40, pauseMs: 800)
        print("UXGATE fling jumps=\(st.jumps) placeholders=\(st.placeholderFrames) estimated=\(st.estimatedFrames) rest=\(st.restJump) paged=\(st.pagesLoaded)")
        st.log.forEach { print("UXGATE   \($0)") }
        XCTAssertGreaterThan(st.pagesLoaded, 100, "older history must keep loading gesture after gesture")
        XCTAssertEqual(st.jumps, 0, "the bubble being read must move exactly with the scroll")
        XCTAssertEqual(st.placeholderFrames, 0, "no placeholder rows may be visible")
        XCTAssertEqual(st.estimatedFrames, 0, "no visible row may use an estimated height")
        XCTAssertLessThanOrEqual(st.restJump, 1, "nothing may move once scrolling stops")
    }

    func testStreamingContinuesWhileScrollingWithoutJumps() throws {
        let fx = try makeFixture(total: 30)
        drain(1_000)
        try startTurn(fx, seq: 31)
        let chars = Array(Self.longAnswer(8_000))
        var streamed = 0
        func push(_ n: Int) {
            guard streamed < chars.count else { return }
            fx.app.messageStore.applyCardMessage(sid, String(chars[streamed..<min(streamed + n, chars.count)]), reset: false)
            streamed += n
        }
        while streamed < 3_000 { push(40); drain(20) }
        drain(500)
        var revisions = Set<String>()
        let st = scrollAndTrack(fx, packets: 200, px: 6, intervalMs: 8, burst: 80, pauseMs: 300) { _ in
            push(10)
            if let live = fx.doc.automationVisibleCells.first(where: { $0.key == "__live__" }) {
                revisions.insert(live.cell.renderRevision)
            }
        }
        // The old code paused the live bubble for the whole scroll (exactly 1
        // revision). The rate itself depends on machine load (~90 idle, 14–29
        // with another process saturating CPU/GPU), so only require "live".
        XCTAssertGreaterThan(revisions.count, 2, "the visible live bubble keeps streaming while the user scrolls")
        XCTAssertEqual(st.jumps, 0, "live growth must not move the text being read")
        XCTAssertEqual(st.placeholderFrames, 0)
    }

    /// A notched mouse wheel (MX Vertical, no vendor smoothing) spun steadily
    /// must scroll like a browser: continuous per-frame motion, not a pulse
    /// per notch.
    func testDiscreteWheelScrollsContinuously() throws {
        let fx = try makeFixture(total: 200)
        drain(1_200)
        var deltas: [CGFloat] = []
        func notch() {
            let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 1, wheel2: 0, wheel3: 0)!
            let event = NSEvent(cgEvent: cg)!
            deltas.append(event.scrollingDeltaY)
            fx.sv.scrollWheel(with: event)
        }
        // Content motion as the reader sees it: displacement of an on-screen
        // bubble (immune to offset compensation when history is prepended).
        var tracked: Int?
        var lastScreenY: CGFloat?
        func sample() -> CGFloat {
            let now = cells(fx).filter { !$0.placeholder }
            if let seq = tracked, let cell = now.first(where: { $0.seq == seq }), let last = lastScreenY {
                lastScreenY = cell.screenY
                return abs(cell.screenY - last)
            }
            let mid = fx.sv.contentView.bounds.height / 2
            let pick = now.min { abs($0.screenY + $0.h / 2 - mid) < abs($1.screenY + $1.h / 2 - mid) }
            tracked = pick?.seq
            let moved = (pick != nil && lastScreenY != nil) ? CGFloat.nan : 0
            lastScreenY = pick?.screenY
            return moved
        }
        _ = sample()
        var steps: [CGFloat] = []
        let frame = 34 // two 60Hz display frames (immune to ±1 vsync jitter)
        var t = 0
        while t < 1_700 {
            // ~20 notches/s, delivered between samples.
            drain(17); if t < 1_200, t % 51 == 0 { notch() }
            drain(frame - 17)
            steps.append(sample())
            t += frame
        }
        let valid = steps.filter { !$0.isNaN }
        let steady = Array(steps[9..<33]).filter { !$0.isNaN } // 0.3–1.1s
        let mean = steady.reduce(0, +) / CGFloat(max(steady.count, 1))
        let sd = sqrt(steady.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / CGFloat(max(steady.count, 1)))
        let stalls = steady.filter { $0 < 0.25 }.count
        let settled = valid.suffix(3).allSatisfy { $0 < 0.25 }
        print("UXGATE wheel steps=" + steps.prefix(40).map { String(format: "%.0f", $0) }.joined(separator: ","))
        print(String(format: "UXGATE wheel mean=%.1fpt/frame cv=%.2f stalls=%d max=%.1f settled=%@",
                     mean, sd / max(mean, 0.01), stalls, steady.max() ?? 0, settled ? "Y" : "N"))
        XCTAssertGreaterThan(mean, 6, "the wheel scrolls")
        XCTAssertLessThan(sd / mean, 0.35, "steady spinning moves at an even speed (no per-notch pulse)")
        XCTAssertEqual(stalls, 0, "motion never stops between notches")
        XCTAssertTrue(settled, "comes to rest shortly after the last notch")
    }

    /// Snapshots (new messages, history pages) landing while a wheel glide is
    /// still moving must not pull the viewport back to a stale reading anchor.
    func testWheelGlideIsNotPulledBackBySnapshots() throws {
        let fx = try makeFixture(total: 120)
        drain(1_200)
        for _ in 0..<25 { packet(fx, 40); drain(8) }
        drain(900)
        packetInputTotal = -fx.sv.debugWheelAppliedTotal
        var seq = 121
        let shots = recordFrames(fx) {
            for round in 0..<8 {
                wheel(fx, lines: round % 2 == 0 ? 3 : -3)
                // Messages keep arriving below while the glide runs.
                for _ in 0..<8 {
                    drain(25)
                    try? ingest(fx, ["type": seq % 2 == 1 ? "user_message" : "agent_message", "seq": seq,
                                     "sessionId": sid, "deviceId": dev, "timestamp": "2026-09-01T00:00:05.000Z",
                                     "payload": ["content": "后台到达 \(seq)"]])
                    seq += 1
                }
                drain(150)
            }
        }
        let r = analyze(shots, maxStep: 700, viewportHeight: fx.sv.contentView.bounds.height)
        print("UXGATE glide-vs-snapshots \(r)")
        r.log.forEach { print("UXGATE   \($0)") }
        XCTAssertEqual(r.shifts, 0, "content moved without user input (snapped back to a stale anchor)")
        XCTAssertEqual(r.tears, 0)
        XCTAssertEqual(r.flashes, 0)
    }

    /// Reading near the top of the loaded window while new rows arrive at
    /// the bottom: the pixel-budget trim must not remove the rows on screen.
    func testNewMessagesDoNotTrimRowsBeingRead() throws {
        let fx = try makeFixture(total: 200)
        drain(1_200)
        // Park near the top of the loaded window while older pages are held
        // back (they would otherwise keep loading and slide the window), so
        // the window still ends at the newest row and arrivals append.
        MessageProviderDebug.olderPageDelayMs = 60_000
        defer { MessageProviderDebug.olderPageDelayMs = 0 }
        for _ in 0..<80 { packet(fx, 40); drain(8) }
        drain(900)
        if fx.sv.contentView.bounds.minY > 120 { packet(fx, fx.sv.contentView.bounds.minY - 80); drain(900) }
        XCTAssertEqual(fx.app.messageStore.windows[sid]?.bottomSeq, 200, "precondition: window reaches the tail")
        packetInputTotal = -fx.sv.debugWheelAppliedTotal
        let before = fx.app.messageStore.messages[sid]?.count ?? 0
        var seq = 201
        let shots = recordFrames(fx) {
            for _ in 0..<30 {
                try? ingest(fx, ["type": seq % 2 == 1 ? "user_message" : "agent_message", "seq": seq,
                                 "sessionId": sid, "deviceId": dev, "timestamp": "2026-09-01T00:00:05.000Z",
                                 "payload": ["content": Self.zh]])
                seq += 1
                drain(60)
            }
            drain(500)
        }
        let r = analyze(shots, maxStep: 700, viewportHeight: fx.sv.contentView.bounds.height)
        print("UXGATE trim-while-reading offset=\(Int(fx.sv.contentView.bounds.minY)) window=\(before)->\(fx.app.messageStore.messages[sid]?.count ?? 0) \(r)")
        r.log.forEach { print("UXGATE   \($0)") }
        XCTAssertEqual(r.shifts, 0, "rows being read moved: the window trimmed them")
        XCTAssertEqual(r.flashes, 0)
        XCTAssertEqual(r.blanks, 0)
    }

    /// Aggressive scrolling combined with history loading: max-speed wheel,
    /// momentum bursts with network-latency pages, and Tentacle 100-row pages.
    /// Every committed frame: content moves exactly with the user's scroll,
    /// no row vanishes, no blank area, no placeholder.
    func testAggressiveScrollingWithHistoryLoadingStaysClean() throws {
        func check(_ name: String, _ fx: Fx, _ drive: () -> Void) {
            drain(1_500)
            packetInputTotal = -fx.sv.debugWheelAppliedTotal
            let shots = recordFrames(fx) { drive(); drain(1_000) }
            let r = analyze(shots, maxStep: 10_000, viewportHeight: fx.sv.contentView.bounds.height)
            print("UXGATE aggressive \(name) \(r)")
            r.log.prefix(6).forEach { print("UXGATE   \($0)") }
            XCTAssertTrue(r.clean, "\(name): \(r)")
            windows.forEach { $0.orderOut(nil) }
            windows.removeAll()
        }
        let wheelFx = try makeFixture(total: 400)
        check("wheel-max", wheelFx) {
            for _ in 0..<200 { wheel(wheelFx, lines: 8); drain(12) }
        }
        MessageProviderDebug.olderPageDelayMs = 180
        defer { MessageProviderDebug.olderPageDelayMs = 0 }
        let momentumFx = try makeFixture(total: 400)
        check("momentum-bursts", momentumFx) {
            for burst in 0..<8 {
                for _ in 0..<45 { packet(momentumFx, 160); drain(8) }
                for _ in 0..<(burst % 2 == 0 ? 4 : 40) { drain(8) }
            }
        }
        MessageProviderDebug.olderPageDelayMs = 0
        var relayFx: Fx?
        let fx = try makeFixture(total: 400, dbFrom: 341, outbound: { msg in
            guard msg["type"] as? String == "request_session_messages",
                  let before = (msg["payload"] as? [String: Any])?["beforeSeq"] as? Int else { return true }
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(250)) {
                guard let fx = relayFx else { return }
                let page = (max(1, before - 100)..<before).map { seq -> ChatMessage in
                    let b = Self.message(seq, long: false)
                    return ChatMessage(type: b.type, seq: seq, sessionId: self.sid, deviceId: self.dev,
                                       timestamp: "2026-09-01T00:00:00.000Z", payload: ["content": AnyCodable(b.text)])
                }
                fx.app.messageProvider?.handleBatch(sessionId: self.sid, messages: page, lastSeq: before - 1,
                                                    totalLastSeq: before - 1, containsHead: false)
            }
            return true
        })
        relayFx = fx
        check("relay-pages", fx) {
            for burst in 0..<10 {
                if burst % 2 == 0 {
                    for _ in 0..<40 { wheel(fx, lines: 6); drain(12) }
                } else {
                    for _ in 0..<60 { packet(fx, 150); drain(8) }
                }
                drain(burst % 3 == 0 ? 80 : 650)
            }
        }
        relayFx = nil
    }

    /// A mouse wheel has no gesture boundaries: spinning it without pause must
    /// keep loading history (no stall at the loaded top), with clean frames.
    func testContinuousWheelKeepsLoadingHistoryWithoutFlicker() throws {
        for delay in [0, 250] as [UInt64] {
            MessageProviderDebug.olderPageDelayMs = delay
            defer { MessageProviderDebug.olderPageDelayMs = 0 }
            let fx = try makeFixture(total: 500)
            drain(1_500)
            packetInputTotal = -fx.sv.debugWheelAppliedTotal
            let top0 = fx.app.messageStore.windows[sid]?.topSeq ?? 0
            var tops: [Int] = []
            let shots = recordFrames(fx) {
                for i in 0..<400 {       // ~5s of uninterrupted spinning
                    wheel(fx, lines: 5)
                    drain(12)
                    if i % 40 == 0 { tops.append(fx.app.messageStore.windows[sid]?.topSeq ?? 0) }
                }
                drain(800)
            }
            let r = analyze(shots, maxStep: 10_000, viewportHeight: fx.sv.contentView.bounds.height)
            let paged = top0 - (fx.app.messageStore.windows[sid]?.topSeq ?? 0)
            print("UXGATE continuous-wheel delay=\(delay) paged=\(paged) tops=\(tops) \(r)")
            r.log.prefix(6).forEach { print("UXGATE   \($0)") }
            XCTAssertGreaterThanOrEqual(paged, 80, "continuous spinning keeps paging (delay \(delay))")
            XCTAssertTrue(r.clean, "delay \(delay): \(r)")
            windows.forEach { $0.orderOut(nil) }
            windows.removeAll()
        }
    }

    // MARK: Sending

    func testComposerSubmitReturnsToNewestEdge() throws {
        let fx = try makeFixture(total: 60)
        drain(1_200)
        for _ in 0..<30 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(900)
        XCTAssertGreaterThan(distanceToBottom(fx), 500)
        _ = fx.app.commandSender?.sendInput(sessionId: sid, text: "新的问题：这个怎么修？")
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil, userInfo: ["sessionId": sid])
        drain(700)
        XCTAssertLessThanOrEqual(distanceToBottom(fx), 1, "a local send returns the Chat to its newest edge")
        XCTAssertLessThanOrEqual(hiddenBelowComposer(fx), 1, "the message just sent is fully visible")
        XCTAssertEqual(fx.doc.automationVisibleCells.last?.cell.content?.pendingClientId != nil, true)
    }

    func testFailedInputOffersRetryEditDelete() throws {
        let fx = try makeFixture(total: 20)
        fx.app.commandSender?.confirmationTimeout = .milliseconds(300)
        drain(1_000)
        XCTAssertEqual(fx.app.commandSender?.sendInput(sessionId: sid, text: "这条会发送失败"), true)
        func pending() -> MacChatBubbleCell? {
            fx.doc.automationVisibleCells.last { $0.cell.content?.pendingClientId != nil }?.cell
        }
        drain(100)
        XCTAssertEqual(pending()?.deliveryStatusForRegression, "Sending")
        drain(800)
        let cell = try XCTUnwrap(pending())
        XCTAssertEqual(cell.deliveryStatusForRegression?.hasPrefix("Not delivered"), true)
        let clientId = try XCTUnwrap(cell.content?.pendingClientId)
        fx.doc.onPendingAction?(clientId, .retry)
        drain(100)
        XCTAssertEqual(pending()?.deliveryStatusForRegression, "Sending", "retry re-sends")
        drain(800)
        fx.doc.onPendingAction?(clientId, .edit)
        drain(200)
        XCTAssertNil(pending(), "edit removes the failed bubble")
        XCTAssertEqual(fx.app.sessionStore.drafts[sid], "这条会发送失败", "edit returns the text to the composer")
    }

    // MARK: Navigation

    func testUpStepsBackThroughReplyStartsAndDownShowsUnseenDot() throws {
        let fx = try makeFixture(total: 120)
        drain(1_200)
        for _ in 0..<12 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(900)
        XCTAssertTrue(fx.sv.automationControlsVisible.up)
        XCTAssertTrue(fx.sv.automationControlsVisible.down, "↓ whenever not at the bottom")
        let frames = fx.sv.automationControlFrames
        XCTAssertEqual(frames.down.width, frames.down.height, "round control")
        var previousSeq = Int.max
        var landings = 0
        for _ in 0..<12 {
            guard let key = fx.sv.automationUpTargetKey else {
                fx.sv.automationTapUp(); drain(1_200); continue
            }
            let message = try XCTUnwrap(fx.app.messageStore.messages[sid]?.first { $0.id == key })
            XCTAssertEqual(message.type, "agent_message", "↑ targets AI replies only")
            XCTAssertLessThan(message.seq, previousSeq, "each ↑ steps further back")
            previousSeq = message.seq
            fx.sv.automationTapUp()
            drain(700)
            let frame = try XCTUnwrap(fx.doc.frame(forKey: key))
            let screenY = frame.minY - fx.sv.contentView.bounds.minY
            if fx.sv.contentView.bounds.minY > 1 {
                XCTAssertEqual(screenY, 72, accuracy: 2, "lands at the reply start")
                landings += 1
            }
        }
        XCTAssertGreaterThan(landings, 8)
        XCTAssertLessThan(fx.app.messageStore.windows[sid]?.topSeq ?? 999, 96, "↑ loads older history when needed")

        try startTurn(fx, seq: 121)
        try land(fx, seq: 122, text: Self.zh)
        drain(500)
        XCTAssertTrue(fx.sv.automationUnseenDotVisible, "a reply landing while away lights the ↓ dot")
        fx.sv.automationTapDown()
        drain(1_200)
        XCTAssertLessThanOrEqual(distanceToBottom(fx), 1)
        XCTAssertFalse(fx.sv.automationUnseenDotVisible)
        XCTAssertFalse(fx.sv.automationControlsVisible.down, "↓ hides at the bottom")
    }

    /// Releasing a scroll view that still holds laid-out content (without a
    /// SwiftUI dismantle first) must not re-enter it from its own deinit
    /// (objc weak-reference abort seen in tableWheelRegression teardown).
    func testDeallocatingPopulatedScrollViewDoesNotReenter() throws {
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 420, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        windows.append(window)
        weak var released: MacChatScrollView?
        autoreleasepool {
            let scrollView = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 300))
            released = scrollView
            window.contentView = scrollView
            scrollView.prepareForSession(sid)
            let items = (1...30).map { seq -> MacChatItem in
                let message = ChatMessage(type: seq.isMultiple(of: 2) ? "agent_message" : "user_message", seq: seq,
                                          sessionId: sid, deviceId: dev, timestamp: "2026-09-01T00:00:00.000Z",
                                          payload: ["content": AnyCodable(Self.zh)])
                return MacChatItem(seq: seq, key: message.id, signature: "\(seq)", estimatedHeight: 120,
                                   isReply: seq.isMultiple(of: 2)) {
                    MacChatBubbleContentBuilder.make(message: message, sessionId: self.sid, agent: "claude", documentWidth: 420)
                }
            }
            scrollView.chatDocumentView.apply(contents: items, documentWidth: 420, sessionMode: .discuss)
            scrollView.contentView.bounds.origin.y = 600
            scrollView.reflectScrolledClipView(scrollView.contentView)
            window.contentView = nil
        }
        drain(300)
        XCTAssertNil(released, "released without re-entering deinit")
    }

    /// Table layout runs on the content preparation queue while the main
    /// thread draws code-block labels. Both used AppKit string drawing, whose
    /// shared typesetter is not thread-safe (abort inside
    /// CTLineCreateWithAttributedString seen while history pages loaded).
    func testConcurrentTableLayoutAndCodeDrawingDoNotCrash() throws {
        let code = MacMarkdown.attributed("```swift\nlet a = 1\nlet b = 2\n```\n\n" + Self.table,
                                          cacheKey: "stress-\(UUID())")
        let artifact = try XCTUnwrap(MacCoreTextLayoutArtifact.cached(attributed: code, width: 520, key: "stress-\(UUID())"))
        let view = MacCoreTextBodyView(frame: NSRect(x: 0, y: 0, width: 520, height: artifact.height))
        view.configure(artifact)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        let stop = ManagedAtomicFlag()
        let group = DispatchGroup()
        for worker in 0..<3 {
            DispatchQueue.global(qos: .userInitiated).async(group: group) {
                var i = 0
                while !stop.value {
                    let rows = (0..<6).map { r in ["指标\(worker)-\(i)-\(r)", "覆盖设备 iOS、Android 以及更多平台 \(r)", "\(i * r)ms"] }
                    _ = MacTableLayout(rows: rows, alignments: [.leading, .leading, .trailing])
                    i += 1
                }
            }
        }
        let end = Date().addingTimeInterval(2.5)
        var draws = 0
        while Date() < end {
            view.needsDisplay = true
            view.cacheDisplay(in: view.bounds, to: rep)
            draws += 1
        }
        stop.value = true
        group.wait()
        print("UXGATE concurrent-text draws=\(draws)")
        XCTAssertGreaterThan(draws, 50)
    }

    // MARK: Bubble chrome

    func testTableOnlyReplyIsNotASliver() {
        let message = ChatMessage(type: "agent_message", seq: 7, sessionId: sid, deviceId: dev,
                                  timestamp: "2026-09-01T00:00:00.000Z",
                                  payload: ["content": AnyCodable(Self.table)])
        let content = MacChatBubbleContentBuilder.make(message: message, sessionId: sid, agent: "claude", documentWidth: 820)
        var tableWidth: CGFloat = 0
        content.body?.enumerateAttribute(.attachment, in: NSRange(location: 0, length: content.body?.length ?? 0)) { value, _, _ in
            if let table = value as? MacTableAttachment { tableWidth = table.tableLayout.contentSize.width }
        }
        XCTAssertGreaterThan(tableWidth, 100)
        XCTAssertGreaterThanOrEqual(content.bodyTextWidth, min(tableWidth, content.attachmentWidth - 28) - 1,
                                    "a table-only reply is as wide as its table")
    }

    func testStepsButtonSitsAtBubbleTopLeading() throws {
        let fx = try makeFixture(total: 0)
        drain(300)
        try ingest(fx, ["type": "user_message", "seq": 1, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "问题"]])
        try ingest(fx, ["type": "agent_message", "seq": 2, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:02.000Z",
                        "payload": ["content": Self.zh + Self.zh, "steps": 3]])
        drain(800)
        let cell = try XCTUnwrap(fx.doc.automationVisibleCells.last?.cell)
        let steps = try XCTUnwrap(cell.subviews.compactMap { $0 as? NSButton }.first { $0.accessibilityLabel() == "Show steps" })
        XCTAssertFalse(steps.isHidden)
        XCTAssertLessThan(steps.frame.minX, 40, "steps ··· rides the top-leading edge")
        XCTAssertLessThanOrEqual(steps.frame.minY, MacChatBubbleLayout.outerV)
    }
}

final class ManagedAtomicFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return flag }
        set { lock.lock(); flag = newValue; lock.unlock() }
    }
}
