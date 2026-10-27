import XCTest
@testable import Kraki_Dev

/// Mac table counts use the plural-aware "%lld rows" / "%lld columns" keys,
/// like iOS `TKTable` ("1 row × 1 column", not "1 rows × 1 columns").
@MainActor
final class MacTablesTests: XCTestCase {
    private let single = ChatTable(rows: [["Name"], ["Ada"]], alignments: [.leading])
    private let wide = ChatTable(rows: [["Name", "Age"], ["Ada", "36"], ["Alan", "41"]], alignments: [.leading, .leading])

    func testAccessibilityLabelUsesSingulars() {
        XCTAssertEqual(MacTableScrollView(layout: single).accessibilityLabel(), "Table, 1 row, 1 column")
        XCTAssertEqual(MacTableScrollView(layout: wide).accessibilityLabel(), "Table, 2 rows, 2 columns")
    }

    func testWindowSubtitleUsesSingulars() {
        XCTAssertEqual(MacTableWindowController.subtitle(for: single), "1 row × 1 column")
        XCTAssertEqual(MacTableWindowController.subtitle(for: wide.sorted(by: 0, ascending: true)),
                       "2 rows × 2 columns · sorted by Name")
    }
}
