import UIKit
import SwiftUI
import Highlightr

// MARK: - TextKit2 bubble render path
//
// Landed pure-spine messages have one renderer and one identity: a TextKit
// bubble for the persisted message. TRACE steps are presented separately.

// MARK: - Metrics (mirror the SwiftUI bubble so cached heights line up)

private enum TKMetrics {
    /// Hosting cell padding around the bubble (UIHostingConfiguration used
    /// `.padding(.horizontal, 12) / .vertical, 6`).
    static let outerH: CGFloat = 12
    static let outerV: CGFloat = 6
    /// Trailing gap so the agent bubble doesn't reach the screen edge
    /// (SwiftUI: `Spacer(minLength: width * 0.05)`).
    static let trailingGapFraction: CGFloat = 0.05
    /// Leading gap for the right-aligned user bubble.
    static let userLeadingGapFraction: CGFloat = 0.18

    /// Message section padding (`.padding(.horizontal, 14) / .vertical, 10`).
    static let msgPadH: CGFloat = 14
    static let msgPadV: CGFloat = 10
    /// Tool / tinted section padding (`.padding(.horizontal, 16) / .vertical, 12`).
    static let sectionPadH: CGFloat = 16
    static let sectionPadV: CGFloat = 12
    /// Vertical gap between items inside a section (`VStack(spacing: 8)`).
    static let itemSpacing: CGFloat = 8
    /// Tool-row icon dimension (`ToolChipHeader.iconSize`).
    static let toolIcon: CGFloat = 16
    /// Image grid: spacing between stacked images + cap on a single image's
    /// rendered height + corner radius (mirrors `imageGrid`).
    static let imageSpacing: CGFloat = 6
    static let imageMaxHeight: CGFloat = 240
    static let imageCorner: CGFloat = 12
    /// Nested tool-detail box: inner padding, corner radius, and the gap
    /// between the tool chip row and the revealed detail box.
    static let detailPad: CGFloat = 12
    static let detailCorner: CGFloat = 8
    static let detailGap: CGFloat = 6
}

// MARK: - Markdown → NSAttributedString

private let tkMarkdownCache: NSCache<NSString, NSAttributedString> = {
    let c = NSCache<NSString, NSAttributedString>()
    c.countLimit = 512
    return c
}()

private let tkCodeHighlightCache: NSCache<NSString, NSAttributedString> = {
    let cache = NSCache<NSString, NSAttributedString>()
    cache.countLimit = 256
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
}()

private enum TKCodeHighlighter {
    private static let queue = DispatchQueue(label: "chat.kraki.code-highlight", qos: .utility)
    nonisolated(unsafe) private static var engine: Highlightr?

    static func prewarm() {
        queue.async { _ = makeEngine() }
    }

    private static func makeEngine() -> Highlightr? {
        if let engine { return engine }
        let created = Highlightr()
        created?.ignoreIllegals = true
        _ = created?.setTheme(to: "github-dark")
        engine = created
        return created
    }

    static func attributed(code: String, language: String?) -> NSAttributedString {
        let normalizedLanguage = language?.lowercased() ?? "auto"
        let key = "\(normalizedLanguage)\u{1F}\(code)" as NSString
        if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }

        return queue.sync {
            if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }
            let highlighted = makeEngine()?.highlight(code, as: language, fastRender: true)
                ?? NSAttributedString(string: code)
            tkCodeHighlightCache.setObject(highlighted, forKey: key, cost: highlighted.length * 8)
            return highlighted
        }
    }
}

extension NSAttributedString.Key {
    static let tkBlockKind = NSAttributedString.Key("chat.kraki.tkBlockKind")
    static let tkBlockID = NSAttributedString.Key("chat.kraki.tkBlockID")
    static let tkBlockLabel = NSAttributedString.Key("chat.kraki.tkBlockLabel")
    static let tkDecorativeSpacer = NSAttributedString.Key("chat.kraki.tkDecorativeSpacer")
    static let tkSemanticText = NSAttributedString.Key("chat.kraki.tkSemanticText")
}

enum TKBlockKind: String {
    case quote, code
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let merged = fontDescriptor.symbolicTraits.union(traits)
        guard let d = fontDescriptor.withSymbolicTraits(merged) else { return self }
        return UIFont(descriptor: d, size: 0)
    }
    var tkBold: UIFont { withTraits(.traitBold) }
    var tkItalic: UIFont { withTraits(.traitItalic) }
}

final class TKTableLayout {
    let rows: [[String]]
    let alignments: [TableAlignment]
    let columnWidths: [CGFloat]
    let rowHeights: [CGFloat]
    let rowOrigins: [CGFloat]
    let contentSize: CGSize
    let bubbleVisibleRowCount: Int
    let bubbleRowsHeight: CGFloat
    let bubbleViewportHeight: CGFloat
    let hiddenRowCount: Int

    static let showMoreHeight: CGFloat = 40

    private static let headerFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)
    private static let bodyFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    static let cellPadH: CGFloat = 10
    static let cellPadV: CGFloat = 8

    init(rows: [[String]], alignments: [TableAlignment]) {
        self.rows = rows
        self.alignments = alignments
        let columnCount = rows.first?.count ?? 0
        var widths = Array(repeating: CGFloat(72), count: columnCount)
        for (rowIndex, row) in rows.enumerated() {
            let font = rowIndex == 0 ? Self.headerFont : Self.bodyFont
            for column in 0..<columnCount {
                let value = column < row.count ? row[column] : ""
                let measured = ceil((value as NSString).size(withAttributes: [.font: font]).width)
                widths[column] = max(widths[column], min(220, measured + Self.cellPadH * 2))
            }
        }
        columnWidths = widths

        var heights: [CGFloat] = []
        var origins: [CGFloat] = []
        var y: CGFloat = 0
        for (rowIndex, row) in rows.enumerated() {
            origins.append(y)
            let font = rowIndex == 0 ? Self.headerFont : Self.bodyFont
            var rowHeight: CGFloat = 36
            for column in 0..<columnCount {
                let value = column < row.count ? row[column] : ""
                let available = max(1, widths[column] - Self.cellPadH * 2)
                let rect = (value as NSString).boundingRect(
                    with: CGSize(width: available, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [.font: font], context: nil)
                rowHeight = max(rowHeight, ceil(rect.height) + Self.cellPadV * 2)
            }
            heights.append(rowHeight)
            y += rowHeight
        }
        rowHeights = heights
        rowOrigins = origins
        contentSize = CGSize(width: max(1, widths.reduce(0, +)), height: max(1, y))

        let previewBudget: CGFloat = 280
        var visibleCount = 0
        var visibleHeight: CGFloat = 0
        for height in heights {
            let needsFooter = visibleCount + 1 < heights.count
            let projected = visibleHeight + height + (needsFooter ? Self.showMoreHeight : 0)
            if visibleCount >= 2, projected > previewBudget { break }
            visibleHeight += height
            visibleCount += 1
        }
        bubbleVisibleRowCount = visibleCount
        bubbleRowsHeight = visibleHeight
        hiddenRowCount = max(0, rows.count - visibleCount)
        bubbleViewportHeight = visibleHeight + (hiddenRowCount > 0 ? Self.showMoreHeight : 0)
    }

    func semanticText() -> String {
        rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }

    func font(for row: Int) -> UIFont { row == 0 ? Self.headerFont : Self.bodyFont }
}

private final class TKTableCanvasView: UIView {
    let layout: TKTableLayout

    init(layout: TKTableLayout) {
        self.layout = layout
        super.init(frame: CGRect(origin: .zero, size: layout.contentSize))
        isOpaque = false
        backgroundColor = .clear
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let line = UIColor.label.withAlphaComponent(0.16)
        let headerLine = UIColor.label.withAlphaComponent(0.34)
        var firstVisible = 0
        while firstVisible + 1 < layout.rowOrigins.count,
              layout.rowOrigins[firstVisible] + layout.rowHeights[firstVisible] < rect.minY {
            firstVisible += 1
        }
        for row in firstVisible..<layout.rows.count {
            let y = layout.rowOrigins[row]
            let height = layout.rowHeights[row]
            if y > rect.maxY { break }
            var x: CGFloat = 0
            for column in layout.columnWidths.indices {
                let width = layout.columnWidths[column]
                let value = column < layout.rows[row].count ? layout.rows[row][column] : ""
                let paragraph = NSMutableParagraphStyle()
                switch column < layout.alignments.count ? layout.alignments[column] : .leading {
                case .leading: paragraph.alignment = .left
                case .center: paragraph.alignment = .center
                case .trailing: paragraph.alignment = .right
                }
                let textRect = CGRect(x: x + TKTableLayout.cellPadH,
                                      y: y + TKTableLayout.cellPadV,
                                      width: width - TKTableLayout.cellPadH * 2,
                                      height: height - TKTableLayout.cellPadV * 2)
                (value as NSString).draw(
                    with: textRect,
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [
                        .font: layout.font(for: row),
                        .foregroundColor: UIColor.label,
                        .paragraphStyle: paragraph,
                    ], context: nil)
                x += width
                if column < layout.columnWidths.count - 1 {
                    line.setFill()
                    context.fill(CGRect(x: x - 0.5, y: y, width: 0.5, height: height))
                }
            }
            (row == 0 ? headerLine : line).setFill()
            let ruleHeight: CGFloat = row == 0 ? 1 : 0.5
            context.fill(CGRect(x: 0, y: y + height - ruleHeight,
                                width: layout.contentSize.width, height: ruleHeight))
        }
    }
}

final class TKTableScrollView: UIScrollView, UIScrollViewDelegate {
    private let overflowHint = UIImageView(image: UIImage(systemName: "chevron.right"))
    private let showMoreButton = UIButton(type: .system)
    let tableLayout: TKTableLayout
    var onShowAll: (() -> Void)?

    init(layout: TKTableLayout, fullTable: Bool = false) {
        tableLayout = layout
        let viewportHeight = fullTable ? layout.contentSize.height : layout.bubbleViewportHeight
        super.init(frame: CGRect(origin: .zero,
                                 size: CGSize(width: layout.contentSize.width,
                                              height: viewportHeight)))
        delegate = self
        backgroundColor = .clear
        showsHorizontalScrollIndicator = layout.contentSize.width > bounds.width
        showsVerticalScrollIndicator = fullTable && layout.contentSize.height > bounds.height
        alwaysBounceHorizontal = false
        alwaysBounceVertical = false
        isDirectionalLockEnabled = true
        delaysContentTouches = false
        contentSize = CGSize(width: layout.contentSize.width, height: viewportHeight)
        isAccessibilityElement = true
        accessibilityLabel = "Markdown table"
        accessibilityValue = layout.semanticText()
        accessibilityHint = layout.hiddenRowCount > 0
            ? "Swipe horizontally for more columns. Activate Show more rows for the complete table."
            : "Swipe horizontally to view more columns"
        accessibilityTraits = [.adjustable]
        if layout.hiddenRowCount > 0 {
            accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "Show all rows", target: self,
                                            selector: #selector(accessibilityShowAllRows))
            ]
        }

        let canvas = TKTableCanvasView(layout: layout)
        canvas.frame = CGRect(x: 0, y: 0, width: layout.contentSize.width,
                              height: fullTable ? layout.contentSize.height : layout.bubbleRowsHeight)
        addSubview(canvas)

        if !fullTable, layout.hiddenRowCount > 0 {
            var config = UIButton.Configuration.plain()
            config.title = "Show \(layout.hiddenRowCount) more rows"
            config.image = UIImage(systemName: "chevron.down")
            config.imagePlacement = .trailing
            config.imagePadding = 6
            config.baseForegroundColor = .secondaryLabel
            showMoreButton.configuration = config
            showMoreButton.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
            showMoreButton.addTarget(self, action: #selector(showAllRows), for: .touchUpInside)
            showMoreButton.frame = CGRect(x: 0, y: layout.bubbleRowsHeight,
                                          width: layout.contentSize.width,
                                          height: TKTableLayout.showMoreHeight)
            addSubview(showMoreButton)
        }

        overflowHint.tintColor = .secondaryLabel
        overflowHint.contentMode = .center
        overflowHint.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.72)
        overflowHint.layer.cornerRadius = 10
        overflowHint.isAccessibilityElement = false
        addSubview(overflowHint)
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func showAllRows() {
        onShowAll?()
    }

    @objc private func accessibilityShowAllRows() -> Bool {
        onShowAll?()
        return true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        overflowHint.frame = CGRect(x: contentOffset.x + bounds.width - 24,
                                    y: contentOffset.y + max(6, (bounds.height - 20) / 2),
                                    width: 20, height: 20)
        bringSubviewToFront(overflowHint)
        updateOverflowHint()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        setNeedsLayout()
    }

    override func accessibilityIncrement() {
        scrollHorizontally(direction: 1)
    }

    override func accessibilityDecrement() {
        scrollHorizontally(direction: -1)
    }

    private func scrollHorizontally(direction: CGFloat) {
        let maximum = max(0, contentSize.width - bounds.width)
        let target = min(maximum, max(0, contentOffset.x + direction * bounds.width * 0.8))
        setContentOffset(CGPoint(x: target, y: contentOffset.y), animated: true)
    }

    private func updateOverflowHint() {
        let maximum = max(0, contentSize.width - bounds.width)
        overflowHint.isHidden = maximum <= 1 || contentOffset.x >= maximum - 1
    }
}

final class TKTableAttachment: NSTextAttachment {
    let tableLayout: TKTableLayout

    init(rows: [[String]], alignments: [TableAlignment]) {
        tableLayout = TKTableLayout(rows: rows, alignments: alignments)
        super.init(data: nil, ofType: nil)
        allowsTextAttachmentView = false
        image = Self.transparentPixel
    }

    required init?(coder: NSCoder) { fatalError() }

    private static let transparentPixel: UIImage = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        return renderer.image { _ in }
    }()

    override func attachmentBounds(
        for attributes: [NSAttributedString.Key: Any],
        location: NSTextLocation,
        textContainer: NSTextContainer?,
        proposedLineFragment: CGRect,
        position: CGPoint
    ) -> CGRect {
        CGRect(x: 0, y: 0, width: proposedLineFragment.width,
               height: tableLayout.bubbleViewportHeight)
    }
}

enum TKMarkdown {
    static func prewarmSyntaxHighlighter() {
        TKCodeHighlighter.prewarm()
    }

    /// Parse `text` to an `NSAttributedString` matching the SwiftUI bubble's
    /// inline-only markdown + heading post-pass. Cached by content.
    static func attributed(_ text: String, cacheKey: String) -> NSAttributedString {
        // The caller key identifies the message/slot, but live content can
        // change in-place. Include the complete source so equal-length updates
        // cannot inherit stale block metadata (for example code → plain text).
        let key = "\(cacheKey)\u{1F}\(text)" as NSString
        if let hit = tkMarkdownCache.object(forKey: key) { return hit }
        let built = build(text)
        tkMarkdownCache.setObject(built, forKey: key)
        return built
    }

    /// Build the full body: split into inline / code / blockquote / table
    /// segments and assemble one styled `NSAttributedString`. Keeping it a
    /// single string lets the cell render it in ONE reused TextKit2
    /// `UITextView` (the proven-fast path) rather than a stack of views.
    private static func build(_ text: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let segments = splitMessageBody(text)
        for (i, seg) in segments.enumerated() {
            let piece: NSAttributedString
            switch seg {
            case .inline(let content):
                piece = inlineSegment(content)
            case .blockquote(let content):
                piece = blockquoteSegment(content)
            case .codeBlock(let language, let code):
                piece = codeSegment(language: language, code: code)
            case .table(let rows, let alignments):
                piece = tableSegment(rows: rows, alignments: alignments)
            }
            if i > 0 {
                // 6pt gap between segments (mirrors the SwiftUI VStack spacing).
                out.append(NSAttributedString(string: "\n", attributes: [
                    .font: UIFont.systemFont(ofSize: 6),
                ]))
            }
            out.append(piece)
        }
        if out.length == 0 { return inlineSegment(text) }
        return out
    }

    /// Inline markdown segment: headings and lists are normalized before the
    /// inline markdown pass so source markers (`#`, `-`, `1.`) never leak into
    /// rendered output. List rows use hanging indents and real typographic
    /// bullets/numbers while preserving inline emphasis and links per row.
    private static func inlineSegment(_ text: String) -> NSAttributedString {
        let lines = text.components(separatedBy: "\n")
        let result = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            if let heading = parseHeading(line) {
                let piece = inlineMarkdown(heading.text, baseFont: heading.font)
                let paragraph = NSMutableParagraphStyle()
                paragraph.paragraphSpacingBefore = heading.level == 1 ? 2 : 1
                paragraph.paragraphSpacing = heading.level <= 2 ? 5 : 3
                result.append(applyingParagraph(paragraph, to: piece))
            } else if let list = parseListItem(line) {
                let marker = list.ordered ? "\(list.number)." : "•"
                let markerWidth = list.ordered ? 25.0 : 18.0
                let indent = CGFloat(list.depth) * 18
                let paragraph = NSMutableParagraphStyle()
                paragraph.firstLineHeadIndent = indent
                paragraph.headIndent = indent + markerWidth
                paragraph.tabStops = [NSTextTab(textAlignment: .left, location: indent + markerWidth)]
                paragraph.defaultTabInterval = markerWidth
                paragraph.paragraphSpacing = 3
                let row = NSMutableAttributedString(string: "\(marker)\t", attributes: [
                    .font: UIFont.preferredFont(forTextStyle: .subheadline).tkBold,
                    .foregroundColor: UIColor.secondaryLabel,
                ])
                row.append(inlineMarkdown(list.text, baseFont: UIFont.preferredFont(forTextStyle: .subheadline)))
                row.addAttribute(.paragraphStyle, value: paragraph,
                                 range: NSRange(location: 0, length: row.length))
                result.append(row)
            } else {
                result.append(inlineMarkdown(line, baseFont: UIFont.preferredFont(forTextStyle: .subheadline)))
            }
        }
        return result
    }

    private static func inlineMarkdown(_ text: String, baseFont: UIFont) -> NSAttributedString {
        let parsed: AttributedString = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        let result = NSMutableAttributedString()
        for run in parsed.runs {
            let slice = String(parsed[run.range].characters)
            var font = baseFont
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.stronglyEmphasized) { font = font.tkBold }
                if intent.contains(.emphasized) { font = font.tkItalic }
                if intent.contains(.code) {
                    font = .monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular)
                }
            }
            var attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: UIColor.label,
            ]
            if let link = run.link {
                attrs[.link] = link
                attrs[.foregroundColor] = UIColor.tintColor
            }
            result.append(NSAttributedString(string: slice, attributes: attrs))
        }
        return result
    }

    private static func applyingParagraph(_ paragraph: NSParagraphStyle,
                                          to string: NSAttributedString) -> NSAttributedString {
        let result = NSMutableAttributedString(attributedString: string)
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        return result
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String, font: UIFont)? {
        let chars = Array(line)
        var level = 0
        while level < min(chars.count, 6), chars[level] == "#" { level += 1 }
        guard level > 0, chars.count > level, chars[level] == " " else { return nil }
        let text = String(chars.dropFirst(level + 1))
        guard !text.isEmpty else { return nil }
        let font: UIFont
        switch level {
        case 1: font = UIFont.preferredFont(forTextStyle: .title2).tkBold
        case 2: font = UIFont.preferredFont(forTextStyle: .title3).tkBold
        case 3: font = UIFont.preferredFont(forTextStyle: .headline)
        case 4: font = UIFont.preferredFont(forTextStyle: .subheadline).tkBold
        default: font = UIFont.preferredFont(forTextStyle: .footnote).tkBold
        }
        return (level, text, font)
    }

    private static func parseListItem(_ line: String) -> (ordered: Bool, number: Int, depth: Int, text: String)? {
        let leading = line.prefix { $0 == " " || $0 == "\t" }
        let depth = leading.reduce(0) { $1 == "\t" ? $0 + 1 : $0 + 1 } / 2
        let trimmed = line.dropFirst(leading.count)
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            return (false, 0, depth, String(trimmed.dropFirst(2)))
        }
        var digits = ""
        var cursor = trimmed.startIndex
        while cursor < trimmed.endIndex, trimmed[cursor].isNumber {
            digits.append(trimmed[cursor])
            cursor = trimmed.index(after: cursor)
        }
        guard !digits.isEmpty, cursor < trimmed.endIndex, trimmed[cursor] == "." else { return nil }
        cursor = trimmed.index(after: cursor)
        guard cursor < trimmed.endIndex, trimmed[cursor] == " " else { return nil }
        let text = String(trimmed[trimmed.index(after: cursor)...])
        return (true, Int(digits) ?? 1, depth, text)
    }

    /// Blockquote: padded text with a real drawn leading rule. The source `>`
    /// markers are already removed by the body splitter; one block id spans all
    /// wrapped lines so the background/rule is drawn as one continuous region.
    private static func blockquoteSegment(_ content: String) -> NSAttributedString {
        let normalized = normalizeQuoteWhitespace(content)
        let result = NSMutableAttributedString(attributedString: inlineSegment(normalized))
        result.addAttribute(.foregroundColor, value: UIColor.label,
                            range: NSRange(location: 0, length: result.length))
        let paragraph = NSMutableParagraphStyle()
        paragraph.firstLineHeadIndent = 14
        paragraph.headIndent = 14
        paragraph.tailIndent = -8
        paragraph.lineSpacing = 1
        paragraph.paragraphSpacingBefore = 0
        paragraph.paragraphSpacing = 0
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        markBlock(result, kind: .quote)
        return result
    }

    private static func normalizeQuoteWhitespace(_ content: String) -> String {
        var lines = content.components(separatedBy: "\n")
        while lines.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeFirst() }
        while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeLast() }
        var normalized: [String] = []
        var previousWasEmpty = false
        for line in lines {
            let empty = line.trimmingCharacters(in: .whitespaces).isEmpty
            if empty, previousWasEmpty { continue }
            normalized.append(line)
            previousWasEmpty = empty
        }
        return normalized.joined(separator: "\n")
    }

    /// Fenced code uses a neutral editor surface drawn by `TKBodyTextView`.
    /// The language is syntax metadata rather than message content, so it is
    /// intentionally not injected as a fake first line. This matches the web
    /// `<pre>` treatment and keeps copy/selection limited to actual code.
    private static func codeSegment(language: String?, code: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let topHeight: CGFloat = language?.isEmpty == false ? 20 : 8
        result.append(codeSpacer(height: topHeight, terminatesLine: true))

        let highlighted = NSMutableAttributedString(
            attributedString: TKCodeHighlighter.attributed(code: code, language: language)
        )
        if highlighted.length > 0 {
            let paragraph = NSMutableParagraphStyle()
            paragraph.firstLineHeadIndent = 12
            paragraph.headIndent = 12
            paragraph.tailIndent = -12
            paragraph.lineSpacing = 2
            highlighted.addAttributes([
                .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                .paragraphStyle: paragraph,
            ], range: NSRange(location: 0, length: highlighted.length))
            result.append(highlighted)
        }
        result.append(NSAttributedString(string: "\n"))
        result.append(codeSpacer(height: 8, terminatesLine: false))

        markBlock(result, kind: .code)
        if let language, !language.isEmpty, result.length > 0 {
            result.addAttribute(.tkBlockLabel, value: language.lowercased(),
                                range: NSRange(location: 0, length: result.length))
        }
        return result
    }

    private static func codeSpacer(height: CGFloat, terminatesLine: Bool) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = height
        paragraph.maximumLineHeight = height
        return NSAttributedString(string: terminatesLine ? "\u{200B}\n" : "\u{200B}", attributes: [
            .font: UIFont.systemFont(ofSize: 1),
            .foregroundColor: UIColor.clear,
            .paragraphStyle: paragraph,
            .tkDecorativeSpacer: true,
        ])
    }

    /// Native scrollable GFM table attachment. Column widths come from the
    /// actual content, wide tables scroll horizontally, tall tables cap their
    /// viewport and scroll vertically, and no cell text is truncated.
    private static func tableSegment(rows: [[String]], alignments: [TableAlignment]) -> NSAttributedString {
        guard let header = rows.first, !header.isEmpty else { return NSAttributedString() }
        let attachment = TKTableAttachment(rows: rows, alignments: alignments)
        let semanticText = attachment.tableLayout.semanticText()
        return NSAttributedString(attachment: attachment, attributes: [
            .tkSemanticText: semanticText,
        ])
    }

    private static func markBlock(_ string: NSMutableAttributedString, kind: TKBlockKind) {
        guard string.length > 0 else { return }
        let range = NSRange(location: 0, length: string.length)
        string.addAttribute(.tkBlockKind, value: kind.rawValue, range: range)
        string.addAttribute(.tkBlockID, value: UUID().uuidString, range: range)
    }

    static func plainText(_ attr: NSAttributedString?) -> String? {
        guard let attr, attr.length > 0 else { return nil }
        var output = ""
        attr.enumerateAttributes(in: NSRange(location: 0, length: attr.length)) { attributes, range, _ in
            if attributes[.tkDecorativeSpacer] != nil { return }
            if let semantic = attributes[.tkSemanticText] as? String {
                output += semantic
            } else {
                output += attr.attributedSubstring(from: range).string
            }
        }
        return output
            .replacingOccurrences(of: "\u{FFFC}", with: "")
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Copy an attributed body while replacing its foreground color. Links keep
    /// their URL attribute, so UIKit still treats them as tappable.
    static func recolored(_ attr: NSAttributedString, color: UIColor) -> NSAttributedString {
        let copy = NSMutableAttributedString(attributedString: attr)
        let full = NSRange(location: 0, length: copy.length)
        copy.enumerateAttribute(.tkBlockKind, in: full) { value, range, _ in
            if value as? String != TKBlockKind.code.rawValue {
                copy.addAttribute(.foregroundColor, value: color, range: range)
            }
        }
        return copy
    }

    /// A dimmed copy (foreground alpha 0.7) — matches SwiftUI history
    /// `agent_message` rendered with `.primary.opacity(0.7)`.
    static func dimmed(_ attr: NSAttributedString) -> NSAttributedString {
        let m = NSMutableAttributedString(attributedString: attr)
        let full = NSRange(location: 0, length: m.length)
        m.enumerateAttribute(.foregroundColor, in: full) { val, range, _ in
            let c = (val as? UIColor) ?? .label
            m.addAttribute(.foregroundColor, value: c.withAlphaComponent(0.7), range: range)
        }
        return m
    }
}

// MARK: - Shared TextKit2 measurement

enum TKMeasure {
    static func naturalWidth(_ attr: NSAttributedString) -> CGFloat {
        guard attr.length > 0 else { return 0 }
        let rect = attr.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude,
                         height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        return ceil(rect.width)
    }

    /// Lay out `attr` in a TextKit2 stack at `width` and return the used
    /// height. Matches a `UITextView(usingTextLayoutManager: true)` with
    /// `textContainerInset = .zero` and `lineFragmentPadding = 0`.
    static func height(_ attr: NSAttributedString, width: CGFloat) -> CGFloat {
        guard width > 0, attr.length > 0 else { return 0 }
        let content = NSTextContentStorage()
        content.attributedString = attr
        let layout = NSTextLayoutManager()
        let container = NSTextContainer(size: CGSize(width: width,
                                                     height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.textContainer = container
        content.addTextLayoutManager(layout)
        layout.ensureLayout(for: layout.documentRange)
        var maxY: CGFloat = 0
        layout.enumerateTextLayoutFragments(from: nil, options: [.ensuresLayout]) { frag in
            maxY = max(maxY, frag.layoutFragmentFrame.maxY)
            return true
        }
        return ceil(maxY)
    }
}

// MARK: - Flat bubble content model

/// Immutable TextKit description of one persisted spine message. Tool and
/// narration history intentionally do not live here; they are fetched through
/// the TRACE axis and shown by the Steps sheet.
final class TKBubbleContent {
    enum Kind: Equatable { case agent, user, error, system }

    let message: ChatMessage
    let kind: Kind
    let hueSeed: String
    let body: NSAttributedString?
    let images: [UIImage]
    /// Lazy image references (tool-produced images via `kraki-show_image`).
    /// Surfaced through the `AttachmentStore` chunk pipeline; rendered as a
    /// SwiftUI grid inside the cell. Mirrors web `content_ref` handling.
    let imageRefs: [ContentRef]
    /// Optional action slot for a streaming / frozen turn: tool_start /
    /// tool_complete / tool_batch / permission / question / user_abort /
    /// failed. nil on ordinary completed bubbles. Replaces the old
    /// LiveAgentBubbleView action section — same bubble, same path.
    let action: ChatMessage?
    /// Streaming tail card (live draft). Drives the footer rule below.
    let isLive: Bool
    /// Frozen terminal card (turn_status / interrupted_turn). Real timestamp.
    let isFrozen: Bool
    let frozenTimestamp: String?

    private var heightCache: [CGFloat: CGFloat] = [:]
    private var bodyTextHeightCache: [CGFloat: CGFloat] = [:]

    init(message: ChatMessage, kind: Kind, hueSeed: String,
         body: NSAttributedString?, images: [UIImage] = [],
         imageRefs: [ContentRef] = [],
         action: ChatMessage? = nil, isLive: Bool = false,
         isFrozen: Bool = false, frozenTimestamp: String? = nil) {
        self.message = message
        self.kind = kind
        self.hueSeed = hueSeed
        self.body = body
        self.images = images
        self.imageRefs = imageRefs
        self.action = action
        self.isLive = isLive
        self.isFrozen = isFrozen
        self.frozenTimestamp = frozenTimestamp
    }

    var canShowSteps: Bool {
        (kind == .agent || kind == .system) && (message.steps ?? 0) > 0
    }

    /// Build a live/frozen bubble content from a streaming `SessionCard` (or a
    /// frozen terminal card rebuilt from a persisted message). Mirrors the old
    /// LiveAgentBubbleView: the draft becomes the body, the card.action becomes
    /// the action slot. The host TKBubbleCell renders both through the same
    /// TextKit path as a completed bubble.
    static func live(card: MessageStore.SessionCard, agent: String, sessionId: String,
                     steps: Int, isFrozen: Bool = false,
                     frozenTimestamp: String? = nil) -> TKBubbleContent {
        let draft = card.text
        var payload: [String: AnyCodable] = [:]
        if !draft.isEmpty { payload["content"] = AnyCodable(draft) }
        if steps > 0 { payload["steps"] = AnyCodable(steps) }
        let msg = ChatMessage(type: "agent_message", seq: 0,
                              sessionId: sessionId, deviceId: nil,
                              timestamp: frozenTimestamp, payload: payload)
        let body = draft.isEmpty ? nil
            : TKMarkdown.attributed(draft, cacheKey: "\(sessionId):live:\(draft.count)")
        return TKBubbleContent(message: msg, kind: .agent, hueSeed: sessionId,
                               body: body, images: [], action: card.action,
                               isLive: !isFrozen, isFrozen: isFrozen,
                               frozenTimestamp: frozenTimestamp)
    }

    func bubbleWidth(cellWidth: CGFloat) -> CGFloat {
        let usable = cellWidth - TKMetrics.outerH * 2
        switch kind {
        case .agent:
            return usable - cellWidth * TKMetrics.trailingGapFraction
        case .user:
            let maximum = usable - cellWidth * TKMetrics.userLeadingGapFraction
            // User bubbles hug short content like Messages/Web instead of
            // occupying a fixed 82%-wide slab. Images keep the established
            // maximum so their layout remains stable; long text clamps and
            // wraps at that same maximum.
            guard images.isEmpty, action == nil else { return maximum }
            let naturalBody = body.map(TKMeasure.naturalWidth) ?? 0
            let fitted = ceil(naturalBody) + TKMetrics.msgPadH * 2
            return min(maximum, max(fitted, TKMetrics.msgPadH * 2 + 1))
        case .error, .system:
            return usable - cellWidth * 0.10
        }
    }

    func bodyTextWidth(cellWidth: CGFloat) -> CGFloat {
        bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
    }

    func bodyTextHeight(cellWidth: CGFloat) -> CGFloat {
        guard let body, body.length > 0 else { return 0 }
        let width = bodyTextWidth(cellWidth: cellWidth)
        if let cached = bodyTextHeightCache[width] { return cached }
        let height = TKMeasure.height(body, width: width)
        bodyTextHeightCache[width] = height
        return height
    }

    func imageDisplaySize(_ image: UIImage, maxWidth: CGFloat) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return .zero }
        var width = min(size.width, maxWidth)
        var height = width * size.height / size.width
        if height > TKMetrics.imageMaxHeight {
            height = TKMetrics.imageMaxHeight
            width = height * size.width / size.height
        }
        return CGSize(width: width, height: height)
    }

    func imagesHeight(cellWidth: CGFloat) -> CGFloat {
        let width = bodyTextWidth(cellWidth: cellWidth)
        return images.enumerated().reduce(0) { total, pair in
            total + (pair.offset == 0 ? 0 : TKMetrics.imageSpacing)
                + imageDisplaySize(pair.element, maxWidth: width).height
        }
    }

    var footerDate: Date? { nil }

    func cellHeight(cellWidth: CGFloat) -> CGFloat {
        if let cached = heightCache[cellWidth] { return cached }
        let textHeight = bodyTextHeight(cellWidth: cellWidth)
        let imageHeight = imagesHeight(cellWidth: cellWidth)
        let textGap = textHeight > 0 && imageHeight > 0 ? TKMetrics.imageSpacing : 0
        var h = textHeight + textGap + imageHeight
        // Lazy content-ref images (kraki-show_image). Placeholder height
        // until chunks hydrate; the live cell invalidates via onHeightChange.
        if !imageRefs.isEmpty {
            let refWidth = bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
            let imageRefH = TKImageMeasure.height(refs: imageRefs, sessionId: message.sessionId ?? "", width: refWidth)
            if h > 0 { h += TKMetrics.imageSpacing }
            h += imageRefH
        }
        // Action slot (streaming / frozen): measured synchronously via the same
        // SwiftUI host the cell uses, so cellHeight matches what configure lays
        // out. The list re-measures on action transitions via onActionHeightChange.
        if let action {
            let actionWidth = bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
            let actionH = TKActionMeasure.height(action: action, width: actionWidth)
            if h > 0 { h += 8 }
            h += actionH
        }
        if h > 0 || action != nil { h += TKMetrics.msgPadV * 2 }
        else { h += TKMetrics.msgPadV * 2 }
        let height = max(h, 1) + TKMetrics.outerV * 2
        heightCache[cellWidth] = height
        return height
    }

    func bubbleColor(dark: Bool) -> UIColor {
        let hue = stringToHue(hueSeed) / 360
        switch kind {
        case .agent:
            let (h, s, b) = hslToHSB(h: hue, s: dark ? 0.35 : 0.40, l: dark ? 0.18 : 0.93)
            return UIColor(hue: h, saturation: s, brightness: b, alpha: 1)
        case .user:
            return UIColor(Color.krakiPrimary)
        case .error:
            return UIColor.systemRed.withAlphaComponent(dark ? 0.20 : 0.12)
        case .system:
            return dark ? UIColor.tertiarySystemFill : UIColor.secondarySystemBackground
        }
    }

    private static let cache: NSCache<NSString, TKBubbleContent> = {
        let cache = NSCache<NSString, TKBubbleContent>()
        cache.countLimit = 600
        return cache
    }()

    static func make(message: ChatMessage, sessionId: String, agent: String) -> TKBubbleContent {
        let key = message.id as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let built = build(message: message, sessionId: sessionId, agent: agent)
        cache.setObject(built, forKey: key)
        return built
    }

    static func bust(_ id: String) { cache.removeObject(forKey: id as NSString) }

    private static func build(message: ChatMessage, sessionId: String, agent: String) -> TKBubbleContent {
        let isUser = ["user_message", "send_input", "pending_input"].contains(message.type)
        let kind: Kind
        switch message.type {
        case "error": kind = .error
        case "system_message": kind = .system
        default: kind = isUser ? .user : .agent
        }
        // `interrupted_turn` / `turn_status` are excluded from the bubble list
        // in ChatViewModel — they render via the frozen LiveAgentBubble path.
        let source = message.content
        let rawBody = source.flatMap { text -> NSAttributedString? in
            guard !text.isEmpty, text != "[image]" else { return nil }
            return TKMarkdown.attributed(text, cacheKey: "\(message.id):body:\(text.count)")
        }
        // One bubble implementation: every renderable message uses the same
        // path — agent/user/system/error recolor of its body text.
        let body: NSAttributedString?
        switch kind {
        case .user:
            body = rawBody.map { TKMarkdown.recolored($0, color: .white) }
        case .error:
            body = TKMarkdown.recolored(
                rawBody ?? NSAttributedString(string: message.result ?? "Error"),
                color: .systemRed)
        case .system, .agent:
            body = rawBody
        }
        return TKBubbleContent(
            message: message, kind: kind, hueSeed: sessionId.isEmpty ? agent : sessionId,
            body: body, images: decodeImages(message.attachments),
            imageRefs: message.contentRefAttachments.filter { $0.mimeType.hasPrefix("image/") })
    }

    private static let imageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    private static func decodeImages(_ attachments: [ImageAttachment]?) -> [UIImage] {
        guard let attachments else { return [] }
        return attachments.compactMap { attachment in
            guard attachment.type == "image" else { return nil }
            let key = attachment.data as NSString
            if let cached = imageCache.object(forKey: key) { return cached }
            guard let data = Data(base64Encoded: attachment.data),
                  let image = UIImage(data: data) else { return nil }
            imageCache.setObject(image, forKey: key)
            return image
        }
    }
}

// MARK: - Rounded bubble background view (per-corner radii)

private final class TKRoundedView: UIView {
    var fillColor: UIColor = .clear { didSet { setNeedsLayout() } }
    /// (topLeading, topTrailing, bottomLeading, bottomTrailing)
    var radii: (CGFloat, CGFloat, CGFloat, CGFloat) = (16, 16, 16, 16) {
        didSet { setNeedsLayout() }
    }
    private let shape = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(shape)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let (tl, tr, bl, br) = radii
        let path = UIBezierPath()
        let r = bounds
        path.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        path.addArc(withCenter: CGPoint(x: r.maxX - tr, y: r.minY + tr),
                    radius: tr, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        path.addArc(withCenter: CGPoint(x: r.maxX - br, y: r.maxY - br),
                    radius: br, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        path.addArc(withCenter: CGPoint(x: r.minX + bl, y: r.maxY - bl),
                    radius: bl, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        path.addArc(withCenter: CGPoint(x: r.minX + tl, y: r.minY + tl),
                    radius: tl, startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: true)
        path.close()
        shape.path = path.cgPath
        shape.fillColor = fillColor.cgColor
    }
}

// MARK: - The TextKit2 bubble cell

/// Read-only text view for the bubble body. Whole-message Copy / Steps live on
/// the cell's context menu, so the body must never become first responder: on
/// iOS 26 a focused non-editable UITextView draws an editor surface and caret
/// behind otherwise plain text. Links and embedded tables remain interactive
/// through their existing tap/host paths.
final class TKBodyTextView: UITextView {
    override var canBecomeFirstResponder: Bool { false }

    private struct RichBlock {
        let kind: TKBlockKind
        let label: String?
        var rect: CGRect
    }

    struct TablePlacement {
        let attachment: TKTableAttachment
        let frame: CGRect
    }

    func tablePlacements() -> [TablePlacement] {
        guard let textLayoutManager,
              let storage = textLayoutManager.textContentManager as? NSTextContentStorage,
              let attributedText, attributedText.length > 0 else { return [] }
        var placements: [TablePlacement] = []
        attributedText.enumerateAttribute(.attachment,
                                          in: NSRange(location: 0, length: attributedText.length)) { value, range, _ in
            guard let attachment = value as? TKTableAttachment,
                  let location = storage.location(storage.documentRange.location, offsetBy: range.location),
                  let fragment = textLayoutManager.textLayoutFragment(for: location) else { return }
            var frame = fragment.layoutFragmentFrame
            frame.origin.x = 0
            frame.size.width = bounds.width
            frame.size.height = attachment.tableLayout.bubbleViewportHeight
            placements.append(TablePlacement(attachment: attachment, frame: frame))
        }
        return placements
    }

    override func draw(_ rect: CGRect) {
        // This view is transparent over the bubble color. Explicitly clear the
        // dirty region before redrawing: TextKit2 can otherwise preserve pixels
        // drawn by a previous reused message's code surface (#18181B) when the
        // replacement is plain text and invalidates only its glyph bounds.
        UIGraphicsGetCurrentContext()?.clear(rect)
        drawRichBlocks()
        super.draw(rect)
    }

    private func drawRichBlocks() {
        guard let textLayoutManager,
              let storage = textLayoutManager.textContentManager as? NSTextContentStorage,
              let attributedText, attributedText.length > 0,
              let context = UIGraphicsGetCurrentContext() else { return }

        var blocks: [String: RichBlock] = [:]
        textLayoutManager.enumerateTextLayoutFragments(from: nil, options: [.ensuresLayout]) { fragment in
            let start = storage.offset(from: storage.documentRange.location,
                                       to: fragment.rangeInElement.location)
            guard start >= 0, start < attributedText.length,
                  let blockID = attributedText.attribute(.tkBlockID, at: start, effectiveRange: nil) as? String,
                  let rawKind = attributedText.attribute(.tkBlockKind, at: start, effectiveRange: nil) as? String,
                  let kind = TKBlockKind(rawValue: rawKind) else { return true }
            let label = attributedText.attribute(.tkBlockLabel, at: start, effectiveRange: nil) as? String
            var frame = fragment.layoutFragmentFrame
            frame.origin.x = 0
            frame.size.width = bounds.width
            if var current = blocks[blockID] {
                current.rect = current.rect.union(frame)
                blocks[blockID] = current
            } else {
                blocks[blockID] = RichBlock(kind: kind, label: label, rect: frame)
            }
            return true
        }

        context.saveGState()
        defer { context.restoreGState() }
        for block in blocks.values.sorted(by: { $0.rect.minY < $1.rect.minY }) {
            var frame = block.rect.insetBy(dx: 0, dy: -2)
            frame = frame.intersection(bounds.insetBy(dx: 0, dy: -1))
            guard !frame.isNull, frame.height > 0 else { continue }
            switch block.kind {
            case .quote:
                UIColor.secondarySystemFill.setFill()
                UIBezierPath(roundedRect: frame, cornerRadius: 8).fill()
                UIColor.tertiaryLabel.setFill()
                UIBezierPath(roundedRect: CGRect(x: frame.minX, y: frame.minY,
                                                 width: 3, height: frame.height),
                             cornerRadius: 1.5).fill()
            case .code:
                // A code block is its own editor surface. Keep it neutral and
                // stable across differently tinted agent/user bubbles.
                UIColor(red: 0x18/255, green: 0x18/255, blue: 0x1B/255, alpha: 1).setFill()
                UIBezierPath(roundedRect: frame, cornerRadius: 9).fill()
                UIColor(red: 0x52/255, green: 0x52/255, blue: 0x5B/255, alpha: 0.72).setStroke()
                let outline = UIBezierPath(roundedRect: frame.insetBy(dx: 0.25, dy: 0.25), cornerRadius: 9)
                outline.lineWidth = 0.5
                outline.stroke()
                if let label = block.label {
                    let attributes: [NSAttributedString.Key: Any] = [
                        .font: UIFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                        .foregroundColor: UIColor(red: 0xA1/255, green: 0xA1/255, blue: 0xAA/255, alpha: 1),
                    ]
                    label.draw(at: CGPoint(x: frame.minX + 12, y: frame.minY + 5), withAttributes: attributes)
                }
            }
        }
    }

    override func addGestureRecognizer(_ gestureRecognizer: UIGestureRecognizer) {
        if let tap = gestureRecognizer as? UITapGestureRecognizer,
           tap.numberOfTapsRequired >= 2 {
            tap.isEnabled = false
        }
        super.addGestureRecognizer(gestureRecognizer)
    }

    /// Disable the (interaction-managed) double-tap-to-select-word recognizer.
    /// Idempotent; call whenever interaction is (re)enabled.
    func disableDoubleTapSelection() {
        guard let grs = gestureRecognizers else { return }
        for g in grs {
            if let tap = g as? UITapGestureRecognizer, tap.numberOfTapsRequired == 2 {
                tap.isEnabled = false
            }
        }
    }
}

/// A UILabel with text insets — the tool-name pill chip.
private final class TKPillLabel: UILabel {
    var insets = UIEdgeInsets(top: 1, left: 5, bottom: 1, right: 5)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right,
                      height: s.height + insets.top + insets.bottom)
    }
}

final class TKTableSheetViewController: UIViewController {
    private let tableLayout: TKTableLayout

    init(layout: TKTableLayout) {
        tableLayout = layout
        super.init(nibName: nil, bundle: nil)
        title = "Table"
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let close = UIBarButtonItem(systemItem: .close)
        close.target = self
        close.action = #selector(dismissSheet)
        navigationItem.rightBarButtonItem = close

        let table = TKTableScrollView(layout: tableLayout, fullTable: true)
        table.translatesAutoresizingMaskIntoConstraints = false
        table.alwaysBounceVertical = true
        table.contentSize = tableLayout.contentSize
        view.addSubview(table)
        NSLayoutConstraint.activate([
            table.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            table.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func dismissSheet() { dismiss(animated: true) }
}

/// Flat, single-message TextKit cell used by the production chat list.
final class TKBubbleCell: UICollectionViewCell, UIContextMenuInteractionDelegate {
    static let reuseID = "TKBubbleCell"

    var onOpenSteps: ((ChatMessage) -> Void)?
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var attachmentStore: AttachmentStore?
    var sessionMode: SessionMode = .discuss
    var onActionHeightChange: (() -> Void)?
    var onShowTable: ((TKTableLayout) -> Void)?
    private(set) var sessionId: String = ""
    var contentSnapshot: TKBubbleContent? { content }

    private let bubbleBG = TKRoundedView()
    private let bodyView: TKBodyTextView
    private let moreButton = UIButton(type: .system)
    private let actionHost = BubbleActionHostView()
    private let imageHost = BubbleImageHostView()
    private var imageViews: [UIImageView] = []
    private var tableViews: [TKTableScrollView] = []
    private var tableAttachmentIDs: [ObjectIdentifier] = []
    private var bodyHasLinks = false
    private var content: TKBubbleContent?

    override init(frame: CGRect) {
        bodyView = TKBodyTextView(usingTextLayoutManager: true)
        super.init(frame: frame)
        contentView.clipsToBounds = false
        contentView.addSubview(bubbleBG)

        bodyView.isEditable = false
        bodyView.isScrollEnabled = false
        bodyView.isSelectable = true
        bodyView.isUserInteractionEnabled = false
        bodyView.isOpaque = false
        bodyView.tintColor = .clear
        bodyView.backgroundColor = .clear
        bodyView.subviews.forEach {
            $0.isOpaque = false
            $0.backgroundColor = .clear
        }
        bodyView.textContainerInset = .zero
        bodyView.textContainer.lineFragmentPadding = 0
        bodyView.adjustsFontForContentSizeCategory = true
        bodyView.dataDetectorTypes = []
        contentView.addSubview(bodyView)

        // Historical bubble affordance (786cbdf3): a compact "···" capsule
        // floating over the bubble's top-right edge. For traceable messages it
        // opens Steps directly; the full action menu is available by long-press.
        var configuration = UIButton.Configuration.gray()
        configuration.title = "···"
        configuration.baseForegroundColor = .secondaryLabel
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 7, bottom: 2, trailing: 7)
        configuration.background.cornerRadius = 10
        moreButton.configuration = configuration
        moreButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        moreButton.addTarget(self, action: #selector(openSteps), for: .touchUpInside)
        moreButton.accessibilityLabel = "Show steps"
        contentView.addSubview(moreButton)
        contentView.addInteraction(UIContextMenuInteraction(delegate: self))

        // Action slot for streaming / frozen bubbles. Hidden on plain
        // completed bubbles (no action). Same cell as every other message.
        actionHost.backgroundColor = .clear
        actionHost.translatesAutoresizingMaskIntoConstraints = false
        actionHost.onHeightChange = { [weak self] _ in self?.onActionHeightChange?() }
        contentView.addSubview(actionHost)

        imageHost.backgroundColor = .clear
        imageHost.translatesAutoresizingMaskIntoConstraints = false
        imageHost.onHeightChange = { [weak self] _ in self?.onActionHeightChange?() }
        contentView.addSubview(imageHost)
    }

    required init?(coder: NSCoder) { fatalError() }

    func setBodyInteractive(_ enabled: Bool) {
        // Plain text never needs UITextView selection: whole-message Copy and
        // Steps are provided by the cell context menu. Only link-bearing text
        // receives UITextView touches, which prevents iOS selection highlights
        // from leaving black rectangles behind ordinary user/agent text.
        let textInteractive = enabled && bodyHasLinks
        if bodyView.isSelectable != textInteractive { bodyView.isSelectable = textInteractive }
        if bodyView.isUserInteractionEnabled != textInteractive {
            bodyView.isUserInteractionEnabled = textInteractive
        }
        for tableView in tableViews where tableView.isUserInteractionEnabled != enabled {
            tableView.isUserInteractionEnabled = enabled
        }
        if textInteractive { bodyView.disableDoubleTapSelection() }
    }

    func configure(_ content: TKBubbleContent, cellWidth: CGFloat) {
        self.content = content
        bodyView.resignFirstResponder()
        bodyHasLinks = false
        if let body = content.body, body.length > 0 {
            body.enumerateAttribute(.link,
                                    in: NSRange(location: 0, length: body.length)) { value, _, stop in
                if value != nil {
                    bodyHasLinks = true
                    stop.pointee = true
                }
            }
        }
        bodyView.isSelectable = false
        bodyView.isUserInteractionEnabled = false
        bodyView.isOpaque = false
        bodyView.backgroundColor = .clear
        bodyView.subviews.forEach {
            $0.isOpaque = false
            $0.backgroundColor = .clear
        }
        let dark = traitCollection.userInterfaceStyle == .dark
        bodyView.attributedText = content.body
        if !bodyHasLinks {
            // UITextView may restore its previous selected range while a reused
            // cell assigns new attributed text. Collapse it after assignment;
            // this removes stale whole-word/whole-message highlights without
            // asking TextKit2 for the invalid nil/NSNotFound selection state.
            bodyView.selectedRange = NSRange(location: 0, length: 0)
        }
        bodyView.setNeedsDisplay()
        bodyView.isHidden = content.body == nil
        bubbleBG.fillColor = content.bubbleColor(dark: dark)
        switch content.kind {
        case .agent: bubbleBG.radii = (4, 16, 16, 16)
        case .user: bubbleBG.radii = (16, 4, 16, 16)
        case .error, .system: bubbleBG.radii = (12, 12, 12, 12)
        }

        for (index, image) in content.images.enumerated() {
            let imageView: UIImageView
            if index < imageViews.count { imageView = imageViews[index] } else {
                imageView = UIImageView()
                imageView.contentMode = .scaleAspectFill
                imageView.clipsToBounds = true
                imageView.layer.cornerRadius = TKMetrics.imageCorner
                imageView.layer.shouldRasterize = true
                imageView.layer.rasterizationScale = UIScreen.main.scale
                contentView.addSubview(imageView)
                imageViews.append(imageView)
            }
            imageView.image = image
            imageView.isHidden = false
        }
        for index in content.images.count..<imageViews.count { imageViews[index].isHidden = true }

        // Lazy content-ref images (kraki-show_image). Hosted as SwiftUI so
        // they hydrate through AttachmentStore and grow the cell on load.
        sessionId = content.message.sessionId ?? sessionId
        if !content.imageRefs.isEmpty {
            imageHost.configure(refs: content.imageRefs, sessionId: sessionId, attachmentStore: attachmentStore)
            imageHost.isHidden = false
        } else {
            imageHost.isHidden = true
            imageHost.configure(refs: [], sessionId: sessionId, attachmentStore: attachmentStore)
        }

        moreButton.isHidden = !content.canShowSteps

        // Action slot (streaming / frozen turns). Hosts the SwiftUI action UI
        // inside this UIKit cell — same component as a completed bubble.
        if let action = content.action {
            actionHost.onResolvePermission = onResolvePermission
            actionHost.onAnswerQuestion = onAnswerQuestion
            actionHost.configure(action: action, sessionMode: sessionMode)
            actionHost.isHidden = false
        } else {
            actionHost.isHidden = true
            actionHost.configure(action: nil, sessionMode: sessionMode)
        }

        let exposesInteractiveAction = content.action != nil
        var exposesInteractiveTable = false
        if let body = content.body {
            body.enumerateAttribute(.attachment,
                                    in: NSRange(location: 0, length: body.length)) { value, _, stop in
                if value is TKTableAttachment {
                    exposesInteractiveTable = true
                    stop.pointee = true
                }
            }
        }
        let exposesInteractiveContent = exposesInteractiveAction || exposesInteractiveTable
        let semanticText = TKMarkdown.plainText(content.body)
        isAccessibilityElement = !exposesInteractiveContent
        accessibilityLabel = exposesInteractiveContent ? nil : semanticText
        accessibilityTraits = content.kind == .error ? [.staticText, .notEnabled] : .staticText
        bodyView.isAccessibilityElement = exposesInteractiveContent && !(semanticText?.isEmpty ?? true)
        bodyView.accessibilityLabel = semanticText
        actionHost.isAccessibilityElement = false
        actionHost.accessibilityElementsHidden = false
        setNeedsLayout()
    }

    private func syncTableViews(bodyOrigin: CGPoint) {
        let placements = bodyView.tablePlacements()
        let desiredIDs = placements.map { ObjectIdentifier($0.attachment) }
        if desiredIDs != tableAttachmentIDs {
            let oldViews = tableViews
            tableViews = []
            tableAttachmentIDs = []
            oldViews.forEach { $0.removeFromSuperview() }
            tableAttachmentIDs = desiredIDs
            tableViews = placements.map { placement in
                let view = TKTableScrollView(layout: placement.attachment.tableLayout)
                view.onShowAll = { [weak self] in
                    self?.onShowTable?(placement.attachment.tableLayout)
                }
                view.isUserInteractionEnabled = bodyView.isUserInteractionEnabled
                contentView.addSubview(view)
                return view
            }
        }
        for (index, placement) in placements.enumerated() where index < tableViews.count {
            var frame = placement.frame
            frame.origin.x += bodyOrigin.x
            frame.origin.y += bodyOrigin.y
            let view = tableViews[index]
            view.frame = frame
            view.showsHorizontalScrollIndicator = placement.attachment.tableLayout.contentSize.width > frame.width
            view.showsVerticalScrollIndicator = placement.attachment.tableLayout.contentSize.height > frame.height
            contentView.bringSubviewToFront(view)
        }
    }

    @objc private func openSteps() {
        guard let content, content.canShowSteps else { return }
        onOpenSteps?(content.message)
    }

    func messageActions() -> [UIAction] {
        guard let content else { return [] }
        var actions: [UIAction] = []
        if let text = TKMarkdown.plainText(content.body), !text.isEmpty {
            actions.append(UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in
                UIPasteboard.general.string = text
            })
        }
        if content.canShowSteps {
            actions.append(UIAction(title: "Show Steps", image: UIImage(systemName: "list.bullet.indent")) { [weak self] _ in
                self?.openSteps()
            })
        }
        return actions
    }

    func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard bubbleBG.frame.contains(location), !messageActions().isEmpty else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(children: self?.messageActions() ?? [])
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let content else { return }
        let cellWidth = bounds.width
        let bubbleWidth = content.bubbleWidth(cellWidth: cellWidth)
        let x: CGFloat
        switch content.kind {
        case .agent: x = TKMetrics.outerH
        case .user: x = cellWidth - TKMetrics.outerH - bubbleWidth
        case .error, .system: x = (cellWidth - bubbleWidth) / 2
        }
        let y = TKMetrics.outerV
        let innerX = x + TKMetrics.msgPadH
        let innerWidth = content.bodyTextWidth(cellWidth: cellWidth)
        var cursorY = y + TKMetrics.msgPadV
        let textHeight = content.bodyTextHeight(cellWidth: cellWidth)
        if textHeight > 0 {
            bodyView.frame = CGRect(x: innerX, y: cursorY, width: innerWidth, height: textHeight)
            cursorY += textHeight
        }
        syncTableViews(bodyOrigin: bodyView.frame.origin)
        if !content.images.isEmpty {
            if textHeight > 0 { cursorY += TKMetrics.imageSpacing }
            for (index, image) in content.images.enumerated() where index < imageViews.count {
                let size = content.imageDisplaySize(image, maxWidth: innerWidth)
                imageViews[index].frame = CGRect(x: innerX, y: cursorY, width: size.width, height: size.height)
                cursorY += size.height + TKMetrics.imageSpacing
            }
        }
        // Action slot (streaming / frozen). Placed inside the bubble width with
        // the same tertiary background + divider the old live card used.
        let actionWidth = bubbleWidth - TKMetrics.msgPadH * 2
        if !actionHost.isHidden {
            if cursorY > y + TKMetrics.msgPadV {
                cursorY += 8 // gap between body and action
            }
            actionHost.frame = CGRect(x: x + TKMetrics.msgPadH, y: cursorY, width: actionWidth, height: 60)
            actionHost.setNeedsLayout()
            actionHost.layoutIfNeeded()
            let fit = actionHost.hostingController?.view.systemLayoutSizeFitting(
                CGSize(width: actionWidth, height: .greatestFiniteMagnitude),
                withHorizontalFittingPriority: .required,
                verticalFittingPriority: .fittingSizeLevel).height ?? 0
            if fit > 0 {
                actionHost.frame.size.height = fit
                cursorY += fit
            } else {
                cursorY += actionHost.frame.height
            }
            cursorY += TKMetrics.msgPadV
        } else {
            cursorY += textHeight > 0 || !content.images.isEmpty ? TKMetrics.msgPadV : 0
        }
        // Lazy content-ref images (kraki-show_image). Same SwiftUI host as
        // the action slot: size to fit, advance cursor.
        if !imageHost.isHidden {
            if cursorY > y + TKMetrics.msgPadV {
                cursorY += TKMetrics.imageSpacing
            }
            imageHost.frame = CGRect(x: x + TKMetrics.msgPadH, y: cursorY, width: actionWidth, height: 60)
            imageHost.setNeedsLayout()
            imageHost.layoutIfNeeded()
            let imgFit = imageHost.hostingController?.view.systemLayoutSizeFitting(
                CGSize(width: actionWidth, height: .greatestFiniteMagnitude),
                withHorizontalFittingPriority: .required,
                verticalFittingPriority: .fittingSizeLevel).height ?? 0
            if imgFit > 0 {
                imageHost.frame.size.height = imgFit
                cursorY += imgFit
            } else {
                cursorY += imageHost.frame.height
            }
            cursorY += TKMetrics.msgPadV
        }
        let bubbleHeight = max(cursorY - y, 1)
        bubbleBG.frame = CGRect(x: x, y: y, width: bubbleWidth, height: bubbleHeight)

        let buttonSize = moreButton.sizeThatFits(CGSize(width: 80, height: 30))
        moreButton.frame = CGRect(
            x: x + bubbleWidth - buttonSize.width - 8,
            y: y - buttonSize.height / 2,
            width: buttonSize.width, height: buttonSize.height)
    }
}
