import XCTest
@testable import Kraki

/// K-063: the permission card's monospaced detail repeated the title for the
/// descriptions real adapters write ("Run: <command>", "Read: <path>").
final class PermissionPromptSummaryTests: XCTestCase {
    private func permission(_ tool: String, _ description: String, _ args: [String: Any]) -> ChatMessage {
        ChatMessage(type: "permission", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil, payload: [
            "id": AnyCodable("p1"), "toolName": AnyCodable(tool), "description": AnyCodable(description),
            "args": AnyCodable(args),
        ])
    }

    func testDetailThatTheTitleAlreadySaysIsNotRepeated() {
        XCTAssertNil(PermissionPromptCopy.argsSummary(permission("shell", "Run: npm run build", ["command": "npm run build"])))
        XCTAssertNil(PermissionPromptCopy.argsSummary(permission("read_file", "Read: /repo/a.swift", ["path": "/repo/a.swift"])))
        XCTAssertNil(PermissionPromptCopy.argsSummary(permission("fetch_url", "WebFetch: https://x.dev", ["url": "https://x.dev"])))
        XCTAssertNil(PermissionPromptCopy.argsSummary(permission("edit", "Edit /repo/b.ts", ["path": "/repo/b.ts"])))
    }

    func testDetailTheTitleDoesNotSayIsShown() {
        XCTAssertEqual(PermissionPromptCopy.argsSummary(permission("shell", "Clean the build", ["command": "rm -rf build"])),
                       "rm -rf build")
        XCTAssertEqual(PermissionPromptCopy.argsSummary(permission("custom", "custom", ["b": "second", "a": "first"])),
                       "first", "an unknown tool shows its first argument in key order")
    }
}
