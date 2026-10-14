import XCTest
import AppKit
@testable import Kraki_Dev

/// Steer placement in the real Mac chat list (MessageStore+SteerPlacement):
/// the live card stays above a steer the agent has not read, keeps growing
/// there, then moves below it on the agent's next segment. The move glides
/// (no jump on screen) and the reader pinned at the bottom stays pinned.
@MainActor
final class MacSteerPlacementMotionTests: MacChatUXTestCase {
    private func steer(_ fx: Fx, seq: Int, text: String) throws {
        let payload: [String: Any] = ["content": text, "clientId": "steer-\(seq)", "delivery": "steer"]
        // As MessageRouter does for a persisted user_message.
        fx.app.messageStore.beginCardTurn(sid, userMessage: payload, seq: seq)
        try ingest(fx, ["type": "user_message", "seq": seq, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:01.500Z", "payload": payload])
    }

    /// Visible cells whose frames overlap, top to bottom.
    private func overlaps(_ fx: Fx) -> [String] {
        let cells = fx.doc.visibleCells.sorted { $0.key < $1.key }.map(\.value)
        return zip(cells, cells.dropFirst()).compactMap { upper, lower in
            lower.frame.minY < upper.frame.maxY - 0.5 ? "\(lower.frame.minY) over \(upper.frame.maxY)" : nil
        }
    }

    private func liveIndex(_ fx: Fx) -> Int? { fx.doc.itemKeys.firstIndex(of: "__live__") }
    private func steerKey(_ seq: Int) -> String { "\(sid):\(seq)" }

    func testLiveCardStaysAboveSteerThenGlidesBelowOnNewSegment() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        try startTurn(fx, seq: 41)
        fx.app.messageStore.applyCardMessage(sid, Self.en, reset: false)
        drain(600)
        try steer(fx, seq: 42, text: "Also drop the emoji in headings.")
        drain(600)
        XCTAssertEqual(fx.doc.itemKeys.suffix(2), ["__live__", steerKey(42)], "the steer appears below the card")

        // Same segment keeps growing above the steer; the bottom stays pinned
        // and the steer moves down with it (no overlap at any step).
        var overlapSeen: [String] = []
        for word in Self.en.split(separator: " ") {
            fx.app.messageStore.applyCardMessage(sid, " " + word, reset: false)
            drain(30)
            overlapSeen += overlaps(fx)
        }
        drain(800)
        XCTAssertEqual(overlapSeen, [], "the steer below the growing card moves with it")
        XCTAssertEqual(fx.doc.itemKeys.suffix(2), ["__live__", steerKey(42)])
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1, "pinned while the card grows above the steer")

        // New segment: the card goes below the steer, gliding.
        let steerCell = fx.doc.visibleCells[fx.doc.itemKeys.count - 1]
        let before = fx.doc.frame(forKey: steerKey(42)).map { $0.minY - fx.sv.contentView.bounds.minY }
        fx.app.messageStore.applyCardMessage(sid, "Got it, removing the emoji too.", reset: true)
        var trace: [String] = []
        for _ in 0..<30 {
            drain(8)
            let y = fx.doc.frame(forKey: steerKey(42)).map { $0.minY - fx.sv.contentView.bounds.minY } ?? -1
            let ty = (steerCell?.layer?.presentation()?.value(forKeyPath: "transform.translation.y") as? CGFloat) ?? 0
            trace.append(String(format: "%.0f/%.0f/%.0f/%.0f/%@", y, ty, fx.doc.frame.height, fx.sv.contentView.bounds.minY, fx.doc.itemKeys.last == "__live__" ? "L" : "S"))
        }
        print("MOTION trace " + trace.joined(separator: " "))
        XCTAssertEqual(fx.doc.itemKeys.suffix(2), [steerKey(42), "__live__"], "the new segment is below the steer")
        let glide = steerCell?.layer?.animation(forKey: "kraki.liveCardMove") as? CASpringAnimation
        XCTAssertNotNil(glide, "the steer bubble glides up instead of jumping")
        if let glide, let from = glide.fromValue as? CGFloat, let before,
           let after = fx.doc.frame(forKey: steerKey(42)).map({ $0.minY - fx.sv.contentView.bounds.minY }) {
            // It starts where it was on screen and travels to its new place.
            XCTAssertEqual(abs(from), abs(before - after), accuracy: 1)
            print(String(format: "MOTION steer-move before=%.1f after=%.1f from=%.1f", before, after, from))
        }
        drain(1_500)
        XCTAssertLessThanOrEqual(abs(distanceToBottom(fx)), 1, "still pinned after the move")

        // The reply lands below the steer.
        try land(fx, seq: 43, text: "Done: headings no longer carry emoji.")
        drain(800)
        XCTAssertNil(liveIndex(fx))
        XCTAssertEqual(fx.doc.itemKeys.suffix(2), [steerKey(42), "\(sid):43"])
    }
}
