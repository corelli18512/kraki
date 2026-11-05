import XCTest
import UIKit
import SwiftUI
@testable import Kraki

/// Bubble body rendering: link colors, tables, long tokens, chunked code
/// blocks and very long bodies (moved out of TextKitPureSpineTests.swift).
extension TextKitPureSpineTests {
    /// K-060: a link in the user's own (navy) bubble is drawn white and
    /// underlined, not in the agent link blue.
    func testUserBubbleLinkIsWhiteAndUnderlinedNotAgentBlue() throws {
        let bubble = content("user_message", seq: 102,
                             body: "see [the docs page here](https://kraki.chat/docs) and https://kraki.chat/a")
        let body = try XCTUnwrap(bubble.body)
        let range = (body.string as NSString).range(of: "the docs page here")
        XCTAssertEqual(body.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor, .white)
        XCTAssertNotNil(body.attribute(.underlineStyle, at: range.location, effectiveRange: nil),
                        "white links need an underline to read as links")
        XCTAssertLessThan(try agentLinkBluePixels(bubble), 20,
                          "user-bubble links must not be painted in the agent link blue")
    }

    /// Links in a red error bubble are recolored with the text, so they are
    /// underlined to read as links (review of K-060).
    func testErrorBubbleLinkIsUnderlined() throws {
        let bubble = content("error", seq: 108, body: "Failed, see [status page](https://kraki.chat/status)")
        let body = try XCTUnwrap(bubble.body)
        let range = (body.string as NSString).range(of: "status page")
        XCTAssertEqual(body.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor, .systemRed)
        XCTAssertNotNil(body.attribute(.underlineStyle, at: range.location, effectiveRange: nil))
    }

    /// Light-mode pixels in the agent link color (#0056A8) of a rendered cell.
    private func agentLinkBluePixels(_ bubble: TKBubbleContent) throws -> Int {
        let width: CGFloat = 390
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: bubble.cellHeight(cellWidth: width)))
        cell.overrideUserInterfaceStyle = .light
        cell.configure(bubble, cellWidth: width)
        cell.setBodyInteractive(true)
        cell.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.preferredRange = .standard
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: cell.bounds.size, format: format).image { context in
            cell.layer.render(in: context.cgContext)
        }
        let cg = try XCTUnwrap(image.cgImage)
        let bytes = try XCTUnwrap(CFDataGetBytePtr(cg.dataProvider?.data))
        var count = 0
        for y in 0..<cg.height {
            for x in 0..<cg.width {
                let o = y * cg.bytesPerRow + x * 4
                if abs(Int(bytes[o + 2]) - 0x00) < 12, abs(Int(bytes[o + 1]) - 0x56) < 12,
                   abs(Int(bytes[o]) - 0xA8) < 12 { count += 1 }
            }
        }
        return count
    }

    /// Agent links keep their link color.
    func testAgentBubbleLinkKeepsLinkColor() throws {
        let bubble = content("agent_message", seq: 103, body: "see [docs](https://kraki.chat/docs)")
        let body = try XCTUnwrap(bubble.body)
        let range = (body.string as NSString).range(of: "docs")
        XCTAssertEqual(body.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor,
                       IOSMarkdownPalette.link)
        XCTAssertGreaterThan(try agentLinkBluePixels(bubble), 20, "the agent link is drawn in the link color")
    }

    /// K-058: a table in a bubble without links is interactive at rest as
    /// soon as it is laid out (Open table / Copy / sort), not after a scroll.
    func testTableWithoutLinksIsInteractiveInAFreshCell() throws {
        let bubble = content("agent_message", seq: 104, body: "Numbers:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")
        let width: CGFloat = 390
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: bubble.cellHeight(cellWidth: width)))
        cell.configure(bubble, cellWidth: width)
        cell.setBodyInteractive(true)   // what configureCell does at rest
        cell.layoutIfNeeded()           // tables are created here
        let tables = descendants(of: cell.contentView, as: TKTableScrollView.self)
        XCTAssertEqual(tables.count, 1)
        XCTAssertTrue(tables.allSatisfy(\.isUserInteractionEnabled), "fresh table must accept taps")
        cell.setBodyInteractive(false)
        XCTAssertFalse(tables.contains(where: \.isUserInteractionEnabled), "off while the list scrolls")
    }

    /// K-162: a token longer than the line (base64, hashes) wraps without the
    /// hyphen TextKit 2 inserts at a forced break. Every line ends at a real
    /// break opportunity, and copy returns the token unchanged.
    func testLongTokensWrapWithoutInsertedHyphens() throws {
        let token = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgdG9rZW4gdGhhdA"
        let source = "Token: \(token) and `\(token)` end"
        let rendered = TKMarkdown.attributed(source, cacheKey: "long-token-hyphen")
        XCTAssertEqual(TKMarkdown.plainText(rendered), "Token: \(token) and \(token) end")
        let view = TKBodyTextView(usingTextLayoutManager: true)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.attributedText = rendered
        view.frame = CGRect(x: 0, y: 0, width: 150, height: 1_000)
        view.layoutIfNeeded()
        let text = rendered.string as NSString
        var forcedBreaks: [String] = []
        let layoutManager = try XCTUnwrap(view.textLayoutManager)
        layoutManager.enumerateTextLayoutFragments(from: nil, options: [.ensuresLayout]) { fragment in
            let start = layoutManager.offset(from: layoutManager.documentRange.location,
                                             to: fragment.rangeInElement.location)
            for line in fragment.textLineFragments.dropLast() {
                let end = start + NSMaxRange(line.characterRange)
                guard end > 0, end < text.length else { continue }
                let last = text.substring(with: NSRange(location: end - 1, length: 1))
                if !(last == " " || last == "/" || last == "-" || last == "\u{200B}" || last == "\n") {
                    forcedBreaks.append(text.substring(with: NSRange(location: max(0, end - 6), length: min(6, end))))
                }
            }
            return true
        }
        XCTAssertEqual(forcedBreaks, [], "a line ended mid-token (TextKit draws a hyphen there)")
        // Select the whole first token (with the inserted break characters).
        let first = (rendered.string as NSString).range(of: "Token: ")
        let tokenEnd = (rendered.string as NSString).range(of: " and ")
        view.selectedRange = NSRange(location: NSMaxRange(first), length: tokenEnd.location - NSMaxRange(first))
        UIPasteboard.general.string = ""
        view.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, token, "Select Text copy returns the token as written")
    }

    /// Review of K-162: scripts written without spaces (Chinese, Thai) and
    /// emoji sequences keep their own line breaking; only long ASCII tokens
    /// get break opportunities.
    func testLongTokenBreaksLeaveNonASCIIRunsUnchanged() {
        let chinese = "这是一个很长的中文句子，没有任何空格，用来检查换行规则是否保持不变，标点不能出现在行首。"
        let thai = "ภาษาไทยเขียนติดกันโดยไม่มีช่องว่างระหว่างคำเลยแม้แต่น้อยนะครับ"
        let emoji = "👩‍💻👨‍👩‍👧‍👦🏳️‍🌈1️⃣🇨🇳👍🏽" + "👩‍💻👨‍👩‍👧‍👦🏳️‍🌈1️⃣🇨🇳👍🏽"
        for text in [chinese, thai, emoji, "\(chinese)\(emoji)\(thai)"] {
            let piece = NSAttributedString(string: text)
            XCTAssertEqual(TKMarkdown.breakingLongTokens(piece).string, text)
        }
        // A long ASCII token next to CJK text still gets break opportunities,
        // and they sit only inside the token.
        let token = String(repeating: "A1b2C3d4", count: 4)
        let mixed = TKMarkdown.breakingLongTokens(NSAttributedString(string: "\(chinese)\(token)\(chinese)")).string
        XCTAssertTrue(mixed.hasPrefix(chinese) && mixed.hasSuffix(chinese))
        XCTAssertEqual(mixed.filter { $0 == "\u{200B}" }.count, token.count / TKMarkdown.longTokenBreakStride - 1)
    }

    private static func longCode(lines: Int) -> String {
        "Here is the file:\n\n```swift\n"
            + (1...lines).map { "let value\($0) = compute(\($0)) // line \($0)" }.joined(separator: "\n")
    }

    /// K-071: a long streaming code block is split between its lines, so a
    /// streaming code reply re-lays out only its last chunk instead of the
    /// whole block.
    func testLongCodeBlockIsChunkedBetweenItsLines() throws {
        let body = TKMarkdown.attributed(Self.longCode(lines: 200) + "\n```\nDone.", cacheKey: "long-code-chunks")
        let chunks = TKBodyChunks.chunks(body, splitCodeBlocks: true)
        XCTAssertGreaterThan(chunks.count, 5, "a 200-line block is not one chunk")
        let ns = body.string as NSString
        for chunk in chunks.dropFirst() {
            XCTAssertEqual(ns.substring(with: NSRange(location: chunk.range.location - 1, length: 1)), "\n")
        }
    }

    /// A landed long code block stays in one chunk view, so Select Text can
    /// select and copy the whole block (review of K-071).
    func testLandedLongCodeBlockStaysInOneChunk() throws {
        let body = TKMarkdown.attributed(Self.longCode(lines: 200) + "\n```\nDone.", cacheKey: "landed-long-code-chunks")
        let ns = body.string as NSString
        let codeStart = ns.range(of: "let value1 ").location
        let codeEnd = NSMaxRange(ns.range(of: "// line 200"))
        let chunks = TKBodyChunks.chunks(body)
        let holding = chunks.filter { NSIntersectionRange($0.range, NSRange(location: codeStart, length: codeEnd - codeStart)).length > 0 }
        XCTAssertEqual(holding.count, 1, "the whole code block is one chunk view")
        let bubble = content("agent_message", seq: 107, body: Self.longCode(lines: 200) + "\n```\nDone.")
        let width: CGFloat = 390
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: bubble.cellHeight(cellWidth: width)))
        cell.configure(bubble, cellWidth: width)
        cell.layoutIfNeeded()
        let views = descendants(of: cell.contentView, as: TKBodyTextView.self).filter { !$0.isHidden }
        XCTAssertTrue(views.contains { view in
            let text = view.attributedText?.string ?? ""
            return text.contains("let value1 ") && text.contains("// line 200")
        }, "one view holds the first and last line of the block")
    }

    func testStreamingCodeBlockKeepsSettledChunksIdentical() throws {
        let liveID = "long-code-\(UUID().uuidString)"
        let live = TKLiveBody.forSession(liveID)
        defer { TKLiveBody.discard(liveID) }
        live.update(Self.longCode(lines: 150))
        let first = try XCTUnwrap(live.body)
        let firstChunks = TKBodyChunks.chunks(first, splitCodeBlocks: true)
        XCTAssertGreaterThan(firstChunks.count, 3)
        live.update(Self.longCode(lines: 151))
        let second = try XCTUnwrap(live.body)
        let secondChunks = TKBodyChunks.chunks(second, splitCodeBlocks: true)
        for chunk in firstChunks.dropLast() {
            XCTAssertTrue(secondChunks.contains { $0.range == chunk.range }, "boundary \(chunk.range) moved")
            XCTAssertTrue(first.attributedSubstring(from: chunk.range).isEqual(to: second.attributedSubstring(from: chunk.range)),
                          "settled chunk \(chunk.range) changed, so its view would be re-assigned")
        }
    }

    /// The code surface runs through the seam between two chunk views (no
    /// rounded corner or repeated language label at the split).
    func testSplitCodeBlockSurfaceContinuesAcrossChunkViews() throws {
        let liveID = "split-code-surface-\(UUID().uuidString)"
        defer { TKLiveBody.discard(liveID) }
        let bubble = TKBubbleContent.live(card: MessageStore.SessionCard(text: Self.longCode(lines: 120) + "\n```"),
                                          agent: "pi", sessionId: liveID, steps: 0)
        let width: CGFloat = 390
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: bubble.cellHeight(cellWidth: width)))
        cell.configure(bubble, cellWidth: width)
        cell.layoutIfNeeded()
        let views = descendants(of: cell.contentView, as: TKBodyTextView.self).filter { !$0.isHidden }
        XCTAssertGreaterThan(views.count, 2)
        guard views.count > 2 else { return }
        let middle = views[1]
        let format = UIGraphicsImageRendererFormat()
        format.preferredRange = .standard
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: middle.bounds.size, format: format).image { context in
            middle.layer.render(in: context.cgContext)
        }
        let cg = try XCTUnwrap(image.cgImage)
        let bytes = try XCTUnwrap(CFDataGetBytePtr(cg.dataProvider?.data))
        func isSurface(_ x: Int, _ y: Int) -> Bool {
            let o = y * cg.bytesPerRow + x * 4
            return abs(Int(bytes[o + 2]) - 0x18) < 6 && abs(Int(bytes[o + 1]) - 0x18) < 6 && abs(Int(bytes[o]) - 0x1B) < 6
        }
        XCTAssertTrue(isSurface(1, 0), "top-left corner of a continued block is square surface")
        XCTAssertTrue(isSurface(1, cg.height - 1), "bottom-left corner of a continuing block is square surface")
    }

    /// K-017: a huge reply keeps text views only near the screen, not one per
    /// ~500-character chunk (1100 views for 1 MB froze entry and used GBs).
    func testHugeBodyRealizesOnlyTheChunksNearTheScreen() throws {
        let paragraph = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 12)
        let text = (1...300).map { "\($0). \(paragraph)" }.joined(separator: "\n\n")
        let bubble = content("agent_message", seq: 106, body: text)
        let width: CGFloat = 390
        let chunks = bubble.bodyChunks(cellWidth: width)
        XCTAssertGreaterThan(chunks.count, 200)
        let height = bubble.cellHeight(cellWidth: width)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
        let host = UIView(frame: window.bounds)
        window.addSubview(host)
        defer { window.isHidden = true }
        // The cell's bottom is on screen (a chat opens at its newest end).
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 852 - height, width: width, height: height))
        cell.configure(bubble, cellWidth: width)
        host.addSubview(cell)
        cell.layoutIfNeeded()
        func shown() -> [TKBodyTextView] {
            descendants(of: cell.contentView, as: TKBodyTextView.self).filter { !$0.isHidden && ($0.attributedText?.length ?? 0) > 0 }
        }
        let all = descendants(of: cell.contentView, as: TKBodyTextView.self)
        XCTAssertLessThan(all.count, 40, "text views are bounded, not one per chunk (\(all.count))")
        let body = try XCTUnwrap(bubble.body)
        let lastChunk = body.attributedSubstring(from: try XCTUnwrap(chunks.last).range).string
        XCTAssertTrue(shown().contains { $0.attributedText?.string == lastChunk }, "the visible end is rendered")
        // Every visible pixel row of the cell is covered by a realized chunk.
        let visible = cell.convert(window.bounds, from: window).intersection(cell.bounds)
        let covered = shown().map(\.frame).reduce(CGRect.null) { $0.union($1) }
        XCTAssertLessThanOrEqual(covered.minY, max(visible.minY, 20))
        // Scroll to the top of the reply: the start is realized, the end released.
        cell.frame.origin.y = 0
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
        let firstChunk = body.attributedSubstring(from: chunks[0].range).string
        XCTAssertTrue(shown().contains { $0.attributedText?.string == firstChunk })
        XCTAssertFalse(shown().contains { $0.attributedText?.string == lastChunk })
        XCTAssertLessThan(descendants(of: cell.contentView, as: TKBodyTextView.self).count, 40)
    }

    /// Review of K-017/K-058: chunk views realized after a scroll take the
    /// cell's interaction state (links tappable at rest), and realizing does
    /// not replace the text of a view the user is selecting in.
    func testHugeBodyRealizedChunksKeepLinksAndSelection() throws {
        let paragraph = String(repeating: "See [the docs](https://kraki.chat/docs) for more about the fox. ", count: 6)
        let text = (1...300).map { "\($0). \(paragraph)" }.joined(separator: "\n\n")
        let bubble = content("agent_message", seq: 109, body: text)
        let width: CGFloat = 390
        let height = bubble.cellHeight(cellWidth: width)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
        let host = UIView(frame: window.bounds)
        window.addSubview(host)
        window.isHidden = false
        defer { window.isHidden = true }
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 852 - height, width: width, height: height))
        cell.configure(bubble, cellWidth: width)
        host.addSubview(cell)
        cell.setBodyInteractive(true)   // at rest
        cell.layoutIfNeeded()
        func shown() -> [TKBodyTextView] {
            descendants(of: cell.contentView, as: TKBodyTextView.self).filter { !$0.isHidden && ($0.attributedText?.length ?? 0) > 0 }
        }
        cell.frame.origin.y = 0
        cell.refreshRealizedChunks()
        cell.layoutIfNeeded()
        XCTAssertFalse(shown().isEmpty)
        XCTAssertTrue(shown().allSatisfy(\.isUserInteractionEnabled), "newly realized chunks have live links")

        cell.beginTextSelection()
        let selected = try XCTUnwrap(shown().first { $0.selectionModeEnabled })
        let selectedText = try XCTUnwrap(selected.attributedText)
        let selectedRange = selected.selectedRange
        cell.frame.origin.y = 852 - height
        cell.refreshRealizedChunks()
        cell.layoutIfNeeded()
        XCTAssertTrue(selected.attributedText?.isEqual(to: selectedText) ?? false, "the selected text stays")
        XCTAssertEqual(selected.selectedRange, selectedRange)
        cell.endTextSelection()
    }

    /// K-059: a reused body view redraws its code/quote surface when it is
    /// resized or the appearance changes, instead of keeping stale pixels.
    func testBodyViewRedrawsItsSurfaceAfterResizeAndAppearanceChange() throws {
        let bubble = content("agent_message", seq: 107, body: "> quoted\n\n```\nlet x = 1\n```")
        let width: CGFloat = 390
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 600)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width, height: bubble.cellHeight(cellWidth: width)))
        cell.configure(bubble, cellWidth: width)
        window.addSubview(cell)
        cell.layoutIfNeeded()
        let view = try XCTUnwrap(descendants(of: cell.contentView, as: TKBodyTextView.self).first { !$0.isHidden })
        view.layer.displayIfNeeded()
        XCTAssertFalse(view.layer.needsDisplay())
        view.frame.size.height += 40
        XCTAssertTrue(view.layer.needsDisplay(), "a resize redraws the surfaces")
        view.layer.displayIfNeeded()
        window.overrideUserInterfaceStyle = .dark
        window.layoutIfNeeded()
        cell.layoutIfNeeded()
        XCTAssertTrue(view.layer.needsDisplay(), "an appearance change redraws the dynamic quote surface")
    }
}
