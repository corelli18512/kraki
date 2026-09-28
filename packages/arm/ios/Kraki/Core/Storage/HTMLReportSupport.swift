import Foundation
import WebKit

/// Client-side rendering support for `show_report` HTML reports.
///
/// Reports are text-first: diagrams arrive as Mermaid *source*
/// (`<pre class="mermaid">…</pre>`), never as screenshots or an inlined
/// 3.5 MB library. The app bundles the Mermaid runtime and injects it only
/// into reports that contain Mermaid blocks, after the page's own scripts —
/// so a legacy report that already inlined Mermaid keeps its own copy.
enum HTMLReportMermaid {
    private static let markerRegex = try? NSRegularExpression(
        pattern: #"class\s*=\s*["'][^"']*\bmermaid\b|language-mermaid"#,
        options: [.caseInsensitive]
    )

    /// True when the report contains Mermaid blocks to render.
    static func containsMermaid(_ html: String) -> Bool {
        guard let markerRegex else { return false }
        return markerRegex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)) != nil
    }

    /// Bundled runtime (MIT, see Resources/Mermaid/LICENSE-mermaid.txt).
    static let librarySource: String? = {
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }()

    /// Renders every Mermaid block once the document is parsed. Uses
    /// `strict` security (no HTML labels with script, no click callbacks).
    static let bootSource = """
    (function () {
      var selector = 'pre.mermaid, div.mermaid, code.language-mermaid';
      if (!(window.mermaid && typeof window.mermaid.run === 'function') || !document.querySelector(selector)) return;
      document.querySelectorAll('code.language-mermaid').forEach(function (code) {
        var pre = code.parentElement && code.parentElement.tagName === 'PRE' ? code.parentElement : code;
        pre.classList.add('mermaid');
        pre.textContent = code.textContent;
      });
      try {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        window.mermaid.run({ querySelector: 'pre.mermaid:not([data-processed]), div.mermaid:not([data-processed])' })
          .catch(function () {});
      } catch (e) {}
    })();
    """

    /// Adds the runtime to a web view configuration for `html`, if needed.
    static func install(into controller: WKUserContentController, for html: String) {
        guard containsMermaid(html), let library = librarySource else { return }
        // Load only when the page did not bring its own Mermaid.
        let guarded = "if (!(window.mermaid && typeof window.mermaid.run === 'function')) {\n" + library + "\n}"
        controller.addUserScript(WKUserScript(source: guarded, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: bootSource, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }
}

/// "Open in Browser" fallback: a standalone copy of the report outside the
/// sandboxed viewer, for content that really needs a browser.
enum HTMLReportExport {
    static let runtimeFileName = "kraki-mermaid.min.js"

    /// Writes `<tmp>/Kraki Reports/<id>/<name>.html` (the agent's original
    /// HTML, without the viewer's CSP) and, when the report relies on Kraki
    /// to render Mermaid, places the runtime next to it.
    static func writeBrowserCopy(html: String, ref: ContentRef) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("Kraki Reports", isDirectory: true)
            .appendingPathComponent(String(ref.id.prefix(32)), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var page = html
        if HTMLReportMermaid.containsMermaid(html),
           !html.localizedCaseInsensitiveContains("mermaid.initialize"),
           let library = HTMLReportMermaid.librarySource {
            try library.write(to: folder.appendingPathComponent(runtimeFileName), atomically: true, encoding: .utf8)
            let tag = "<script src=\"\(runtimeFileName)\"></script><script>\(HTMLReportMermaid.bootSource)</script>"
            if let range = page.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
                page.insert(contentsOf: tag, at: range.lowerBound)
            } else {
                page += tag
            }
        }
        let url = folder.appendingPathComponent(fileName(for: ref))
        try page.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    static func fileName(for ref: ContentRef) -> String {
        let raw = (ref.name ?? "report.html").trimmingCharacters(in: .whitespacesAndNewlines)
        let base = raw.components(separatedBy: CharacterSet(charactersIn: "/\\:")).last ?? "report.html"
        let cleaned = base.isEmpty || base.hasPrefix(".") ? "report.html" : base
        let lower = cleaned.lowercased()
        return lower.hasSuffix(".html") || lower.hasSuffix(".htm") ? cleaned : cleaned + ".html"
    }
}
