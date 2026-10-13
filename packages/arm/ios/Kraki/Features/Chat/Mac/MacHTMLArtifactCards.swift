/// HTML artifact cards under a Mac bubble: one button per report/page, laid out as cards.

#if os(macOS)
import AppKit

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
            accessibilityDescription: "Report"
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
        let displayTitle = [artifact.caption, artifact.name]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "Report"
        titleLabel.stringValue = displayTitle
        detailLabel.stringValue = "Report · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Open report \(displayTitle)")
        toolTip = MacControlHelp.report(displayTitle)
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

final class MacHTMLArtifactCardsView: NSView {
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
#endif
