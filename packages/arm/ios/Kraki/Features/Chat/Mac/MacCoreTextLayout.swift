/// CoreText layout and drawing for Mac bubbles: the layout artifact (lines, runs, tables), the body view, and text measuring.

#if os(macOS)
import AppKit

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
        let built = MacChatCost.measure(Thread.isMainThread ? "ctArtifact(main)" : "ctArtifact(bg)") {
            MacCoreTextLayoutArtifact(attributed: attributed, width: width)
        }
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
                ascent: attachment.tableLayout.bubbleHeight(width: width) + MacTableSpacing.below
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
                    height: attachment.tableLayout.bubbleHeight(width: width)
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
        MacChatCost.measure("ctDraw") { drawBody(dirtyRect) }
    }

    private func drawBody(_ dirtyRect: NSRect) {
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
                    MacCTText.draw(label, attributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                        .foregroundColor: NSColor(srgbRed: 0xA1/255, green: 0xA1/255, blue: 0xAA/255, alpha: 1),
                    ], at: NSPoint(x: frame.minX + 12, y: frame.minY + 5))
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
        if let pendingLink, !didDragSelection, !hasSelection, isSafeLinkURL(pendingLink) {
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
