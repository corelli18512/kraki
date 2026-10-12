import XCTest
import AppKit
@testable import Kraki_Dev

/// Motion of the whole conversation while new content arrives at the
/// followed bottom (a reply streaming line by line, a reply or the user's own
/// message appearing). Sampled at 240 Hz in a real on-screen window: the
/// screen position of an older bubble the reader is looking at. A "jump" is
/// that bubble moving by a large step within one display frame.
@MainActor
final class MacMotionTests: MacChatUXTestCase {
    struct Sample { let t: CFTimeInterval; let y: CGFloat }

    final class Sampler {
        private(set) var samples: [Sample] = []
        private var timer: Timer?
        let read: () -> CGFloat?
        init(_ read: @escaping () -> CGFloat?) { self.read = read }
        func start() {
            let t = Timer(timeInterval: 1.0 / 240.0, repeats: true) { [weak self] _ in
                guard let self, let y = self.read() else { return }
                self.samples.append(Sample(t: CACurrentMediaTime(), y: y))
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
        func stop() { timer?.invalidate(); timer = nil }

        /// Largest movement within any one 60 Hz frame (16.7 ms window).
        var worstFrameStep: CGFloat {
            var worst: CGFloat = 0
            var j = 0
            for i in samples.indices {
                while j < i, samples[i].t - samples[j].t > 1.0 / 60.0 { j += 1 }
                worst = max(worst, abs(samples[i].y - samples[j].y))
            }
            return worst
        }
        /// Frames whose movement exceeds `limit`.
        func framesOver(_ limit: CGFloat) -> Int {
            var count = 0, j = 0, lastCounted: CFTimeInterval = -1
            for i in samples.indices {
                while j < i, samples[i].t - samples[j].t > 1.0 / 60.0 { j += 1 }
                if abs(samples[i].y - samples[j].y) > limit, samples[i].t - lastCounted > 1.0 / 60.0 {
                    count += 1; lastCounted = samples[i].t
                }
            }
            return count
        }
        /// Largest movement within one 120 Hz refresh (8.5 ms), ignoring spans
        /// that contain a main-thread stall (dropped frames are counted apart).
        /// A layout jump moves a whole line or bubble at once.
        var worstRefreshStep: CGFloat {
            var worst: CGFloat = 0
            var j = 0
            for i in samples.indices {
                if i > 0, samples[i].t - samples[i - 1].t > 0.012 { j = i; continue }
                while j < i, samples[i].t - samples[j].t > 0.0085 { j += 1 }
                worst = max(worst, abs(samples[i].y - samples[j].y))
            }
            return worst
        }
        var travel: CGFloat { abs((samples.first?.y ?? 0) - (samples.last?.y ?? 0)) }
        /// Sampling gaps over 12 ms: the main thread was busy (dropped frames).
        var stalls: Int {
            samples.indices.dropFirst().filter { samples[$0].t - samples[$0 - 1].t > 0.012 }.count
        }
        /// Movement against the travel direction (content pulled back down).
        var worstReversal: CGFloat {
            var worst: CGFloat = 0
            for i in samples.indices.dropFirst() { worst = max(worst, samples[i].y - samples[i - 1].y) }
            return worst
        }
    }

    private func anchorY(_ fx: Fx, seq: Int) -> () -> CGFloat? {
        { [weak sv = fx.sv] in
            guard let sv, let frame = sv.chatDocumentView.frame(forSeq: seq) else { return nil }
            return frame.minY - sv.contentView.bounds.minY
        }
    }

    func testStreamingGrowthMovesTheConversationSmoothly() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        try startTurn(fx, seq: 41)
        let sampler = Sampler(anchorY(fx, seq: 41))
        sampler.start()
        let chars = Array(Self.zh + Self.zh + Self.zh + "\n\n" + Self.list + "\n\n" + Self.zh + Self.zh + Self.en + Self.en)
        var i = 0
        var worstHidden: CGFloat = 0
        while i < chars.count {
            fx.app.messageStore.applyCardMessage(sid, String(chars[i..<min(i + 8, chars.count)]), reset: false)
            i += 8
            drain(40)
            worstHidden = max(worstHidden, hiddenBelowComposer(fx))
        }
        drain(600)
        sampler.stop()
        let settledHidden = hiddenBelowComposer(fx)
        print(String(format: "MOTION stream refreshStep=%.1f reversal=%.1f stalls=%d worstHidden=%.1f settledHidden=%.1f",
                     sampler.worstRefreshStep, sampler.worstReversal, sampler.stalls, worstHidden, settledHidden))
        // A streamed line is ≥ 18 pt; it used to move in one refresh.
        XCTAssertLessThanOrEqual(sampler.worstRefreshStep, 16, "a new line glides the conversation up, it never jumps")
        XCTAssertLessThanOrEqual(sampler.worstReversal, 0.5, "never pulled back down")
        XCTAssertLessThanOrEqual(settledHidden, 1, "once settled the newest line is above the composer")
        XCTAssertLessThanOrEqual(worstHidden, MacTailMotion.maxLag + 8, "only the lines gliding in are briefly under the composer")
    }

    func testAReplyArrivingWholeGlidesIn() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        let sampler = Sampler(anchorY(fx, seq: 40))
        sampler.start()
        try ingest(fx, ["type": "user_message", "seq": 41, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:01.000Z", "payload": ["content": "继续"]])
        drain(700)
        try ingest(fx, ["type": "agent_message", "seq": 42, "sessionId": sid, "deviceId": dev,
                        "timestamp": "2026-09-01T00:00:02.000Z", "payload": ["content": Self.zh + "\n\n" + Self.list]])
        drain(900)
        sampler.stop()
        print(String(format: "MOTION arrive refreshStep=%.1f reversal=%.1f stalls=%d dist=%.1f",
                     sampler.worstRefreshStep, sampler.worstReversal, sampler.stalls, distanceToBottom(fx)))
        // An ease-out glide covers ≤ ~10% of its travel in one 120 Hz refresh.
        XCTAssertLessThanOrEqual(sampler.worstRefreshStep, sampler.travel * 0.2, "an arrival glides, it never jumps")
        XCTAssertLessThanOrEqual(sampler.worstReversal, 0.5)
        XCTAssertLessThanOrEqual(distanceToBottom(fx), 1)
    }

    func testStreamThenLandHasNoJump() throws {
        let fx = try makeFixture(total: 40)
        drain(1_200)
        try startTurn(fx, seq: 41)
        let text = Self.zh + Self.zh + "\n\n" + Self.code
        fx.app.messageStore.applyCardMessage(sid, text, reset: false)
        drain(800)
        let sampler = Sampler(anchorY(fx, seq: 41))
        sampler.start()
        try land(fx, seq: 42, text: text)
        drain(800)
        sampler.stop()
        print(String(format: "MOTION land worstFrameStep=%.1f", sampler.worstFrameStep))
        XCTAssertLessThanOrEqual(sampler.worstFrameStep, 1, "live → landed does not move anything")
    }
}
