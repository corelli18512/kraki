/// MacSessionActivityDots — the sidebar's animated active-work indicator
/// (moved out of SessionsSidebarView+macOS.swift).

#if os(macOS)
import AppKit
import SwiftUI

/// Core Animation owns the repeating frames so active rows do not invalidate
/// SwiftUI's Session list on every animation tick.
struct MacSessionActivityDots: NSViewRepresentable {
    let color: NSColor
    let reduceMotion: Bool

    func makeNSView(context: Context) -> MacSessionActivityDotsView {
        MacSessionActivityDotsView()
    }

    func updateNSView(_ nsView: MacSessionActivityDotsView, context: Context) {
        nsView.configure(color: color, reduceMotion: reduceMotion)
    }
}

final class MacSessionActivityDotsView: NSView, VisibilityTickClient {
    private let dotLayers: [CALayer] = (0..<3).map { _ in CALayer() }
    private var reduceMotion = false
    private weak var observedClipView: NSClipView?
    private var clipBoundsObserver: NSObjectProtocol?
    private var ticking = false
    private var wasVisibleInClip = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = false
        for dot in dotLayers {
            dot.cornerRadius = 1.5
            layer?.addSublayer(dot)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        if let clipBoundsObserver {
            NotificationCenter.default.removeObserver(clipBoundsObserver)
        }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 14, height: 14) }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        refreshClipObservation()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshClipObservation()
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, dot) in dotLayers.enumerated() {
            dot.frame = CGRect(x: CGFloat(index) * 5.5, y: 5.5, width: 3, height: 3)
        }
        CATransaction.commit()
    }

    private var dotColor: NSColor?

    /// `NSColor.cgColor` resolves a dynamic colour against the *current drawing*
    /// appearance (the system's), not this view's. Resolve under the view's
    /// effective appearance so the in-app Dark theme gets the dark brand blue.
    private func applyDotColor() {
        guard let dotColor else { return }
        var resolved = dotColor.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { resolved = dotColor.cgColor }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for dot in dotLayers {
            dot.backgroundColor = resolved
        }
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyDotColor()
    }

    func configure(color: NSColor, reduceMotion: Bool) {
        dotColor = color
        applyDotColor()

        let reduceMotionChanged = self.reduceMotion != reduceMotion
        self.reduceMotion = reduceMotion
        refreshClipObservation()
        guard reduceMotionChanged || dotLayers[0].animation(forKey: "thinking") == nil else {
            return
        }
        installAnimations()
    }

    private func refreshClipObservation() {
        let clipView = enclosingScrollView?.contentView
        if clipView !== observedClipView {
            if let clipBoundsObserver {
                NotificationCenter.default.removeObserver(clipBoundsObserver)
            }
            clipBoundsObserver = nil
            observedClipView = clipView
            wasVisibleInClip = false

            if let clipView {
                clipView.postsBoundsChangedNotifications = true
                clipBoundsObserver = NotificationCenter.default.addObserver(
                    forName: NSView.boundsDidChangeNotification,
                    object: clipView,
                    queue: .main
                ) { [weak self] _ in
                    self?.updateViewportVisibility()
                }
            }
        }
        updateVisibilityTimer()
        updateViewportVisibility()
    }

    private func updateVisibilityTimer() {
        let wantsTick = window != nil && observedClipView != nil
        guard wantsTick != ticking else { return }
        ticking = wantsTick
        if wantsTick { VisibilityTicker.shared.add(self) } else { VisibilityTicker.shared.remove(self) }
    }

    func visibilityTick() { updateViewportVisibility() }

    private func updateViewportVisibility() {
        let isVisible = window != nil && observedClipView != nil && !visibleRect.isEmpty
        defer { wasVisibleInClip = isVisible }
        guard isVisible, !wasVisibleInClip else { return }
        // SwiftUI keeps lazy sidebar rows alive while they are off-screen.
        // AppKit/Core Animation may stop or evict a detached presentation
        // timeline without causing `updateNSView` to run when the row returns.
        // Reinstall on the actual viewport transition even if the model layer
        // still reports the old animation key.
        installAnimations()
    }

    private func installAnimations() {
        for (index, dot) in dotLayers.enumerated() {
            dot.removeAnimation(forKey: "thinking")
            if reduceMotion {
                dot.opacity = Float(0.48 + Double(index) * 0.2)
                dot.transform = CATransform3DIdentity
                continue
            }

            dot.opacity = 0.36
            let opacity = CAKeyframeAnimation(keyPath: "opacity")
            opacity.values = [0.36, 1.0, 0.36]
            opacity.keyTimes = [0, 0.5, 1]

            let scale = CAKeyframeAnimation(keyPath: "transform.scale")
            scale.values = [0.72, 1.0, 0.72]
            scale.keyTimes = [0, 0.5, 1]

            let group = CAAnimationGroup()
            group.animations = [opacity, scale]
            group.duration = 1.2
            group.repeatCount = .infinity
            group.beginTime = dot.convertTime(CACurrentMediaTime(), from: nil) + Double(index) * 0.16
            group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.add(group, forKey: "thinking")
        }
    }

    #if DEBUG
    var debugHasAnimations: Bool {
        dotLayers.allSatisfy { $0.animation(forKey: "thinking") != nil }
    }

    var debugVisibilityState: [String: Any] {
        [
            "hasClip": observedClipView != nil,
            "wasVisible": wasVisibleInClip,
            "visibleRectEmpty": visibleRect.isEmpty,
        ]
    }

    var debugPresentationOpacities: [Float] {
        dotLayers.map { $0.presentation()?.opacity ?? $0.opacity }
    }

    func debugEvictAnimations() {
        dotLayers.forEach { $0.removeAnimation(forKey: "thinking") }
    }
    #endif
}

#if DEBUG
@MainActor
enum MacSessionActivityDotsRegression {
    private struct ListView: View {
        var body: some View {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(0..<80, id: \.self) { index in
                        HStack(spacing: 8) {
                            if index == 0 {
                                MacSessionActivityDots(color: .systemBlue, reduceMotion: false)
                                    .frame(width: 14, height: 14)
                            } else {
                                Color.clear.frame(width: 14, height: 14)
                            }
                            Text("Session \(index)")
                            Spacer(minLength: 0)
                        }
                        .frame(height: 48)
                        .padding(.horizontal, 8)
                    }
                }
            }
            .frame(width: 260, height: 180)
        }
    }

    static func run(completion: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            completion(await result())
        }
    }

    private static func result() async -> [String: Any] {
        let size = NSSize(width: 260, height: 180)
        let host = NSHostingView(rootView: ListView())
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFrontRegardless()
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        host.display()

        try? await Task.sleep(nanoseconds: 250_000_000)
        guard let scrollView = firstView(NSScrollView.self, in: host),
              let initialDots = firstView(MacSessionActivityDotsView.self, in: host),
              let documentView = scrollView.documentView else {
            return ["passed": false, "error": "missing scroll view or activity dots"]
        }

        let initialBefore = initialDots.debugPresentationOpacities
        try? await Task.sleep(nanoseconds: 180_000_000)
        let initialAfter = initialDots.debugPresentationOpacities
        let initialMoving = moved(initialBefore, initialAfter)
        let maximumY = max(0, documentView.frame.height - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: maximumY))
        scrollView.reflectScrolledClipView(scrollView.contentView)

        try? await Task.sleep(nanoseconds: 180_000_000)
        let offscreen = initialDots.visibleRect.isEmpty
        initialDots.debugEvictAnimations()
        let evicted = !initialDots.debugHasAnimations
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)

        try? await Task.sleep(nanoseconds: 200_000_000)
        guard let returnedDots = firstView(MacSessionActivityDotsView.self, in: host) else {
            return ["passed": false, "error": "activity dots did not return"]
        }
        let returnedBefore = returnedDots.debugPresentationOpacities
        try? await Task.sleep(nanoseconds: 180_000_000)
        let returnedAfter = returnedDots.debugPresentationOpacities
        let returnedMoving = moved(returnedBefore, returnedAfter)
        let restoredAnimations = returnedDots.debugHasAnimations
        let reusedView = returnedDots === initialDots
        return [
            "passed": initialMoving && offscreen && evicted && restoredAnimations && returnedMoving,
            "initialMoving": initialMoving,
            "offscreen": offscreen,
            "evicted": evicted,
            "reusedView": reusedView,
            "restoredAnimations": restoredAnimations,
            "returnedMoving": returnedMoving,
            "visibility": returnedDots.debugVisibilityState,
            "initialBefore": initialBefore.map(Double.init),
            "initialAfter": initialAfter.map(Double.init),
            "returnedBefore": returnedBefore.map(Double.init),
            "returnedAfter": returnedAfter.map(Double.init),
        ]
    }

    private static func firstView<T: NSView>(_ type: T.Type, in root: NSView) -> T? {
        if let match = root as? T { return match }
        for child in root.subviews {
            if let match = firstView(type, in: child) { return match }
        }
        return nil
    }

    private static func moved(_ before: [Float], _ after: [Float]) -> Bool {
        zip(before, after).contains { abs($0 - $1) > 0.02 }
    }
}
#endif
#endif
