import XCTest
import UIKit
@testable import Kraki

/// Regressions found in the Windows CLI → iPhone end-to-end run (2026-10-01).
@MainActor
final class WindowsIOSRoundTwoTests: XCTestCase {
    func testFenceNestedInAListItemIsACodeBlockWithoutItsIndent() {
        let text = "- **\u{8F93}\u{51FA}**\u{FF1A}\n  ```\n  Kraki on Windows OK\n  Node v22\n  ```\n\ndone"
        let segments = splitMessageBody(text)
        let code = segments.compactMap { seg -> String? in
            if case .codeBlock(_, let code) = seg { return code }
            return nil
        }
        XCTAssertEqual(code, ["Kraki on Windows OK\nNode v22"])
        for seg in segments {
            if case .inline(let content) = seg { XCTAssertFalse(content.contains("```"), "no stray fence in text") }
        }
    }

    func testUserMessageKeepsMarkdownCharactersAsTyped() {
        let message = ChatMessage(type: "user_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable("echo SHOULD_NOT_APPEAR > *.txt")])
        let content = TKBubbleContent.make(message: message, sessionId: "s", agent: "pi")
        XCTAssertEqual(content.body?.string, "echo SHOULD_NOT_APPEAR > *.txt")
    }

    func testDeviceDatesReadIsoAndSqliteTimestamps() {
        XCTAssertNotNil(DeviceDates.parse("2026-10-01T12:00:00.123Z"))
        XCTAssertNotNil(DeviceDates.parse("2026-10-01T12:00:00Z"))
        XCTAssertNotNil(DeviceDates.parse("2026-10-01 12:00:00"))
        XCTAssertNil(DeviceDates.parse(""))
        XCTAssertNil(DeviceDates.parse(nil))
    }

    func testDraftlessStopIsShownSoTheTurnLeavesATrace() {
        let user = ChatMessage(type: "user_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                               payload: ["content": AnyCodable("run it")])
        let stop = ChatMessage(type: "turn_status", seq: 2, sessionId: "s", deviceId: "d", timestamp: nil,
                               payload: ["draft": AnyCodable(""), "action": AnyCodable(["type": "user_abort"])])
        XCTAssertEqual(ChatViewModel.renderable([user, stop]).map(\.seq), [1, 2])
    }

    func testPiIsCapitalized() {
        XCTAssertEqual(AgentInfo.from("pi").label, "Pi")
    }
}

@MainActor
final class MarkdownEmphasisRulesTests: XCTestCase {
    private func italicText(_ s: String) -> [String] {
        parseMarkdownInline(s).filter(\.italic).map(\.text)
    }

    func testUnderscoresInsideWordsStayLiteral() {
        XCTAssertEqual(italicText("echo SHOULD_NOT_APPEAR > /c/late.txt"), [])
        XCTAssertEqual(italicText("call snake_case_name now"), [])
        XCTAssertEqual(parseMarkdownInline("SHOULD_NOT_APPEAR").map(\.text).joined(), "SHOULD_NOT_APPEAR")
    }

    func testRealEmphasisStillWorks() {
        XCTAssertEqual(italicText("an _important_ note"), ["important"])
        XCTAssertEqual(italicText("an *important* note"), ["important"])
        XCTAssertEqual(parseMarkdownInline("**bold** text").filter(\.bold).map(\.text), ["bold"])
    }

    func testWindowsPathsKeepTheirBackslashes() {
        XCTAssertEqual(parseMarkdownInline(#"\#u{770B}\#u{4E00}\#u{4E0B} C:\kraki-ios\hello.js"#).map(\.text).joined(), #"\#u{770B}\#u{4E00}\#u{4E0B} C:\kraki-ios\hello.js"#)
        XCTAssertEqual(parseMarkdownInline(#"literal \*star\*"#).map(\.text).joined(), "literal *star*")
    }

    func testLoneOrSpacedStarsAreNotEmphasis() {
        XCTAssertEqual(italicText("rm *.txt and 2 * 3 * 4"), [])
    }
}
