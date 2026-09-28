import WebKit
import XCTest
@testable import Kraki_Dev

/// show_report renders Mermaid source with the bundled runtime inside the
/// production report CSP, without overriding a report's own Mermaid copy.
@MainActor
final class HTMLReportMermaidTests: XCTestCase {
    private final class Loader: NSObject, WKNavigationDelegate {
        var finished: CheckedContinuation<Void, Never>?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            finished?.resume(); finished = nil
        }
    }

    private func render(_ html: String) async throws -> (webView: WKWebView, svgs: Int, blocks: Int) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        HTMLReportMermaid.install(into: configuration.userContentController, for: html)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 1400), configuration: configuration)
        let loader = Loader()
        webView.navigationDelegate = loader
        await withCheckedContinuation { continuation in
            loader.finished = continuation
            webView.loadHTMLString(HTMLArtifactSecurity.securedHTML(html), baseURL: nil)
        }
        var svgs = 0, blocks = 0
        for _ in 0..<100 {
            let result = try await webView.evaluateJavaScript(
                "[document.querySelectorAll('.mermaid svg').length, document.querySelectorAll('pre.mermaid, div.mermaid').length]"
            ) as? [Int] ?? [0, 0]
            svgs = result[0]; blocks = result[1]
            if svgs >= blocks, blocks > 0 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return (webView, svgs, blocks)
    }

    private func fixture() throws -> String {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "mermaid-complex-report", withExtension: "html"))
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testBundledRuntimeRendersComplexReportUnderReportCSP() async throws {
        XCTAssertNotNil(HTMLReportMermaid.librarySource, "mermaid.min.js must ship in the app bundle")
        let html = try fixture()
        XCTAssertLessThan(html.utf8.count, 16 * 1024, "six complex diagrams stay a few KB as source")
        let (_, svgs, blocks) = try await render(html)
        XCTAssertEqual(blocks, 6)
        XCTAssertEqual(svgs, 6, "every Mermaid block renders to SVG")
    }

    func testPlainReportsGetNoRuntime() {
        let controller = WKUserContentController()
        HTMLReportMermaid.install(into: controller, for: "<html><body><p>text only</p></body></html>")
        XCTAssertTrue(controller.userScripts.isEmpty)
    }

    func testReportThatBringsItsOwnMermaidKeepsIt() async throws {
        let html = """
        <html><head><script>
        window.mermaid = { run: function () { document.body.dataset.own = 'yes'; return Promise.resolve(); },
                           initialize: function () {} };
        </script></head><body><pre class="mermaid">graph TD; A--&gt;B</pre></body></html>
        """
        let (webView, _, _) = try await render(html)
        let own = try await webView.evaluateJavaScript("document.body.dataset.own || ''") as? String
        XCTAssertEqual(own, "yes", "the page's Mermaid object was not replaced by the bundled runtime")
    }

    func testBrowserCopyShipsRuntimeNextToTheReport() throws {
        let ref = ContentRef(type: "content_ref", id: "test-\(UUID().uuidString)", mimeType: "text/html", size: 10, caption: nil, name: "../evil/name.html", width: nil, height: nil)
        let url = try HTMLReportExport.writeBrowserCopy(html: try fixture(), ref: ref)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(url.lastPathComponent, "name.html")
        let written = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(written.contains("<script src=\"kraki-mermaid.min.js\"></script>"))
        XCTAssertFalse(written.contains("Content-Security-Policy"), "the browser copy is the original report")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent("kraki-mermaid.min.js").path))
    }
}
