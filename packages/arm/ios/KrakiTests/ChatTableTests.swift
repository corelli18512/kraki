import XCTest
@testable import Kraki

final class ChatTableTests: XCTestCase {

    // MARK: Inline Markdown

    func testBareAndAngleAutolinksBecomeLinks() {
        let runs = parseMarkdownInline("see https://kraki.chat/install. and <https://example.com/a_b> 好")
        let links = runs.compactMap { run in run.link.map { (run.text, $0.absoluteString) } }
        XCTAssertEqual(links.map(\.0), ["https://kraki.chat/install", "https://example.com/a_b"])
        XCTAssertEqual(runs.first { $0.text.hasPrefix(".") }?.link, nil, "trailing period is not part of the URL")
    }

    func testAutolinkKeepsBalancedParenthesesAndStopsAtCJK() {
        let wiki = parseMarkdownInline("(see https://en.wikipedia.org/wiki/Foo_(bar))")
        XCTAssertEqual(wiki.compactMap(\.link).first?.absoluteString, "https://en.wikipedia.org/wiki/Foo_(bar)")
        let cjk = parseMarkdownInline("文档在https://kraki.chat/docs，请看")
        XCTAssertEqual(cjk.compactMap(\.link).first?.absoluteString, "https://kraki.chat/docs")
    }

    func testCodeAndLabelledLinksAreUnchanged() {
        let code = parseMarkdownInline("`https://not.a/link`")
        XCTAssertNil(code.first?.link)
        XCTAssertTrue(code.first?.code == true)
        let labelled = parseMarkdownInline("[docs](https://kraki.chat/docs)")
        XCTAssertEqual(labelled.map(\.text), ["docs"])
        XCTAssertEqual(labelled.first?.link?.absoluteString, "https://kraki.chat/docs")
    }

    // MARK: Row splitting

    func testPipesInsideCodeAndEscapedPipesStayInOneCell() {
        XCTAssertEqual(parseTableRow("| Shell | `a | b` | x \\| y |"), ["Shell", "`a | b`", "x \\| y"])
        let table = ChatTable(rows: [["A", "B"], [parseTableRow("| `a | b` | x \\| y |")[0], "x \\| y"]],
                              alignments: [.leading, .leading])
        XCTAssertEqual(table.plainBody[0], ["a | b", "x | y"])
    }

    // MARK: Columns

    func testNumericColumnsAlignTrailingAndNeverWrap() {
        let table = ChatTable(rows: [["Platform", "Tests", "Time"], ["iOS", "551", "153.3 s"], ["Mac", "1,199", "27 ms"]],
                              alignments: [.leading, .leading, .leading])
        XCTAssertEqual(table.numeric, [false, true, true])
        XCTAssertEqual(table.alignments[1], .trailing)
        XCTAssertEqual(table.alignments[0], .leading)
        XCTAssertEqual(table.columnMin[2], table.columnPreferred[2], accuracy: 0.5, "a number keeps its line")
    }

    func testNarrowTableFillsTheBubbleWidth() {
        let table = ChatTable(rows: [["Key", "Value"], ["a", "1"], ["b", "2"]], alignments: [.leading, .leading])
        let geometry = table.geometry(width: 300)
        XCTAssertEqual(geometry.mode, .grid)
        XCTAssertFalse(geometry.overflows)
        XCTAssertEqual(geometry.columnWidths.reduce(0, +), 298, accuracy: 1)
        XCTAssertFalse(geometry.showsFooter)
    }

    func testWideNumericTableScrollsWithPinnedFirstColumn() {
        let header = ["Version"] + (36...47).map { "W\($0)" }
        let rows = [header] + (0..<3).map { r in ["v0.\(r)"] + (0..<12).map { "\($0).\(r)%" } }
        let table = ChatTable(rows: rows, alignments: Array(repeating: .leading, count: header.count))
        let geometry = table.geometry(width: 360)
        XCTAssertEqual(geometry.mode, .grid)
        XCTAssertTrue(geometry.overflows)
        XCTAssertTrue(geometry.pinsFirstColumn)
        XCTAssertTrue(geometry.showsFooter)
        XCTAssertTrue(geometry.footerText.contains("13 columns"))
    }

    func testTextHeavyComparisonBecomesCardsOnlyWhenNarrow() {
        let rows = [
            ["Option", "Pros", "Risks", "Effort"],
            ["A client ordering", "No protocol change, works with every Tentacle version out there", "Relies on client rules; replies can still be lost", "2 d"],
            ["B Tentacle backfill", "Ordering guaranteed by structure on a reliable stream", "Protocol change, version checks and fallback needed", "5 d"],
        ]
        let table = ChatTable(rows: rows, alignments: Array(repeating: .leading, count: 4))
        let phone = table.geometry(width: 340)
        XCTAssertEqual(phone.mode, .cards)
        XCTAssertEqual(phone.cards.count, 2)
        XCTAssertNotNil(phone.cards[0].trailing, "the numeric Effort column becomes the card's trailing value")
        XCTAssertEqual(phone.cards[0].fields.count, 2)
        XCTAssertEqual(table.geometry(width: 720).mode, .grid)
        XCTAssertEqual(table.geometry(width: 340, full: true).mode, .grid, "full screen is always a grid")
    }

    func testLongTablePreviewsEightRows() {
        let rows = [["Key", "Value"]] + (0..<60).map { ["row-\($0)", "\($0)"] }
        let table = ChatTable(rows: rows, alignments: [.leading, .leading])
        let geometry = table.geometry(width: 340)
        XCTAssertEqual(geometry.previewRowCount, 8)
        XCTAssertEqual(geometry.hiddenRowCount, 52)
        XCTAssertEqual(geometry.footerText, "Showing 8 of 60 rows · 2 columns")
        XCTAssertLessThan(geometry.bubbleHeight, geometry.fullHeight)
    }

    // MARK: Sorting and export

    func testSortingByNumbersAndText() {
        let table = ChatTable(rows: [["Name", "Calls"], ["b", "1,200"], ["a", "90"], ["c", "—"], ["d", "15,000"]],
                              alignments: [.leading, .leading])
        XCTAssertEqual(table.sorted(by: 1, ascending: false).plainBody.map { $0[0] }, ["d", "b", "a", "c"])
        XCTAssertEqual(table.sorted(by: 1, ascending: true).plainBody.map { $0[0] }, ["a", "b", "d", "c"],
                       "empty cells sink to the bottom")
        XCTAssertEqual(table.sorted(by: 0, ascending: true).plainBody.map { $0[0] }, ["a", "b", "c", "d"])
        XCTAssertEqual(table.sorted(by: nil, ascending: true).plainBody.map { $0[0] }, ["b", "a", "c", "d"])
    }

    func testExportKeepsMarkdownAndProducesTabSeparatedValues() {
        let table = ChatTable(rows: [["File", "Note"], ["`a.swift`", "**bold** | x"]], alignments: [.leading, .trailing])
        XCTAssertEqual(table.tsv(), "File\tNote\na.swift\tbold | x")
        XCTAssertEqual(table.markdown(), "| File | Note |\n| --- | --: |\n| `a.swift` | **bold** \\| x |")
    }

    func testCellMarkdownIsRendered() {
        let table = ChatTable(rows: [["A"], ["**bold** `code` [link](https://kraki.chat)"]], alignments: [.leading])
        let cell = table.body[0][0]
        XCTAssertEqual(cell.string, "bold code link")
        var sawCode = false, sawLink = false
        cell.enumerateAttributes(in: NSRange(location: 0, length: cell.length)) { attributes, _, _ in
            if attributes[.chatTableCode] != nil { sawCode = true }
            if attributes[.link] != nil { sawLink = true }
        }
        XCTAssertTrue(sawCode)
        XCTAssertTrue(sawLink)
    }
}

#if os(iOS)
@MainActor final class SelectTextTests: XCTestCase {
    func testSelectTextKeepsWordsCodeAndTablesAsTSV() {
        let source = "Intro **bold** and `code`.\n\n| A | B |\n|---|---|\n| one | two |\n\nAfter."
        let body = TKMarkdown.attributed(source, cacheKey: "select-text-\(UUID())")
        let text = TKTextSelectionViewController.selectable(body).string
        XCTAssertTrue(text.contains("Intro bold and code."), text)
        XCTAssertTrue(text.contains("A\tB\none\ttwo"), text)
        XCTAssertTrue(text.contains("After."), text)
        XCTAssertFalse(text.contains("\u{FFFC}"), "no attachment placeholder")
    }

    func testMessageMenuOffersSelectText() {
        let message = ChatMessage(type: "agent_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable("hello world")])
        let content = TKBubbleContent.make(message: message, sessionId: "s", agent: "pi")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390, height: content.cellHeight(cellWidth: 390)))
        cell.configure(content, cellWidth: 390)
        XCTAssertEqual(cell.messageActions().map(\.title).prefix(2), ["Copy", "Select Text"])
    }
}
#endif
