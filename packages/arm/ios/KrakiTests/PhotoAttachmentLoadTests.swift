import XCTest
import UIKit
@testable import Kraki

/// 2-15 (review group 2, 2026-10-13) moved photo compression out of the
/// composer so its load can be checked against the current pick; the
/// compression itself is unchanged.
final class PhotoAttachmentLoadTests: XCTestCase {
    func testOutcomes() throws {
        XCTAssertEqual(PhotoAttachmentLoad.jpeg(from: nil), .unreadable)
        XCTAssertEqual(PhotoAttachmentLoad.jpeg(from: Data("not an image".utf8)), .unsupported)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let png = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: format)
            .pngData { context in
                UIColor.systemTeal.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
            }
        guard case .image(let jpeg) = PhotoAttachmentLoad.jpeg(from: png) else { return XCTFail("not attached") }
        let image = try XCTUnwrap(UIImage(data: jpeg))
        XCTAssertEqual(image.size.width * image.scale, 1568, accuracy: 1, "long side capped in pixels")
    }
}
