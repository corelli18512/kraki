/// Turns a picked photo into the composer's attachment: a GIF within the
/// limits as it is, a larger GIF redrawn smaller (both stay animated),
/// anything else as a JPEG.

#if os(iOS)
import ImageIO
import UIKit

enum PhotoAttachmentLoad {
    enum Outcome: Equatable {
        case image(Data, mimeType: String)
        case unreadable
        case unsupported
        /// Still over the 3 MB cap after compression.
        case tooLarge
    }

    // Pixels, not points: the default renderer format uses the screen
    // scale (3x), which turned a "1024" limit into 3072 px images.
    // 1568 px is the long side vision models use without downscaling.
    static let maxDimension: CGFloat = 1568
    static let maxSize = 3 * 1024 * 1024

    static func attachment(from data: Data?) -> Outcome {
        guard let data else { return .unreadable }
        if let gif = gifWithinLimits(data) ?? ComposerGIFFit.fitted(data, limits: gifFit) {
            return .image(gif, mimeType: "image/gif")
        }
        guard let uiImage = UIImage(data: data) else { return .unsupported }

        var targetImage = uiImage
        let pixelWidth = uiImage.size.width * uiImage.scale
        let pixelHeight = uiImage.size.height * uiImage.scale
        if pixelWidth > maxDimension || pixelHeight > maxDimension {
            let ratio = maxDimension / max(pixelWidth, pixelHeight)
            let newSize = CGSize(width: (pixelWidth * ratio).rounded(), height: (pixelHeight * ratio).rounded())
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
            targetImage = renderer.image { _ in uiImage.draw(in: CGRect(origin: .zero, size: newSize)) }
        }

        for quality in [0.8, 0.6] as [CGFloat] {
            if let compressed = targetImage.jpegData(compressionQuality: quality), compressed.count <= maxSize {
                return .image(compressed, mimeType: "image/jpeg")
            }
        }
        return .tooLarge
    }

    /// A larger GIF is redrawn to fit, still animated; one that cannot be
    /// (too many frames, or too small once fitted) goes as a still JPEG.
    static let gifFit = ComposerGIFFit.Limits(maxBytes: maxSize, maxDimension: Int(maxDimension))

    /// A GIF already within the size and dimension limits goes unchanged
    /// (re-encoding with UIKit keeps only its first frame).
    static func gifWithinLimits(_ data: Data) -> Data? {
        guard ChatGIFAnimation.isGIF(data), data.count <= maxSize,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0, max(width, height) <= maxDimension else { return nil }
        return data
    }
}
#endif
