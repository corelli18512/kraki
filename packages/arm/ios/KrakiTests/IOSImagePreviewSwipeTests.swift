#if os(iOS)
import CryptoKit
import XCTest
import SwiftUI
import UIKit
@testable import Kraki

/// The full-screen image preview pages between images by swiping.
@MainActor final class IOSImagePreviewSwipeTests: XCTestCase {
    private func image(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 60, height: 40)).image { ctx in
            color.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 60, height: 40))
        }
    }

    private func labels(_ view: UIView) -> [String] {
        var out: [String] = []
        if let label = view.accessibilityLabel { out.append(label) }
        out += view.subviews.flatMap(labels)
        return out
    }

    private func pager(_ view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView, scroll.isPagingEnabled { return scroll }
        for sub in view.subviews { if let found = pager(sub) { return found } }
        return nil
    }

    func testSwipingPagesThroughImages() throws {
        let items = [UIColor.red, .green, .blue].enumerated().map { index, color in
            IOSImagePreviewItem(id: "img-\(index)", image: image(color), title: "image-\(index + 1).png")
        }
        let host = UIHostingController(rootView: IOSImagePreviewGallery(selection: IOSImagePreviewSelection(items: items)))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.windowLevel = .alert + 1
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))

        let scroll = try XCTUnwrap(pager(host.view), "images are in a horizontally paging view")
        XCTAssertEqual(scroll.contentSize.width, scroll.bounds.width * 3, accuracy: 2)
        func centerColor() -> (CGFloat, CGFloat, CGFloat) {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let cg = image.cgImage!
            let scale = image.scale
            let x = Int(window.bounds.midX * scale), y = Int(window.bounds.midY * scale)
            var pixel = [UInt8](repeating: 0, count: 4)
            let ctx = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(cg, in: CGRect(x: -x, y: y - cg.height + 1, width: cg.width, height: cg.height))
            return (CGFloat(pixel[0]) / 255, CGFloat(pixel[1]) / 255, CGFloat(pixel[2]) / 255)
        }
        let first = centerColor()
        XCTAssertGreaterThan(first.0, 0.8, "page 1 shows the red image")
        scroll.setContentOffset(CGPoint(x: scroll.bounds.width, y: 0), animated: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let second = centerColor()
        XCTAssertGreaterThan(second.1, 0.6, "a swipe shows the green image: \(second)")
        XCTAssertLessThan(second.0, 0.3)
        scroll.setContentOffset(CGPoint(x: scroll.bounds.width * 2, y: 0), animated: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let third = centerColor()
        XCTAssertGreaterThan(third.2, 0.8, "another swipe shows the blue image: \(third)")
    }

    /// A message with two images, the second still downloading: the viewer
    /// opens on the first, swipes to the second (progress), and that page
    /// becomes the image as the chunks land — without reopening.
    func testLoadingImageOpensSwipesAndFillsInPlace() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-preview-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var requested: [Int] = []
        let store = AttachmentStore(cacheDirectory: dir, visibleDwell: 0, chunkTimeout: 30) { _, _, index in
            requested.append(index); return true
        }
        store.setTransportReady(true)
        let png = try XCTUnwrap(image(.green).pngData())
        let id = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined().prefix(32).description
        let items = [
            IOSImagePreviewItem(id: "first", image: image(.red), title: "first.png"),
            IOSImagePreviewItem(attachmentID: id, title: "second.png"),
        ]
        let selection = IOSImagePreviewSelection(items: items, initialIndex: 0, attachmentStore: store, sessionId: "s")
        let host = UIHostingController(rootView: IOSImagePreviewGallery(selection: selection))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.windowLevel = .alert + 1
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        XCTAssertEqual(requested, [0], "opening the viewer starts the loading neighbour")

        let scroll = try XCTUnwrap(pager(host.view))
        XCTAssertEqual(scroll.contentSize.width, scroll.bounds.width * 2, accuracy: 2, "both images are pages")
        scroll.setContentOffset(CGPoint(x: scroll.bounds.width, y: 0), animated: false)
        let half = png.count / 2
        store.ingestChunk(id: id, index: 0, total: 2, mimeType: "image/png",
                          data: png.prefix(half).base64EncodedString(), error: nil, paced: true)
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let loading = centerGreen(snapshot(window, "kraki-preview-loading.png"))
        XCTAssertLessThan(loading, 0.3, "the second page shows progress, not an image yet")

        store.ingestChunk(id: id, index: 1, total: 2, mimeType: "image/png",
                          data: png.suffix(from: half).base64EncodedString(), error: nil, paced: true)
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        let loaded = centerGreen(snapshot(window, "kraki-preview-loaded.png"))
        XCTAssertGreaterThan(loaded, 0.6, "the page became the image in place")
    }

    private func snapshot(_ window: UIWindow, _ name: String) -> UIImage {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name))
        return image
    }

    /// Green channel at the centre of a screenshot.
    private func centerGreen(_ image: UIImage) -> CGFloat {
        let cg = image.cgImage!
        let x = cg.width / 2, y = cg.height / 2
        var pixel = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: -x, y: y - cg.height + 1, width: cg.width, height: cg.height))
        return CGFloat(pixel[1]) / 255
    }
}

private extension UIView {
    var subviewsDescribe: String {
        ([(self as? UILabel)?.text ?? ""] + subviews.map(\.subviewsDescribe)).joined(separator: " ")
    }
}
#endif
