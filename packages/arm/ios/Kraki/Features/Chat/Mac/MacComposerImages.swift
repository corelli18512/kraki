#if os(macOS)
import AppKit

enum MacComposerImages {
    private static let previews = NSCache<NSUUID, NSImage>()

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
