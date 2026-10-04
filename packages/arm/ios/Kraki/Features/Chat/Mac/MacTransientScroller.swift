#if os(macOS)
import AppKit

/// Keep NSScroller's native tracking, geometry, target/action and accessibility,
/// but draw the knob ourselves. AppKit's overlay skin has its own flash/fade
/// clock, which would otherwise hide the knob before our shared idle deadline.
class MacTransientScroller: NSScroller {
    var onHoverChanged: ((Bool) -> Void)?
    var onTrackingChanged: ((Bool) -> Void)?
    var onDetached: (() -> Void)?
    private var hoverArea: NSTrackingArea?
    private var hovered = false

    override class var isCompatibleWithOverlayScrollers: Bool { true }
    // NSScroller normally uses updateLayer, bypassing draw(_:) entirely.
    override var wantsUpdateLayer: Bool { false }
    override var doubleValue: Double { didSet { invalidateKnob() } }
    override var knobProportion: CGFloat { didSet { invalidateKnob() } }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        invalidateKnob()
    }

    func invalidateKnob() {
        // NSScroller's needsDisplay setter services its native overlay skin;
        // explicitly invalidate the backing contents used by our draw(_:) too.
        setNeedsDisplay(bounds)
        layer?.setNeedsDisplay()
    }

    override func draw(_ dirtyRect: NSRect) { drawKnob() }
    override func drawKnob() {
        guard knobProportion < 1 else { return }
        let native = rect(for: .knob)
        guard !native.isEmpty else { return }
        let width: CGFloat = hovered ? 6 : 4
        let knob = CGRect(x: native.midX - width / 2, y: native.minY, width: width, height: native.height)
        NSColor.secondaryLabelColor.withAlphaComponent(0.65).setFill()
        NSBezierPath(roundedRect: knob, xRadius: width / 2, yRadius: width / 2).fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); hoverArea = area
    }
    override func mouseEntered(with event: NSEvent) {
        hovered = true; invalidateKnob(); onHoverChanged?(true)
    }
    override func mouseExited(with event: NSEvent) {
        hovered = false; invalidateKnob(); onHoverChanged?(false)
    }
    override func mouseDown(with event: NSEvent) {
        onTrackingChanged?(true)
        defer { onTrackingChanged?(false) }
        super.mouseDown(with: event)
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard knobProportion < 1 else { return nil }
        let opacity = layer?.presentation()?.opacity ?? Float(alphaValue)
        return opacity > 0.01 ? super.hitTest(point) : nil
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hovered = false; onDetached?() }
    }
}
#endif
