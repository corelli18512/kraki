#if os(iOS)
import XCTest
@testable import Kraki

final class HelpersTests: XCTestCase {

    // MARK: - formatTokenCount

    func testFormatTokenCountZero() {
        XCTAssertEqual(formatTokenCount(0), "0")
    }

    func testFormatTokenCountSmall() {
        XCTAssertEqual(formatTokenCount(500), "500")
        XCTAssertEqual(formatTokenCount(999), "999")
    }

    func testFormatTokenCountThousands() {
        XCTAssertEqual(formatTokenCount(1234), "1.2K")
        XCTAssertEqual(formatTokenCount(9999), "10.0K")
        XCTAssertEqual(formatTokenCount(45300), "45K")
    }

    func testFormatTokenCountMillions() {
        XCTAssertEqual(formatTokenCount(1500000), "1.5M")
        XCTAssertEqual(formatTokenCount(15000000), "15M")
    }

    // MARK: - formatCost

    func testFormatCostSmall() {
        XCTAssertEqual(formatCost(0.001), "$0.0010")
    }

    func testFormatCostMedium() {
        XCTAssertEqual(formatCost(0.042), "$0.042")
    }

    func testFormatCostLarge() {
        XCTAssertEqual(formatCost(1.5), "$1.500")
    }

    // MARK: - formatDuration

    func testFormatDurationSeconds() {
        XCTAssertEqual(formatDuration(500), "0.5s")
        XCTAssertEqual(formatDuration(2300), "2.3s")
    }

    func testFormatDurationMinutes() {
        XCTAssertEqual(formatDuration(90000), "1m 30s")
    }

    // MARK: - truncate

    func testTruncateShortString() {
        XCTAssertEqual(truncate("hello", maxLength: 10), "hello")
    }

    func testTruncateLongString() {
        let result = truncate("hello world this is long", maxLength: 5)
        XCTAssertEqual(result, "hello…")
        XCTAssertEqual(result.count, 6) // 5 chars + "…"
    }

    func testTruncateExactLength() {
        XCTAssertEqual(truncate("hello", maxLength: 5), "hello")
    }

    // MARK: - getArgsSummary

    func testGetArgsSummaryShell() {
        let result = getArgsSummary(toolName: "shell", args: ["command": AnyCodable("ls -la")])
        XCTAssertEqual(result, "ls -la")
    }

    func testGetArgsSummaryBash() {
        let result = getArgsSummary(toolName: "bash", args: ["command": AnyCodable("echo hi")])
        XCTAssertEqual(result, "echo hi")
    }

    func testGetArgsSummaryWriteFile() {
        let result = getArgsSummary(toolName: "write_file", args: ["path": AnyCodable("/tmp/test.txt")])
        XCTAssertEqual(result, "/tmp/test.txt")
    }

    func testGetArgsSummaryFetchUrl() {
        let result = getArgsSummary(toolName: "fetch_url", args: ["url": AnyCodable("https://example.com")])
        XCTAssertEqual(result, "https://example.com")
    }

    func testGetArgsSummaryUnknownTool() {
        let result = getArgsSummary(toolName: "custom_tool", args: ["input": AnyCodable("some value")])
        XCTAssertEqual(result, "some value")
    }

    func testGetArgsSummaryNilArgs() {
        let result = getArgsSummary(toolName: "shell", args: nil)
        XCTAssertNil(result)
    }

    func testGetArgsSummaryNilToolName() {
        let result = getArgsSummary(toolName: nil, args: ["command": AnyCodable("ls")])
        XCTAssertNil(result)
    }

    // MARK: - relativeTimestamp

    func testRelativeTimestampReturnsNonEmptyString() {
        let result = relativeTimestamp(Date())
        XCTAssertFalse(result.isEmpty)
    }

    func testRelativeTimestampJustNow() {
        let result = relativeTimestamp(Date())
        XCTAssertEqual(result, "just now")
    }

    func testRelativeTimestampMinutesAgo() {
        let result = relativeTimestamp(Date(timeIntervalSinceNow: -120))
        XCTAssertEqual(result, "2m ago")
    }

    func testRelativeTimestampHoursAgo() {
        let result = relativeTimestamp(Date(timeIntervalSinceNow: -7200))
        XCTAssertEqual(result, "2h ago")
    }
}
#endif
