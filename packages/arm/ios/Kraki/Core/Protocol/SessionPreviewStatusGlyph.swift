import SwiftUI
#if os(macOS)
import AppKit
typealias PreviewPlatformView = NSView
#else
import UIKit
typealias PreviewPlatformView = UIView
#endif

struct SessionPreviewStatusGlyph: View {
    let kind: SessionPreviewGlyphKind
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var appeared = false

    private var color: Color {
        switch kind {
        case .delivery(.failed): return .red
        case .delivery(.queued): return .textMuted
        default: return .krakiPrimary
        }
    }

    var body: some View {
        PreviewGlyphRepresentable(kind: kind, color: color,
                                  enabled: appeared && scenePhase != .background && !reduceMotion)
            .frame(width: 16, height: 16)
            .onAppear { appeared = true }
            .onDisappear { appeared = false }
            .allowsHitTesting(false) // decorative; row navigation owns every click
            .accessibilityHidden(true) // the preview row exposes the full status + text
    }
}

/// Visibility reconciliation is deliberately low frequency (not an animation
/// driver). It covers retained/reused list cells and hidden/occluded windows,
/// without observing per-frame scroll offsets or invalidating SwiftUI layout.
final class PreviewGlyphHost: PreviewPlatformView {
    let renderer = SessionPreviewGlyphLayer()
    private var kind: SessionPreviewGlyphKind = .compacting
    private var color: CGColor = CGColor(gray: 0, alpha: 1)
    private var image: CGImage?
    private var imageKey = ""
    private var enabled = false
    private var visibilityTimer: Timer?

    #if os(macOS)
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.addSublayer(renderer)
    }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); reconcile() }
    override func layout() { super.layout(); reconcile() }
    #else
    override init(frame: CGRect) { super.init(frame: frame); layer.addSublayer(renderer) }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    override func didMoveToWindow() { super.didMoveToWindow(); reconcile() }
    override func layoutSubviews() { super.layoutSubviews(); reconcile() }
    #endif
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { visibilityTimer?.invalidate() }

    func configure(kind: SessionPreviewGlyphKind, color: CGColor, enabled: Bool) {
        self.kind = kind; self.color = color; self.enabled = enabled
        reconcile()
    }

    private var displayScale: CGFloat {
        #if os(macOS)
        window?.backingScaleFactor ?? 2
        #else
        window?.screen.scale ?? 2
        #endif
    }

    private var visible: Bool {
        guard let window, !isHidden, !bounds.isEmpty else { return false }
        #if os(macOS)
        guard let content = window.contentView else { return false }
        let inWindow = convert(bounds, to: nil).intersection(content.convert(content.bounds, to: nil))
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
            && !isHiddenOrHasHiddenAncestor && !visibleRect.isEmpty && !inWindow.isEmpty && !inWindow.isNull
        #else
        guard !window.isHidden, alpha > 0 else { return false }
        var rect = convert(bounds, to: window).intersection(window.bounds)
        var ancestor = superview
        while let view = ancestor {
            if view.isHidden || view.alpha == 0 { return false }
            if view.clipsToBounds { rect = rect.intersection(view.convert(view.bounds, to: window)) }
            ancestor = view.superview
        }
        return !rect.isNull && !rect.isEmpty
        #endif
    }

    private func reconcile() {
        let scale = displayScale
        if kind != .compacting {
            let key = "\(scale):\(String(describing: color.colorSpace?.name)):\(color.components ?? [])"
            if imageKey != key {
                let symbol = Image(systemName: "tray.and.arrow.up")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(Color(cgColor: color))
                    .frame(width: 16, height: 16)
                let raster = ImageRenderer(content: symbol)
                raster.scale = scale
                image = raster.cgImage
                imageKey = key
            }
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        renderer.frame = CGRect(x: (bounds.width-16)/2, y: (bounds.height-16)/2, width: 16, height: 16)
        CATransaction.commit()
        renderer.configure(kind: kind, color: color, image: kind == .compacting ? nil : image,
                           displayScale: scale, animate: enabled && visible)
        if window != nil && enabled && kind.animates {
            if visibilityTimer == nil {
                let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.reconcile() }
                RunLoop.main.add(timer, forMode: .common)
                visibilityTimer = timer
            }
        } else {
            visibilityTimer?.invalidate(); visibilityTimer = nil
        }
    }
}

#if os(macOS)
private struct PreviewGlyphRepresentable: NSViewRepresentable {
    let kind: SessionPreviewGlyphKind
    let color: Color
    let enabled: Bool
    func makeNSView(context: Context) -> PreviewGlyphHost { PreviewGlyphHost(frame: .zero) }
    func updateNSView(_ view: PreviewGlyphHost, context: Context) {
        view.configure(kind: kind, color: color.resolve(in: context.environment).cgColor, enabled: enabled)
    }
    static func dismantleNSView(_ view: PreviewGlyphHost, coordinator: ()) {
        view.configure(kind: .compacting, color: CGColor(gray: 0, alpha: 0), enabled: false)
    }
}
#else
private struct PreviewGlyphRepresentable: UIViewRepresentable {
    let kind: SessionPreviewGlyphKind
    let color: Color
    let enabled: Bool
    func makeUIView(context: Context) -> PreviewGlyphHost { PreviewGlyphHost(frame: .zero) }
    func updateUIView(_ view: PreviewGlyphHost, context: Context) {
        view.configure(kind: kind, color: color.resolve(in: context.environment).cgColor, enabled: enabled)
    }
    static func dismantleUIView(_ view: PreviewGlyphHost, coordinator: ()) {
        view.configure(kind: .compacting, color: CGColor(gray: 0, alpha: 0), enabled: false)
    }
}
#endif
