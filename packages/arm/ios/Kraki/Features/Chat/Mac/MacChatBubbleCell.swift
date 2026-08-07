#if os(macOS)
import AppKit
import CoreText
import SwiftUI

/// One virtualized chat bubble. Layout constants and view hierarchy mirror
/// iOS `TKBubbleCell`: no Mac-only avatar column, one bubble background, body,
/// inline/lazy images, in-bubble action slot, and a floating Steps capsule.
enum MacBubbleKind: Equatable { case agent, user, error, system }

private final class MacCoreTextRunMetrics: NSObject {
    let width: CGFloat
    let ascent: CGFloat
    let descent: CGFloat

    init(width: CGFloat, ascent: CGFloat, descent: CGFloat = 0) {
        self.width = width
        self.ascent = ascent
        self.descent = descent
    }
}

private func macCoreTextRunDealloc(_ pointer: UnsafeMutableRawPointer) {
    Unmanaged<MacCoreTextRunMetrics>.fromOpaque(pointer).release()
}

private func macCoreTextRunAscent(_ pointer: UnsafeMutableRawPointer) -> CGFloat {
    Unmanaged<MacCoreTextRunMetrics>.fromOpaque(pointer).takeUnretainedValue().ascent
}

private func macCoreTextRunDescent(_ pointer: UnsafeMutableRawPointer) -> CGFloat {
    Unmanaged<MacCoreTextRunMetrics>.fromOpaque(pointer).takeUnretainedValue().descent
}

private func macCoreTextRunWidth(_ pointer: UnsafeMutableRawPointer) -> CGFloat {
    Unmanaged<MacCoreTextRunMetrics>.fromOpaque(pointer).takeUnretainedValue().width
}

private extension NSAttributedString.Key {
    static let krakiCoreTextTable = NSAttributedString.Key("chat.kraki.coreTextTable")
}

private extension NSAttributedString {
    func attributeRanges(for key: NSAttributedString.Key) -> [(Any, NSRange)] {
        var result: [(Any, NSRange)] = []
        enumerateAttribute(key, in: NSRange(location: 0, length: length)) { value, range, _ in
            if let value { result.append((value, range)) }
        }
        return result
    }
}

/// Immutable CoreText output for one body/revision/width. The expensive line
/// breaking and link/block geometry survive cell reuse, so rebinding a bubble
/// never reinstalls an attributed string into TextKit or lays glyphs out again.
final class MacCoreTextLayoutArtifact: NSObject {
    struct LinkRegion {
        let url: URL
        let label: String
        let rects: [NSRect]
    }

    struct BlockRegion {
        let kind: TKBlockKind
        let label: String?
        let frame: NSRect
    }

    struct TableRegion {
        let attachment: MacTableAttachment
        let frame: NSRect
    }

    struct LineInfo {
        let line: CTLine
        let range: NSRange
        let rect: NSRect
    }

    private static let cache: NSCache<NSString, MacCoreTextLayoutArtifact> = {
        let cache = NSCache<NSString, MacCoreTextLayoutArtifact>()
        cache.countLimit = 256
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    let attributed: NSAttributedString
    let frame: CTFrame
    let width: CGFloat
    let height: CGFloat
    let links: [LinkRegion]
    let blocks: [BlockRegion]
    let tables: [TableRegion]
    let lines: [LineInfo]
    let plainText: String

    static func removeCached(width: CGFloat, key: String) {
        let cacheKey = "\(key)|w:\(Int(width.rounded()))" as NSString
        cache.removeObject(forKey: cacheKey)
    }

    static func cached(
        attributed: NSAttributedString,
        width: CGFloat,
        key: String
    ) -> MacCoreTextLayoutArtifact? {
        guard attributed.length > 0, width > 0 else { return nil }
        let cacheKey = "\(key)|w:\(Int(width.rounded()))" as NSString
        if let hit = cache.object(forKey: cacheKey) { return hit }
        let built = MacCoreTextLayoutArtifact(attributed: attributed, width: width)
        cache.setObject(
            built,
            forKey: cacheKey,
            cost: max(attributed.length * 32, Int(width * built.height / 4))
        )
        return built
    }

    func stringIndex(at point: NSPoint) -> Int? {
        guard let first = lines.first, let last = lines.last else { return nil }
        let info: LineInfo
        if point.y <= first.rect.minY {
            info = first
        } else if point.y >= last.rect.maxY {
            info = last
        } else {
            info = lines.min { lhs, rhs in
                let lhsDistance = point.y < lhs.rect.minY
                    ? lhs.rect.minY - point.y
                    : max(0, point.y - lhs.rect.maxY)
                let rhsDistance = point.y < rhs.rect.minY
                    ? rhs.rect.minY - point.y
                    : max(0, point.y - rhs.rect.maxY)
                return lhsDistance < rhsDistance
            } ?? first
        }

        if point.x <= info.rect.minX { return info.range.location }
        if point.x >= info.rect.maxX {
            return min(NSMaxRange(info.range), attributed.length)
        }
        let index = CTLineGetStringIndexForPosition(
            info.line,
            CGPoint(x: point.x - info.rect.minX, y: 0)
        )
        guard index != kCFNotFound else { return info.range.location }
        return min(max(index, info.range.location), min(NSMaxRange(info.range), attributed.length))
    }

    func point(forStringIndex requestedIndex: Int) -> NSPoint? {
        guard !lines.isEmpty else { return nil }
        let index = min(max(requestedIndex, 0), attributed.length)
        let info = lines.first { line in
            index >= line.range.location && index <= NSMaxRange(line.range)
        } ?? lines.last!
        let offset = CTLineGetOffsetForStringIndex(info.line, index, nil)
        return NSPoint(x: info.rect.minX + offset, y: info.rect.midY)
    }

    func selectionRects(for requestedRange: NSRange) -> [NSRect] {
        guard requestedRange.location != NSNotFound else { return [] }
        let lower = min(max(requestedRange.location, 0), attributed.length)
        let upper = min(max(requestedRange.location + requestedRange.length, lower), attributed.length)
        guard upper > lower else { return [] }
        let range = NSRange(location: lower, length: upper - lower)
        return lines.compactMap { info in
            let intersection = NSIntersectionRange(range, info.range)
            guard intersection.length > 0 else { return nil }
            let start = CTLineGetOffsetForStringIndex(info.line, intersection.location, nil)
            let end = CTLineGetOffsetForStringIndex(
                info.line,
                intersection.location + intersection.length,
                nil
            )
            return NSRect(
                x: info.rect.minX + min(start, end),
                y: info.rect.minY,
                width: max(abs(end - start), 2),
                height: info.rect.height
            )
        }
    }

    func plainText(in requestedRange: NSRange) -> String? {
        guard requestedRange.location != NSNotFound else { return nil }
        let lower = min(max(requestedRange.location, 0), attributed.length)
        let upper = min(max(requestedRange.location + requestedRange.length, lower), attributed.length)
        guard upper > lower else { return nil }
        let substring = attributed.attributedSubstring(
            from: NSRange(location: lower, length: upper - lower)
        )
        return MacMarkdown.plainText(substring) ?? substring.string
    }

    func wordRange(containing requestedIndex: Int) -> NSRange {
        let text = attributed.string as NSString
        guard text.length > 0 else { return NSRange(location: 0, length: 0) }
        let index = min(max(requestedIndex, 0), text.length - 1)
        var range = text.rangeOfComposedCharacterSequence(at: index)
        let wordCharacters = CharacterSet.alphanumerics
            .union(.nonBaseCharacters)
            .union(CharacterSet(charactersIn: "_"))
        func isWord(_ candidate: NSRange) -> Bool {
            text.substring(with: candidate).rangeOfCharacter(from: wordCharacters) != nil
        }
        guard isWord(range) else { return range }
        while range.location > 0 {
            let previous = text.rangeOfComposedCharacterSequence(at: range.location - 1)
            guard isWord(previous) else { break }
            range = NSUnionRange(range, previous)
        }
        while NSMaxRange(range) < text.length {
            let next = text.rangeOfComposedCharacterSequence(at: NSMaxRange(range))
            guard isWord(next) else { break }
            range = NSUnionRange(range, next)
        }
        return range
    }

    func paragraphRange(containing requestedIndex: Int) -> NSRange {
        let text = attributed.string as NSString
        guard text.length > 0 else { return NSRange(location: 0, length: 0) }
        let index = min(max(requestedIndex, 0), text.length - 1)
        return text.paragraphRange(for: NSRange(location: index, length: 0))
    }

    private init(attributed source: NSAttributedString, width requestedWidth: CGFloat) {
        let source = NSAttributedString(attributedString: source)
        let width = max(requestedWidth, 1)
        let attributed = NSMutableAttributedString(attributedString: source)
        source.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: source.length)
        ) { value, range, _ in
            guard let attachment = value as? MacTableAttachment else { return }
            let metrics = MacCoreTextRunMetrics(
                width: width,
                ascent: attachment.tableLayout.bubbleViewportHeight
            )
            let retained = Unmanaged.passRetained(metrics).toOpaque()
            var callbacks = CTRunDelegateCallbacks(
                version: kCTRunDelegateVersion1,
                dealloc: macCoreTextRunDealloc,
                getAscent: macCoreTextRunAscent,
                getDescent: macCoreTextRunDescent,
                getWidth: macCoreTextRunWidth
            )
            guard let delegate = CTRunDelegateCreate(&callbacks, retained) else {
                Unmanaged<MacCoreTextRunMetrics>.fromOpaque(retained).release()
                return
            }
            attributed.removeAttribute(.attachment, range: range)
            attributed.addAttributes([
                NSAttributedString.Key(kCTRunDelegateAttributeName as String): delegate,
                .krakiCoreTextTable: attachment,
                .foregroundColor: NSColor.clear,
            ], range: range)
        }
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let constraint = CGSize(width: width, height: 1_000_000)
        let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: attributed.length),
            nil,
            constraint,
            nil
        )
        let height = max(ceil(suggested.height), 1)
        let path = CGPath(
            rect: CGRect(x: 0, y: 0, width: width, height: height),
            transform: nil
        )
        let frame = CTFramesetterCreateFrame(
            framesetter,
            CFRange(location: 0, length: attributed.length),
            path,
            nil
        )

        let ctLines = CTFrameGetLines(frame)
        let lineCount = CFArrayGetCount(ctLines)
        var origins = Array(repeating: CGPoint.zero, count: lineCount)
        if !origins.isEmpty {
            CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        }
        var lineInfo: [LineInfo] = []
        lineInfo.reserveCapacity(lineCount)
        for index in 0..<lineCount {
            let line = unsafeBitCast(
                CFArrayGetValueAtIndex(ctLines, index),
                to: CTLine.self
            )
            let rawRange = CTLineGetStringRange(line)
            let range = NSRange(location: rawRange.location, length: rawRange.length)
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            var leading: CGFloat = 0
            let measuredWidth = CGFloat(
                CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            )
            let baselineY = height - origins[index].y
            let rect = NSRect(
                x: origins[index].x,
                y: baselineY - ascent,
                width: max(ceil(measuredWidth), 1),
                height: max(ceil(ascent + descent + leading), 1)
            )
            lineInfo.append(LineInfo(line: line, range: range, rect: rect))
        }

        var builtLinks: [LinkRegion] = []
        attributed.enumerateAttribute(
            .link,
            in: NSRange(location: 0, length: attributed.length)
        ) { value, range, _ in
            let url: URL?
            switch value {
            case let value as URL: url = value
            case let value as String: url = URL(string: value)
            default: url = nil
            }
            guard let url else { return }
            var rects: [NSRect] = []
            for info in lineInfo {
                let intersection = NSIntersectionRange(range, info.range)
                guard intersection.length > 0 else { continue }
                let start = CTLineGetOffsetForStringIndex(info.line, intersection.location, nil)
                let end = CTLineGetOffsetForStringIndex(
                    info.line,
                    intersection.location + intersection.length,
                    nil
                )
                rects.append(NSRect(
                    x: info.rect.minX + min(start, end),
                    y: info.rect.minY,
                    width: max(abs(end - start), 2),
                    height: info.rect.height
                ))
            }
            let label = attributed.attributedSubstring(from: range).string
            builtLinks.append(LinkRegion(url: url, label: label, rects: rects))
        }

        var groupedBlocks: [String: (TKBlockKind, String?, NSRange)] = [:]
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length)
        ) { attributes, range, _ in
            guard let id = attributes[.tkBlockID] as? String,
                  let rawKind = attributes[.tkBlockKind] as? String,
                  let kind = TKBlockKind(rawValue: rawKind) else { return }
            let label = attributes[.tkBlockLabel] as? String
            if let existing = groupedBlocks[id] {
                groupedBlocks[id] = (existing.0, existing.1 ?? label, NSUnionRange(existing.2, range))
            } else {
                groupedBlocks[id] = (kind, label, range)
            }
        }
        let builtBlocks: [BlockRegion] = groupedBlocks.values.compactMap { value -> BlockRegion? in
            let (kind, label, range) = value
            let intersecting = lineInfo.filter { NSIntersectionRange(range, $0.range).length > 0 }
            guard let first = intersecting.first else { return nil }
            let vertical = intersecting.dropFirst().reduce(first.rect) { $0.union($1.rect) }
            let minY = max(0, vertical.minY - 2)
            let padded = NSRect(
                x: 0,
                y: minY,
                width: width,
                height: min(height, vertical.maxY + 2) - minY
            )
            return BlockRegion(kind: kind, label: label, frame: padded)
        }

        let builtTables: [TableRegion] = source.attributeRanges(for: .attachment).compactMap { value, range in
            guard let attachment = value as? MacTableAttachment,
                  let info = lineInfo.first(where: { NSIntersectionRange(range, $0.range).length > 0 }) else {
                return nil
            }
            return TableRegion(
                attachment: attachment,
                frame: NSRect(
                    x: 0,
                    y: info.rect.minY,
                    width: width,
                    height: attachment.tableLayout.bubbleViewportHeight
                )
            )
        }

        self.attributed = source
        self.frame = frame
        self.width = width
        self.height = height
        self.links = builtLinks
        self.blocks = builtBlocks
        self.tables = builtTables
        self.lines = lineInfo
        self.plainText = MacMarkdown.plainText(source) ?? ""
        super.init()
    }
}

/// Lightweight layer-backed renderer for cached CoreText artifacts. It draws
/// read-only Markdown and selection directly, and exposes native link hit
/// targets without a per-cell NSTextStorage/NSLayoutManager/NSTextContainer stack.
final class MacCoreTextBodyView: NSView {
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { artifact != nil }

    private(set) var artifact: MacCoreTextLayoutArtifact?
    private var selectionRange: NSRange?
    private var selectionAnchor: Int?
    private var dragOrigin: NSPoint?
    private var pendingLink: URL?
    private var didDragSelection = false

    var hasSelection: Bool { selectionRange?.length ?? 0 > 0 }
    var selectedText: String? {
        guard let artifact, let selectionRange else { return nil }
        return artifact.plainText(in: selectionRange)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.drawsAsynchronously = true
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ artifact: MacCoreTextLayoutArtifact?) {
        guard self.artifact !== artifact else { return }
        self.artifact = artifact
        resetSelection()
        setAccessibilityLabel(artifact?.plainText ?? "")
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let artifact,
              let context = NSGraphicsContext.current?.cgContext else { return }
        drawBlockBackgrounds(artifact.blocks, dirtyRect: dirtyRect)
        drawSelection(in: artifact, dirtyRect: dirtyRect)
        context.saveGState()
        context.clip(to: dirtyRect)
        context.textMatrix = .identity
        context.translateBy(x: 0, y: bounds.height)
        context.scaleBy(x: 1, y: -1)
        CTFrameDraw(artifact.frame, context)
        context.restoreGState()
    }

    private func drawSelection(
        in artifact: MacCoreTextLayoutArtifact,
        dirtyRect: NSRect
    ) {
        guard let selectionRange, selectionRange.length > 0 else { return }
        let isActive = window?.isKeyWindow == true && window?.firstResponder === self
        let color = isActive
            ? NSColor.selectedTextBackgroundColor
            : NSColor.unemphasizedSelectedTextBackgroundColor
        color.setFill()
        for rect in artifact.selectionRects(for: selectionRange) where rect.intersects(dirtyRect) {
            rect.intersection(bounds).fill()
        }
    }

    private func drawBlockBackgrounds(
        _ blocks: [MacCoreTextLayoutArtifact.BlockRegion],
        dirtyRect: NSRect
    ) {
        for block in blocks where block.frame.intersects(dirtyRect) {
            let frame = block.frame.intersection(bounds.insetBy(dx: 0, dy: -1))
            guard !frame.isNull, frame.height > 0 else { continue }
            switch block.kind {
            case .quote:
                NSColor.secondarySystemFill.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
                NSColor.separatorColor.setFill()
                NSBezierPath(
                    roundedRect: NSRect(x: frame.minX, y: frame.minY, width: 3, height: frame.height),
                    xRadius: 1.5,
                    yRadius: 1.5
                ).fill()
            case .code:
                MacCodePalette.background.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 9, yRadius: 9).fill()
                NSColor(srgbRed: 0x52/255, green: 0x52/255, blue: 0x5B/255, alpha: 0.72).setStroke()
                let outline = NSBezierPath(
                    roundedRect: frame.insetBy(dx: 0.25, dy: 0.25),
                    xRadius: 9,
                    yRadius: 9
                )
                outline.lineWidth = 0.5
                outline.stroke()
                if let label = block.label {
                    (label as NSString).draw(
                        at: NSPoint(x: frame.minX + 12, y: frame.minY + 5),
                        withAttributes: [
                            .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                            .foregroundColor: NSColor(
                                srgbRed: 0xA1/255,
                                green: 0xA1/255,
                                blue: 0xAA/255,
                                alpha: 1
                            ),
                        ]
                    )
                }
            }
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard artifact != nil else { return }
        addCursorRect(bounds, cursor: .iBeam)
        for link in artifact?.links ?? [] {
            for rect in link.rects { addCursorRect(rect, cursor: .pointingHand) }
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        event?.type == .leftMouseDown
    }

    override func mouseDown(with event: NSEvent) {
        guard event.buttonNumber == 0,
              let artifact,
              let index = artifact.stringIndex(at: convert(event.locationInWindow, from: nil)) else {
            super.mouseDown(with: event)
            return
        }
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        dragOrigin = point
        didDragSelection = false
        pendingLink = artifact.links.first(where: { region in
            region.rects.contains(where: { $0.insetBy(dx: -2, dy: -2).contains(point) })
        })?.url

        if event.clickCount >= 3 {
            pendingLink = nil
            applySelection(artifact.paragraphRange(containing: index))
            return
        }
        if event.clickCount == 2 {
            pendingLink = nil
            applySelection(artifact.wordRange(containing: index))
            return
        }

        if event.modifierFlags.contains(.shift), let existing = selectionRange, existing.length > 0 {
            let anchor = selectionAnchor
                ?? (index < existing.location ? NSMaxRange(existing) : existing.location)
            selectionAnchor = anchor
            updateSelection(from: anchor, to: index)
        } else {
            selectionAnchor = index
            selectionRange = nil
            needsDisplay = true
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let artifact, let selectionAnchor else {
            super.mouseDragged(with: event)
            return
        }
        _ = autoscroll(with: event)
        let point = convert(event.locationInWindow, from: nil)
        if let dragOrigin,
           hypot(point.x - dragOrigin.x, point.y - dragOrigin.y) >= 2 {
            didDragSelection = true
            pendingLink = nil
        }
        guard let index = artifact.stringIndex(at: point) else { return }
        if index != selectionAnchor { didDragSelection = true }
        updateSelection(from: selectionAnchor, to: index)
    }

    override func mouseUp(with event: NSEvent) {
        if let pendingLink, !didDragSelection, !hasSelection {
            NSWorkspace.shared.open(pendingLink)
        }
        self.pendingLink = nil
        dragOrigin = nil
        didDragSelection = false
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command, hasSelection {
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "c":
                copySelection(nil)
                return true
            case "a":
                selectAll(nil)
                return true
            default:
                break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            resetSelection()
            return
        }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { needsDisplay = true }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { needsDisplay = true }
        return resigned
    }

    @objc func copySelection(_ sender: Any?) {
        guard let selectedText, !selectedText.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(selectedText, forType: .string)
    }

    @objc func copy(_ sender: Any?) {
        copySelection(sender)
    }

    @objc override func selectAll(_ sender: Any?) {
        guard let artifact, artifact.attributed.length > 0 else { return }
        applySelection(NSRange(location: 0, length: artifact.attributed.length))
    }

    private func updateSelection(from anchor: Int, to active: Int) {
        let lower = min(anchor, active)
        let upper = max(anchor, active)
        selectionRange = upper > lower
            ? NSRange(location: lower, length: upper - lower)
            : nil
        selectionAnchor = anchor
        needsDisplay = true
    }

    private func applySelection(_ range: NSRange) {
        selectionRange = range.length > 0 ? range : nil
        selectionAnchor = range.location
        needsDisplay = true
    }

    private func resetSelection() {
        selectionRange = nil
        selectionAnchor = nil
        dragOrigin = nil
        pendingLink = nil
        didDragSelection = false
        needsDisplay = true
    }

    #if DEBUG
    func selectForRegression(_ range: NSRange) -> (text: String?, rectCount: Int) {
        applySelection(range)
        return (selectedText, artifact?.selectionRects(for: range).count ?? 0)
    }
    #endif

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private final class MacHTMLArtifactButton: NSButton {
    private let iconView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let openIcon = NSImageView()
    private var trackingAreaRef: NSTrackingArea?
    private var hovered = false
    private var artifact: ContentRef?
    private var onOpen: ((ContentRef) -> Void)?

    var artifactID: String? { artifact?.id }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        target = self
        action = #selector(openArtifact)
        wantsLayer = true

        iconView.image = NSImage(
            systemSymbolName: "doc.richtext",
            accessibilityDescription: "HTML report"
        )
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        iconView.contentTintColor = NSColor.controlAccentColor
        iconView.imageScaling = .scaleProportionallyDown

        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 1

        detailLabel.font = .systemFont(ofSize: 10, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail
        detailLabel.maximumNumberOfLines = 1

        openIcon.image = NSImage(
            systemSymbolName: "arrow.up.right",
            accessibilityDescription: "Open report"
        )
        openIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
        openIcon.contentTintColor = .tertiaryLabelColor
        openIcon.imageScaling = .scaleProportionallyDown

        [iconView, titleLabel, detailLabel, openIcon].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(artifact: ContentRef, onOpen: @escaping (ContentRef) -> Void) {
        self.artifact = artifact
        self.onOpen = onOpen
        let title = artifact.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = artifact.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayTitle = !(title ?? "").isEmpty
            ? title!
            : (!(name ?? "").isEmpty ? name! : "HTML Report")
        titleLabel.stringValue = displayTitle
        detailLabel.stringValue = "HTML Report · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Open report \(displayTitle)")
        needsDisplay = true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, bounds.contains(point) else { return nil }
        return self
    }

    override func layout() {
        super.layout()
        let iconFrame = NSRect(x: 11, y: 11, width: 32, height: 32)
        iconView.frame = iconFrame.insetBy(dx: 7, dy: 7)
        openIcon.frame = NSRect(x: bounds.width - 25, y: 20, width: 12, height: 12)
        let textX = iconFrame.maxX + 10
        let textWidth = max(1, openIcon.frame.minX - textX - 8)
        titleLabel.frame = NSRect(x: textX, y: 9, width: textWidth, height: 17)
        detailLabel.frame = NSRect(x: textX, y: 29, width: textWidth, height: 14)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaRef { removeTrackingArea(trackingAreaRef) }
        let tracking = NSTrackingArea(
            rect: bounds,
            options: [.activeInKeyWindow, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(tracking)
        trackingAreaRef = tracking
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        needsDisplay = true
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let frame = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8)
        (hovered ? NSColor.controlAccentColor.withAlphaComponent(0.09) : NSColor.controlBackgroundColor.withAlphaComponent(0.78)).setFill()
        path.fill()
        (hovered ? NSColor.controlAccentColor.withAlphaComponent(0.42) : NSColor.separatorColor.withAlphaComponent(0.72)).setStroke()
        path.lineWidth = 1
        path.stroke()
        let iconBackground = NSBezierPath(roundedRect: NSRect(x: 11, y: 11, width: 32, height: 32), xRadius: 7, yRadius: 7)
        NSColor.controlAccentColor.withAlphaComponent(0.10).setFill()
        iconBackground.fill()
    }

    @objc private func openArtifact() {
        guard let artifact else { return }
        onOpen?(artifact)
    }
}

private final class MacHTMLArtifactCardsView: NSView {
    static let cardHeight: CGFloat = 54
    static let spacing: CGFloat = 6

    override var isFlipped: Bool { true }
    private var buttons: [MacHTMLArtifactButton] = []

    static func height(for count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return CGFloat(count) * cardHeight + CGFloat(count - 1) * spacing
    }

    func configure(artifacts: [ContentRef], onOpen: @escaping (ContentRef) -> Void) {
        buttons.forEach { $0.removeFromSuperview() }
        buttons = artifacts.map { artifact in
            let button = MacHTMLArtifactButton(frame: .zero)
            button.configure(artifact: artifact, onOpen: onOpen)
            addSubview(button)
            return button
        }
        isHidden = artifacts.isEmpty
        needsLayout = true
    }

    @discardableResult
    func openArtifact(id: String? = nil) -> Bool {
        guard let button = buttons.first(where: { id == nil || $0.artifactID == id }) else {
            return false
        }
        button.performClick(nil)
        return true
    }

    func reset() {
        buttons.forEach { $0.removeFromSuperview() }
        buttons.removeAll(keepingCapacity: true)
        isHidden = true
        frame = .zero
    }

    override func layout() {
        super.layout()
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(
                x: 0,
                y: CGFloat(index) * (Self.cardHeight + Self.spacing),
                width: bounds.width,
                height: Self.cardHeight
            )
        }
    }
}

private final class MacFlippedContentClipView: NSView {
    override var isFlipped: Bool { true }
}

final class MacChatBubbleCell: NSView {
    override var isFlipped: Bool { true }
    private let contentClipView = MacFlippedContentClipView()
    private let bubbleBG = MacRoundedView()
    private let coreTextBodyView = MacCoreTextBodyView()
    private let bodyView = MacBubbleTextView()
    private let stepsMaterial = NSView()
    private let stepsButton = NSButton()
    private lazy var actionHost = NSHostingView(rootView: Optional<MacBubbleActionSlot>.none)
    private lazy var imageHost = NSHostingView(rootView: Optional<MacBubbleImageGrid>.none)
    private let artifactCardsView = MacHTMLArtifactCardsView()
    private var tableViews: [MacTableScrollView] = []
    private var tableAttachmentIDs: [ObjectIdentifier] = []

    private(set) var bubbleSeq = 0
    private(set) var canShowStepsFlag = false
    private(set) var isLiveFlag = false
    private(set) var isPlaceholderFlag = false
    private(set) var usesCoreTextBodyFlag = false
    private(set) var renderRevision = ""
    var documentWidthVar: CGFloat = 0

    private var content: MacChatBubbleContent?
    private var sessionMode: SessionMode = .discuss
    private var onTapSteps: ((MacChatBubbleCell) -> Void)?
    private var onResolvePermission: ((String, String?, String) -> Void)?
    private var onAnswerQuestion: ((String, String) -> Void)?
    private var onOpenImage: ((MacImagePreviewSelection) -> Void)?
    private var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    private var onHeightInvalidated: (() -> Void)?
    private var bodyHasLinks = false
    private var bodyHasTables = false
    private var measuredBodyHeight: CGFloat = 0
    private var measuredActionHeight: CGFloat = 0
    private var usesCoreTextBody = false

    #if DEBUG
    var bodyFrameForRegression: NSRect {
        usesCoreTextBody ? coreTextBodyView.frame : bodyView.frame
    }
    var actionFrameForRegression: NSRect { actionHost.frame }
    var imageFrameForRegression: NSRect { imageHost.frame }
    var bubbleFrameForRegression: NSRect { bubbleBG.frame }

    func selectBodyTextForRegression(_ range: NSRange) -> (text: String?, rectCount: Int) {
        guard usesCoreTextBody else { return (nil, 0) }
        return coreTextBodyView.selectForRegression(range)
    }

    func dragSelectBodyTextForRegression(
        _ range: NSRange,
        windowNumber: Int
    ) -> (text: String?, rectCount: Int, hitTested: Bool) {
        guard usesCoreTextBody,
              let artifact = coreTextBodyView.artifact,
              let start = artifact.point(forStringIndex: range.location),
              let end = artifact.point(forStringIndex: NSMaxRange(range)) else {
            return (nil, 0, false)
        }
        let startInCell = coreTextBodyView.convert(start, to: self)
        let hit = hitTest(startInCell)
        let hitTested = hit === coreTextBodyView || hit?.isDescendant(of: coreTextBodyView) == true
        let startInWindow = coreTextBodyView.convert(start, to: nil)
        let endInWindow = coreTextBodyView.convert(end, to: nil)
        let timestamp = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: startInWindow,
            modifierFlags: [],
            timestamp: timestamp,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        ), let drag = NSEvent.mouseEvent(
            with: .leftMouseDragged,
            location: endInWindow,
            modifierFlags: [],
            timestamp: timestamp + 0.01,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 2,
            clickCount: 1,
            pressure: 1
        ), let up = NSEvent.mouseEvent(
            with: .leftMouseUp,
            location: endInWindow,
            modifierFlags: [],
            timestamp: timestamp + 0.02,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 3,
            clickCount: 1,
            pressure: 0
        ) else {
            return (nil, 0, hitTested)
        }
        coreTextBodyView.mouseDown(with: down)
        coreTextBodyView.mouseDragged(with: drag)
        coreTextBodyView.mouseUp(with: up)
        let rectCount = coreTextBodyView.artifact?.selectionRects(for: range).count ?? 0
        return (coreTextBodyView.selectedText, rectCount, hitTested)
    }
    var bubbleHiddenForRegression: Bool { bubbleBG.isHidden }
    var contentClipIsFlippedForRegression: Bool { contentClipView.isFlipped }

    func openFirstImageForRegression() -> (found: Bool, hitTested: Bool) {
        imageHost.layoutSubtreeIfNeeded()
        func collectButtons(in view: NSView, into result: inout [NSButton]) {
            if let button = view as? NSButton,
               ["Open image preview", "Open image gallery"].contains(button.accessibilityLabel()) {
                result.append(button)
            }
            for child in view.subviews {
                collectButtons(in: child, into: &result)
            }
        }
        var buttons: [NSButton] = []
        collectButtons(in: imageHost, into: &buttons)
        guard !buttons.isEmpty else { return (false, false) }
        let visibleButton = buttons.first { button in
            let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: self)
            let hit = hitTest(center)
            return hit === button || hit?.isDescendant(of: button) == true
        }
        guard let visibleButton else { return (true, false) }
        visibleButton.performClick(nil)
        return (true, true)
    }
    #endif

    var htmlArtifactCount: Int { content?.htmlArtifacts.count ?? 0 }
    var hasProvisionalCodeHighlight: Bool {
        guard let body = content?.body else { return false }
        var found = false
        body.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: body.length)
        ) { value, _, stop in
            if value != nil {
                found = true
                stop.pointee = true
            }
        }
        return found
    }
    var htmlArtifactIDs: [String] { content?.htmlArtifacts.map(\.id) ?? [] }

    var htmlArtifactFrameInSuperview: NSRect? {
        guard htmlArtifactCount > 0, !artifactCardsView.isHidden, artifactCardsView.frame.height > 0 else {
            return nil
        }
        return artifactCardsView.frame.offsetBy(dx: frame.minX, dy: frame.minY)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        contentClipView.clipsToBounds = true
        addSubview(contentClipView)
        contentClipView.addSubview(bubbleBG)
        contentClipView.addSubview(coreTextBodyView)
        contentClipView.addSubview(bodyView)
        contentClipView.addSubview(imageHost)
        contentClipView.addSubview(artifactCardsView)
        contentClipView.addSubview(actionHost)
        addSubview(stepsMaterial)
        addSubview(stepsButton)

        bodyView.isEditable = false
        bodyView.isSelectable = false
        bodyView.isRichText = true
        bodyView.drawsBackground = false
        bodyView.backgroundColor = .clear
        bodyView.textContainerInset = .zero
        bodyView.textContainer?.lineFragmentPadding = 0

        actionHost.wantsLayer = true
        actionHost.layer?.backgroundColor = NSColor.clear.cgColor
        imageHost.wantsLayer = true
        imageHost.layer?.backgroundColor = NSColor.clear.cgColor

        stepsMaterial.wantsLayer = true
        stepsMaterial.layer?.cornerRadius = 10
        stepsMaterial.layer?.masksToBounds = true
        stepsMaterial.layer?.backgroundColor = NSColor.tertiarySystemFill.cgColor
        stepsMaterial.isHidden = true

        stepsButton.title = "···"
        stepsButton.isBordered = false
        stepsButton.font = .systemFont(ofSize: 14, weight: .bold)
        stepsButton.contentTintColor = .secondaryLabelColor
        stepsButton.target = self
        stepsButton.action = #selector(stepsTapped)
        stepsButton.isHidden = true
        stepsButton.setAccessibilityLabel("Show steps")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func prepareForReuse() {
        super.prepareForReuse()
        content = nil
        bubbleSeq = 0
        canShowStepsFlag = false
        isLiveFlag = false
        isPlaceholderFlag = false
        usesCoreTextBodyFlag = false
        renderRevision = ""
        onTapSteps = nil
        onResolvePermission = nil
        onAnswerQuestion = nil
        onOpenImage = nil
        onOpenHTMLArtifact = nil
        onHeightInvalidated = nil
        bodyHasLinks = false
        bodyHasTables = false
        usesCoreTextBody = false
        measuredBodyHeight = 0
        measuredActionHeight = 0
        coreTextBodyView.configure(nil)
        coreTextBodyView.isHidden = true
        bodyView.textStorage?.setAttributedString(NSAttributedString())
        bodyView.isHidden = true
        bodyView.isSelectable = false
        imageHost.rootView = nil
        artifactCardsView.reset()
        actionHost.rootView = nil
        tableViews.forEach { $0.removeFromSuperview() }
        tableViews.removeAll(keepingCapacity: true)
        tableAttachmentIDs.removeAll(keepingCapacity: true)
        stepsButton.isHidden = true
        stepsMaterial.isHidden = true
        bubbleBG.fillColor = .clear
        bubbleBG.frame = .zero
    }

    /// Show estimated geometry without touching TextKit. Cold rows use this
    /// while a scroll gesture outruns attributed-content warming, so the
    /// viewport never collapses to a blank page. Real content replaces it one
    /// cell per frame after the gesture settles.
    func configurePlaceholder(documentWidth: CGFloat, estimatedHeight: CGFloat) {
        content = nil
        bubbleSeq = 0
        canShowStepsFlag = false
        isLiveFlag = false
        isPlaceholderFlag = true
        usesCoreTextBodyFlag = false
        renderRevision = "placeholder"
        documentWidthVar = documentWidth
        measuredBodyHeight = 0
        measuredActionHeight = 0
        usesCoreTextBody = false
        coreTextBodyView.configure(nil)
        coreTextBodyView.isHidden = true
        bodyView.isHidden = true
        imageHost.isHidden = true
        artifactCardsView.isHidden = true
        actionHost.isHidden = true
        stepsButton.isHidden = true
        stepsMaterial.isHidden = true
        tableViews.forEach { $0.isHidden = true }

        let width = max(120, documentWidth * 0.72)
        let height = max(44, estimatedHeight - MacChatBubbleLayout.outerV * 2)
        bubbleBG.fillColor = NSColor.tertiarySystemFill
        bubbleBG.radii = (12, 12, 12, 12)
        bubbleBG.frame = NSRect(
            x: MacChatBubbleLayout.outerH,
            y: MacChatBubbleLayout.outerV,
            width: width,
            height: height
        )
        bubbleBG.needsLayout = true
    }

    func configure(
        content: MacChatBubbleContent,
        renderKey: String,
        documentWidth: CGFloat,
        sessionMode: SessionMode,
        attachmentStore: AttachmentStore? = nil,
        onTapSteps: @escaping (MacChatBubbleCell) -> Void,
        onResolvePermission: @escaping (String, String?, String) -> Void,
        onAnswerQuestion: @escaping (String, String) -> Void,
        onOpenImage: @escaping (MacImagePreviewSelection) -> Void,
        onOpenHTMLArtifact: @escaping (ContentRef) -> Void,
        onHeightInvalidated: @escaping () -> Void
    ) {
        self.content = content
        renderRevision = renderKey
        isPlaceholderFlag = false
        bubbleSeq = content.seq
        canShowStepsFlag = content.canShowSteps
        isLiveFlag = content.isLive
        documentWidthVar = documentWidth
        self.sessionMode = sessionMode
        self.onTapSteps = onTapSteps
        self.onResolvePermission = onResolvePermission
        self.onAnswerQuestion = onAnswerQuestion
        self.onOpenImage = onOpenImage
        self.onOpenHTMLArtifact = onOpenHTMLArtifact
        self.onHeightInvalidated = onHeightInvalidated

        bodyHasLinks = false
        bodyHasTables = false
        content.body?.enumerateAttributes(
            in: NSRange(location: 0, length: content.body?.length ?? 0)
        ) { attributes, _, stop in
            if attributes[.link] != nil { bodyHasLinks = true }
            if attributes[.attachment] is MacTableAttachment { bodyHasTables = true }
            if bodyHasLinks && bodyHasTables { stop.pointee = true }
        }
        let coreTextArtifact = content.body.flatMap {
            MacCoreTextLayoutArtifact.cached(
                attributed: $0,
                width: content.bodyTextWidth,
                key: renderKey
            )
        }
        usesCoreTextBody = coreTextArtifact != nil
        usesCoreTextBodyFlag = usesCoreTextBody
        if let coreTextArtifact {
            coreTextBodyView.configure(coreTextArtifact)
            coreTextBodyView.isHidden = false
            measuredBodyHeight = coreTextArtifact.height
            bodyView.textStorage?.setAttributedString(NSAttributedString())
            bodyView.isHidden = true
            bodyView.isSelectable = false
            bodyView.setAccessibilityElement(false)
        } else {
            coreTextBodyView.configure(nil)
            coreTextBodyView.isHidden = true
            bodyView.textStorage?.setAttributedString(content.body ?? NSAttributedString())
            bodyView.isSelectable = bodyHasLinks
            bodyView.setAccessibilityElement(bodyHasLinks)
            bodyView.setAccessibilityLabel(MacMarkdown.plainText(content.body) ?? "")
            bodyView.setTableViewportWidth(content.bodyTextWidth)
            bodyView.textContainer?.size = NSSize(
                width: content.bodyTextWidth,
                height: CGFloat.greatestFiniteMagnitude
            )
            if let container = bodyView.textContainer,
               let layoutManager = bodyView.layoutManager {
                layoutManager.ensureLayout(for: container)
                measuredBodyHeight = content.body == nil
                    ? 0
                    : max(ceil(layoutManager.usedRect(for: container).height), 1)
            } else {
                measuredBodyHeight = 0
            }
            bodyView.isHidden = content.body == nil
        }
        imageHost.isHidden = false
        artifactCardsView.isHidden = content.htmlArtifacts.isEmpty
        actionHost.isHidden = false
        tableViews.forEach { $0.isHidden = false }

        bubbleBG.fillColor = content.bubbleColor
        bubbleBG.radii = content.cornerRadii

        stepsButton.isHidden = !content.canShowSteps
        stepsMaterial.isHidden = !content.canShowSteps

        imageHost.rootView = (content.inlineImages.isEmpty && content.imageRefs.isEmpty)
            ? nil
            : MacBubbleImageGrid(
                inlineImages: content.inlineImages,
                refs: content.imageRefs,
                sessionId: content.sessionId,
                maxWidth: content.bubbleWidth,
                alignment: content.kind == .user ? .trailing : .leading,
                attachmentStore: attachmentStore,
                onOpenImage: { [weak self] selection in self?.onOpenImage?(selection) }
            )

        artifactCardsView.configure(artifacts: content.htmlArtifacts) { [weak self] artifact in
            self?.onOpenHTMLArtifact?(artifact)
        }

        actionHost.rootView = content.action.map { action in
            MacBubbleActionSlot(
                action: action,
                sessionMode: sessionMode,
                onResolvePermission: { [weak self] id, tool, decision in
                    self?.onResolvePermission?(id, tool, decision)
                },
                onAnswerQuestion: { [weak self] id, answer in
                    self?.onAnswerQuestion?(id, answer)
                }
            )
        }
        if content.action != nil {
            actionHost.frame = NSRect(x: 0, y: 0, width: content.bodyTextWidth, height: 1)
            actionHost.layoutSubtreeIfNeeded()
            measuredActionHeight = max(ceil(actionHost.fittingSize.height), 1)
        } else {
            measuredActionHeight = 0
        }

        let exposesInteractiveContent = content.action != nil
            || bodyHasTables
            || !content.inlineImages.isEmpty
            || !content.imageRefs.isEmpty
            || !content.htmlArtifacts.isEmpty
        setAccessibilityElement(!exposesInteractiveContent)
        setAccessibilityRole(.group)
        if !exposesInteractiveContent {
            setAccessibilityLabel(MacMarkdown.plainText(content.body) ?? "")
        }
        needsLayout = true
    }

    /// Exact height after `configure` has already installed and laid out the
    /// TextKit body. This reuses that live layout instead of running the
    /// separate offscreen MacTextMeasure path a second time.
    func configuredHeight() -> CGFloat {
        guard let content else { return 1 }
        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        var bubbleInnerHeight = measuredBodyHeight
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += MacChatBubbleLayout.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        if measuredActionHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += measuredActionHeight
        }
        let hasBubbleContent = bubbleInnerHeight > 0
        let bubbleCellHeight = hasBubbleContent
            ? bubbleInnerHeight + MacChatBubbleLayout.msgPadV * 2 + MacChatBubbleLayout.outerV * 2
            : 0
        let imageHeight = Self.imagesHeight(content: content, width: content.bubbleWidth)
        guard imageHeight > 0 else { return max(bubbleCellHeight, 1) }
        if hasBubbleContent {
            return bubbleCellHeight + MacChatBubbleLayout.attachmentSpacing + imageHeight
        }
        return imageHeight + MacChatBubbleLayout.outerV * 2
    }

    @discardableResult
    func captureHTMLArtifactCard(to path: String) -> Bool {
        guard htmlArtifactCount > 0, !artifactCardsView.isHidden else { return false }
        artifactCardsView.layoutSubtreeIfNeeded()
        let bounds = artifactCardsView.bounds
        guard bounds.width > 1, bounds.height > 1,
              let bitmap = artifactCardsView.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        artifactCardsView.cacheDisplay(in: bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [.compressionFactor: 1]) else {
            return false
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    func openHTMLArtifact(id: String? = nil) -> Bool {
        artifactCardsView.openArtifact(id: id)
    }

    @objc private func stepsTapped() { onTapSteps?(self) }

    override func layout() {
        super.layout()
        contentClipView.frame = bounds
        guard let content else { return }
        let cellWidth = documentWidthVar > 0 ? documentWidthVar : bounds.width
        let bubbleWidth = content.bubbleWidth
        let x: CGFloat
        switch content.kind {
        case .agent:
            x = MacChatBubbleLayout.outerH
        case .user:
            x = cellWidth - MacChatBubbleLayout.outerH - bubbleWidth
        case .error, .system:
            x = (cellWidth - bubbleWidth) / 2
        }
        let y = MacChatBubbleLayout.outerV
        let innerX = x + MacChatBubbleLayout.msgPadH
        let innerWidth = content.bodyTextWidth
        var cursorY = y + MacChatBubbleLayout.msgPadV

        let bodyHeight = measuredBodyHeight
        if bodyHeight > 0 {
            let bodyFrame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: bodyHeight)
            if usesCoreTextBody {
                coreTextBodyView.frame = bodyFrame
                bodyView.frame = .zero
                syncTableViews(bodyOrigin: coreTextBodyView.frame.origin)
            } else {
                coreTextBodyView.frame = .zero
                bodyView.frame = bodyFrame
                syncTableViews(bodyOrigin: bodyView.frame.origin)
            }
            cursorY += bodyHeight
        } else {
            coreTextBodyView.frame = .zero
            bodyView.frame = .zero
            syncTableViews(bodyOrigin: .zero)
        }

        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if cursorY > y + MacChatBubbleLayout.msgPadV { cursorY += MacChatBubbleLayout.imageSpacing }
            artifactCardsView.frame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: artifactHeight)
            cursorY += artifactHeight
        } else {
            artifactCardsView.frame = .zero
        }

        let actionHeight = measuredActionHeight
        if actionHeight > 0 {
            if cursorY > y + MacChatBubbleLayout.msgPadV { cursorY += 8 }
            actionHost.frame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: actionHeight)
            cursorY += actionHeight
        } else {
            actionHost.frame = .zero
        }

        let hasBubbleContent = measuredBodyHeight > 0 || artifactHeight > 0 || actionHeight > 0
        let bubbleHeight: CGFloat
        if hasBubbleContent {
            cursorY += MacChatBubbleLayout.msgPadV
            bubbleHeight = max(cursorY - y, 1)
            bubbleBG.isHidden = false
            bubbleBG.frame = NSRect(x: x, y: y, width: bubbleWidth, height: bubbleHeight)
        } else {
            bubbleHeight = 0
            bubbleBG.isHidden = true
            bubbleBG.frame = .zero
        }

        let imageHeight = Self.imagesHeight(content: content, width: bubbleWidth)
        if imageHeight > 0 {
            let imageY = hasBubbleContent
                ? y + bubbleHeight + MacChatBubbleLayout.attachmentSpacing
                : y
            imageHost.frame = NSRect(x: x, y: imageY, width: bubbleWidth, height: imageHeight)
        } else {
            imageHost.frame = .zero
        }

        if !stepsButton.isHidden {
            let size = NSSize(width: 34, height: 20)
            let frame = NSRect(
                x: x + bubbleWidth - size.width - 8,
                y: y - size.height / 2,
                width: size.width,
                height: size.height
            )
            stepsMaterial.frame = frame
            stepsButton.frame = frame
        }
    }

    private func syncTableViews(bodyOrigin: NSPoint) {
        if usesCoreTextBody, let artifact = coreTextBodyView.artifact {
            let placements = artifact.tables
            let desiredIDs = placements.map { ObjectIdentifier($0.attachment) }
            if desiredIDs != tableAttachmentIDs {
                tableViews.forEach { $0.removeFromSuperview() }
                tableAttachmentIDs = desiredIDs
                tableViews = placements.map { placement in
                    let table = MacTableScrollView(layout: placement.attachment.tableLayout)
                    contentClipView.addSubview(table, positioned: .above, relativeTo: coreTextBodyView)
                    return table
                }
            }
            for (index, placement) in placements.enumerated() where index < tableViews.count {
                var frame = placement.frame
                frame.origin.x += bodyOrigin.x
                frame.origin.y += bodyOrigin.y
                tableViews[index].frame = frame
                tableViews[index].needsLayout = true
            }
            return
        }
        let placements = bodyView.tablePlacements()
        let desiredIDs = placements.map { ObjectIdentifier($0.attachment) }
        if desiredIDs != tableAttachmentIDs {
            tableViews.forEach { $0.removeFromSuperview() }
            tableAttachmentIDs = desiredIDs
            tableViews = placements.map { placement in
                let table = MacTableScrollView(layout: placement.attachment.tableLayout)
                contentClipView.addSubview(table, positioned: .above, relativeTo: bodyView)
                return table
            }
        }
        for (index, placement) in placements.enumerated() where index < tableViews.count {
            var frame = placement.frame
            frame.origin.x += bodyOrigin.x
            frame.origin.y += bodyOrigin.y
            tableViews[index].frame = frame
            tableViews[index].needsLayout = true
        }
    }

    static func height(
        for content: MacChatBubbleContent,
        bodyHeight: CGFloat,
        actionHeight: CGFloat = 0
    ) -> CGFloat {
        var bubbleInnerHeight = bodyHeight
        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += MacChatBubbleLayout.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        if actionHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += actionHeight
        }
        let hasBubbleContent = bubbleInnerHeight > 0
        let bubbleCellHeight = hasBubbleContent
            ? bubbleInnerHeight + MacChatBubbleLayout.msgPadV * 2 + MacChatBubbleLayout.outerV * 2
            : 0
        let imageHeight = imagesHeight(content: content, width: content.bubbleWidth)
        guard imageHeight > 0 else { return max(bubbleCellHeight, 1) }
        if hasBubbleContent {
            return bubbleCellHeight + MacChatBubbleLayout.attachmentSpacing + imageHeight
        }
        return imageHeight + MacChatBubbleLayout.outerV * 2
    }

    static func height(
        for content: MacChatBubbleContent,
        documentWidth: CGFloat,
        sessionMode: SessionMode
    ) -> CGFloat {
        let bodyHeight = bodyHeight(content)
        let actionHeight = actionHeight(
            content.action,
            width: content.bodyTextWidth,
            sessionMode: sessionMode,
            onResolvePermission: nil,
            onAnswerQuestion: nil
        )
        return height(for: content, bodyHeight: bodyHeight, actionHeight: actionHeight)
    }

    private static func bodyHeight(_ content: MacChatBubbleContent) -> CGFloat {
        content.body.map {
            MacTextMeasure.height($0, width: content.bodyTextWidth)
        } ?? 0
    }

    private static func imagesHeight(content: MacChatBubbleContent, width: CGFloat) -> CGFloat {
        MacImageGalleryLayout.height(
            inlineImages: content.inlineImages,
            refs: content.imageRefs,
            maxWidth: width
        )
    }

    private static func inlineImageHeight(_ image: NSImage, maxWidth: CGFloat) -> CGFloat {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return 0 }
        var height = min(size.width, maxWidth) * size.height / size.width
        if height > MacChatBubbleLayout.imageMaxHeight { height = MacChatBubbleLayout.imageMaxHeight }
        return height
    }

    private static func actionHeight(
        _ action: ChatMessage?,
        width: CGFloat,
        sessionMode: SessionMode,
        onResolvePermission: ((String, String?, String) -> Void)?,
        onAnswerQuestion: ((String, String) -> Void)?
    ) -> CGFloat {
        guard let action, action.type != "compaction" else { return 0 }
        let host = NSHostingView(rootView: MacBubbleActionSlot(
            action: action,
            sessionMode: sessionMode,
            onResolvePermission: onResolvePermission ?? { _, _, _ in },
            onAnswerQuestion: onAnswerQuestion ?? { _, _ in }
        ))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        return max(ceil(host.fittingSize.height), 1)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        guard let content else { return nil }
        let menu = NSMenu()
        if coreTextBodyView.hasSelection {
            let copy = NSMenuItem(
                title: "Copy Selection",
                action: #selector(MacCoreTextBodyView.copySelection(_:)),
                keyEquivalent: ""
            )
            copy.target = coreTextBodyView
            menu.addItem(copy)
        } else if let text = MacMarkdown.plainText(content.body), !text.isEmpty {
            let copy = NSMenuItem(title: "Copy", action: #selector(copyMessage), keyEquivalent: "")
            copy.target = self
            menu.addItem(copy)
        }
        if content.canShowSteps {
            let steps = NSMenuItem(title: "Show Steps", action: #selector(stepsTapped), keyEquivalent: "")
            steps.target = self
            menu.addItem(steps)
        }
        return menu.items.isEmpty ? nil : menu
    }

    @objc private func copyMessage() {
        guard let text = MacMarkdown.plainText(content?.body), !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Rounded background supporting four independent corner radii, matching the
/// iOS `TKRoundedView` path exactly.
final class MacRoundedView: NSView {
    override var isFlipped: Bool { true }
    var fillColor: NSColor = .clear { didSet { needsLayout = true } }
    var radii: (CGFloat, CGFloat, CGFloat, CGFloat) = (16, 16, 16, 16) {
        didSet { needsLayout = true }
    }
    private let shape = CAShapeLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.addSublayer(shape)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let (tl, tr, bl, br) = radii
        let r = bounds
        let path = CGMutablePath()
        path.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        path.addArc(center: CGPoint(x: r.maxX - tr, y: r.minY + tr), radius: tr,
                    startAngle: -.pi / 2, endAngle: 0, clockwise: false)
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        path.addArc(center: CGPoint(x: r.maxX - br, y: r.maxY - br), radius: br,
                    startAngle: 0, endAngle: .pi / 2, clockwise: false)
        path.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        path.addArc(center: CGPoint(x: r.minX + bl, y: r.maxY - bl), radius: bl,
                    startAngle: .pi / 2, endAngle: .pi, clockwise: false)
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        path.addArc(center: CGPoint(x: r.minX + tl, y: r.minY + tl), radius: tl,
                    startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: false)
        path.closeSubpath()

        var resolvedFill = fillColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            resolvedFill = fillColor.usingColorSpace(.deviceRGB) ?? fillColor
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.frame = bounds
        shape.path = path
        shape.fillColor = resolvedFill.cgColor
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }
}

enum MacTextMeasure {
    static func height(_ attributed: NSAttributedString, width: CGFloat) -> CGFloat {
        guard attributed.length > 0, width > 0 else { return 0 }
        let storage = NSTextStorage(attributedString: attributed)
        storage.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: storage.length)
        ) { value, _, _ in
            (value as? MacTableAttachment)?.setViewportWidth(width)
        }
        let manager = NSLayoutManager()
        storage.addLayoutManager(manager)
        let container = NSTextContainer(containerSize: NSSize(
            width: width,
            height: CGFloat.greatestFiniteMagnitude
        ))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        manager.ensureLayout(for: container)
        return ceil(manager.usedRect(for: container).height)
    }

    static func naturalWidth(_ attributed: NSAttributedString) -> CGFloat {
        guard attributed.length > 0 else { return 0 }
        // Bubble hugging only needs the widest explicit line. Using a full
        // NSLayoutManager here turned content construction into offscreen
        // TextKit layout and spawned 15–20 attributed-string agents for one
        // long user message. CoreText measures glyph advances locally without
        // creating an NSTextStorage / NSLayoutManager / NSTextContainer stack.
        let string = attributed.string as NSString
        var location = 0
        var widest: CGFloat = 0
        while location <= attributed.length {
            let remaining = NSRange(location: location, length: attributed.length - location)
            let newline = string.range(of: "\n", options: [], range: remaining)
            let end = newline.location == NSNotFound ? attributed.length : newline.location
            let range = NSRange(location: location, length: max(0, end - location))
            if range.length > 0 {
                let line = CTLineCreateWithAttributedString(attributed.attributedSubstring(from: range))
                widest = max(widest, CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
            }
            if newline.location == NSNotFound { break }
            location = newline.location + newline.length
        }
        return ceil(widest)
    }
}
#endif
