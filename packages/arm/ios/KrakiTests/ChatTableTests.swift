import XCTest
@testable import Kraki

final class ChatTableTests: XCTestCase {
    func testOnlyWebAndMailLinksAreTappable() {
        let text = "[docs](https://kraki.chat) [mail](mailto:a@b.c) [run](file:///tmp/x.command) [app](vscode://x) [js](javascript:alert(1))"
        let links = parseMarkdownInline(text).compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(links, ["https://kraki.chat", "mailto:a@b.c"])
        // The label of a refused link stays as text.
        XCTAssertTrue(parseMarkdownInline(text).map(\.text).joined().contains("run"))
    }


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
    private func cell(_ text: String) throws -> (TKBubbleCell, UIWindow) {
        let message = ChatMessage(type: "agent_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable(text)])
        let content = TKBubbleContent.make(message: message, sessionId: "s", agent: "pi")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390, height: content.cellHeight(cellWidth: 390)))
        cell.configure(content, cellWidth: 390)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIViewController()
        window.rootViewController = host
        host.view.addSubview(cell)
        window.makeKeyAndVisible()
        cell.layoutIfNeeded()
        return (cell, window)
    }

    private func bodies(_ view: UIView) -> [TKBodyTextView] {
        (view as? TKBodyTextView).map { [$0] } ?? view.subviews.flatMap(bodies)
    }

    func testMessageMenuOffersSelectText() throws {
        let (cell, window) = try cell("hello world")
        defer { window.isHidden = true }
        XCTAssertEqual(cell.messageActions().map(\.title).prefix(2), ["Copy", "Select Text"])
    }

    func testSelectTextSelectsInsideTheBubbleAndEndsOnTapElsewhere() throws {
        let (cell, window) = try cell("Intro **bold** and `code`. Some more words to select.")
        defer { window.isHidden = true }
        let body = try XCTUnwrap(bodies(cell).first { ($0.attributedText?.length ?? 0) > 0 })
        XCTAssertFalse(body.canBecomeFirstResponder, "plain bubbles are not selectable until asked")

        cell.beginTextSelection()
        XCTAssertTrue(cell.isSelectingText)
        XCTAssertTrue(body.isFirstResponder)
        XCTAssertEqual(body.selectedRange.length, body.attributedText?.length)
        XCTAssertTrue(body.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
        XCTAssertFalse(body.canPerformAction(#selector(UIResponderStandardEditActions.cut(_:)), withSender: nil))
        XCTAssertNotEqual(body.tintColor, .clear, "selection is visible")

        cell.setBodyInteractive(false)  // scrolling must not drop the selection
        XCTAssertTrue(body.isFirstResponder)

        TKBubbleCell.endActiveTextSelection(unlessAt: CGPoint(x: 5, y: 800))
        XCTAssertFalse(cell.isSelectingText)
        XCTAssertFalse(body.isFirstResponder)
        XCTAssertEqual(body.selectedRange.length, 0)
        XCTAssertFalse(body.canBecomeFirstResponder)
    }

    func testSelectionShotForReview() throws {
        try requireForegroundUITests()
        let text = "三种方案的对比如下：方案 A 不改协议，对所有版本的 Tentacle 都有效。Run `pnpm test` and see https://kraki.chat/docs for details."
        let message = ChatMessage(type: "agent_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable(text)])
        let content = TKBubbleContent.make(message: message, sessionId: "s", agent: "pi")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.windowLevel = .alert + 1
        let host = UIViewController()
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 260, width: window.bounds.width, height: content.cellHeight(cellWidth: window.bounds.width)))
        cell.configure(content, cellWidth: window.bounds.width)
        cell.setBodyInteractive(true)
        host.view.addSubview(cell)
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        cell.beginTextSelection()
        try? "go".write(toFile: NSTemporaryDirectory() + "kraki-select-shot-go", atomically: true, encoding: .utf8)
        print("SELECT-SHOT-READY")
        RunLoop.main.run(until: Date().addingTimeInterval(5))
        window.isHidden = true
    }

    func testReuseEndsSelection() throws {
        let (cell, window) = try cell("Some text")
        defer { window.isHidden = true }
        cell.beginTextSelection()
        XCTAssertTrue(cell.isSelectingText)
        cell.prepareForReuse()
        XCTAssertFalse(cell.isSelectingText)
    }
}
#endif
