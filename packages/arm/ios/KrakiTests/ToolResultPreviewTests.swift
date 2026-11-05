import XCTest
@testable import Kraki

/// K-050: a 5 MB tool result was put whole into one `Text` (seconds of main
/// thread per expand, then an empty box).
final class ToolResultPreviewTests: XCTestCase {
    func testLargeResultShowsItsHeadAndSaysItWasCut() throws {
        let data = Data(String(repeating: "x", count: 5_000_000).utf8)
        let preview = try XCTUnwrap(ToolResultPreview(data))
        XCTAssertEqual(preview.text.utf8.count, ToolResultPreview.limit)
        XCTAssertEqual(preview.omittedBytes, 5_000_000 - ToolResultPreview.limit)
        XCTAssertNotNil(preview.truncationNotice)
    }

    func testCutNeverSplitsACharacter() throws {
        // "好" is 3 UTF-8 bytes: a 32 KB cut lands inside one.
        let data = Data(String(repeating: "\u{597D}", count: 20_000).utf8)
        let preview = try XCTUnwrap(ToolResultPreview(data))
        XCTAssertTrue(preview.text.allSatisfy { $0 == "\u{597D}" })
        XCTAssertEqual(preview.text.utf8.count + preview.omittedBytes, data.count)
    }

    func testSmallResultIsShownWholeAndBinaryIsNotText() throws {
        let preview = try XCTUnwrap(ToolResultPreview(Data("ok\n".utf8)))
        XCTAssertEqual(preview.text, "ok\n")
        XCTAssertNil(preview.truncationNotice)
        XCTAssertNil(ToolResultPreview(Data([0xFF, 0xFE, 0x00])))
    }

    /// K-051: lazy edit arguments were drawn as raw JSON, an edit's text one
    /// escaped blob with literal "\n". Shown as the web does: sorted
    /// `key: value` lines, strings verbatim.
    func testArgumentsReadAsKeyValueLinesWithRealNewlines() throws {
        let json = #"{"path":"a.swift","old_string":"let a = 1\nlet b = 2","new_string":"let a = 3","replace_all":false}"#
        let preview = try XCTUnwrap(ToolResultPreview.arguments(Data(json.utf8)))
        XCTAssertEqual(preview.text, "new_string: let a = 3\nold_string: let a = 1\nlet b = 2\npath: a.swift\nreplace_all: false")
        XCTAssertEqual(ToolResultPreview.arguments(Data("plain".utf8))?.text, "plain")
    }

    /// The arguments preview is built in the view body: a multi-MB write is
    /// not parsed as JSON on every render, its raw head is shown instead.
    func testArgumentsOverTheParseLimitShowTheirRawHead() throws {
        let content = String(repeating: "x", count: ToolResultPreview.argumentsParseLimit)
        let json = #"{"path":"big.txt","content":""# + content + #""}"#
        let preview = try XCTUnwrap(ToolResultPreview.arguments(Data(json.utf8)))
        XCTAssertTrue(preview.text.hasPrefix(#"{"path":"big.txt""#), "raw JSON head, not parsed lines")
        XCTAssertEqual(preview.totalBytes, json.utf8.count)
        XCTAssertNotNil(preview.truncationNotice)
    }
}
