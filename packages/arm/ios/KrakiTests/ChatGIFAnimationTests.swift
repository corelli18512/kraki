import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Animated GIFs in chat decode into frames with their own delays, within
/// memory limits (iOS and Mac).
final class ChatGIFAnimationTests: XCTestCase {
    func testDecodesEveryFrameWithItsDelayAndLoopCount() throws {
        let data = try ChatGIFFixture.gif(frames: 4, delays: [0.1, 0.2, 0.05, 0.3], loopCount: 0)
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(data))
        XCTAssertEqual(animation.frames.count, 4)
        XCTAssertEqual(animation.delays.count, 4)
        for (delay, expected) in zip(animation.delays, [0.1, 0.2, 0.05, 0.3]) {
            XCTAssertEqual(delay, expected, accuracy: 0.001)
        }
        XCTAssertEqual(animation.duration, 0.65, accuracy: 0.001)
        XCTAssertEqual(animation.loopCount, 0, "loops forever")
        // Frames are the GIF's own pictures, in order.
        let colors = animation.frames.map(ChatGIFFixture.centerColor)
        XCTAssertGreaterThan(colors[0].0, 0.9)
        XCTAssertGreaterThan(colors[1].1, 0.9)
        XCTAssertGreaterThan(colors[2].2, 0.9)
        XCTAssertEqual(animation.frames[0].width, 40)
    }

    func testFrameAtATimeFollowsEachFramesDelay() throws {
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(
            try ChatGIFFixture.gif(frames: 4, delays: [0.1, 0.2, 0.05, 0.3], loopCount: 0)))
        let samples: [(TimeInterval, Int)] = [(0, 0), (0.099, 0), (0.101, 1), (0.29, 1), (0.31, 2), (0.36, 3), (0.64, 3), (0.66, 0), (1.42, 1), (1.62, 2)]
        for (time, frame) in samples {
            XCTAssertEqual(animation.frameIndex(at: time), frame, "at \(time) s")
        }
        XCTAssertEqual(try XCTUnwrap(animation.timeUntilNextFrame(at: 0.12)), 0.18, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(animation.timeUntilNextFrame(at: 0.6)), 0.05, accuracy: 0.001)
    }

    func testAFiniteLoopCountEndsOnTheLastFrame() throws {
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(
            try ChatGIFFixture.gif(frames: 3, delays: [0.1, 0.1, 0.1], loopCount: 2)))
        XCTAssertEqual(animation.loopCount, 2)
        XCTAssertEqual(animation.frameIndex(at: 0.35), 0, "second pass")
        XCTAssertFalse(animation.hasFinished(at: 0.59))
        XCTAssertTrue(animation.hasFinished(at: 0.61))
        XCTAssertEqual(animation.frameIndex(at: 5), 2)
        XCTAssertNil(animation.timeUntilNextFrame(at: 5))
    }

    func testTinyOrMissingDelaysPlayAt100msLikeBrowsers() {
        XCTAssertEqual(ChatGIFAnimation.frameDelay(nil), 0.1)
        XCTAssertEqual(ChatGIFAnimation.frameDelay([kCGImagePropertyGIFDelayTime: 0.0]), 0.1)
        XCTAssertEqual(ChatGIFAnimation.frameDelay([kCGImagePropertyGIFUnclampedDelayTime: 0.01]), 0.1)
        XCTAssertEqual(ChatGIFAnimation.frameDelay([kCGImagePropertyGIFUnclampedDelayTime: 0.02, kCGImagePropertyGIFDelayTime: 0.1]), 0.02, accuracy: 1e-9)
    }

    func testStillImagesAreNotAnimated() throws {
        XCTAssertNil(ChatGIFAnimation.decode(try ChatGIFFixture.png()), "a PNG")
        XCTAssertNil(ChatGIFAnimation.decode(try ChatGIFFixture.gif(frames: 1)), "a one-frame GIF")
        XCTAssertNil(ChatGIFAnimation.decode(Data("GIF89a and then nothing".utf8)), "a broken GIF")
    }

    func testTooManyFramesStayStill() throws {
        let data = try ChatGIFFixture.gif(frames: 4)
        var limits = ChatGIFAnimation.Limits.chat
        limits.maxFrameCount = 3
        XCTAssertNil(ChatGIFAnimation.decode(data, limits: limits))
        limits.maxFrameCount = 4
        XCTAssertNotNil(ChatGIFAnimation.decode(data, limits: limits))
    }

    func testFramesOverTheMemoryBudgetAreDecodedSmaller() throws {
        let data = try ChatGIFFixture.gif(frames: 4, width: 400, height: 200)
        var limits = ChatGIFAnimation.Limits.chat
        limits.minPixelSize = 100
        // Room for four 200×100 frames only.
        limits.maxDecodedBytes = 4 * 200 * 100 * 4
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(data, limits: limits))
        XCTAssertEqual(animation.frames.count, 4)
        XCTAssertLessThanOrEqual(animation.frames[0].width, 200)
        XCTAssertGreaterThanOrEqual(animation.frames[0].width, 190)
        XCTAssertLessThanOrEqual(animation.frames.reduce(0) { $0 + $1.width * $1.height * 4 }, limits.maxDecodedBytes)
        // Smaller than worth animating: shown still.
        limits.minPixelSize = 300
        XCTAssertNil(ChatGIFAnimation.decode(data, limits: limits))
    }

    func testDecodedSideIsCappedAndFitsTheBudget() {
        let limits = ChatGIFAnimation.Limits.chat
        XCTAssertEqual(ChatGIFAnimation.decodedLongestSide(source: CGSize(width: 480, height: 270), frameCount: 60, limits: limits), 480)
        XCTAssertEqual(ChatGIFAnimation.decodedLongestSide(source: CGSize(width: 9000, height: 100), frameCount: 2, limits: limits), 4096)
        // 150 frames of 1000×1000 (600 MB) shrink to fit 64 MB.
        let side = ChatGIFAnimation.decodedLongestSide(source: CGSize(width: 1000, height: 1000), frameCount: 150, limits: limits)
        XCTAssertEqual(side.map { $0 * $0 * 4 * 150 <= limits.maxDecodedBytes }, true)
        XCTAssertEqual(side.map { $0 >= limits.minPixelSize }, true)
        XCTAssertNil(ChatGIFAnimation.decodedLongestSide(source: CGSize(width: 2000, height: 2000), frameCount: 300, limits: limits), "would be under 240 px")
    }
}
