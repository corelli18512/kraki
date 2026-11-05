#if os(iOS)
import XCTest
@testable import Kraki

/// K-029: the composer measured the whole draft on every body pass; a
/// pasted megabyte froze the field for 30–70 s.
final class IOSComposerTextMetricsTests: XCTestCase {
    private let width: CGFloat = 280

    func testShortDraftsMeasureAsBefore() {
        let line = IOSComposerTextMetrics.lineHeight
        XCTAssertEqual(IOSComposerTextMetrics.height("", width: width, maxHeight: line * 5), line)
        XCTAssertEqual(IOSComposerTextMetrics.height("hello", width: width, maxHeight: line * 5), line)
        XCTAssertEqual(IOSComposerTextMetrics.height("a\nb\nc", width: width, maxHeight: line * 5), line * 3)
        XCTAssertEqual(IOSComposerTextMetrics.height(String(repeating: "a\n", count: 20), width: width, maxHeight: line * 5),
                       line * 5, "capped")
    }

    func testLongSingleParagraphJustOverThePrefixStillMeasuresExactly() {
        // Few lines but long: no cap is reached by the prefix, so the whole text decides.
        let line = IOSComposerTextMetrics.lineHeight
        let text = String(repeating: "x", count: IOSComposerTextMetrics.measuredPrefixLength + 10)
        let height = IOSComposerTextMetrics.height(text, width: width, maxHeight: .greatestFiniteMagnitude)
        XCTAssertGreaterThan(height, line * 5)
    }

    func testAMegabyteDraftOnlyMeasuresAPrefix() {
        let line = IOSComposerTextMetrics.lineHeight
        let huge = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 24_000) // ~1 MB
        let typing = IOSComposerTextMetrics.measure(huge, width: width, maxHeight: line * 5)
        let wraps = IOSComposerTextMetrics.measure(huge, width: width, maxHeight: line * 2)
        XCTAssertEqual(typing.height, line * 5)
        XCTAssertEqual(wraps.height, line * 2)
        XCTAssertLessThanOrEqual(typing.measuredLength, IOSComposerTextMetrics.measuredPrefixLength)
        XCTAssertLessThanOrEqual(wraps.measuredLength, IOSComposerTextMetrics.measuredPrefixLength)
    }
}
#endif
