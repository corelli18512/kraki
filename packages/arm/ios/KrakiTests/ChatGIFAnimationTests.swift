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

    /// A GIF's loop block says how often it plays: 0 forever, n plays n
    /// more times after the first pass (n + 1 passes, like browsers). A GIF
    /// without one loops forever. Read from the GIF's own bytes, whatever
    /// ImageIO reports.
    func testLoopBlockSetsThePlayCountAndAGIFWithoutOneLoopsForever() throws {
        let forever = try ChatGIFFixture.gif(frames: 3, loopCount: 0)
        let playsThreeTimes = try ChatGIFFixture.gif(frames: 3, loopCount: 3)
        XCTAssertEqual(Self.loopBlockCount(forever), 0)
        XCTAssertEqual(Self.loopBlockCount(playsThreeTimes), 2, "ImageIO stores the extra passes")
        XCTAssertEqual(ChatGIFAnimation.playCount(forever), 0)
        XCTAssertEqual(ChatGIFAnimation.playCount(playsThreeTimes), 3)
        XCTAssertEqual(try XCTUnwrap(ChatGIFAnimation.decode(playsThreeTimes)).loopCount, 3)

        // No loop block at all: loops forever (browsers would play it once).
        let noLoopBlock = Self.withoutLoopBlock(forever)
        XCTAssertNil(Self.loopBlockCount(noLoopBlock))
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(noLoopBlock))
        XCTAssertEqual(animation.loopCount, 0)
        XCTAssertFalse(animation.hasFinished(at: 3600))
        XCTAssertNotNil(animation.timeUntilNextFrame(at: 3600))
        XCTAssertEqual(ChatGIFAnimation.playCount(try ChatGIFFixture.gif(frames: 3, loopCount: nil)), 0)
        XCTAssertEqual(ChatGIFAnimation.playCount(try ChatGIFFixture.gif(frames: 3, loopCount: 1)), 0, "ImageIO writes no block for one pass")
    }

    func testLoopBlocksThatImageIOMisreads() throws {
        let noLoopBlock = Self.withoutLoopBlock(try ChatGIFFixture.gif(frames: 3, loopCount: 0))
        let start = Self.blocksStart(noLoopBlock)
        func inserting(_ block: [UInt8], at index: Int) -> Data {
            var data = noLoopBlock
            data.insert(contentsOf: block, at: data.startIndex + index)
            return data
        }
        // NETSCAPE2.0's buffering sub-block (id 2) is no loop count (ImageIO
        // reports 4097 passes for this one).
        let buffering = inserting(Self.applicationBlock("NETSCAPE2.0", [0x05, 0x02, 0x00, 0x10, 0x00, 0x00]), at: start)
        XCTAssertEqual(ChatGIFAnimation.playCount(buffering), 0)
        // ANIMEXTS1.0 is NETSCAPE2.0's twin (ImageIO ignores it).
        let animexts = inserting(Self.applicationBlock("ANIMEXTS1.0", [0x03, 0x01, 0x01, 0x00]), at: start)
        XCTAssertEqual(ChatGIFAnimation.playCount(animexts), 2)
        // A loop block after the first frame still counts.
        let firstFrameEnd = try XCTUnwrap(noLoopBlock.range(of: Data([0x21, 0xF9]), in: (noLoopBlock.startIndex + start + 8)..<noLoopBlock.endIndex))
        let late = inserting(Self.applicationBlock("NETSCAPE2.0", [0x03, 0x01, 0x04, 0x00]), at: firstFrameEnd.lowerBound - noLoopBlock.startIndex)
        XCTAssertEqual(ChatGIFAnimation.playCount(late), 5)
        XCTAssertEqual(try XCTUnwrap(ChatGIFAnimation.decode(late)).frames.count, 3)
        // Cut off mid-frame: no loop block found, loops forever.
        XCTAssertEqual(ChatGIFAnimation.playCount(noLoopBlock.prefix(noLoopBlock.count - 20)), 0)
        XCTAssertEqual(ChatGIFAnimation.playCount(Data("GIF89a".utf8)), 0)
        XCTAssertEqual(ChatGIFAnimation.playCount(try ChatGIFFixture.png()), 0)
    }

    /// `21 FF 0B <identifier> <sub-blocks> 00`
    private static func applicationBlock(_ identifier: String, _ subBlocks: [UInt8]) -> [UInt8] {
        [0x21, 0xFF, 0x0B] + Array(identifier.utf8) + subBlocks + [0x00]
    }

    private static func blocksStart(_ gif: Data) -> Int {
        let packed = gif[gif.startIndex + 10]
        return 13 + (packed & 0x80 != 0 ? 3 << (Int(packed & 0x07) + 1) : 0)
    }

    /// The NETSCAPE2.0 loop count stored in the file, nil without one.
    private static func loopBlockCount(_ gif: Data) -> Int? {
        guard let range = gif.range(of: Data("NETSCAPE2.0".utf8)) else { return nil }
        let bytes = [UInt8](gif[range.upperBound..<(range.upperBound + 4)])
        return Int(bytes[2]) | Int(bytes[3]) << 8
    }

    private static func withoutLoopBlock(_ gif: Data) -> Data {
        guard let range = gif.range(of: Data("NETSCAPE2.0".utf8)) else { return gif }
        var data = gif
        data.removeSubrange((range.lowerBound - 3)..<(range.upperBound + 5))
        return data
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
