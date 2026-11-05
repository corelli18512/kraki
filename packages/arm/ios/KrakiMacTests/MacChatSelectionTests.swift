#if os(macOS) && DEBUG
import AppKit
import XCTest
@testable import Kraki_Dev

/// K-313: selecting inside a code block painted the light system selection
/// over the dark code surface and hid the light code text. Drawn offscreen.
@MainActor
final class MacChatSelectionTests: XCTestCase {
    private func codeBody() throws -> (MacCoreTextBodyView, MacCoreTextLayoutArtifact, NSRange) {
        let markdown = "Intro line\n\n```swift\nlet a = 1\nlet b = 2\nlet c = 3\n```\n\nOutro line"
        let attributed = MacMarkdown.attributed(markdown, cacheKey: "selection-\(UUID())", allowSyntaxHighlighting: false)
        let artifact = try XCTUnwrap(MacCoreTextLayoutArtifact.cached(attributed: attributed, width: 420,
                                                                      key: "selection-\(UUID())"))
        let view = MacCoreTextBodyView(frame: NSRect(x: 0, y: 0, width: 420, height: artifact.height))
        view.appearance = NSAppearance(named: .aqua)
        view.configure(artifact)
        let code = (artifact.attributed.string as NSString).range(of: "let a = 1\nlet b = 2\nlet c = 3")
        XCTAssertNotEqual(code.location, NSNotFound)
        return (view, artifact, code)
    }

    /// Average brightness (0…1) of `rect` in the rendered view.
    private func brightness(of view: NSView, in rect: NSRect) throws -> CGFloat {
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        let scaleX = CGFloat(rep.pixelsWide) / view.bounds.width
        let scaleY = CGFloat(rep.pixelsHigh) / view.bounds.height
        var total: CGFloat = 0
        var count: CGFloat = 0
        for y in Int(rect.minY * scaleY)..<Int(rect.maxY * scaleY) {
            for x in Int(rect.minX * scaleX)..<Int(rect.maxX * scaleX) {
                guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                total += (color.redComponent + color.greenComponent + color.blueComponent) / 3
                count += 1
            }
        }
        return count > 0 ? total / count : 0
    }

    func testSelectedCodeStaysDarkUnderLightCodeText() throws {
        let (view, artifact, code) = try codeBody()
        let selection = view.selectForRegression(code)
        XCTAssertEqual(selection.text, "let a = 1\nlet b = 2\nlet c = 3")
        let rects = artifact.selectionRects(for: code)
        let first = try XCTUnwrap(rects.first)
        XCTAssertTrue(artifact.blocks.contains { $0.kind == .code && $0.frame.intersects(first) })
        XCTAssertLessThan(try brightness(of: view, in: first), 0.5,
                          "selected code must keep a dark background behind its light text")
    }

    /// Copying a selection across lines gives "\n" line breaks (the report
    /// saw "\r" from its clipboard reader).
    func testCopiedSelectionUsesNewlines() throws {
        let (_, artifact, code) = try codeBody()
        let all = try XCTUnwrap(artifact.plainText(in: NSRange(location: 0, length: artifact.attributed.length)))
        XCTAssertFalse(all.contains("\r"))
        XCTAssertEqual(artifact.plainText(in: code), "let a = 1\nlet b = 2\nlet c = 3")
    }
}
#endif
