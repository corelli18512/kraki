import ImageIO
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// A GIF over the composer's limits is redrawn smaller and stays animated
/// (iOS and Mac composers); it used to go out as a still JPEG.
final class ComposerGIFFitTests: XCTestCase {
    private func properties(_ gif: Data) throws -> (width: Int, height: Int, frames: Int) {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(gif as CFData, nil))
        let first = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return (try XCTUnwrap(first[kCGImagePropertyPixelWidth] as? Int), try XCTUnwrap(first[kCGImagePropertyPixelHeight] as? Int),
                CGImageSourceGetCount(source))
    }

    func testAGIFOverTheSizeLimitIsRedrawnSmallerAndKeepsItsFramesDelaysAndLoopCount() throws {
        let delays = [0.05, 0.2, 0.07, 1.0]
        let gif = try ChatGIFFixture.noisyGIF(frames: 4, width: 480, height: 320, delays: delays, loopCount: 3)
        let limits = ComposerGIFFit.Limits(maxBytes: gif.count / 2, maxDimension: 1024)
        let fitted = try XCTUnwrap(ComposerGIFFit.fitted(gif, limits: limits))
        XCTAssertLessThanOrEqual(fitted.count, limits.maxBytes)
        let size = try properties(fitted)
        XCTAssertEqual(size.frames, 4, "every frame kept")
        XCTAssertLessThan(size.width, 480)
        XCTAssertEqual(Double(size.width) / Double(size.height), 1.5, accuracy: 0.02, "same proportions")
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(fitted))
        for (delay, expected) in zip(animation.delays, delays) {
            XCTAssertEqual(delay, expected, accuracy: 0.011)
        }
        XCTAssertEqual(ChatGIFAnimation.playCount(fitted), 3, "plays as often as the original")
    }

    func testAGIFOverTheDimensionLimitIsRedrawnToTheLongestSide() throws {
        let gif = try ChatGIFFixture.gif(frames: 3, width: 2000, height: 100, loopCount: 0)
        let fitted = try XCTUnwrap(ComposerGIFFit.fitted(gif, limits: ComposerGIFFit.Limits(maxBytes: 3 * 1024 * 1024, maxDimension: 1568)))
        let size = try properties(fitted)
        XCTAssertEqual(size.width, 1568)
        XCTAssertEqual(size.frames, 3)
        XCTAssertEqual(ChatGIFAnimation.playCount(fitted), 0, "loops forever")
        XCTAssertEqual(ChatGIFAnimation.loopBlockCount(fitted), 0)
    }

    func testAGIFWithoutALoopBlockGetsNoneSoItStillLoopsForever() throws {
        let gif = try ChatGIFFixture.gif(frames: 2, width: 1200, height: 60, loopCount: nil)
        XCTAssertNil(ChatGIFAnimation.loopBlockCount(gif))
        let fitted = try XCTUnwrap(ComposerGIFFit.fitted(gif, limits: ComposerGIFFit.Limits(maxBytes: 3 * 1024 * 1024, maxDimension: 1024)))
        XCTAssertNil(ChatGIFAnimation.loopBlockCount(fitted))
        XCTAssertEqual(try properties(fitted).width, 1024)
    }

    func testFramesOverTheMemoryBudgetAreRedrawnSmaller() throws {
        let gif = try ChatGIFFixture.gif(frames: 4, width: 1000, height: 500)
        var limits = ComposerGIFFit.Limits(maxBytes: 3 * 1024 * 1024, maxDimension: 1024)
        // Room for four 400×200 frames.
        limits.maxDecodedBytes = 4 * 400 * 200 * 4
        let fitted = try XCTUnwrap(ComposerGIFFit.fitted(gif, limits: limits))
        let size = try properties(fitted)
        XCTAssertLessThanOrEqual(size.width * size.height * 4 * size.frames, limits.maxDecodedBytes)
        XCTAssertGreaterThan(size.width, 380)
    }

    func testWhatCannotBeFittedIsLeftToTheStillImagePath() throws {
        let limits = ComposerGIFFit.Limits(maxBytes: 3 * 1024 * 1024, maxDimension: 1024)
        XCTAssertNil(ComposerGIFFit.fitted(try ChatGIFFixture.gif(frames: 1, width: 2000, height: 100), limits: limits), "one frame: a still image anyway")
        XCTAssertNil(ComposerGIFFit.fitted(try ChatGIFFixture.png(width: 2000, height: 100), limits: limits))
        XCTAssertNil(ComposerGIFFit.fitted(Data("GIF89a, then nothing".utf8), limits: limits))
        var frames = limits
        frames.maxFrameCount = 3
        XCTAssertNil(ComposerGIFFit.fitted(try ChatGIFFixture.gif(frames: 4, width: 2000, height: 100), limits: frames), "more frames than the chat animates")
        var tiny = limits
        tiny.maxBytes = 200
        XCTAssertNil(ComposerGIFFit.fitted(try ChatGIFFixture.noisyGIF(frames: 3, width: 400, height: 300), limits: tiny), "only fits under the smallest useful size")
    }
}
