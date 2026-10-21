/// Markdown tables in Mac bubbles: layout, attachment cell, canvas/document/footer views, the scrollable table and the table window.

#if os(macOS)
import AppKit

typealias MacTableLayout = ChatTable

enum MacTableSpacing {
    /// Breathing room below a table (carried by its attachment line).
    static let below: CGFloat = 6
}

extension ChatTablePaint {
    static func current(surface: NSColor, appearance: NSAppearance) -> ChatTablePaint {
        var paint = ChatTablePaint(hairline: NSColor.clear.cgColor, headerFill: NSColor.clear.cgColor,
                                   codeFill: NSColor.clear.cgColor, surface: NSColor.clear.cgColor,
                                   highlight: NSColor.clear.cgColor, accent: NSColor.clear.cgColor)
        appearance.performAsCurrentDrawingAppearance {
            paint = ChatTablePaint(
                hairline: NSColor.labelColor.withAlphaComponent(0.13).cgColor,
                headerFill: NSColor.labelColor.withAlphaComponent(0.05).cgColor,
                codeFill: NSColor.labelColor.withAlphaComponent(0.08).cgColor,
                surface: surface.cgColor,
                highlight: NSColor.systemYellow.withAlphaComponent(0.22).cgColor,
                accent: NSColor.systemYellow.withAlphaComponent(0.48).cgColor
            )
        }
        return paint
    }
}

private final class MacTableAttachmentCell: NSTextAttachmentCell {
    let tableLayout: ChatTable
    var viewportWidth: CGFloat = 1

    init(layout: ChatTable) {
        tableLayout = layout
        super.init(textCell: "")
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var cellSize: NSSize {
        NSSize(width: max(1, viewportWidth),
               height: tableLayout.bubbleHeight(width: max(1, viewportWidth)) + MacTableSpacing.below)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {}
}

final class MacTableAttachment: NSTextAttachment {
    let tableLayout: ChatTable
    private let sizingCell: MacTableAttachmentCell

    init(rows: [[String]], alignments: [TableAlignment]) {
        let layout = ChatTable(rows: rows, alignments: alignments)
        tableLayout = layout
        sizingCell = MacTableAttachmentCell(layout: layout)
        super.init(data: nil, ofType: nil)
        attachmentCell = sizingCell
        sizingCell.attachment = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setViewportWidth(_ width: CGFloat) {
        sizingCell.viewportWidth = max(1, width)
    }
}

/// Draws the visible part of the table at the scroll view's viewport, so the
/// pinned first column and sticky header are simply drawn at its edges.
private final class MacTableCanvasView: NSView {
    weak var host: MacTableScrollView?
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let host, let geometry = host.geometry, let context = NSGraphicsContext.current?.cgContext else { return }
        let paint = ChatTablePaint.current(surface: host.surfaceColor, appearance: effectiveAppearance)
        if geometry.mode == .cards {
            geometry.drawCards(in: context, paint: paint)
            return
        }
        let visible = host.contentView.bounds
        geometry.drawGrid(in: context, viewport: CGRect(x: visible.minX, y: visible.minY, width: bounds.width, height: bounds.height),
                          rowLimit: host.fullTable ? geometry.rowHeights.count : geometry.previewRowCount,
                          stickyHeader: host.fullTable, paint: paint,
                          highlightedRows: host.highlightedRows, currentRow: host.currentRow)
    }
}

/// Sized like the table content; receives clicks in content coordinates.
private final class MacTableDocumentView: NSView {
    weak var host: MacTableScrollView?
    override var isFlipped: Bool { true }
    private var resizing: (column: Int, startX: CGFloat, startWidth: CGFloat)?

    override func resetCursorRects() {
        guard let host, host.fullTable, let geometry = host.geometry, geometry.mode == .grid else { return }
        let visible = host.contentView.bounds
        for column in geometry.columnOrigins.indices {
            let edge = geometry.columnOrigins[column] + geometry.columnWidths[column]
            addCursorRect(NSRect(x: edge - 3, y: visible.minY, width: 6, height: geometry.headerHeight), cursor: .resizeLeftRight)
        }
    }

    private func resizeColumn(at point: NSPoint) -> Int? {
        guard let host, host.fullTable, let geometry = host.geometry, geometry.mode == .grid else { return nil }
        let visible = host.contentView.bounds
        guard point.y >= visible.minY, point.y < visible.minY + geometry.headerHeight else { return nil }
        return geometry.columnOrigins.indices.first { column in
            abs(point.x - (geometry.columnOrigins[column] + geometry.columnWidths[column])) <= 3
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let column = resizeColumn(at: point), let geometry = host?.geometry {
            resizing = (column, point.x, geometry.columnWidths[column])
            return
        }
        if event.clickCount == 2, let host, !host.fullTable {
            host.openFullTable()
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let resizing, let host else { return }
        let point = convert(event.locationInWindow, from: nil)
        host.setColumnWidth(resizing.column, width: resizing.startWidth + point.x - resizing.startX)
    }

    override func mouseUp(with event: NSEvent) {
        if resizing != nil {
            resizing = nil
            window?.invalidateCursorRects(for: self)
            return
        }
        guard event.clickCount == 1, let host, let geometry = host.geometry else { return }
        let point = convert(event.locationInWindow, from: nil)
        let visible = host.contentView.bounds
        if geometry.mode == .grid, host.fullTable,
           let hit = geometry.gridCell(at: point, viewportMinX: visible.minX, viewportMinY: visible.minY, stickyHeader: true),
           hit.row < 0 {
            host.sort(by: hit.column)
            return
        }
        if let url = geometry.link(at: point, viewportMinX: visible.minX, viewportMinY: visible.minY, stickyHeader: host.fullTable) {
            if isSafeLinkURL(url) { NSWorkspace.shared.open(url) }
        } else if geometry.mode == .cards, geometry.hiddenCardFields > 0 {
            host.openFullTable()
        }
    }
}

private final class MacTableFooterView: NSView {
    let label = NSTextField(labelWithString: "")
    let button = NSButton(title: String(localized: "Open table"), target: nil, action: nil)
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingTail
        button.isBordered = false
        button.font = .systemFont(ofSize: 12, weight: .semibold)
        button.contentTintColor = .linkColor
        button.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        button.imagePosition = .imageTrailing
        addSubview(label)
        addSubview(button)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        button.sizeToFit()
        button.frame.origin = NSPoint(x: bounds.width - button.frame.width - ChatTableStyle.padH,
                                      y: (bounds.height - button.frame.height) / 2)
        label.sizeToFit()
        label.frame = NSRect(x: ChatTableStyle.padH, y: (bounds.height - label.frame.height) / 2,
                             width: max(0, button.frame.minX - ChatTableStyle.padH - 6), height: label.frame.height)
    }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.04).cgColor
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.13).setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 0.5).fill()
    }
    override var wantsUpdateLayer: Bool { false }
}

/// One table in a bubble (preview) or in the table window (full). Grid
/// previews scroll sideways with the first column pinned; vertical wheel
/// gestures go to the conversation. The full table scrolls both ways with a
/// sticky header, sorts by header click and resizes columns by dragging.
final class MacTableScrollView: NSScrollView, NSMenuItemValidation {
    private enum WheelAxis { case horizontal, vertical }

    #if DEBUG
    private(set) var debugLastWheelRoute = "none"
    var debugHasEnclosingChatScrollView: Bool { enclosingChatScrollView != nil }
    static var debugInstanceCount = 0
    #endif

    private(set) var tableLayout: ChatTable
    let fullTable: Bool
    var surfaceColor: NSColor = .windowBackgroundColor { didSet { canvas.needsDisplay = true } }
    var highlightedRows: Set<Int> = [] { didSet { canvas.needsDisplay = true } }
    var currentRow: Int? { didSet { canvas.needsDisplay = true } }
    var onSort: ((ChatTable) -> Void)?
    private(set) var geometry: ChatTableGeometry?
    private var columnOverrides: [Int: CGFloat] = [:]
    private var wheelAxis: WheelAxis?
    private let document = MacTableDocumentView()
    private let canvas = MacTableCanvasView()
    private let footer = MacTableFooterView()
    private let fadeView = NSView()
    private let fade = CAGradientLayer()

    init(layout: ChatTable, fullTable: Bool = false) {
        #if DEBUG
        Self.debugInstanceCount += 1
        #endif
        tableLayout = layout
        self.fullTable = fullTable
        super.init(frame: .zero)
        drawsBackground = false
        borderType = .noBorder
        hasHorizontalScroller = true
        hasVerticalScroller = fullTable
        autohidesScrollers = true
        scrollerStyle = .overlay
        horizontalScrollElasticity = .none
        verticalScrollElasticity = fullTable ? .automatic : .none
        contentView.postsBoundsChangedNotifications = true
        document.host = self
        canvas.host = self
        documentView = document
        addSubview(canvas)
        fadeView.wantsLayer = true
        fadeView.layer?.addSublayer(fade)
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        addSubview(fadeView)
        footer.button.target = self
        footer.button.action = #selector(showAllRows)
        addSubview(footer)
        wantsLayer = true
        if !fullTable {
            layer?.cornerRadius = ChatTableStyle.cornerRadius
            layer?.cornerCurve = .continuous
            layer?.masksToBounds = true
            layer?.borderWidth = 1
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.table)
        setAccessibilityLabel(String(localized: "Table, \(layout.bodyRowCount) rows, \(layout.columnCount) columns"))
        setAccessibilityValue(layout.semanticText())
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func replaceTable(_ table: ChatTable) {
        tableLayout = table
        geometry = nil
        setAccessibilityValue(table.semanticText())
        needsLayout = true
        canvas.needsDisplay = true
    }

    func setColumnWidth(_ column: Int, width: CGFloat) {
        columnOverrides[column] = width
        geometry = nil
        needsLayout = true
        layoutSubtreeIfNeeded()
        canvas.needsDisplay = true
    }

    func sort(by column: Int) {
        let next: ChatTable
        if tableLayout.sortColumn == column {
            next = tableLayout.sortAscending ? tableLayout.sorted(by: column, ascending: false)
                : tableLayout.sorted(by: nil, ascending: true)
        } else {
            next = tableLayout.sorted(by: column, ascending: !tableLayout.numeric[column])
        }
        replaceTable(next)
        onSort?(next)
    }

    func scrollToRow(_ row: Int) {
        guard let geometry, row < geometry.rowOrigins.count else { return }
        let visible = contentView.bounds
        let top = geometry.rowOrigins[row] - geometry.headerHeight
        let bottom = geometry.rowOrigins[row] + geometry.rowHeights[row]
        guard top < visible.minY || bottom > visible.maxY else { return }
        contentView.scroll(to: NSPoint(x: visible.minX, y: max(0, top - visible.height / 3)))
        reflectScrolledClipView(contentView)
    }

    override func layout() {
        super.layout()
        guard bounds.width > 1 else { return }
        if geometry?.width != bounds.width {
            geometry = tableLayout.geometry(width: bounds.width, full: fullTable, columnOverrides: columnOverrides)
            canvas.needsDisplay = true
        }
        guard let geometry else { return }
        let cards = geometry.mode == .cards
        let gridHeight = fullTable ? bounds.height : (cards ? geometry.bubbleHeight - 2 : geometry.previewGridHeight)
        let documentSize = NSSize(width: cards ? bounds.width : geometry.contentWidth,
                                  height: fullTable ? geometry.fullHeight : gridHeight)
        if document.frame.size != documentSize { document.setFrameSize(documentSize) }
        footer.isHidden = !geometry.showsFooter
        footer.label.stringValue = geometry.footerText
        let needsScroller = documentSize.width > bounds.width + 1
        if hasHorizontalScroller != needsScroller { hasHorizontalScroller = needsScroller }
        tile()
        window?.invalidateCursorRects(for: document)
    }

    private var isTiling = false

    override func tile() {
        guard !isTiling else { return }
        isTiling = true
        defer { isTiling = false }
        super.tile()
        guard let geometry else { return }
        let footerHeight = geometry.showsFooter ? ChatTableStyle.footerHeight : 0
        // NSScrollView is flipped: the grid sits on top, the footer below it.
        let gridHeight = max(0, bounds.height - footerHeight)
        let gridFrame = NSRect(x: 0, y: 0, width: bounds.width, height: gridHeight)
        contentView.frame = gridFrame
        canvas.frame = gridFrame
        footer.frame = NSRect(x: 0, y: gridHeight, width: bounds.width, height: footerHeight)
        if let scroller = horizontalScroller {
            scroller.frame.origin.y = gridHeight - scroller.frame.height
        }
        updateFade()
    }

    private func updateFade() {
        guard let geometry else { return }
        let maximum = max(0, document.frame.width - contentView.bounds.width)
        let shows = geometry.mode == .grid && maximum > 1 && contentView.bounds.minX < maximum - 1
        fadeView.isHidden = !shows
        guard shows else { return }
        fadeView.frame = NSRect(x: bounds.width - 28, y: contentView.frame.minY, width: 28, height: contentView.frame.height)
        fade.frame = fadeView.bounds
        var surface = surfaceColor.cgColor
        var clear = surfaceColor.withAlphaComponent(0).cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            surface = surfaceColor.cgColor
            clear = surfaceColor.withAlphaComponent(0).cgColor
        }
        fade.colors = [clear, surface]
    }

    override func updateLayer() {
        super.updateLayer()
        if !fullTable { layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.16).cgColor }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.16).cgColor
        }
        updateFade()
        canvas.needsDisplay = true
        footer.needsDisplay = true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        viewDidChangeEffectiveAppearance()
    }

    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        canvas.needsDisplay = true
        updateFade()
    }

    override func scrollWheel(with event: NSEvent) {
        guard !fullTable else {
            #if DEBUG
            debugLastWheelRoute = "full-table"
            #endif
            super.scrollWheel(with: event)
            return
        }

        let continuousGesture = event.phase != [] || event.momentumPhase != []
        if !continuousGesture || event.phase.contains(.began) || event.momentumPhase.contains(.began) {
            wheelAxis = nil
        }
        if wheelAxis == nil {
            let horizontalIntent = event.modifierFlags.contains(.shift)
                || abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
            wheelAxis = horizontalIntent ? .horizontal : .vertical
        }

        if wheelAxis == .horizontal {
            #if DEBUG
            debugLastWheelRoute = "horizontal"
            #endif
            super.scrollWheel(with: event)
        } else if let chatScrollView = enclosingChatScrollView {
            #if DEBUG
            debugLastWheelRoute = "chat"
            #endif
            chatScrollView.scrollWheel(with: event)
        } else {
            #if DEBUG
            debugLastWheelRoute = "responder"
            #endif
            nextResponder?.scrollWheel(with: event)
        }

        if event.phase.contains(.ended) || event.phase.contains(.cancelled)
            || event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) {
            wheelAxis = nil
        }
    }

    private var enclosingChatScrollView: MacChatScrollView? {
        var candidate = superview
        while let view = candidate {
            if let chat = view as? MacChatScrollView { return chat }
            candidate = view.superview
        }
        return nil
    }

    // MARK: Menu / copy

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        let markdown = NSMenuItem(title: String(localized: "Copy Table"), action: #selector(copyMarkdown), keyEquivalent: "")
        markdown.target = self
        let tsv = NSMenuItem(title: String(localized: "Copy as TSV"), action: #selector(copyTSV), keyEquivalent: "")
        tsv.target = self
        menu.addItem(markdown)
        menu.addItem(tsv)
        if !fullTable {
            menu.addItem(.separator())
            let open = NSMenuItem(title: String(localized: "Open Table in Window"), action: #selector(showAllRows), keyEquivalent: "")
            open.target = self
            menu.addItem(open)
        }
        return menu
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { true }

    @objc func copyMarkdown() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(tableLayout.markdown(), forType: .string)
    }

    @objc func copyTSV() {
        NSPasteboard.general.clearContents()
        let tsv = tableLayout.tsv()
        NSPasteboard.general.setString(tsv, forType: .string)
        NSPasteboard.general.setString(tsv, forType: NSPasteboard.PasteboardType("public.utf8-tab-separated-values-text"))
    }

    @objc private func showAllRows() { openFullTable() }

    func openFullTable() {
        MacTableWindowController.show(tableLayout)
    }
}

/// The full table in its own resizable window, beside the conversation.
final class MacTableWindowController: NSWindowController, NSWindowDelegate, NSSearchFieldDelegate {
    private static var open: [MacTableWindowController] = []
    private var table: ChatTable
    private let scrollView: MacTableScrollView
    private let search = NSSearchField()
    private let matchLabel = NSTextField(labelWithString: "")
    private var matches: [Int] = []
    private var matchIndex = 0

    static func show(_ table: ChatTable) {
        if let existing = open.first(where: { $0.table.contentKey == table.contentKey }) {
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        let controller = MacTableWindowController(table: table)
        open.append(controller)
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
    }

    private init(table: ChatTable) {
        self.table = table
        scrollView = MacTableScrollView(layout: table, fullTable: true)
        let natural = min(max(table.naturalWidth + 2, 560), 1_200)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: natural, height: 600),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = String(localized: "Table")
        window.minSize = NSSize(width: 420, height: 260)
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
        buildContent()
        updateSubtitle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func buildContent() {
        guard let window else { return }
        let root = NSView()
        search.placeholderString = String(localized: "Search")
        search.delegate = self
        search.target = self
        search.action = #selector(searchSubmitted)
        search.sendsWholeSearchString = false
        matchLabel.font = .systemFont(ofSize: 12)
        matchLabel.textColor = .secondaryLabelColor
        let copyMarkdown = NSButton(title: String(localized: "Copy Markdown"), target: scrollView, action: #selector(MacTableScrollView.copyMarkdown))
        let copyTSV = NSButton(title: String(localized: "Copy TSV"), target: scrollView, action: #selector(MacTableScrollView.copyTSV))
        [copyMarkdown, copyTSV].forEach { $0.bezelStyle = .rounded; $0.controlSize = .regular }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bar = NSStackView(views: [search, matchLabel, spacer, copyMarkdown, copyTSV])
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        search.widthAnchor.constraint(equalToConstant: 220).isActive = true

        let hint = NSTextField(labelWithString: String(localized: "Click a header to sort · Drag a column edge to resize · ⌘C copies the table"))
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .tertiaryLabelColor

        let separator = NSBox()
        separator.boxType = .separator
        scrollView.surfaceColor = .windowBackgroundColor
        scrollView.onSort = { [weak self] sorted in
            self?.table = sorted
            self?.updateSubtitle()
            self?.runSearch(scroll: false)
        }
        let bottomSeparator = NSBox()
        bottomSeparator.boxType = .separator
        for view in [bar, separator, scrollView, bottomSeparator, hint] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            separator.topAnchor.constraint(equalTo: bar.bottomAnchor),
            separator.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: separator.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -26),
            bottomSeparator.topAnchor.constraint(equalTo: scrollView.bottomAnchor),
            bottomSeparator.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bottomSeparator.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            hint.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            hint.centerYAnchor.constraint(equalTo: root.bottomAnchor, constant: -13),
        ])
        window.contentView = root
    }

    private func updateSubtitle() {
        if let column = table.sortColumn {
            window?.subtitle = String(localized: "\(table.bodyRowCount) rows × \(table.columnCount) columns · sorted by \(table.plainHeader[column])")
        } else {
            window?.subtitle = String(localized: "\(table.bodyRowCount) rows × \(table.columnCount) columns")
        }
    }

    func controlTextDidChange(_ obj: Notification) { runSearch(scroll: true) }

    @objc private func searchSubmitted() {
        guard !matches.isEmpty else { return }
        matchIndex = (matchIndex + 1) % matches.count
        showMatch()
    }

    private func runSearch(scroll: Bool) {
        let query = search.stringValue.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            matches = []
            scrollView.highlightedRows = []
            scrollView.currentRow = nil
            matchLabel.stringValue = ""
            return
        }
        matches = table.plainBody.indices.filter { row in
            table.plainBody[row].contains { $0.localizedCaseInsensitiveContains(query) }
        }
        matchIndex = 0
        scrollView.highlightedRows = Set(matches)
        showMatch(scroll: scroll)
    }

    private func showMatch(scroll: Bool = true) {
        guard !matches.isEmpty else {
            scrollView.currentRow = nil
            matchLabel.stringValue = String(localized: "No matches")
            return
        }
        scrollView.currentRow = matches[matchIndex]
        matchLabel.stringValue = String(localized: "\(matchIndex + 1) of \(matches.count)")
        if scroll { scrollView.scrollToRow(matches[matchIndex]) }
    }

    /// ⌘C copies the whole table (TSV pastes as columns in spreadsheets).
    @objc func copy(_ sender: Any?) {
        if let editor = window?.firstResponder as? NSText, editor.selectedRange.length > 0 {
            editor.copy(sender)
            return
        }
        scrollView.copyTSV()
    }

    func windowWillClose(_ notification: Notification) {
        Self.open.removeAll { $0 === self }
    }
}
#endif
