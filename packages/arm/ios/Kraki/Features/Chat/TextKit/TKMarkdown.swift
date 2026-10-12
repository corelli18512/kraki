/// Markdown → attributed text for iOS bubbles, with its palette and cache.

import UIKit
import Highlightr

enum IOSMarkdownPalette {
    static let link = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x8F/255, green: 0xD5/255, blue: 1, alpha: 1)
            : UIColor(red: 0x00/255, green: 0x56/255, blue: 0xA8/255, alpha: 1)
    }
}

private let tkMarkdownCache: NSCache<NSString, NSAttributedString> = {
    let c = NSCache<NSString, NSAttributedString>()
    c.countLimit = 512
    return c
}()

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
            let piece = segmentPiece(seg, allowHighlighting: allowHighlighting, lineCache: nil)
            if i > 0 { out.append(segmentSeparator) }
            out.append(piece)
        }
        if out.length == 0 { return inlineSegment(text, lineCache: nil) }
        return out
    }

    /// 6pt gap between segments (mirrors the SwiftUI VStack spacing).
    static let segmentSeparator = NSAttributedString(string: "\n", attributes: [
        .font: UIFont.systemFont(ofSize: 6),
    ])

    /// Stable identity of one parsed segment. Equal keys produce identical
    /// rendered pieces, which lets the streaming pipeline reuse settled blocks.
    static func segmentKey(_ seg: MessageBodySegment) -> String {
        switch seg {
        case .inline(let content): return "i\u{1F}" + content
        case .blockquote(let content): return "q\u{1F}" + content
        case .codeBlock(let language, let code): return "c\u{1F}\(language ?? "")\u{1F}" + code
        case .table(let rows, let alignments):
            let a = alignments.map { alignment -> String in
                switch alignment { case .leading: return "l"; case .center: return "c"; case .trailing: return "r" }
            }.joined()
            return "t\u{1F}\(a)\u{1F}" + rows.map { $0.joined(separator: "\u{1E}") }.joined(separator: "\u{1D}")
        }
    }

    /// Render one parsed segment. `lineCache` (streaming only) memoizes inline
    /// lines, so a growing paragraph run re-renders only its changed line.
    static func segmentPiece(_ seg: MessageBodySegment, allowHighlighting: Bool,
                             lineCache: TKInlineLineCache?) -> NSAttributedString {
        switch seg {
        case .inline(let content):
            return inlineSegment(content, lineCache: lineCache)
        case .blockquote(let content):
            return blockquoteSegment(content)
        case .codeBlock(let language, let code):
            return codeSegment(language: language, code: code, allowHighlighting: allowHighlighting)
        case .table(let rows, let alignments):
            return tableSegment(rows: rows, alignments: alignments)
        }
    }

    /// Inline markdown segment: headings and lists are normalized before the
    /// inline markdown pass so source markers (`#`, `-`, `1.`) never leak into
    /// rendered output. List rows use hanging indents and real typographic
    /// bullets/numbers while preserving inline emphasis and links per row.
    private static func inlineSegment(_ text: String, lineCache: TKInlineLineCache? = nil) -> NSAttributedString {
        let lines = text.components(separatedBy: "\n")
        let result = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            if let lineCache {
                if let hit = lineCache.pieces[line] {
                    result.append(hit)
                } else {
                    let piece = inlineLine(line)
                    lineCache.store(line, piece)
                    result.append(piece)
                }
            } else {
                result.append(inlineLine(line))
            }
        }
        return result
    }

    private static func inlineLine(_ line: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        do {
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
