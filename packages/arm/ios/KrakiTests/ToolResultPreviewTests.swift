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
}
