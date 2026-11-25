#if os(iOS)
import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// The chat header's expanded mode picker follows a mode change made
/// elsewhere (another device, the computer) while it is open (K-046).
@MainActor
final class HeaderModePickerTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func segmentedControl(in view: UIView) -> UISegmentedControl? {
        if let control = view as? UISegmentedControl { return control }
        for sub in view.subviews { if let found = segmentedControl(in: sub) { return found } }
        return nil
    }

    private func rgba(_ color: UIColor?, _ view: UIView) -> [Int] {
        guard let resolved = color?.resolvedColor(with: view.traitCollection) else { return [] }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return [r, g, b, a].map { Int(($0 * 255).rounded()) }
    }

    /// Which third of the control the coloured thumb is drawn in, from the
    /// pixels on screen (the property alone does not prove the lens moved).
    /// The track and labels are white/grey/black: any saturated pixel is thumb.
    private func thumbSegment(_ control: UISegmentedControl, _ window: UIWindow) -> Int? {
        let frame = control.convert(control.bounds, to: window)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return nil }
        let bpp = cg.bitsPerPixel / 8
        var hits = [0, 0, 0]
        for y in Int(frame.minY)..<Int(frame.maxY) {
            for x in Int(frame.minX)..<Int(frame.maxX) {
                let o = y * cg.bytesPerRow + x * bpp
                let c = [Int(bytes[o]), Int(bytes[o + 1]), Int(bytes[o + 2])]
                if (c.max() ?? 0) - (c.min() ?? 0) > 60 {
                    hits[min(2, Int((CGFloat(x) - frame.minX) * 3 / frame.width))] += 1
                }
            }
        }
        guard let best = hits.max(), best > 50 else { return nil }
        return hits.firstIndex(of: best)
    }

    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    }

    func testExpandedPickerFollowsARemoteModeChange() throws {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("mode-picker-\(UUID().uuidString).sqlite")))
        let sid = "s1"
        app.sessionStore.setMode(sid, .auto)
        let host = UIHostingController(rootView: HeaderModePicker(sessionId: sid, expanded: .constant(true))
            .environment(app)
            .frame(width: 320))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 200)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        settle()
        let control = try XCTUnwrap(segmentedControl(in: host.view))
        XCTAssertEqual(control.selectedSegmentIndex, SessionMode.allCases.firstIndex(of: .auto))
        XCTAssertEqual(thumbSegment(control, window),
                       SessionMode.allCases.firstIndex(of: .auto), "thumb drawn for auto")

        // What `session_mode_set` from another device does.
        for mode in [SessionMode.safe, .delegate] {
            app.sessionStore.setSessionMode(sid, mode: mode.rawValue)
            settle()
            XCTAssertEqual(control.selectedSegmentIndex, SessionMode.allCases.firstIndex(of: mode), "\(mode)")
            XCTAssertEqual(rgba(control.selectedSegmentTintColor, control), rgba(UIColor(Color.modeColor(mode)), control), "\(mode)")
            XCTAssertEqual(thumbSegment(control, window),
                           SessionMode.allCases.firstIndex(of: mode), "thumb drawn for \(mode)")
        }
    }
}
#endif
