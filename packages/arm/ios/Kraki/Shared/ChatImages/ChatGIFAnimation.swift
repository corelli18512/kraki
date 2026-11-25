/// Animated GIFs in chat (iOS and Mac): decoding into bounded frames and the
/// frame shown at a point in time.

import CoreGraphics
import Foundation
import ImageIO

/// An animated GIF decoded through ImageIO into frames held in memory.
///
/// Bounded like `AttachmentImageCache`'s still images: a GIF with too many
/// frames, or one whose frames would not fit the memory budget even at a
/// reduced size, is not animated (the chat shows its first frame instead).
final class ChatGIFAnimation: @unchecked Sendable {
    struct Limits {
        /// More frames than this: shown still.
        var maxFrameCount = 300
        /// Decoded size of all frames together (4 bytes a pixel). Larger
        /// GIFs are decoded smaller to fit.
        var maxDecodedBytes = 64 * 1024 * 1024
        /// Longest side of a decoded frame.
        var maxPixelSize = AttachmentImageCache.maxPixelSize
        /// Fitting the budget would make the frames smaller than this
        /// (longest side, and the GIF itself is larger): shown still.
        var minPixelSize = 240

        static let chat = Limits()
    }

    let frames: [CGImage]
    /// How long each frame stays, in seconds.
    let delays: [TimeInterval]
    /// How many times the animation plays; 0 means forever
    /// (`playCount(_:)`).
    let loopCount: Int
    /// One pass through all frames.
    let duration: TimeInterval

    /// Decoded bytes, for the cache's cost.
    var cost: Int { frames.reduce(0) { $0 + $1.bytesPerRow * $1.height } }

    init(frames: [CGImage], delays: [TimeInterval], loopCount: Int) {
        self.frames = frames
        self.delays = delays
        self.loopCount = max(0, loopCount)
        self.duration = delays.reduce(0, +)
    }

    /// GIF87a / GIF89a signature.
    static func isGIF(_ data: Data) -> Bool {
        let head = [UInt8](data.prefix(6))
        return head == Array("GIF87a".utf8) || head == Array("GIF89a".utf8)
    }

    /// The animation, or nil for anything that is not a GIF of at least two
    /// frames within the limits.
    static func decode(_ data: Data, limits: Limits = .chat) -> ChatGIFAnimation? {
        guard isGIF(data),
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1, count <= limits.maxFrameCount,
              let size = pixelSize(source),
              let side = decodedLongestSide(source: size, frameCount: count, limits: limits)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        var frames: [CGImage] = []
        var delays: [TimeInterval] = []
        frames.reserveCapacity(count)
        for index in 0..<count {
            guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { return nil }
            frames.append(frame)
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            delays.append(frameDelay(properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]))
        }
        return ChatGIFAnimation(frames: frames, delays: delays, loopCount: playCount(data))
    }

    /// How many times a GIF plays (0: forever), from its loop block
    /// (NETSCAPE2.0, or its ANIMEXTS1.0 twin): a count of 0 loops forever,
    /// a count n plays the animation n more times after the first pass, so
    /// n + 1 times (as Chromium, WebKit and Firefox play it; ImageIO's
    /// kCGImagePropertyGIFLoopCount reports the same). A GIF without a loop
    /// block loops forever in Kraki on every client (browsers would play it
    /// once; the web client gives it a loop-forever block to show it).
    ///
    /// Read from the bytes, not from ImageIO, which reports a missing block
    /// as one pass and takes NETSCAPE2.0's buffering sub-block (id 2) for a
    /// loop count.
    static func playCount(_ data: Data) -> Int {
        data.withUnsafeBytes { raw -> Int in
            let bytes = raw.bindMemory(to: UInt8.self)
            guard isGIF(data), bytes.count >= 13 else { return 0 }
            func colorTableSize(_ packed: UInt8) -> Int { packed & 0x80 != 0 ? 3 << (Int(packed & 0x07) + 1) : 0 }
            /// Index after the data sub-blocks starting at `index`.
            func skipSubBlocks(_ index: Int) -> Int {
                var index = index
                while index < bytes.count, bytes[index] != 0 { index += Int(bytes[index]) + 1 }
                return index + 1
            }
            var index = 13 + colorTableSize(bytes[10])
            while index < bytes.count {
                switch bytes[index] {
                case 0x21: // extension
                    if index + 16 <= bytes.count, bytes[index + 1] == 0xFF, bytes[index + 2] == 0x0B,
                       let identifier = String(bytes: bytes[(index + 3)..<(index + 14)], encoding: .ascii),
                       identifier == "NETSCAPE2.0" || identifier == "ANIMEXTS1.0",
                       bytes[index + 14] >= 3, bytes[index + 15] == 0x01, index + 18 <= bytes.count {
                        let count = Int(bytes[index + 16]) | Int(bytes[index + 17]) << 8
                        return count == 0 ? 0 : count + 1
                    }
                    index = skipSubBlocks(index + 2)
                case 0x2C: // image: descriptor, local colour table, LZW code size, pixels
                    guard index + 10 <= bytes.count else { return 0 }
                    index = skipSubBlocks(index + 10 + colorTableSize(bytes[index + 9]) + 1)
                default: // trailer, or not a GIF block
                    return 0
                }
            }
            return 0
        }
    }

    /// The longest side to decode frames at: the GIF's own (capped), or
    /// smaller so all frames fit the memory budget; nil when that would be
    /// too small to be worth animating.
    static func decodedLongestSide(source: CGSize, frameCount: Int, limits: Limits) -> Int? {
        let longest = max(source.width, source.height)
        guard longest > 0, source.width > 0, source.height > 0 else { return nil }
        var side = min(longest, CGFloat(limits.maxPixelSize))
        let bytesAtSide = { (side: CGFloat) -> CGFloat in
            let scale = side / longest
            return (source.width * scale).rounded(.up) * (source.height * scale).rounded(.up) * 4 * CGFloat(frameCount)
        }
        if bytesAtSide(side) > CGFloat(limits.maxDecodedBytes) {
            side = (side * (CGFloat(limits.maxDecodedBytes) / bytesAtSide(side)).squareRoot()).rounded(.down)
            while side > 1, bytesAtSide(side) > CGFloat(limits.maxDecodedBytes) { side -= 1 }
            guard side >= CGFloat(limits.minPixelSize) else { return nil }
        }
        return max(1, Int(side))
    }

    /// A frame's delay like browsers: the unclamped delay, else the clamped
    /// one; 10 ms or less (or none) means 100 ms.
    static func frameDelay(_ gif: [CFString: Any]?) -> TimeInterval {
        let unclamped = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue ?? 0
        let clamped = (gif?[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue ?? 0
        let delay = unclamped > 0 ? unclamped : clamped
        return delay <= 0.010 + 1e-9 ? 0.1 : delay
    }

    /// The frame shown `elapsed` seconds after playback started. Once a
    /// finite loop count has played, the last frame stays.
    func frameIndex(at elapsed: TimeInterval) -> Int {
        guard frames.count > 1, duration > 0 else { return 0 }
        if hasFinished(at: elapsed) { return frames.count - 1 }
        var time = max(0, elapsed).truncatingRemainder(dividingBy: duration)
        for (index, delay) in delays.enumerated() {
            if time < delay { return index }
            time -= delay
        }
        return frames.count - 1
    }

    /// Seconds from `elapsed` until the next frame change, nil once
    /// playback has finished.
    func timeUntilNextFrame(at elapsed: TimeInterval) -> TimeInterval? {
        guard frames.count > 1, duration > 0, !hasFinished(at: elapsed) else { return nil }
        let time = max(0, elapsed).truncatingRemainder(dividingBy: duration)
        var end: TimeInterval = 0
        for delay in delays {
            end += delay
            if time < end { return max(0.001, end - time) }
        }
        return max(0.001, duration - time)
    }

    func hasFinished(at elapsed: TimeInterval) -> Bool {
        loopCount > 0 && elapsed >= duration * TimeInterval(loopCount)
    }

    private static func pixelSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }
}
