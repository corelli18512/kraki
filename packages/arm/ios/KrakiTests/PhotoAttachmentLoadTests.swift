import XCTest
import UIKit
@testable import Kraki

/// 2-15 (review group 2, 2026-10-13) moved photo compression out of the
/// composer so its load can be checked against the current pick. A GIF
/// within the limits is attached as it is, so it stays animated.
final class PhotoAttachmentLoadTests: XCTestCase {
    func testOutcomes() throws {
        XCTAssertEqual(PhotoAttachmentLoad.attachment(from: nil), .unreadable)
        XCTAssertEqual(PhotoAttachmentLoad.attachment(from: Data("not an image".utf8)), .unsupported)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let png = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: format)
            .pngData { context in
                UIColor.systemTeal.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
            }
        guard case .image(let jpeg, let mimeType) = PhotoAttachmentLoad.attachment(from: png) else { return XCTFail("not attached") }
        XCTAssertEqual(mimeType, "image/jpeg")
        let image = try XCTUnwrap(UIImage(data: jpeg))
        XCTAssertEqual(image.size.width * image.scale, 1568, accuracy: 1, "long side capped in pixels")
    }

    func testAnimatedGIFIsAttachedUnchanged() throws {
        let gif = try ChatGIFFixture.gif(frames: 3, width: 200, height: 100)
        XCTAssertEqual(PhotoAttachmentLoad.attachment(from: gif), .image(gif, mimeType: "image/gif"))
    }

    func testGIFOverTheLimitsIsRedrawnToFitAndStaysAnimated() throws {
        let gif = try ChatGIFFixture.gif(frames: 2, width: 2000, height: 100)
        guard case .image(let data, let mimeType) = PhotoAttachmentLoad.attachment(from: gif) else { return XCTFail("not attached") }
        XCTAssertEqual(mimeType, "image/gif")
        let animation = try XCTUnwrap(ChatGIFAnimation.decode(data), "still animated")
        XCTAssertEqual(animation.frames.count, 2)
        XCTAssertEqual(animation.frames[0].width, 1568, "long side capped in pixels")
    }

    func testGIFThatCannotBeFittedIsSentAsAStillJPEG() throws {
        let gif = try ChatGIFFixture.gif(frames: 1, width: 2000, height: 100)
        guard case .image(let data, let mimeType) = PhotoAttachmentLoad.attachment(from: gif) else { return XCTFail("not attached") }
        XCTAssertEqual(mimeType, "image/jpeg")
        XCTAssertNotEqual(data, gif)
    }

    /// A cancelled load (×, a newer pick, send) skips the still-image fallback
    /// instead of decoding and JPEG-encoding a photo nobody will use.
    func testACancelledLoadSkipsTheStillImageFallback() async throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let png = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: format)
            .pngData { context in
                UIColor.systemTeal.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
            }
        let load = { (cancelled: Bool) async -> PhotoAttachmentLoad.Outcome in
            await Task.detached { () -> PhotoAttachmentLoad.Outcome in
                if cancelled { withUnsafeCurrentTask { $0?.cancel() } }
                return PhotoAttachmentLoad.attachment(from: png)
            }.value
        }
        guard case .image(_, let mimeType) = await load(false) else { return XCTFail("not attached when not cancelled") }
        XCTAssertEqual(mimeType, "image/jpeg")
        let cancelledOutcome = await load(true)
        XCTAssertEqual(cancelledOutcome, .unreadable, "a cancelled load stops before the JPEG fallback")
    }
}
