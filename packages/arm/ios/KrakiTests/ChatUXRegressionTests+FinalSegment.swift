import XCTest
import UIKit
@testable import Kraki

#if os(iOS)
extension ChatUXRegressionTests {
    /// Shared mixed-Markdown corpus for the streaming regression cases.
    static func longAnswer(_ minimum: Int) -> String {
        var text = ""
        while text.count < minimum {
            text += code + "\n\n" + zh + "\n\n" + list + "\n\n" + table + "\n\n" + en + "\n\n"
        }
        return text
    }

    private func attachStreamingTrace(_ trace: [String]) {
        let attachment = XCTAttachment(data: Data(trace.joined(separator: "\n").utf8), uniformTypeIdentifier: "public.comma-separated-values-text")
        attachment.name = "streaming-geometry"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testFinalSegmentFollowsWithoutInteraction() throws {
        try exerciseFinalSegment(returnToTail: false)
    }

    func testFinalSegmentFollowsAfterReturningToTail() throws {
        try exerciseFinalSegment(returnToTail: true)
    }

    func testFinalSegmentFollowsAfterDraggingBackToTail() throws {
        try exerciseFinalSegment(returnToTail: true, usingDrag: true)
    }

    func testScrollingUpAgainStopsFollowDuringStreaming() throws {
        let fx = try makeFixture(total: 40, onScreen: true)
        drain(900)
        try beginFinalSegmentTurn(fx)
        drag(fx, by: -300)
        fx.vc.automationTapDown()
        drain(700)
        fx.app.messageStore.applyCardMessage(sid, Self.zh, reset: true)
        fx.vc.syncLiveUpdates(); drain(400)
        XCTAssertTrue(fx.vc.followingBottom)
        drag(fx, by: -12)
        drain(400)
        XCTAssertFalse(fx.vc.followingBottom)
        let offset = fx.cv.contentOffset.y
        let height = fx.cv.contentSize.height
        for _ in 0..<30 {
            fx.app.messageStore.applyCardMessage(sid, "\n" + Self.en, reset: false)
            fx.vc.syncLiveUpdates(); drain(32)
            XCTAssertFalse(fx.vc.followingBottom)
            XCTAssertEqual(fx.cv.contentOffset.y, offset, accuracy: 1)
        }
        drain(600)
        XCTAssertGreaterThan(fx.cv.contentSize.height - height, 500)
        XCTAssertEqual(fx.cv.contentOffset.y, offset, accuracy: 1)
    }

    private func drag(_ fx: Fx, by delta: CGFloat) {
        fx.vc.scrollViewWillBeginDragging(fx.cv)
        fx.vc.automationUserScrollActive = true
        fx.cv.contentOffset.y += delta
        fx.vc.scrollViewDidScroll(fx.cv)
        fx.vc.automationUserScrollActive = false
        fx.vc.scrollViewDidEndDragging(fx.cv, willDecelerate: false)
    }

    func testNotificationEntryStopsFollowingWhenFinalAnswerOutgrowsViewport() throws {
        try exerciseFinalSegment(returnToTail: false, fromNotification: true)
    }

    private func beginFinalSegmentTurn(_ fx: Fx) throws {
        fx.app.messageStore.beginCardTurn(sid)
        let user = try JSONSerialization.data(withJSONObject: [
            "type": "user_message", "seq": 41, "sessionId": sid, "deviceId": dev,
            "timestamp": "2026-10-10T00:00:00Z", "payload": ["content": "Continue"],
        ])
        fx.app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 41, deviceId: dev)
        fx.app.messageProvider?.ingestTailCandidate(sid, json: user)
        fx.vc.syncLiveUpdates()
        drain(500)
    }

    private func exerciseFinalSegment(
        returnToTail: Bool, fromNotification: Bool = false, usingDrag: Bool = false
    ) throws {
        let fx = try makeFixture(total: 40, onScreen: true, fromNotification: fromNotification)
        drain(900)
        try beginFinalSegmentTurn(fx)
        if returnToTail {
            drag(fx, by: -300)
            if usingDrag {
                drag(fx, by: fx.vc.distanceToBottom())
            } else {
                fx.vc.automationTapDown()
            }
            drain(700)
            XCTAssertLessThan(abs(fx.vc.distanceToBottom()), 2)
        }
        XCTAssertTrue(fx.vc.followingBottom)
        for step in 1...3 {
            fx.app.messageStore.applyCardMessage(sid, "Step \(step): " + Self.zh, reset: true)
            fx.app.messageStore.applyCardAction(sid, ChatMessage(
                type: "tool_start", seq: 0, sessionId: sid, deviceId: dev,
                timestamp: "2026-10-10T00:00:00Z",
                payload: ["tool": AnyCodable("bash"), "input": AnyCodable("inspect step \(step)")]))
            fx.vc.syncLiveUpdates(); drain(180)
            fx.app.messageStore.applyCardAction(sid, nil)
            fx.vc.syncLiveUpdates(); drain(100)
        }
        fx.app.messageStore.applyCardMessage(sid, "Final answer:", reset: true)
        fx.vc.syncLiveUpdates(); drain(350)
        let startOffset = fx.cv.contentOffset.y
        var worstHidden: CGFloat = 0
        var worstModelDistance: CGFloat = 0
        var hiddenSince: CFTimeInterval?
        var longestHidden: CFTimeInterval = 0
        var trace = ["characters,offset,contentHeight,presentationHidden,modelDistance,following"]
        var lostFollowFrames = 0
        let chars = Array(Self.longAnswer(3_000))
        var index = 0
        while index < chars.count {
            let end = min(index + 12, chars.count)
            fx.app.messageStore.applyCardMessage(sid, String(chars[index..<end]), reset: false)
            index = end
            fx.vc.syncLiveUpdates()
            for _ in 0..<2 {
                drain(16)
                let layer = fx.cv.layer.presentation() ?? fx.cv.layer
                let hidden = fx.cv.contentSize.height + fx.cv.adjustedContentInset.bottom
                    - fx.cv.bounds.height - layer.bounds.minY + layer.sublayerTransform.m42
                worstHidden = max(worstHidden, hidden)
                if hidden > 100 {
                    let now = CACurrentMediaTime()
                    if hiddenSince == nil { hiddenSince = now }
                    longestHidden = max(longestHidden, now - (hiddenSince ?? now))
                } else { hiddenSince = nil }
                worstModelDistance = max(worstModelDistance, fx.vc.distanceToBottom())
                if !fx.vc.followingBottom { lostFollowFrames += 1 }
                trace.append("\(index),\(fx.cv.contentOffset.y),\(fx.cv.contentSize.height),\(hidden),\(fx.vc.distanceToBottom()),\(fx.vc.followingBottom)")
            }
        }
        attachStreamingTrace(trace)
        let streamingDistance = fx.vc.distanceToBottom()
        drain(600)
        print("FINALFOLLOW ios notification=\(fromNotification) returned=\(returnToTail) drag=\(usingDrag) hidden=\(worstHidden) modelDistance=\(worstModelDistance) longestHiddenSeconds=\(longestHidden) lostFrames=\(lostFollowFrames) streamDistance=\(streamingDistance) settled=\(fx.vc.distanceToBottom()) travel=\(fx.cv.contentOffset.y - startOffset) policy=\(fx.vc.scrollPolicy)")
        if fromNotification {
            XCTAssertEqual(fx.vc.automationUnreadEntry, .anchored)
            XCTAssertGreaterThan(worstHidden, fx.cv.bounds.height)
            // UIKit's height-animation path may set followingBottom again
            // even while the unread anchor overrides each subsequent pin.
            // Assert actual viewport geometry, not that inconsistent latch.
            XCTAssertGreaterThan(fx.vc.distanceToBottom(), fx.cv.bounds.height)
            return
        }
        XCTAssertGreaterThan(fx.cv.contentOffset.y - startOffset, 500)
        // Full Markdown blocks (especially an opening code fence) can grow by
        // hundreds of points in one chunk. Presentation lag alone is not a
        // lost follow latch: keep it in the trace, assert model tracking here.
        XCTAssertLessThan(worstModelDistance, 2, "every streaming sample must track the current tail")
        XCTAssertLessThan(longestHidden, 0.75, "the visible tail must not stay hidden during generation")
        XCTAssertEqual(lostFollowFrames, 0)
        XCTAssertLessThan(abs(fx.vc.distanceToBottom()), 2)
    }
}
#endif
