import XCTest
import AppKit
@testable import Kraki_Dev

/// ↑/↓ must track the window edge frame by frame during a resize drag and must
/// not flicker or travel. Off-screen window, never activates the app.
@MainActor final class MacJumpControlResizeTests: MacChatUXTestCase {
    // Off-screen and never activated, so it does not need the foreground gate.
    override func setUpWithError() throws {}


    private struct Sample { let width: CGFloat; let up: NSRect; let down: NSRect; let upShown: Bool; let downShown: Bool; let expectedX: CGFloat }

    private func drag(_ fx: Fx, from: CGFloat, to: CGFloat, step: CGFloat) -> [Sample] {
        var out: [Sample] = []
        let height = fx.window.contentLayoutRect.height
        var w = from
        while (step < 0 ? w >= to : w <= to) {
            fx.window.setContentSize(NSSize(width: w, height: height))
            drain(16)
            let f = fx.sv.automationControlFrames
            let v = fx.sv.automationControlsVisible
            out.append(Sample(width: w, up: f.up, down: f.down, upShown: v.up, downShown: v.down,
                              expectedX: fx.sv.bounds.width - 16 - MacChatScrollView.jumpControlSize))
            w += step
        }
        return out
    }

    private func report(_ name: String, _ s: [Sample]) -> (maxUpDx: CGFloat, maxDownDx: CGFloat, upFlips: Int, downFlips: Int, upYMoves: Int) {
        var maxUp: CGFloat = 0, maxDown: CGFloat = 0, upFlips = 0, downFlips = 0, upYMoves = 0
        for (i, x) in s.enumerated() {
            maxDown = max(maxDown, abs(x.down.minX - x.expectedX))
            if x.upShown { maxUp = max(maxUp, abs(x.up.minX - x.expectedX)) }
            if i > 0 {
                if s[i - 1].upShown != x.upShown { upFlips += 1 }
                if s[i - 1].downShown != x.downShown { downFlips += 1 }
                if abs(s[i - 1].up.minY - x.up.minY) > 0.5 { upYMoves += 1 }
            }
        }
        print("JUMP-RESIZE \(name): samples=\(s.count) maxUpDx=\(maxUp) maxDownDx=\(maxDown) upFlips=\(upFlips) downFlips=\(downFlips) upYMoves=\(upYMoves)")
        let worst = s.max { abs($0.up.minX - $0.expectedX) < abs($1.up.minX - $1.expectedX) }!
        print("JUMP-RESIZE \(name) worst: width=\(worst.width) up=\(worst.up) down=\(worst.down) expectedX=\(worst.expectedX)")
        return (maxUp, maxDown, upFlips, downFlips, upYMoves)
    }

    private func offscreen(_ fx: Fx) {
        fx.window.level = .normal
        fx.window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    }

    func testControlsTrackResizeAtBottom() throws {
        let fx = try makeFixture(total: 120)
        offscreen(fx)
        drain(1_200)
        let s = drag(fx, from: 900, to: 600, step: -10) + drag(fx, from: 600, to: 1_100, step: 10)
        let r = report("bottom", s)
        XCTAssertLessThanOrEqual(r.maxUpDx, 0.5)
        XCTAssertLessThanOrEqual(r.maxDownDx, 0.5)
        XCTAssertEqual(r.upFlips + r.downFlips, 0, "visibility must not flicker while resizing")
    }

    func testControlsTrackResizeScrolledUp() throws {
        let fx = try makeFixture(total: 120)
        offscreen(fx)
        drain(1_200)
        for _ in 0..<12 { _ = fx.sv.automationPreciseScrollPacket(deltaY: 40); drain(8) }
        drain(1_200)
        XCTAssertTrue(fx.sv.automationControlsVisible.down)
        let s = drag(fx, from: 900, to: 600, step: -10) + drag(fx, from: 600, to: 1_100, step: 10)
        let r = report("scrolledUp", s)
        XCTAssertLessThanOrEqual(r.maxUpDx, 0.5)
        XCTAssertLessThanOrEqual(r.maxDownDx, 0.5)
        XCTAssertEqual(r.upFlips + r.downFlips + r.upYMoves, 0, "↑/↓ must not appear, hide or travel while resizing")
    }

    func testControlsTrackResizeNearBottomEdge() throws {
        // A few lines above the bottom: reflow during resize can push the list
        // across the "at bottom" threshold, which used to flip ↓ and fly ↑.
        let fx = try makeFixture(total: 120)
        offscreen(fx)
        drain(1_200)
        _ = fx.sv.automationPreciseScrollPacket(deltaY: 14); drain(8)
        drain(1_200)
        let s = drag(fx, from: 900, to: 600, step: -10) + drag(fx, from: 600, to: 1_100, step: 10)
        let r = report("nearBottom", s)
        XCTAssertLessThanOrEqual(r.maxUpDx, 0.5)
        XCTAssertEqual(r.upFlips + r.downFlips + r.upYMoves, 0, "↑/↓ must not appear, hide or travel while resizing")
        // Once the window holds still, the controls are re-evaluated and ↑
        // stays in ↓'s column.
        drain(900)
        let f = fx.sv.automationControlFrames
        XCTAssertEqual(f.up.minX, f.down.minX, accuracy: 0.5)
        XCTAssertEqual(fx.sv.automationControlsVisible.down, distanceToBottom(fx) > 8)
    }
}
