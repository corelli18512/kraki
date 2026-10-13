/// The Mac bubble's NSTextView (TextKit 2) body.

#if os(macOS)
import AppKit

// MARK: - Bubble text view (NSTextView, TextKit2)

final class MacBubbleTextView: NSTextView {
    /// Body whose plain text is this view's accessibility label, computed only
    /// when accessibility asks (converting the whole body on every configure
    /// cost ~2 scans of the full answer per streaming delta on the main thread).
    var lazyAccessibilityBody: NSAttributedString? {
        didSet { if lazyAccessibilityBody !== oldValue { lazyAccessibilityLabel = nil } }
    }
    private var lazyAccessibilityLabel: String?
    override func accessibilityLabel() -> String? {
        guard let body = lazyAccessibilityBody else { return super.accessibilityLabel() }
        if let cached = lazyAccessibilityLabel { return cached }
        let text = MacMarkdown.plainText(body) ?? ""
        lazyAccessibilityLabel = text
        return text
    }
    override var acceptsFirstResponder: Bool { false }

    init() {
        // Build a complete TextKit1 stack so drawRichBlocks can walk the
        // layoutManager: NSTextStorage → NSLayoutManager → NSTextContainer.
        let storage = NSTextStorage()
        let lm = NSLayoutManager()
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(containerSize: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        tc.widthTracksTextView = true
        lm.addTextContainer(tc)
        super.init(frame: .zero, textContainer: tc)
        isVerticallyResizable = true
        isHorizontallyResizable = false
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticLinkDetectionEnabled = false
        isAutomaticDataDetectionEnabled = false
        enabledTextCheckingTypes = 0
        // Do NOT autoresize width with the superview, and do NOT let the
        // textContainer width track the view frame - both cause the container
        // to collapse/expand during layout and balloon measured height. We
        // set the container size explicitly.
        autoresizingMask = []
        tc.widthTracksTextView = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    struct TablePlacement {
        let attachment: MacTableAttachment
        let frame: NSRect
    }

    func setTableViewportWidth(_ width: CGFloat) {
        guard let storage = textStorage else { return }
        storage.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: storage.length)
        ) { value, _, _ in
            (value as? MacTableAttachment)?.setViewportWidth(width)
        }
    }

    func tablePlacements() -> [TablePlacement] {
        guard let layoutManager,
              let textContainer,
              let storage = textStorage,
              storage.length > 0 else { return [] }
        layoutManager.ensureLayout(for: textContainer)
        var placements: [TablePlacement] = []
        storage.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: storage.length)
        ) { value, range, _ in
            guard let attachment = value as? MacTableAttachment else { return }
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: range,
                actualCharacterRange: nil
            )
            var frame = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            frame.origin.x = 0
            frame.size.width = bounds.width
            frame.size.height = attachment.tableLayout.bubbleHeight(width: bounds.width)
            placements.append(TablePlacement(attachment: attachment, frame: frame))
        }
        return placements
    }

    override var intrinsicContentSize: NSSize {
        guard let lm = layoutManager, let tc = textContainer else { return NSSize(width: 650, height: 20) }
        lm.ensureLayout(for: tc)
        let used = lm.usedRect(for: tc)
        return NSSize(width: max(used.width, 1), height: max(ceil(used.height), 1))
    }

    override func layout() {
        super.layout()
        invalidateIntrinsicContentSize()
    }

    /// Plain-text-only messages never enable selection so iOS-style dark
    /// highlights don't appear behind ordinary text. (We keep selection
    /// enabled in the test page — validating it works is the point.)
    override func draw(_ dirtyRect: NSRect) {
        // Draw rich-block backgrounds (code surface / quote rule) FIRST so
        // the glyphs paint on top of them.
        drawRichBlocks(dirtyRect)
        super.draw(dirtyRect)
    }

    /// Walk the attributed string's `.tkBlockKind` ranges and paint the
    /// code/quote decorations underneath the glyphs, mirroring the iOS
    /// `TKBodyTextView.drawRichBlocks`. Uses TextKit1's layoutManager to
    /// resolve each block's character range to a glyph bounding rect.
    private func drawRichBlocks(_ dirtyRect: NSRect) {
        guard let lm = layoutManager,
              let tc = textContainer,
              let ts = textStorage, ts.length > 0 else { return }
        lm.ensureLayout(for: tc)

        // Collect each block's (kind, label, charRange), keyed by blockID so
        // multi-fragment blocks (e.g. a code block with many lines) merge.
        var blocks: [(kind: TKBlockKind, label: String?, charRange: NSRange)] = []
        var seen: [String: Int] = [:]
        var range = NSRange(location: 0, length: 0)
        var idx = 0
        while idx < ts.length {
            let blockID = ts.attribute(.tkBlockID, at: idx, effectiveRange: &range) as? String
            if let blockID, let rawKind = ts.attribute(.tkBlockKind, at: idx, effectiveRange: nil) as? String,
               let kind = TKBlockKind(rawValue: rawKind) {
                let label = ts.attribute(.tkBlockLabel, at: idx, effectiveRange: nil) as? String
                if let existing = seen[blockID] {
                    // Extend the stored block's range to cover this fragment too.
                    let merged = NSUnionRange(blocks[existing].charRange, range)
                    blocks[existing] = (blocks[existing].kind, blocks[existing].label, merged)
                } else {
                    seen[blockID] = blocks.count
                    blocks.append((kind, label, range))
                }
                idx = range.location + range.length
                continue
            }
            idx += 1
        }

        // The layout manager's rect is already in the flipped NSTextView
        // coordinate system on macOS. Do not reflect y again: doing so moves
        // a quote near the bottom of a message onto the first heading.
        for block in blocks {
            let glyphRange = lm.glyphRange(forCharacterRange: block.charRange, actualCharacterRange: nil)
            let lmRect = lm.boundingRect(forGlyphRange: glyphRange, in: tc)
            let rect = NSRect(x: 0, y: lmRect.origin.y, width: bounds.width, height: lmRect.height)
            // Slight vertical padding so the surface hugs the block nicely.
            var frame = rect.insetBy(dx: 0, dy: -2)
            frame = frame.intersection(bounds.insetBy(dx: 0, dy: -1))
            guard !frame.isNull, frame.height > 0 else { continue }
            switch block.kind {
            case .quote:
                NSColor.secondarySystemFill.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
                NSColor.separatorColor.setFill()
                NSBezierPath(roundedRect: NSRect(x: frame.minX, y: frame.minY,
                                                 width: 3, height: frame.height),
                             xRadius: 1.5, yRadius: 1.5).fill()
            case .code:
                // Neutral editor surface — stable across agent/user bubble tints.
                MacCodePalette.background.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 9, yRadius: 9).fill()
                NSColor(srgbRed: 0x52/255, green: 0x52/255, blue: 0x5B/255, alpha: 0.72).setStroke()
                let outline = NSBezierPath(roundedRect: frame.insetBy(dx: 0.25, dy: 0.25),
                                           xRadius: 9, yRadius: 9)
                outline.lineWidth = 0.5
                outline.stroke()
                if let label = block.label {
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                        .foregroundColor: NSColor(srgbRed: 0xA1/255, green: 0xA1/255, blue: 0xAA/255, alpha: 1),
                    ]
                    MacCTText.draw(label, attributes: attrs, at: NSPoint(x: frame.minX + 12, y: frame.minY + 5))
                }
            }
        }
    }
}
#endif
