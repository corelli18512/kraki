import SwiftUI
import WebKit
import XCTest
@testable import Kraki

#if os(iOS)
/// The iOS show_report viewer: its sheet chrome in dark mode, in-page links,
/// and the Mermaid theme on dark reports. Isolated AppState, no network.
@MainActor
final class IOSHTMLReportViewerTests: XCTestCase {
    private var windows: [UIWindow] = []
    private var states: [AppState] = []
    private var roots: [URL] = []

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        states.removeAll()
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    /// K-056: while a report renders, the dark sheet must not turn white,
    /// neither behind the progress text nor under the navigation bar (where a
    /// white backdrop hid the white title for as long as the report was open).
    func testDarkReportSheetHasNoWhiteBackdropWhileRendering() throws {
        // Sanity: the capture sees the sheet (light mode is bright).
        let light = try renderRenderingSheet(style: .light)
        XCTAssertGreaterThan(try XCTUnwrap(luminance(of: light, at: CGPoint(x: 201, y: 600))), 0.8)

        let dark = try renderRenderingSheet(style: .dark)
        // Top band (status/navigation bar, where the title sits) and the middle.
        for point in [CGPoint(x: 40, y: 20), CGPoint(x: 40, y: 80), CGPoint(x: 201, y: 600)] {
            let luma = try XCTUnwrap(luminance(of: dark, at: point))
            XCTAssertLessThan(luma, 0.5, "dark sheet at \(point) must not be white while rendering (luma \(luma))")
        }
    }

    /// The report sheet in its "Rendering report…" phase, captured on screen.
    private func renderRenderingSheet(style: UIUserInterfaceStyle) throws -> UIImage {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("report-viewer-\(UUID().uuidString)")
        roots.append(root)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        states.append(app)
        let html = "<!doctype html><html><body><h1>Report</h1></body></html>"
        let data = Data(html.utf8)
        let id = String(repeating: "a", count: 64)
        app.attachmentStore.seedForTesting(id: id, mimeType: "text/html", data: data)
        let ref = ContentRef(type: "content_ref", id: id, mimeType: "text/html", size: data.count,
                             caption: "Weekly report", name: "report.html", width: nil, height: nil)
        let host = UIHostingController(
            rootView: IOSHTMLArtifactPreview(selection: IOSSelectedHTMLArtifact(sessionId: "s", ref: ref))
                .environment(app)
        )
        // On the app's real scene so Core Animation renders what we sample.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.makeKeyAndVisible()
        windows.append(window)
        host.view.layoutIfNeeded()
        // Well before the web view reports ready (0.45 s after didFinish).
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }

    /// K-163: `<a href="#…">` inside a report scrolls to its target.
    func testInPageAnchorLinkScrollsTheReport() async throws {
        let html = """
        <!doctype html><html><body style="margin:0">
        <a id="go" href="#target">Go to the end</a>
        <div style="height:4000px"></div>
        <h2 id="target">End</h2>
        </body></html>
        """
        let (webView, _) = try await load(html)
        _ = try await webView.evaluateJavaScript("document.getElementById('go').click(); 0")
        var scrolled = 0.0
        for _ in 0..<50 {
            scrolled = (try await webView.evaluateJavaScript("window.scrollY") as? Double) ?? 0
            if scrolled > 1_000 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertGreaterThan(scrolled, 1_000, "the anchor link must scroll to its target")
    }

    /// K-166: a dark report gets Mermaid's dark theme; a light one keeps the default.
    func testMermaidThemeFollowsTheReportBackground() async throws {
        let cases = [
            ("#111418", "dark"), ("#ffffff", "default"),
            // CSS Color 4 values keep their own syntax in computed style (Tailwind v4 is oklch).
            ("oklch(0.985 0.002 247.8)", "default"), ("oklch(0.2 0.01 250)", "dark"),
            ("color(display-p3 1 1 1)", "default"),
        ]
        for (background, theme) in cases {
            let html = """
            <!doctype html><html><body style="background:\(background)">
            <script>window.mermaid = { initialize: function (c) { window.__mermaidConfig = c; },
              run: function () { return Promise.resolve(); } };</script>
            <pre class="mermaid">graph TD; A-->B</pre>
            </body></html>
            """
            let (webView, _) = try await load(html)
            _ = try await webView.evaluateJavaScript(HTMLReportMermaid.bootSource + "; 0")
            let chosen = try await webView.evaluateJavaScript("window.__mermaidConfig && window.__mermaidConfig.theme") as? String
            XCTAssertEqual(chosen, theme, "background \(background)")
        }
    }

    // MARK: Helpers

    /// Loads `html` through the production report web view coordinator.
    private func load(_ html: String) async throws -> (WKWebView, IOSHTMLArtifactWebView.Coordinator) {
        var ready = false
        let coordinator = IOSHTMLArtifactWebView.Coordinator(onReady: { ready = true }, onContentProcessFailure: {})
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 700), configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        let controller = UIViewController()
        controller.view.addSubview(webView)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        windows.append(window)
        coordinator.load(html: HTMLArtifactSecurity.securedHTML(html), artifactID: UUID().uuidString, into: webView)
        for _ in 0..<100 where !ready { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(ready, "report finished loading")
        return (webView, coordinator)
    }

    private func luminance(of image: UIImage, at point: CGPoint) -> CGFloat? {
        guard let cgImage = image.cgImage else { return nil }
        let scale = image.scale
        let x = Int(point.x * scale), y = Int(point.y * scale)
        guard x < cgImage.width, y < cgImage.height,
              let cropped = cgImage.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (0.2126 * CGFloat(pixel[0]) + 0.7152 * CGFloat(pixel[1]) + 0.0722 * CGFloat(pixel[2])) / 255
    }
}
#endif
