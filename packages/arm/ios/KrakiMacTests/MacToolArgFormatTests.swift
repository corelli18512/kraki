import Foundation
import XCTest
@testable import Kraki_Dev

/// Tool arguments in the Steps sheet must never show Swift debug descriptions
/// (e.g. `Optional(<__NSSingleObjectArrayI 0x…>(…))`), which leak pointers.
final class MacToolArgFormatTests: XCTestCase {
    private func decoded(_ json: String) throws -> [String: AnyCodable] {
        try JSONDecoder().decode([String: AnyCodable].self, from: Data(json.utf8))
    }

    func testFormatsScalarsAndCollectionsAsJSON() throws {
        let args = try decoded(#"{"path":"/tmp/a.txt","edits":[{"oldText":"a","newText":"b"}],"n":3,"ok":true,"none":null,"tags":["x"]}"#)
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["path"]?.value), "/tmp/a.txt")
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["edits"]?.value), #"[{"newText":"b","oldText":"a"}]"#)
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["tags"]?.value), #"["x"]"#)
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["n"]?.value), "3")
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["ok"]?.value), "true")
        XCTAssertEqual(MacToolActivityRow.formatArgValue(args["none"]?.value), "null")
        for (_, value) in args {
            XCTAssertFalse(MacToolActivityRow.formatArgValue(value.value).contains("0x"))
        }
    }
}
