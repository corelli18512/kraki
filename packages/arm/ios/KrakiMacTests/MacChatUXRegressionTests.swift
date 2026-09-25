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
        XCTAssertGreaterThan(revisions.count, 20, "the visible live bubble keeps streaming while the user scrolls")
        XCTAssertEqual(st.jumps, 0, "live growth must not move the text being read")
        XCTAssertEqual(st.placeholderFrames, 0)
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

    // MARK: Bubble chrome

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
