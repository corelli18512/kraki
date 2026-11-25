/// A GIF too large for the composer, made to fit and kept animated (iOS and
/// Mac composers).

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Redraws every frame of a GIF smaller with ImageIO, keeping each frame's
/// delay and the GIF's loop count, until the file fits the composer's size
/// and longest-side limits. Without this a GIF over the limits went out as a
/// still JPEG of its first frame.
///
/// Bounded like the chat's own GIF decoding (`ChatGIFAnimation.Limits`): a
/// GIF with more frames than the chat animates, or one whose redrawn frames
/// would not fit the memory budget at a useful size, is not fitted (nil),
/// and the composer sends a still image as before. ImageIO holds every
/// frame until the file is written, so the budget bounds the memory used.
enum ComposerGIFFit {
    struct Limits {
        /// Largest file.
        var maxBytes: Int
        /// Longest side, in pixels.
        var maxDimension: Int
        /// More frames than this (the chat shows such a GIF still anyway).
        var maxFrameCount = ChatGIFAnimation.Limits.chat.maxFrameCount
        /// All redrawn frames together, 4 bytes a pixel.
        var maxDecodedBytes = ChatGIFAnimation.Limits.chat.maxDecodedBytes
        /// Fitting would make the longest side smaller than this: not fitted.
        var minPixelSize = 160
        /// Sizes tried before giving up.
        var attempts = 4
    }

    /// The GIF redrawn to fit `limits`, or nil (not an animated GIF, or it
    /// cannot be fitted within the limits).
    static func fitted(_ data: Data, limits: Limits) -> Data? {
        guard ChatGIFAnimation.isGIF(data),
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1, count <= limits.maxFrameCount,
              let size = pixelSize(source),
              var side = startingSide(source: size, frameCount: count, limits: limits)
        else { return nil }
        for _ in 0..<limits.attempts {
            guard let encoded = encode(source, frameCount: count, longestSide: side, loopBlockCount: ChatGIFAnimation.loopBlockCount(data)) else { return nil }
            if encoded.count <= limits.maxBytes { return encoded }
            // File size follows the pixel count: shrink both sides by the
            // square root of the overshoot, with a margin.
            side = Int((Double(side) * (Double(limits.maxBytes) / Double(encoded.count)).squareRoot() * 0.9).rounded(.down))
            guard side >= limits.minPixelSize else { return nil }
        }
        return nil
    }

    /// The longest side to try first: the GIF's own, capped by the
    /// dimension limit and the memory budget; nil under `minPixelSize`.
    static func startingSide(source: CGSize, frameCount: Int, limits: Limits) -> Int? {
        var budget = ChatGIFAnimation.Limits.chat
        budget.maxDecodedBytes = limits.maxDecodedBytes
        budget.maxPixelSize = limits.maxDimension
        budget.minPixelSize = limits.minPixelSize
        guard let side = ChatGIFAnimation.decodedLongestSide(source: source, frameCount: frameCount, limits: budget),
              side >= min(limits.minPixelSize, Int(max(source.width, source.height)))
        else { return nil }
        return side
    }

    private static func encode(_ source: CGImageSource, frameCount: Int, longestSide: Int, loopBlockCount: Int?) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.gif.identifier as CFString, frameCount, nil) else { return nil }
        // ImageIO counts plays (0: forever) and stores plays − 1; a GIF
        // without a loop block gets none (Kraki loops it forever).
        if let loopBlockCount {
            CGImageDestinationSetProperties(destination, [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: loopBlockCount == 0 ? 0 : loopBlockCount + 1],
            ] as CFDictionary)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longestSide,
        ]
        for index in 0..<frameCount {
            guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { return nil }
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let delay = storedDelay(properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any])
            CGImageDestinationAddImage(destination, frame, [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay],
            ] as CFDictionary)
        }
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }

    /// The frame's own delay as stored (ImageIO's unclamped one; 0 stays 0,
    /// which players show for 100 ms like any delay of 10 ms or less).
    private static func storedDelay(_ gif: [CFString: Any]?) -> Double {
        let unclamped = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue
        return unclamped ?? (gif?[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue ?? 0
    }

    private static func pixelSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }
}
