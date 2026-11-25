#if os(macOS)
import AppKit
import ImageIO

enum MacComposerImages {
    private static let previews = NSCache<NSUUID, NSImage>()

    /// Largest file and longest side the composer sends (after compression).
    static let maxSize = 3 * 1024 * 1024
    static let maxDimension: CGFloat = 1024

    /// Key of the GIF bytes an image was read from (picked file, pasted or
    /// dropped file or data), kept on the image itself so they go with it
    /// and it can be sent as is, still animated.
    private static var gifSourceKey: UInt8 = 0

    /// An image file to attach; remembers a GIF's bytes.
    static func image(contentsOf url: URL) -> NSImage? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return image(data: data)
    }

    /// Image data to attach (pasteboard); remembers a GIF's bytes when it
    /// can be sent as is (a larger GIF becomes a still JPEG anyway).
    static func image(data: Data) -> NSImage? {
        guard let image = NSImage(data: data) else { return nil }
        if ChatGIFAnimation.isGIF(data), data.count <= maxSize,
           let size = pixelSize(data), max(size.width, size.height) <= maxDimension {
            objc_setAssociatedObject(image, &gifSourceKey, data as NSData, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
        return image
    }

    /// The GIF bytes `image` was read from, when it is sent as is.
    static func gifSource(of image: NSImage) -> NSData? {
        objc_getAssociatedObject(image, &gifSourceKey) as? NSData
    }

    /// What the composer stages for `image`: a GIF within the limits as it
    /// is (re-encoding keeps only its first frame), anything else as a JPEG
    /// of at most `maxDimension`; nil when even that is over `maxSize`.
    static func staged(_ image: NSImage) -> StagedComposerImage? {
        if let gif = gifSource(of: image) as Data? {
            return StagedComposerImage(data: gif, mimeType: "image/gif")
        }
        for quality in [0.8, 0.6] {
            if let data = jpegData(from: image, maxDimension: maxDimension, quality: quality), data.count <= maxSize {
                return StagedComposerImage(data: data, mimeType: "image/jpeg")
            }
        }
        return nil
    }

    private static func pixelSize(_ data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue else { return nil }
        return CGSize(width: width, height: height)
    }

    /// The thumbnail of a staged image, decoded once per attachment rather
    /// than on every composer update.
    static func preview(_ image: StagedComposerImage) -> NSImage? {
        if let cached = previews.object(forKey: image.id as NSUUID) { return cached }
        guard let decoded = NSImage(data: image.data) else { return nil }
        previews.setObject(decoded, forKey: image.id as NSUUID)
        return decoded
    }

    static func jpegData(from image: NSImage, maxDimension: CGFloat, quality: CGFloat) -> Data? {
        let source = image.size
        guard source.width > 0, source.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(source.width, source.height))
        let target = NSSize(width: max(1, source.width * scale), height: max(1, source.height * scale))
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(target.width.rounded()),
            pixelsHigh: Int(target.height.rounded()),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        bitmap.size = target
        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            NSGraphicsContext.restoreGraphicsState()
            return nil
        }
        NSGraphicsContext.current = context
        image.draw(
            in: NSRect(origin: .zero, size: target),
            from: NSRect(origin: .zero, size: source),
            operation: .copy,
            fraction: 1
        )
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality])
    }
}
#endif
