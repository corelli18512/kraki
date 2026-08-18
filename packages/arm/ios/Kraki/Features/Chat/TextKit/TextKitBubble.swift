import UIKit
import SwiftUI
import Highlightr

private enum IOSMarkdownPalette {
    static let link = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x8F/255, green: 0xD5/255, blue: 1, alpha: 1)
            : UIColor(red: 0x00/255, green: 0x56/255, blue: 0xA8/255, alpha: 1)
    }
}

/// Fixed palette for the neutral code editor surface. Highlightr themes can
/// emit light-mode or low-contrast token colors even when the surrounding
/// bubble is dark; MacCodePalette applies this same readability contract.
private enum IOSCodePalette {
    static let background = UIColor(red: 0x18/255, green: 0x18/255, blue: 0x1B/255, alpha: 1)
    static let foreground = UIColor(red: 0xF4/255, green: 0xF4/255, blue: 0xF5/255, alpha: 1)

    static func ensuringReadableForeground(in string: NSMutableAttributedString) {
        guard string.length > 0 else { return }
        var unreadableRanges: [NSRange] = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, range, _ in
            guard let color = value as? UIColor,
                  contrastRatio(foreground: color, background: background) >= 4.5 else {
                unreadableRanges.append(range)
                return
            }
        }
        for range in unreadableRanges {
            string.addAttribute(.foregroundColor, value: foreground, range: range)
        }
    }

    static func contrastRatio(foreground: UIColor, background: UIColor) -> CGFloat {
        let resolvedForeground = foreground.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        let resolvedBackground = background.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        var fr: CGFloat = 0, fg: CGFloat = 0, fb: CGFloat = 0, fa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        guard resolvedForeground.getRed(&fr, green: &fg, blue: &fb, alpha: &fa),
              resolvedBackground.getRed(&br, green: &bg, blue: &bb, alpha: &ba) else { return 1 }

        func luminance(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGFloat {
            func linear(_ value: CGFloat) -> CGFloat {
                value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
        }

        // Blend translucent token colors over the actual code surface before
        // measuring, matching what the user sees rather than raw RGBA values.
        let blendedR = fr * fa + br * (1 - fa)
        let blendedG = fg * fa + bg * (1 - fa)
        let blendedB = fb * fa + bb * (1 - fa)
        let foregroundLuminance = luminance(blendedR, blendedG, blendedB)
        let backgroundLuminance = luminance(br, bg, bb)
        return (max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (min(foregroundLuminance, backgroundLuminance) + 0.05)
    }
}

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
    static let attachmentSpacing = IOSImageGalleryLayout.attachmentSpacing
    static let imageMaxHeight: CGFloat = 240
    static let imageCorner: CGFloat = 12
    /// Nested tool-detail box: inner padding, corner radius, and the gap
    /// between the tool chip row and the revealed detail box.
    static let detailPad: CGFloat = 12
    static let detailCorner: CGFloat = 8
    static let detailGap: CGFloat = 6
}

// MARK: - Markdown → NSAttributedString

private func tkContentCacheKey(prefix: String, content: String) -> NSString {
    var hasher = Hasher()
    hasher.combine(content)
    return "\(prefix)\u{1F}\(content.utf8.count)\u{1F}\(hasher.finalize())" as NSString
}

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

extension Notification.Name {
    static let tkCodeHighlightReady = Notification.Name("chat.kraki.tkCodeHighlightReady")
}

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

    private static func normalizedLanguage(_ language: String?) -> String? {
        MarkdownCodeSyntax.normalizedLanguage(language)
    }

    static func attributed(
        code: String,
        language: String?,
        allowHighlighting: Bool
    ) -> NSAttributedString {
        guard allowHighlighting else { return NSAttributedString(string: code) }
        if MarkdownCodeSyntax.isIntentionallyPlain(language) {
            return NSAttributedString(string: code, attributes: [.foregroundColor: IOSCodePalette.foreground])
        }
        let normalized = normalizedLanguage(language)
        let key = tkContentCacheKey(prefix: normalized ?? "auto", content: code)
        if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }

        if Thread.isMainThread {
            queue.async {
                if tkCodeHighlightCache.object(forKey: key) != nil { return }
                let result = finalHighlight(code: code, language: language)
                tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .tkCodeHighlightReady, object: nil)
                }
            }
            return NSAttributedString(
                string: code,
                attributes: [.tkCodeHighlightProvisional: true]
            )
        }

        return queue.sync {
            if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }
            let result = finalHighlight(code: code, language: language)
            tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
            return result
        }
    }

    #if DEBUG
    static func cacheFinalForTesting(code: String, language: String?) {
        queue.sync {
            let normalized = normalizedLanguage(language)
            let key = tkContentCacheKey(prefix: normalized ?? "auto", content: code)
            let result = finalHighlight(code: code, language: language)
            tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
        }
    }
    #endif

    private static func finalHighlight(code: String, language: String?) -> NSAttributedString {
        let raw = MarkdownCodeSyntax.rawLanguage(language)
        let normalized = normalizedLanguage(language)
        let highlighted = makeEngine()?.highlight(code, as: normalized, fastRender: true)
            ?? NSAttributedString(string: code, attributes: [.foregroundColor: IOSCodePalette.foreground])
        guard foregroundColorCount(in: highlighted) <= 1,
              let fallbackLanguage = normalized ?? raw else {
            let readable = NSMutableAttributedString(attributedString: highlighted)
            IOSCodePalette.ensuringReadableForeground(in: readable)
            return readable
        }
        return lexicalFallback(code: code, language: fallbackLanguage)
    }

    private static func lexicalFallback(code: String, language: String) -> NSAttributedString {
        let result = NSMutableAttributedString(
            string: code,
            attributes: [.foregroundColor: IOSCodePalette.foreground]
        )
        let fullRange = NSRange(location: 0, length: result.length)
        var occupied = IndexSet()

        func apply(
            _ pattern: String,
            color: UIColor,
            options: NSRegularExpression.Options = []
        ) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for match in regex.matches(in: code, range: fullRange) {
                let range = match.range
                guard range.length > 0,
                      !occupied.intersects(integersIn: range.location..<(range.location + range.length)) else {
                    continue
                }
                result.addAttribute(.foregroundColor, value: color, range: range)
                occupied.insert(integersIn: range.location..<(range.location + range.length))
            }
        }

        for rule in MarkdownCodeSyntax.lexicalRules {
            let color: UIColor
            switch rule.role {
            case .comment: color = UIColor(red: 0x9A/255, green: 0xA4/255, blue: 0xB2/255, alpha: 1)
            case .string: color = UIColor(red: 0xA5/255, green: 0xD6/255, blue: 1, alpha: 1)
            case .number: color = UIColor(red: 0xD2/255, green: 0xA8/255, blue: 1, alpha: 1)
            case .keyword: color = UIColor(red: 1, green: 0x8F/255, blue: 0xC7/255, alpha: 1)
            case .type: color = UIColor(red: 1, green: 0xB8/255, blue: 0x6C/255, alpha: 1)
            }
            apply(rule.pattern, color: color, options: rule.options)
        }
        _ = language
        return result
    }

    private static func foregroundColorCount(in string: NSAttributedString) -> Int {
        var colors: Set<String> = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, _, _ in
            guard let color = value as? UIColor else {
                colors.insert("none")
                return
            }
            let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
            var red: CGFloat = 0
            var green: CGFloat = 0
            var blue: CGFloat = 0
            var alpha: CGFloat = 0
            guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
                colors.insert(resolved.description)
                return
            }
            colors.insert("\(red)-\(green)-\(blue)-\(alpha)")
        }
        return colors.count
    }
}

extension NSAttributedString.Key {
    static let tkCodeHighlightProvisional = NSAttributedString.Key("chat.kraki.tkCodeHighlightProvisional")
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

    #if DEBUG
    static func prepareFinalHighlightForTesting(code: String, language: String?) {
        TKCodeHighlighter.cacheFinalForTesting(code: code, language: language)
    }
    #endif

    /// Parse `text` to an `NSAttributedString` matching the SwiftUI bubble's
    /// inline-only markdown + heading post-pass. Cached by content.
    static func attributed(
        _ text: String,
        cacheKey: String,
        allowHighlighting: Bool = true
    ) -> NSAttributedString {
        // Avoid retaining another full copy of every message inside the cache
        // key. The caller identity + byte length + process-local content hash
        // still distinguishes equal-length streaming replacements.
        let mode = allowHighlighting ? "final" : "plain"
        let key = tkContentCacheKey(prefix: "\(cacheKey):\(mode)", content: text)
        if let hit = tkMarkdownCache.object(forKey: key) { return hit }
        let built = build(text, allowHighlighting: allowHighlighting)
        var provisional = false
        built.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: built.length)
        ) { value, _, stop in
            if value != nil {
                provisional = true
                stop.pointee = true
            }
        }
        if !provisional { tkMarkdownCache.setObject(built, forKey: key) }
        return built
    }

    /// Build the full body: split into inline / code / blockquote / table
    /// segments and assemble one styled `NSAttributedString`. Keeping it a
    /// single string lets the cell render it in ONE reused TextKit2
    /// `UITextView` (the proven-fast path) rather than a stack of views.
    private static func build(_ text: String, allowHighlighting: Bool) -> NSAttributedString {
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
                piece = codeSegment(
                    language: language,
                    code: code,
                    allowHighlighting: allowHighlighting
                )
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
            switch parseMarkdownInlineLine(line) {
            case .heading(let level, let headingText):
                let font: UIFont
                switch level {
                case 1: font = UIFont.preferredFont(forTextStyle: .title2).tkBold
                case 2: font = UIFont.preferredFont(forTextStyle: .title3).tkBold
                case 3: font = UIFont.preferredFont(forTextStyle: .headline)
                case 4: font = UIFont.preferredFont(forTextStyle: .subheadline).tkBold
                default: font = UIFont.preferredFont(forTextStyle: .footnote).tkBold
                }
                let piece = inlineMarkdown(headingText, baseFont: font)
                let paragraph = NSMutableParagraphStyle()
                paragraph.paragraphSpacingBefore = level == 1 ? 2 : 1
                paragraph.paragraphSpacing = level <= 2 ? 5 : 3
                result.append(applyingParagraph(paragraph, to: piece))
            case .list(let item):
                let marker = item.ordered ? "\(item.number)." : "•"
                let markerWidth = item.ordered ? 25.0 : 18.0
                let indent = CGFloat(item.depth) * 18
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
                row.append(inlineMarkdown(item.text, baseFont: UIFont.preferredFont(forTextStyle: .subheadline)))
                row.addAttribute(.paragraphStyle, value: paragraph,
                                 range: NSRange(location: 0, length: row.length))
                result.append(row)
            case .text(let content):
                result.append(inlineMarkdown(content, baseFont: UIFont.preferredFont(forTextStyle: .subheadline)))
            }
        }
        return result
    }

    private static func inlineMarkdown(_ text: String, baseFont: UIFont) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for run in parseMarkdownInline(text) {
            var font = baseFont
            if run.bold { font = font.tkBold }
            if run.italic { font = font.tkItalic }
            if run.code { font = .monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular) }
            var attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: run.link == nil ? UIColor.label : IOSMarkdownPalette.link,
            ]
            if let link = run.link { attrs[.link] = link }
            if run.strikethrough {
                attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            result.append(NSAttributedString(string: run.text, attributes: attrs))
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

    /// Blockquote: padded text with a real drawn leading rule. The source `>`
    /// markers are already removed by the body splitter; one block id spans all
    /// wrapped lines so the background/rule is drawn as one continuous region.
    private static func blockquoteSegment(_ content: String) -> NSAttributedString {
        let normalized = normalizeMarkdownQuoteWhitespace(content)
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

    /// Fenced code uses a neutral editor surface drawn by `TKBodyTextView`.
    /// The language is syntax metadata rather than message content, so it is
    /// intentionally not injected as a fake first line. This matches the web
    /// `<pre>` treatment and keeps copy/selection limited to actual code.
    private static func codeSegment(
        language: String?,
        code: String,
        allowHighlighting: Bool
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let topHeight: CGFloat = language?.isEmpty == false ? 20 : 8
        result.append(codeSpacer(height: topHeight, terminatesLine: true))

        let highlighted = NSMutableAttributedString(
            attributedString: TKCodeHighlighter.attributed(
                code: code,
                language: language,
                allowHighlighting: allowHighlighting
            )
        )
        // Match Mac: keep valid syntax colors, but replace missing or
        // low-contrast Highlightr output before TextKit draws on #18181B.
        IOSCodePalette.ensuringReadableForeground(in: highlighted)
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
    /// Fixed-geometry HTML report metadata cards. The report WebView is owned
    /// by ChatView, never by a reusable bubble cell.
    let htmlArtifacts: [ContentRef]
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
    private var bubbleWidthCache: [CGFloat: CGFloat] = [:]
    private var bodyTextHeightCache: [CGFloat: CGFloat] = [:]

    init(message: ChatMessage, kind: Kind, hueSeed: String,
         body: NSAttributedString?, images: [UIImage] = [],
         imageRefs: [ContentRef] = [], htmlArtifacts: [ContentRef] = [],
         action: ChatMessage? = nil, isLive: Bool = false,
         isFrozen: Bool = false, frozenTimestamp: String? = nil) {
        self.message = message
        self.kind = kind
        self.hueSeed = hueSeed
        self.body = body
        self.images = images
        self.imageRefs = imageRefs
        self.htmlArtifacts = htmlArtifacts
        self.action = action
        self.isLive = isLive
        self.isFrozen = isFrozen
        self.frozenTimestamp = frozenTimestamp
    }

    var canShowSteps: Bool {
        (kind == .agent || kind == .system) && (message.steps ?? 0) > 0
    }

    var hasProvisionalCodeHighlight: Bool {
        guard let body else { return false }
        var provisional = false
        body.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: body.length)
        ) { value, _, stop in
            if value != nil {
                provisional = true
                stop.pointee = true
            }
        }
        return provisional
    }

    /// Build a live/frozen bubble content from a streaming `SessionCard` (or a
    /// frozen terminal card rebuilt from a persisted message). Mirrors the old
    /// LiveAgentBubbleView: the draft becomes the body, the card.action becomes
    /// the action slot. The host TKBubbleCell renders both through the same
    /// TextKit path as a completed bubble.
    static func live(card: MessageStore.SessionCard, agent: String, sessionId: String,
                     steps: Int, isFrozen: Bool = false,
                     frozenTimestamp: String? = nil,
                     attachments: [ContentRef] = []) -> TKBubbleContent {
        let draft = card.text
        var payload: [String: AnyCodable] = [:]
        if !draft.isEmpty { payload["content"] = AnyCodable(draft) }
        if steps > 0 { payload["steps"] = AnyCodable(steps) }
        let msg = ChatMessage(type: "agent_message", seq: 0,
                              sessionId: sessionId, deviceId: nil,
                              timestamp: frozenTimestamp, payload: payload)
        let body = draft.isEmpty ? nil
            : TKMarkdown.attributed(
                draft,
                cacheKey: "\(sessionId):live:\(draft.count)",
                allowHighlighting: isFrozen
            )
        return TKBubbleContent(message: msg, kind: .agent, hueSeed: sessionId,
                               body: body, images: [],
                               imageRefs: uniqueRefs(attachments).filter { $0.mimeType.hasPrefix("image/") },
                               htmlArtifacts: uniqueRefs(attachments).filter { $0.mimeType == "text/html" },
                               action: card.action,
                               isLive: !isFrozen, isFrozen: isFrozen,
                               frozenTimestamp: frozenTimestamp)
    }

    func bubbleWidth(cellWidth: CGFloat) -> CGFloat {
        if let cached = bubbleWidthCache[cellWidth] { return cached }
        let maximum = maximumBubbleWidth(cellWidth: cellWidth)
        let width: CGFloat
        switch kind {
        case .agent, .user:
            // Match Web's max-width flex bubble: short body/action content hugs
            // its natural width while long content wraps at the established
            // maximum. Attachments remain an independent sibling. Natural width
            // is expensive CoreText work, so cache it for every immutable content
            // object instead of repeating it from each layoutSubviews pass.
            if htmlArtifacts.isEmpty {
                // Once a body is this long it will fill the bubble in ordinary
                // prose/code/table history. Avoid shaping the entire attributed
                // string at infinite width just to rediscover that it exceeds
                // the cap; short messages still keep the exact hug-content look.
                let bodyNatural: CGFloat
                if let body, body.length > 160 {
                    bodyNatural = maximum
                } else {
                    bodyNatural = body.map(TKMeasure.naturalWidth) ?? 0
                }
                let natural = max(bodyNatural, naturalActionWidth())
                let fitted = ceil(natural) + TKMetrics.msgPadH * 2
                width = min(maximum, max(fitted, TKMetrics.msgPadH * 2 + 1))
            } else {
                width = maximum
            }
        case .error, .system:
            width = maximum
        }
        bubbleWidthCache[cellWidth] = width
        return width
    }

    func attachmentWidth(cellWidth: CGFloat) -> CGFloat {
        maximumBubbleWidth(cellWidth: cellWidth)
    }

    private func naturalActionWidth() -> CGFloat {
        guard let action else { return 0 }
        func textWidth(_ text: String, font: UIFont) -> CGFloat {
            guard !text.isEmpty else { return 0 }
            return ceil((text as NSString).size(withAttributes: [.font: font]).width)
        }
        switch action.type {
        case "tool_batch":
            let running = action.payload["running"]?.intValue ?? 0
            let label = running == 1
                ? "1 tool running in parallel…"
                : "\(running) tools running in parallel…"
            return textWidth(label, font: .systemFont(ofSize: 13)) + 24
        case "tool_start", "tool_complete":
            let label = [action.toolName, action.headline]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: "  ")
            return textWidth(label, font: .monospacedSystemFont(ofSize: 12, weight: .regular)) + 30
        case "permission":
            let description = action.toolDescription ?? "Run \(action.toolName ?? "tool")"
            let descriptionWidth = textWidth(description, font: .systemFont(ofSize: 14)) + 24
            let argsWidth = action.args?.values.compactMap(\.stringValue).map {
                textWidth($0, font: .monospacedSystemFont(ofSize: 11, weight: .regular))
            }.max() ?? 0
            return max(380, max(descriptionWidth, argsWidth))
        case "question":
            let questionWidth = textWidth(action.question ?? "", font: .systemFont(ofSize: 14)) + 24
            let choicesWidth = action.choices?.map {
                textWidth($0, font: .systemFont(ofSize: 13)) + 24
            }.max() ?? 0
            return max(280, max(questionWidth, choicesWidth))
        case "failed", "user_abort":
            let label = action.type == "failed" ? "Turn failed" : "User aborted"
            let detail = action.payload["message"]?.stringValue ?? ""
            return textWidth("\(label)  \(detail)", font: .systemFont(ofSize: 13)) + 24
        default:
            return 0
        }
    }

    private func maximumBubbleWidth(cellWidth: CGFloat) -> CGFloat {
        let usable = cellWidth - TKMetrics.outerH * 2
        switch kind {
        case .agent:
            return usable - cellWidth * TKMetrics.trailingGapFraction
        case .user:
            return usable - cellWidth * TKMetrics.userLeadingGapFraction
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

    var hasBubbleContent: Bool {
        (body?.length ?? 0) > 0 || !htmlArtifacts.isEmpty || action != nil
    }

    func imagesHeight(cellWidth: CGFloat) -> CGFloat {
        IOSImageGalleryLayout.height(
            images: images,
            refs: imageRefs,
            maxWidth: attachmentWidth(cellWidth: cellWidth)
        )
    }

    var footerDate: Date? { nil }

    func cellHeight(cellWidth: CGFloat) -> CGFloat {
        if let cached = heightCache[cellWidth] { return cached }
        var bubbleInnerHeight = bodyTextHeight(cellWidth: cellWidth)
        let artifactHeight = TKHTMLArtifactCardsView.height(for: htmlArtifacts.count)
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += TKMetrics.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        // Action slot (streaming / frozen): measured synchronously via the same
        // SwiftUI host the cell uses, so cellHeight matches what configure lays
        // out. The list re-measures on action transitions via onActionHeightChange.
        if let action {
            let actionWidth = bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
            let actionHeight = TKActionMeasure.height(action: action, width: actionWidth)
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += actionHeight
        }
        let bubbleCellHeight = hasBubbleContent
            ? max(bubbleInnerHeight + TKMetrics.msgPadV * 2, 1) + TKMetrics.outerV * 2
            : 0
        let imageHeight = imagesHeight(cellWidth: cellWidth)
        let height: CGFloat
        if imageHeight > 0 {
            height = hasBubbleContent
                ? bubbleCellHeight + TKMetrics.attachmentSpacing + imageHeight
                : imageHeight + IOSImageGalleryLayout.outerVerticalPadding
        } else {
            height = max(bubbleCellHeight, 1)
        }
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
    nonisolated(unsafe) private static var cacheKeysByMessageID: [String: NSString] = [:]

    static func make(message: ChatMessage, sessionId: String, agent: String) -> TKBubbleContent {
        let key = visualCacheKey(message)
        if let previous = cacheKeysByMessageID[message.id], previous != key {
            cache.removeObject(forKey: previous)
        }
        cacheKeysByMessageID[message.id] = key
        if let cached = cache.object(forKey: key) { return cached }
        let built = build(message: message, sessionId: sessionId, agent: agent)
        if !built.hasProvisionalCodeHighlight {
            cache.setObject(built, forKey: key)
        }
        return built
    }

    static func bust(_ id: String) {
        guard let key = cacheKeysByMessageID.removeValue(forKey: id) else { return }
        cache.removeObject(forKey: key)
    }

    private static func visualCacheKey(_ message: ChatMessage) -> NSString {
        var hasher = Hasher()
        hasher.combine(message.id)
        let text = message.content ?? message.result ?? ""
        hasher.combine(text.utf8.count)
        hasher.combine(Data(text.utf8.suffix(512)))
        hasher.combine(message.attachments?.count ?? 0)
        hasher.combine(message.steps ?? 0)
        for ref in message.contentRefAttachments {
            hasher.combine(ref.id)
            hasher.combine(ref.mimeType)
            hasher.combine(ref.size)
            hasher.combine(ref.width ?? 0)
            hasher.combine(ref.height ?? 0)
        }
        return "\(message.id)\u{1F}\(hasher.finalize())" as NSString
    }

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
        let refs = uniqueRefs(message.contentRefAttachments)
        return TKBubbleContent(
            message: message, kind: kind, hueSeed: sessionId.isEmpty ? agent : sessionId,
            body: body, images: decodeImages(message.attachments),
            imageRefs: refs.filter { $0.mimeType.hasPrefix("image/") },
            htmlArtifacts: refs.filter { $0.mimeType == "text/html" })
    }

    private static func uniqueRefs(_ refs: [ContentRef]) -> [ContentRef] {
        var seen = Set<String>()
        return refs.filter { seen.insert($0.id).inserted }
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

private final class TKHTMLArtifactButton: UIControl {
    private let iconBackground = UIView()
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let openIcon = UIImageView()
    private var artifact: ContentRef?
    private var onOpen: ((ContentRef) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 8
        layer.borderWidth = 0.5
        backgroundColor = .secondarySystemBackground
        layer.borderColor = UIColor.separator.withAlphaComponent(0.55).cgColor

        iconBackground.backgroundColor = UIColor.tintColor.withAlphaComponent(0.12)
        iconBackground.layer.cornerRadius = 7
        iconBackground.isUserInteractionEnabled = false
        addSubview(iconBackground)

        iconView.image = UIImage(systemName: "doc.richtext")
        iconView.tintColor = .tintColor
        iconView.contentMode = .scaleAspectFit
        iconBackground.addSubview(iconView)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .label
        titleLabel.lineBreakMode = .byTruncatingTail
        addSubview(titleLabel)

        detailLabel.font = .systemFont(ofSize: 10)
        detailLabel.textColor = .secondaryLabel
        detailLabel.lineBreakMode = .byTruncatingTail
        addSubview(detailLabel)

        openIcon.image = UIImage(systemName: "chevron.right")
        openIcon.tintColor = .tertiaryLabel
        openIcon.contentMode = .scaleAspectFit
        addSubview(openIcon)

        addTarget(self, action: #selector(openArtifact), for: .touchUpInside)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(artifact: ContentRef, onOpen: @escaping (ContentRef) -> Void) {
        self.artifact = artifact
        self.onOpen = onOpen
        let caption = artifact.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = artifact.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = caption?.isEmpty == false
            ? caption!
            : (name?.isEmpty == false ? name! : "HTML Report")
        titleLabel.text = title
        detailLabel.text = "HTML Report · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))"
        accessibilityLabel = title
        accessibilityValue = detailLabel.text
        accessibilityHint = "Opens report preview"
    }

    func reset() {
        artifact = nil
        onOpen = nil
        titleLabel.text = nil
        detailLabel.text = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconBackground.frame = CGRect(x: 10, y: 10, width: 34, height: 34)
        iconView.frame = iconBackground.bounds.insetBy(dx: 8, dy: 8)
        openIcon.frame = CGRect(x: bounds.width - 25, y: 20, width: 10, height: 14)
        let textX: CGFloat = 54
        let textWidth = max(1, bounds.width - textX - 36)
        titleLabel.frame = CGRect(x: textX, y: 9, width: textWidth, height: 18)
        detailLabel.frame = CGRect(x: textX, y: 29, width: textWidth, height: 14)
    }

    @objc private func openArtifact() {
        guard let artifact else { return }
        onOpen?(artifact)
    }
}

private final class TKHTMLArtifactCardsView: UIView {
    static let cardHeight: CGFloat = 54
    static let spacing: CGFloat = 6
    private var buttons: [TKHTMLArtifactButton] = []

    static func height(for count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return CGFloat(count) * cardHeight + CGFloat(count - 1) * spacing
    }

    func configure(artifacts: [ContentRef], onOpen: @escaping (ContentRef) -> Void) {
        while buttons.count < artifacts.count {
            let button = TKHTMLArtifactButton(frame: .zero)
            addSubview(button)
            buttons.append(button)
        }
        for (index, button) in buttons.enumerated() {
            if index < artifacts.count {
                button.isHidden = false
                button.configure(artifact: artifacts[index], onOpen: onOpen)
            } else {
                button.isHidden = true
                button.reset()
            }
        }
        isHidden = artifacts.isEmpty
        setNeedsLayout()
    }

    func reset() {
        buttons.forEach {
            $0.reset()
            $0.isHidden = true
        }
        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var y: CGFloat = 0
        for button in buttons where !button.isHidden {
            button.frame = CGRect(x: 0, y: y, width: bounds.width, height: Self.cardHeight)
            y += Self.cardHeight + Self.spacing
        }
    }
}

/// Flat, single-message TextKit cell used by the production chat list.
final class TKBubbleCell: UICollectionViewCell, UIContextMenuInteractionDelegate {
    static let reuseID = "TKBubbleCell"

    var onOpenSteps: ((ChatMessage) -> Void)?
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var onOpenImage: ((IOSImagePreviewSelection) -> Void)?
    var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    var attachmentStore: AttachmentStore?
    var sessionMode: SessionMode = .discuss
    var onActionHeightChange: (() -> Void)?
    var onShowTable: ((TKTableLayout) -> Void)?
    private(set) var sessionId: String = ""
    var contentSnapshot: TKBubbleContent? { content }
    var hasProvisionalCodeHighlight: Bool {
        content?.hasProvisionalCodeHighlight == true
    }

    #if DEBUG
    var imageFrameForRegression: CGRect { imageHost.frame }
    var bubbleFrameForRegression: CGRect { bubbleBG.frame }
    var bubbleHiddenForRegression: Bool { bubbleBG.isHidden }
    #endif

    private let renderClipView = UIView()
    private let bubbleBG = TKRoundedView()
    private let bodyView: TKBodyTextView
    private let moreButton = UIButton(type: .system)
    private let actionHost = BubbleActionHostView()
    private let imageHost = BubbleImageHostView()
    private let artifactCardsView = TKHTMLArtifactCardsView()
    private var tableViews: [TKTableScrollView] = []
    private var tableAttachmentIDs: [ObjectIdentifier] = []
    private var bodyHasLinks = false
    private var content: TKBubbleContent?

    override init(frame: CGRect) {
        bodyView = TKBodyTextView(usingTextLayoutManager: true)
        super.init(frame: frame)
        contentView.clipsToBounds = false
        renderClipView.clipsToBounds = true
        contentView.addSubview(renderClipView)
        renderClipView.addSubview(bubbleBG)

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
        renderClipView.addSubview(bodyView)

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
        renderClipView.addSubview(actionHost)

        imageHost.backgroundColor = .clear
        imageHost.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageHost)
        renderClipView.addSubview(artifactCardsView)

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (cell: TKBubbleCell, _: UITraitCollection) in
            cell.refreshBubbleAppearance()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A representable can configure cells before it inherits the window's
        // final forced color scheme. Re-resolve the bubble on attachment so an
        // entering Session never paints one light/dark frame before settling.
        refreshBubbleAppearance()
    }

    private func refreshBubbleAppearance() {
        guard let content else { return }
        let dark = traitCollection.userInterfaceStyle == .dark
        bubbleBG.fillColor = content.bubbleColor(dark: dark)
        bubbleBG.setNeedsDisplay()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        content = nil
        onOpenSteps = nil
        onResolvePermission = nil
        onAnswerQuestion = nil
        onOpenImage = nil
        onOpenHTMLArtifact = nil
        attachmentStore = nil
        bodyView.attributedText = nil
        bodyView.isHidden = true
        imageHost.configure(
            images: [],
            refs: [],
            sessionId: sessionId,
            maxWidth: 0,
            alignment: .leading,
            attachmentStore: nil,
            onOpenImage: { _ in }
        )
        imageHost.frame = .zero
        imageHost.isHidden = true
        artifactCardsView.reset()
        actionHost.configure(action: nil, sessionMode: sessionMode)
        actionHost.isHidden = true
        tableViews.forEach { $0.removeFromSuperview() }
        tableViews.removeAll(keepingCapacity: true)
        tableAttachmentIDs.removeAll(keepingCapacity: true)
        moreButton.isHidden = true
        bubbleBG.fillColor = .clear
        bubbleBG.frame = .zero
    }

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
        // UIKit normally derives link color from `tintColor`, but this read-only
        // view keeps a clear tint so links cannot surface an editor caret.
        // Pin the link foreground separately so URL runs remain visible.
        bodyView.linkTextAttributes = [
            .foregroundColor: IOSMarkdownPalette.link,
        ]
        bodyView.subviews.forEach {
            $0.isOpaque = false
            $0.backgroundColor = .clear
        }
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
        refreshBubbleAppearance()
        switch content.kind {
        case .agent: bubbleBG.radii = (4, 16, 16, 16)
        case .user: bubbleBG.radii = (16, 4, 16, 16)
        case .error, .system: bubbleBG.radii = (12, 12, 12, 12)
        }

        // Inline and ContentRef images share one fixed-geometry attachment
        // gallery outside the text bubble. Hydration replaces pixels only;
        // the message height is stable from the first frame.
        sessionId = content.message.sessionId ?? sessionId
        let hasImages = !content.images.isEmpty || !content.imageRefs.isEmpty
        let galleryAlignment: Alignment = content.kind == .user ? .trailing : .leading
        imageHost.configure(
            images: content.images,
            refs: content.imageRefs,
            sessionId: sessionId,
            maxWidth: content.attachmentWidth(cellWidth: cellWidth),
            alignment: galleryAlignment,
            attachmentStore: attachmentStore,
            onOpenImage: { [weak self] selection in
                self?.onOpenImage?(selection)
            }
        )
        imageHost.isHidden = !hasImages

        moreButton.isHidden = !content.canShowSteps
        artifactCardsView.configure(artifacts: content.htmlArtifacts) { [weak self] artifact in
            self?.onOpenHTMLArtifact?(artifact)
        }

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
        let exposesInteractiveContent = exposesInteractiveAction
            || exposesInteractiveTable
            || !content.images.isEmpty
            || !content.imageRefs.isEmpty
            || !content.htmlArtifacts.isEmpty
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
                renderClipView.addSubview(view)
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
            renderClipView.bringSubviewToFront(view)
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
        renderClipView.frame = contentView.bounds
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
        let actionWidth = bubbleWidth - TKMetrics.msgPadH * 2
        let artifactHeight = TKHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if cursorY > y + TKMetrics.msgPadV { cursorY += TKMetrics.imageSpacing }
            artifactCardsView.frame = CGRect(x: innerX, y: cursorY, width: actionWidth, height: artifactHeight)
            cursorY += artifactHeight
        } else {
            artifactCardsView.frame = .zero
        }
        // Action slot (streaming / frozen).
        if !actionHost.isHidden {
            if cursorY > y + TKMetrics.msgPadV { cursorY += 8 }
            actionHost.frame = CGRect(x: innerX, y: cursorY, width: actionWidth, height: 60)
            actionHost.setNeedsLayout()
            actionHost.layoutIfNeeded()
            let fit = actionHost.hostingController?.view.systemLayoutSizeFitting(
                CGSize(width: actionWidth, height: .greatestFiniteMagnitude),
                withHorizontalFittingPriority: .required,
                verticalFittingPriority: .fittingSizeLevel).height ?? actionHost.frame.height
            actionHost.frame.size.height = max(1, fit)
            cursorY += actionHost.frame.height
        }
        cursorY += TKMetrics.msgPadV
        let bubbleHeight: CGFloat
        if content.hasBubbleContent {
            bubbleHeight = max(cursorY - y, 1)
            bubbleBG.isHidden = false
            bubbleBG.frame = CGRect(x: x, y: y, width: bubbleWidth, height: bubbleHeight)
        } else {
            bubbleHeight = 0
            bubbleBG.isHidden = true
            bubbleBG.frame = .zero
        }

        let attachmentWidth = content.attachmentWidth(cellWidth: cellWidth)
        let imageHeight = content.imagesHeight(cellWidth: cellWidth)
        if imageHeight > 0 {
            let imageY = content.hasBubbleContent
                ? y + bubbleHeight + TKMetrics.attachmentSpacing
                : y
            let imageX: CGFloat
            switch content.kind {
            case .agent:
                imageX = TKMetrics.outerH
            case .user:
                imageX = cellWidth - TKMetrics.outerH - attachmentWidth
            case .error, .system:
                imageX = (cellWidth - attachmentWidth) / 2
            }
            imageHost.frame = CGRect(
                x: imageX,
                y: imageY,
                width: attachmentWidth,
                height: imageHeight
            )
            imageHost.setNeedsLayout()
        } else {
            imageHost.frame = .zero
        }

        let buttonSize = moreButton.sizeThatFits(CGSize(width: 80, height: 30))
        moreButton.frame = CGRect(
            x: x + bubbleWidth - buttonSize.width - 8,
            y: y - buttonSize.height / 2,
            width: buttonSize.width, height: buttonSize.height)
    }
}
