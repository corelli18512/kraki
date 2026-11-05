#if os(iOS)
import XCTest
@testable import Kraki

/// K-164: agent text can't reorder what a bubble shows with bidi controls
/// (`txt.exe` displayed as `exe.txt`).
final class BidiControlRenderingTests: XCTestCase {
    private let controls: [Character] = ["\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}",
                                         "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}"]

    func testBubbleTextDropsBidiOverridesAndIsolates() {
        let source = "Download invoice\u{202E}fdp.exe and \u{2067}txt.exe\u{2069} now"
        let rendered = TKMarkdown.attributed(source, cacheKey: "bidi-\(UUID().uuidString)").string
        XCTAssertFalse(rendered.contains { controls.contains($0) }, rendered.debugDescription)
        XCTAssertTrue(rendered.contains("invoicefdp.exe"), rendered)
        XCTAssertTrue(rendered.contains("txt.exe"), rendered)
    }

    func testCodeBlocksDropThemToo() {
        let source = "```\nlet access = \"user\u{202E} \u{2066}// admin\u{2069}\u{2066}\"\n```"
        let segments = splitMessageBody(source)
        XCTAssertEqual(segments.count, 1)
        guard case .codeBlock(_, let code)? = segments.first else { return XCTFail("\(segments)") }
        XCTAssertFalse(code.contains { controls.contains($0) }, code.debugDescription)
    }

    func testRightToLeftTextAndMarksAreKept() {
        let source = "שלום \u{200F}עולם and مرحبا"
        XCTAssertEqual(neutralizingBidiControls(source), source)
    }
}
#endif
