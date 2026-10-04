#if os(iOS)
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
}

private extension UIView {
    var subviewsDescribe: String {
        ([(self as? UILabel)?.text ?? ""] + subviews.map(\.subviewsDescribe)).joined(separator: " ")
    }
}
#endif
