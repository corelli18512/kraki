/// The Mac chat bubble's Markdown → NSAttributedString renderer: palette, content caches, block attributes, CoreText text measuring, MacMarkdown.

#if os(macOS)
import AppKit

// MARK: - Markdown → NSAttributedString (macOS mirror of iOS TKMarkdown)

// Adaptive palette: resolves against the text view's effective appearance,
// so the production chat follows the system light/dark setting. The
// headless bubble-test render forces an aqua window, so it still draws
// the light variant there.
enum MacBubblePalette {
    static let text = NSColor.labelColor
    static let secondary = NSColor.secondaryLabelColor
    static let link = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(srgbRed: 0x8F/255, green: 0xD5/255, blue: 1, alpha: 1)
            : NSColor(srgbRed: 0x00/255, green: 0x56/255, blue: 0xA8/255, alpha: 1)
    }
    static let tertiary = NSColor.tertiaryLabelColor
}

func macContentCacheKey(prefix: String, content: String) -> NSString {
    var hasher = Hasher()
    hasher.combine(content)
    return "\(prefix)\u{1F}\(content.utf8.count)\u{1F}\(hasher.finalize())" as NSString
}

private let macMarkdownCache: NSCache<NSString, NSAttributedString> = {
    let c = NSCache<NSString, NSAttributedString>()
    c.countLimit = 160
    c.totalCostLimit = 24 * 1024 * 1024
    return c
}()

extension NSAttributedString.Key {
    static let tkBlockKind = NSAttributedString.Key("chat.kraki.tkBlockKind")
    static let tkBlockID = NSAttributedString.Key("chat.kraki.tkBlockID")
    static let tkBlockLabel = NSAttributedString.Key("chat.kraki.tkBlockLabel")
    static let tkDecorativeSpacer = NSAttributedString.Key("chat.kraki.tkDecorativeSpacer")
    static let tkSemanticText = NSAttributedString.Key("chat.kraki.tkSemanticText")
    static let tkCodeHighlightProvisional = NSAttributedString.Key("chat.kraki.tkCodeHighlightProvisional")
}

enum TKBlockKind: String {
    case quote, code
}

private extension NSFont {
    func withTraits(_ traits: NSFontDescriptor.SymbolicTraits) -> NSFont {
        let descriptor = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(traits))
        return NSFont(descriptor: descriptor, size: 0) ?? self
    }
    var tkBold: NSFont { withTraits(.bold) }
    var tkItalic: NSFont { withTraits(.italic) }
}

/// Text measurement/drawing through CoreText only. AppKit string drawing
/// (`NSString.size/boundingRect/draw(withAttributes:)`) shares a typesetter
/// that is not safe to use concurrently: table layout runs on the content
/// preparation queue while the main thread draws, and the collision aborted
/// inside CTLineCreateWithAttributedString. CoreText objects are per call.
enum MacCTText {
    static func width(_ text: String, font: NSFont) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        let line = CTLineCreateWithAttributedString(
            NSAttributedString(string: text, attributes: [.font: font]))
        return ceil(CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
    }

    static func height(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        guard !text.isEmpty else { return ceil(font.ascender - font.descender + font.leading) }
        let framesetter = CTFramesetterCreateWithAttributedString(
            NSAttributedString(string: text, attributes: [.font: font]))
        let size = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter, CFRange(location: 0, length: 0), nil,
            CGSize(width: max(1, width), height: .greatestFiniteMagnitude), nil)
        return ceil(size.height)
    }

    /// Wrapped draw in a flipped view, laid out exactly as `height` measures.
    static func drawWrapped(_ text: String, attributes: [NSAttributedString.Key: Any], in rect: NSRect) {
        guard !text.isEmpty, rect.width > 0, let context = NSGraphicsContext.current?.cgContext else { return }
        let framesetter = CTFramesetterCreateWithAttributedString(
            NSAttributedString(string: text, attributes: attributes))
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: rect.width, height: max(rect.height, 1) + 2), transform: nil)
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: rect.minX, y: rect.minY + max(rect.height, 1) + 2)
        context.scaleBy(x: 1, y: -1)
        CTFrameDraw(frame, context)
        context.restoreGState()
    }

    /// Single-line draw in a flipped view; `point` is the top-left.
    static func draw(_ text: String, attributes: [NSAttributedString.Key: Any], at point: NSPoint) {
        guard !text.isEmpty, let context = NSGraphicsContext.current?.cgContext else { return }
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        var ascent: CGFloat = 0
        _ = CTLineGetTypographicBounds(line, &ascent, nil, nil)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: point.x, y: point.y + ascent)
        context.scaleBy(x: 1, y: -1)
        context.textPosition = .zero
        CTLineDraw(line, context)
        context.restoreGState()
    }
}

enum MacMarkdown {
    static func highlightGeneration() -> Int {
        MacCodeHighlightGeneration.shared.current()
    }

    static func prewarmSyntaxHighlighter() {
        MacCodeHighlighter.prewarm()
    }

    #if DEBUG
    static func codeHighlightCatalogDiagnostics(
        completion: @escaping ([String]) -> Void
    ) {
        MacCodeHighlighter.catalogDiagnostics { diagnostics in
            completion(diagnostics.map { diagnostic in
                "title=\(diagnostic.title) language=\(diagnostic.language) "
                    + "supported=\(diagnostic.supported ? 1 : 0) "
                    + "rawColors=\(diagnostic.rawColorCount) "
                    + "readableColors=\(diagnostic.readableColorCount) "
                    + "sourcePreserved=\(diagnostic.sourcePreserved ? 1 : 0) "
                    + "chars=\(diagnostic.characterCount)"
            })
        }
    }
    #endif

    /// Parse `text` to an `NSAttributedString` mirroring the iOS bubble.
    static func attributed(
        _ text: String,
        cacheKey: String,
        allowSyntaxHighlighting: Bool = true
    ) -> NSAttributedString {
        let key = macContentCacheKey(
            prefix: allowSyntaxHighlighting ? cacheKey : "\(cacheKey):plain-code",
            content: text
        )
        if let hit = macMarkdownCache.object(forKey: key) { return hit }
        MacCodeHighlighter.clearProvisionalFlag()
        let built = build(text, allowSyntaxHighlighting: allowSyntaxHighlighting)
        let provisional = MacCodeHighlighter.consumeProvisionalFlag()
        if !provisional {
            macMarkdownCache.setObject(
                built,
                forKey: key,
                cost: max(text.utf8.count * 2, built.length * 16)
            )
        }
        return built
    }

    private static func build(
        _ text: String,
        allowSyntaxHighlighting: Bool
    ) -> NSAttributedString {
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
                    allowSyntaxHighlighting: allowSyntaxHighlighting
                )
            case .table(let rows, let alignments):
                // Tables in the test page render as a TSV block; the real
                // production mac bubble will use a scroll view like iOS.
                piece = tableSegment(rows: rows, alignments: alignments)
            }
            if i > 0 {
                out.append(NSAttributedString(string: "\n", attributes: [
                    .font: NSFont.systemFont(ofSize: 6),
                ]))
            }
            out.append(piece)
        }
        if out.length == 0 { return inlineSegment(text) }
        return out
    }

    private static func inlineSegment(_ text: String) -> NSAttributedString {
        let lines = text.components(separatedBy: "\n")
        let result = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            switch parseMarkdownInlineLine(line) {
            case .heading(let level, let headingText):
                let font: NSFont
                switch level {
                case 1: font = NSFont.systemFont(ofSize: 22, weight: .bold)
                case 2: font = NSFont.systemFont(ofSize: 20, weight: .bold)
                case 3: font = NSFont.systemFont(ofSize: 17, weight: .semibold)
                case 4: font = NSFont.systemFont(ofSize: 15, weight: .bold)
                default: font = NSFont.systemFont(ofSize: 13, weight: .bold)
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
                    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                    .foregroundColor: MacBubblePalette.secondary,
                ])
                row.append(inlineMarkdown(item.text, baseFont: NSFont.systemFont(ofSize: 15)))
                row.addAttribute(.paragraphStyle, value: paragraph,
                                 range: NSRange(location: 0, length: row.length))
                result.append(row)
            case .text(let content):
                result.append(inlineMarkdown(content, baseFont: NSFont.systemFont(ofSize: 15)))
            }
        }
        return result
    }

    private static func inlineMarkdown(_ text: String, baseFont: NSFont) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for run in parseMarkdownInline(text) {
            var font = baseFont
            if run.bold { font = font.tkBold }
            if run.italic { font = font.tkItalic }
            if run.code { font = .monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular) }
            var attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: run.link == nil ? MacBubblePalette.text : MacBubblePalette.link,
            ]
            if let link = run.link { attrs[.link] = link }
            if run.strikethrough { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
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

    private static func blockquoteSegment(_ content: String) -> NSAttributedString {
        let normalized = normalizeMarkdownQuoteWhitespace(content)
        let result = NSMutableAttributedString(attributedString: inlineSegment(normalized))
        result.addAttribute(.foregroundColor, value: MacBubblePalette.text,
                            range: NSRange(location: 0, length: result.length))
        let paragraph = NSMutableParagraphStyle()
        paragraph.firstLineHeadIndent = 14
        paragraph.headIndent = 14
        paragraph.tailIndent = -8
        paragraph.lineSpacing = 1
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        markBlock(result, kind: .quote)
        return result
    }

    private static func codeSegment(
        language: String?,
        code: String,
        allowSyntaxHighlighting: Bool
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let topHeight: CGFloat = language?.isEmpty == false ? 20 : 8
        result.append(codeSpacer(height: topHeight, terminatesLine: true))

        let highlighted = NSMutableAttributedString(
            attributedString: MacCodeHighlighter.attributed(
                code: code,
                language: language,
                allowHighlighting: allowSyntaxHighlighting
            )
        )
        // Cold provisional code has no foreground attribute, while a syntax
        // theme can occasionally emit a token too dark for our fixed editor
        // surface. Normalize only missing/low-contrast ranges so valid syntax
        // colors survive and every code glyph remains readable.
        MacCodePalette.ensuringReadableForeground(in: highlighted)
        if highlighted.length > 0 {
            let paragraph = NSMutableParagraphStyle()
            paragraph.firstLineHeadIndent = 12
            paragraph.headIndent = 12
            paragraph.tailIndent = -12
            paragraph.lineSpacing = 2
            highlighted.addAttributes([
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
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
            .font: NSFont.systemFont(ofSize: 1),
            .foregroundColor: NSColor.clear,
            .paragraphStyle: paragraph,
            .tkDecorativeSpacer: true,
        ])
    }

    private static func tableSegment(rows: [[String]], alignments: [TableAlignment]) -> NSAttributedString {
        let attachment = MacTableAttachment(rows: rows, alignments: alignments)
        return NSAttributedString(attachment: attachment, attributes: [
            .tkSemanticText: attachment.tableLayout.semanticText(),
        ])
    }

    static func plainText(_ attributed: NSAttributedString?) -> String? {
        guard let attributed, attributed.length > 0 else { return nil }
        var output = ""
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length)
        ) { attributes, range, _ in
            if attributes[.tkDecorativeSpacer] != nil { return }
            if let semantic = attributes[.tkSemanticText] as? String {
                output += semantic
            } else {
                output += attributed.attributedSubstring(from: range).string
            }
        }
        return output
            .replacingOccurrences(of: "\u{FFFC}", with: "")
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func markBlock(_ string: NSMutableAttributedString, kind: TKBlockKind) {
        guard string.length > 0 else { return }
        let range = NSRange(location: 0, length: string.length)
        string.addAttribute(.tkBlockKind, value: kind.rawValue, range: range)
        string.addAttribute(.tkBlockID, value: UUID().uuidString, range: range)
    }
}
#endif
