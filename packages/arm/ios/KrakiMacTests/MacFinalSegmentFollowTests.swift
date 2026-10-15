import XCTest
import AppKit
@testable import Kraki_Dev

/// Offline reproduction: several keep-last narration/tool steps, then a final
/// segment growing from one line to multiple screens. Never land the final
/// spine message until all streaming assertions have been collected.
@MainActor
final class MacFinalSegmentFollowTests: MacChatUXTestCase {
    func testFinalSegmentFollowsWithoutInteraction() throws {
        try exerciseFinalSegment(returnToTail: false)
    }

    func testFinalSegmentFollowsAfterReturningToTail() throws {
        try exerciseFinalSegment(returnToTail: true)
    }

    func testFinalSegmentFollowsAfterScrollingBackToTail() throws {
        try exerciseFinalSegment(returnToTail: true, usingWheel: true)
    }

    func testScrollingUpAgainStopsFollowDuringStreaming() throws {
        let fx = try makeFixture(total: 40)
        drain(900)
        try startTurn(fx, seq: 41)
        _ = fx.sv.automationPreciseScrollPacket(deltaY: 200)
        drain(600)
        fx.sv.automationTapDown()
        drain(700)
        fx.app.messageStore.applyCardMessage(sid, Self.zh, reset: true)
        drain(400)
        XCTAssertTrue(fx.sv.followingBottom)
        // A small upward packet must override the preserved follow intent.
        _ = fx.sv.automationPreciseScrollPacket(deltaY: 12)
        drain(600)
        XCTAssertFalse(fx.sv.followingBottom)
        let offset = fx.sv.contentView.bounds.minY
        let height = fx.doc.frame.height
        for _ in 0..<30 {
            fx.app.messageStore.applyCardMessage(sid, "\n" + Self.en, reset: false)
            drain(32)
            XCTAssertFalse(fx.sv.followingBottom)
            XCTAssertEqual(fx.sv.contentView.bounds.minY, offset, accuracy: 1,
                           "streaming must not drag a reader away from older text")
        }
        drain(600)
        XCTAssertGreaterThan(fx.doc.frame.height - height, 500)
        XCTAssertEqual(fx.sv.contentView.bounds.minY, offset, accuracy: 1)
        XCTAssertFalse(fx.sv.isProgrammaticScrollActive)
    }

    func testNotificationEntryStopsFollowingWhenFinalAnswerOutgrowsViewport() throws {
        try exerciseFinalSegment(returnToTail: false, fromNotification: true)
    }

    private func exerciseFinalSegment(
        returnToTail: Bool, fromNotification: Bool = false, usingWheel: Bool = false
    ) throws {
        let fx = try makeFixture(total: 40, size: NSSize(width: 720, height: 660),
                                 fromNotification: fromNotification)
        drain(900)
        try startTurn(fx, seq: 41)
        if returnToTail {
            for _ in 0..<8 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 45); drain(16) }
            drain(250)
            if usingWheel {
                for _ in 0..<12 { _ = fx.sv.automationPreciseScrollPacket(deltaY: -45); drain(16) }
            } else {
                fx.sv.automationTapDown()
            }
            drain(700)
            XCTAssertLessThan(abs(distanceToBottom(fx)), 2)
        }
        XCTAssertTrue(fx.sv.followingBottom)
        for step in 1...3 {
            fx.app.messageStore.applyCardMessage(sid, "Step \(step): " + Self.zh, reset: true)
            fx.app.messageStore.applyCardAction(sid, ChatMessage(
                type: "tool_start", seq: 0, sessionId: sid, deviceId: dev,
                timestamp: "2026-10-10T00:00:00Z",
                payload: ["tool": AnyCodable("bash"), "input": AnyCodable("inspect step \(step)")]))
            drain(180)
            fx.app.messageStore.applyCardAction(sid, nil)
            drain(100)
            print("FINALSTAGE mac step=\(step) following=\(fx.sv.followingBottom) distance=\(distanceToBottom(fx)) policy=\(fx.sv.scrollPolicy)")
        }
        fx.app.messageStore.applyCardMessage(sid, "Final answer:", reset: true)
        drain(350)
        let startOffset = fx.sv.contentView.bounds.minY
        print("FINALSTAGE mac final-start following=\(fx.sv.followingBottom) distance=\(distanceToBottom(fx))")
        var trace = ["characters,offset,documentHeight,hidden,following"]
        var firstLoss = true
        var worstHidden: CGFloat = 0
        var lostFollowFrames = 0
        let full = Self.longAnswer(3_000)
        let chars = Array(full)
        var index = 0
        while index < chars.count {
            let end = min(index + 12, chars.count)
            fx.app.messageStore.applyCardMessage(sid, String(chars[index..<end]), reset: false)
            index = end
            // Two observations per chunk, including the first layout frame.
            for _ in 0..<2 {
                drain(16)
                worstHidden = max(worstHidden, hiddenBelowComposer(fx))
                if !fx.sv.followingBottom {
                    lostFollowFrames += 1
                    if firstLoss {
                        print("FINALLOSS mac chars=\(index) distance=\(distanceToBottom(fx)) policy=\(fx.sv.scrollPolicy)")
                        firstLoss = false
                    }
                }
                trace.append("\(index),\(fx.sv.contentView.bounds.minY),\(fx.doc.frame.height),\(hiddenBelowComposer(fx)),\(fx.sv.followingBottom)")
            }
        }
        let attachment = XCTAttachment(data: Data(trace.joined(separator: "\n").utf8), uniformTypeIdentifier: "public.comma-separated-values-text")
        attachment.name = "streaming-geometry"
        attachment.lifetime = .keepAlways
        add(attachment)
        let streamingDistance = distanceToBottom(fx)
        drain(600)
        print("FINALFOLLOW mac notification=\(fromNotification) returned=\(returnToTail) wheel=\(usingWheel) hidden=\(worstHidden) lostFrames=\(lostFollowFrames) streamDistance=\(streamingDistance) settled=\(distanceToBottom(fx)) travel=\(fx.sv.contentView.bounds.minY - startOffset) policy=\(fx.sv.scrollPolicy)")
        if fromNotification {
            XCTAssertEqual(fx.sv.automationUnreadEntry, .anchored)
            XCTAssertGreaterThan(worstHidden, fx.sv.contentView.bounds.height)
            XCTAssertFalse(fx.sv.followingBottom)
            return
        }
        XCTAssertGreaterThan(fx.sv.contentView.bounds.minY - startOffset, 500)
        XCTAssertLessThan(worstHidden, 100, "streaming must follow, allowing a short smooth-motion lag")
        XCTAssertEqual(lostFollowFrames, 0, "no user gesture during generation may cancel following")
        XCTAssertLessThan(abs(distanceToBottom(fx)), 2)
    }
}
