#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// The Accounts refresh button is disabled most of the time (60 s cool-down
/// after the page's own automatic refresh, or while disconnected). It must
/// still read as a button on the real grouped-list background, light and dark.
@MainActor
final class UsageRefreshButtonVisibilityTests: XCTestCase {
    private func luminance(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGFloat {
        func c(_ v: CGFloat) -> CGFloat { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
    }

    /// Strongest glyph contrast against the background, and disc contrast.
    private func measure(_ style: UIUserInterfaceStyle, busy: Bool = false, ready: Bool, available: Bool? = nil) throws -> (glyph: CGFloat, disc: CGFloat) {
        let view = UsageRefreshButton(busy: busy, ready: ready, available: available) {}
            .padding(30)
            .background(Color(uiColor: .systemGroupedBackground))
        let host = UIHostingController(rootView: view)
        host.overrideUserInterfaceStyle = style
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = style
        window.frame = CGRect(x: 0, y: 0, width: 120, height: 120)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let cg = try XCTUnwrap(image.cgImage)
        let w = cg.width, h = cg.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        func lum(_ x: Int, _ y: Int) -> CGFloat {
            let i = (y * w + x) * 4
            return luminance(CGFloat(px[i]) / 255, CGFloat(px[i + 1]) / 255, CGFloat(px[i + 2]) / 255)
        }
        func ratio(_ a: CGFloat, _ b: CGFloat) -> CGFloat { (max(a, b) + 0.05) / (min(a, b) + 0.05) }
        // The grouped-list background just above the button.
        let background = lum(w / 2, 4)
        var glyph: CGFloat = 1, disc: CGFloat = 1
        for y in 0..<h { for x in 0..<w {
            let r = ratio(lum(x, y), background)
            glyph = max(glyph, r)
            if r < 1.6 { disc = max(disc, r) }   // the disc fill, not the glyph stroke
        } }
        return (glyph, disc)
    }

    func testDisabledRefreshStaysVisibleInLightAndDark() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = style == .dark ? "dark" : "light"
            let enabled = try measure(style, ready: true)
            let coolingDown = try measure(style, ready: false, available: true)
            let unavailable = try measure(style, ready: false, available: false)
            let line = "VISIBILITY \(name) enabled=\(enabled.glyph) cooldown=\(coolingDown.glyph) unavailable=\(unavailable.glyph)\n"
            add(XCTAttachment(string: line))
            // Cool-down is the usual state after the page's automatic refresh: it must look normal.
            XCTAssertEqual(coolingDown.glyph, enabled.glyph, accuracy: 0.05, "cool-down looks like the normal button (\(name))")
            // Unavailable may be quieter but never vanish (WCAG non-text contrast 3:1).
            XCTAssertGreaterThanOrEqual(unavailable.glyph, 3.0, "unavailable arrow visible (\(name))")
            XCTAssertLessThan(unavailable.glyph, enabled.glyph, "unavailable still reads as inactive (\(name))")
        }
    }

}
#endif
