/// Turns a picked photo into the composer's JPEG attachment.

#if os(iOS)
import UIKit

enum PhotoAttachmentLoad {
    enum Outcome: Equatable {
        case image(Data)
        case unreadable
        case unsupported
        /// Still over the 3 MB cap after compression.
        case tooLarge
    }

    static func jpeg(from data: Data?) -> Outcome {
        guard let data else { return .unreadable }
        guard let uiImage = UIImage(data: data) else { return .unsupported }

        // Pixels, not points: the default renderer format uses the screen
        // scale (3x), which turned a "1024" limit into 3072 px images.
        // 1568 px is the long side vision models use without downscaling.
        let maxDimension: CGFloat = 1568
        let maxSize = 3 * 1024 * 1024

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
                return .image(compressed)
            }
        }
        return .tooLarge
    }
}
#endif
