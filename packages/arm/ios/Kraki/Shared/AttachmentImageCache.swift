import Foundation
import ImageIO
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Decodes chat images once, bounded in size.
///
/// Image bytes come from agents and other devices. Decoding them with
/// `UIImage(data:)` / `NSImage(data:)` inside a view body re-decoded on every
/// render at full resolution, so a small file with huge pixel dimensions could
/// exhaust memory. Here every image is decoded through ImageIO with its longest
/// side capped, and the result is cached by attachment id.
enum AttachmentImageCache {
    /// Longest side of a decoded chat image, in pixels.
    static let maxPixelSize = 4096

    private static let cache: NSCache<NSString, PlatformImage> = {
        let cache = NSCache<NSString, PlatformImage>()
        cache.totalCostLimit = 256 * 1024 * 1024
        return cache
    }()

    /// The decoded image for an attachment, cached by its id.
    static func image(id: String, data: Data) -> PlatformImage? {
        let key = id as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = decode(data) else { return nil }
        cache.setObject(image, forKey: key, cost: cost(of: image))
        return image
    }

    /// Bounded decode without caching (for callers with their own cache).
    static func decode(_ data: Data) -> PlatformImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        #if canImport(UIKit)
        return UIImage(cgImage: cgImage)
        #else
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        #endif
    }

    // MARK: Animated GIFs

    /// A decode result, kept also when the image is not animated so it is
    /// not decoded again.
    private final class AnimationEntry {
        let animation: ChatGIFAnimation?
        init(_ animation: ChatGIFAnimation?) { self.animation = animation }
    }

    private static let animations: NSCache<NSString, AnimationEntry> = {
        let cache = NSCache<NSString, AnimationEntry>()
        cache.totalCostLimit = 256 * 1024 * 1024
        return cache
    }()

    @MainActor private static var decodingAnimations: [String: Task<ChatGIFAnimation?, Never>] = [:]

    /// The decoded animation of a GIF, if already known (nil also while
    /// decoding, and for a still image).
    @MainActor static func cachedAnimation(id: String) -> ChatGIFAnimation? {
        animations.object(forKey: id as NSString)?.animation
    }

    /// The animation of an animated GIF within `ChatGIFAnimation.Limits`,
    /// decoded off the main thread once per id; nil for anything else.
    @MainActor static func animation(id: String, data: Data) async -> ChatGIFAnimation? {
        guard ChatGIFAnimation.isGIF(data) else { return nil }
        if let entry = animations.object(forKey: id as NSString) { return entry.animation }
        if let running = decodingAnimations[id] { return await running.value }
        let task = Task.detached(priority: .utility) { ChatGIFAnimation.decode(data) }
        decodingAnimations[id] = task
        let animation = await task.value
        decodingAnimations[id] = nil
        animations.setObject(AnimationEntry(animation), forKey: id as NSString, cost: animation?.cost ?? 1)
        return animation
    }

    private static func cost(of image: PlatformImage) -> Int {
        #if canImport(UIKit)
        guard let cg = image.cgImage else { return 1 }
        #else
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return 1 }
        #endif
        return cg.bytesPerRow * cg.height
    }
}
