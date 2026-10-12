/// Scroller and wheel behaviour for the Mac chat: transient overlay scroller, smooth wheel, the chat scroller and the smooth scroll view base class.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

/// Keeps an AppKit overlay scroller invisible at rest, reveals it immediately
/// for user scrolling, then fades it after the interaction settles. This is
/// intentionally app-controlled so the Session and Chat lists behave the same
/// even when macOS is configured to always show scroll bars.
final class MacTransientOverlayScrollerController {
    private weak var scrollView: NSScrollView?
    private weak var observedVerticalScroller: NSScroller?
    let visibility = TransientScrollIndicatorVisibility()
    private var liveScrollStartObserver: NSObjectProtocol?
    private var liveScrollObserver: NSObjectProtocol?
    private var liveScrollEndObserver: NSObjectProtocol?
    private var preferredStyleObserver: NSObjectProtocol?

    init() {
        visibility.onVisibilityChanged = { [weak self] visible, duration in
            self?.setVisible(visible, duration: duration)
        }
    }

    deinit {
        for observer in [
            liveScrollStartObserver,
            liveScrollObserver,
            liveScrollEndObserver,
            preferredStyleObserver,
        ].compactMap({ $0 }) {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func attach(to scrollView: NSScrollView) {
        guard self.scrollView !== scrollView else {
            applyConfiguration()
            return
        }
        visibility.reset()
        detachObservers()
        self.scrollView = scrollView
        observedVerticalScroller = nil
        applyConfiguration()
        hideImmediately()

        let center = NotificationCenter.default
        liveScrollStartObserver = center.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.visibility.setActive(true, for: .scroll)
        }
        liveScrollObserver = center.addObserver(
            forName: NSScrollView.didLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.visibility.setActive(true, for: .scroll)
        }
        liveScrollEndObserver = center.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.visibility.setActive(false, for: .scroll)
        }
        preferredStyleObserver = center.addObserver(
            forName: NSScroller.preferredScrollerStyleDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.async { self?.applyConfiguration() }
        }
    }

    func noteScrollEvent(_ event: NSEvent) {
        guard abs(event.scrollingDeltaY) > 0.01 || abs(event.scrollingDeltaX) > 0.01 else { return }
        visibility.pulse()
    }

    func setWheelGlideActive(_ active: Bool) { visibility.setActive(active, for: .wheelGlide) }
    func hideImmediately() { visibility.reset() }

    private func setVisible(_ visible: Bool, duration: TimeInterval) {
        applyConfiguration()
        guard let scroller = scrollView?.verticalScroller else { return }
        scroller.layer?.removeAllAnimations()
        scroller.isHidden = false
        scroller.isEnabled = true
        (scroller as? MacTransientScroller)?.invalidateKnob()
        if duration > 0, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                scroller.animator().alphaValue = visible ? 1 : 0
            }
        } else {
            scroller.alphaValue = visible ? 1 : 0
        }
    }

    private func applyConfiguration() {
        guard let scrollView else { return }
        let reservedLegacyGutter = scrollView.scrollerStyle != .overlay
        scrollView.scrollerStyle = .overlay
        defer {
            // SwiftUI may already have laid its document out beside a legacy
            // scroller. Switching style alone widens only the clip view, and
            // leaves Session cards clipped by the stale 17 pt gutter.
            if reservedLegacyGutter { invalidateDocumentWidth(in: scrollView) }
        }
        scrollView.autohidesScrollers = false
        if !scrollView.hasVerticalScroller { scrollView.hasVerticalScroller = true }
        if !(scrollView.verticalScroller is MacTransientScroller) {
            let old = scrollView.verticalScroller
            let replacement = MacTransientScroller()
            replacement.controlSize = old?.controlSize ?? .regular
            replacement.doubleValue = old?.doubleValue ?? 0
            replacement.knobProportion = old?.knobProportion ?? 1
            scrollView.verticalScroller = replacement
            if let old { replacement.target = old.target; replacement.action = old.action }
        }
        if let scroller = scrollView.verticalScroller as? MacTransientScroller {
            scroller.onHoverChanged = { [weak self] in self?.visibility.setActive($0, for: .hover) }
            scroller.onTrackingChanged = { [weak self] in self?.visibility.setActive($0, for: .knob) }
            scroller.onDetached = { [weak self] in self?.hideImmediately() }
        }
        scrollView.verticalScroller?.scrollerStyle = .overlay
        scrollView.verticalScroller?.wantsLayer = true
        if let scroller = scrollView.verticalScroller {
            if scroller !== observedVerticalScroller {
                observedVerticalScroller = scroller
                scroller.isHidden = false
                scroller.alphaValue = visibility.isVisible ? 1 : 0
                scroller.isEnabled = true
            }
        }
    }

    /// SwiftUI re-proposes its document width only on a scroll-view resize,
    /// not on a scroller-style change. A same-turn 1 pt resize round trip
    /// (never displayed) makes it adopt the full overlay-style width.
    private func invalidateDocumentWidth(in scrollView: NSScrollView) {
        let size = scrollView.frame.size
        guard size.width > 1 else { return }
        scrollView.tile()
        scrollView.setFrameSize(NSSize(width: size.width - 1, height: size.height))
        scrollView.layoutSubtreeIfNeeded()
        scrollView.setFrameSize(size)
        scrollView.tile()
        scrollView.layoutSubtreeIfNeeded()
    }

    private func detachObservers() {
        if let old = observedVerticalScroller as? MacTransientScroller {
            old.onHoverChanged = nil
            old.onTrackingChanged = nil
            old.onDetached = nil
        }
        let center = NotificationCenter.default
        for observer in [
            liveScrollStartObserver,
            liveScrollObserver,
            liveScrollEndObserver,
            preferredStyleObserver,
        ].compactMap({ $0 }) {
            center.removeObserver(observer)
        }
        liveScrollStartObserver = nil
        liveScrollObserver = nil
        liveScrollEndObserver = nil
        preferredStyleObserver = nil
    }
}

/// AppKit production chat list mirroring the iOS flat-spine list behavior.
/// Adds a short AppKit animation to discrete mouse-wheel ticks while leaving
/// precise trackpad deltas on the native scrolling path.
/// Browser-style smoothing for notched mouse wheels (no vendor smoothing).
///
/// One frame-driven animation per gesture: every notch only moves the
/// *target*; the offset approaches it exponentially each display frame, so
/// velocity stays continuous across notches (the old per-notch 90ms easeOut
/// restarted from zero velocity and moved in visible pulses). External offset
/// changes during the glide (anchor compensation when older history is
/// prepended) shift the target by the same amount.
final class MacSmoothWheelController: NSObject {
    private weak var scrollView: NSScrollView?
    private var targetY: CGFloat?
    private var lastAppliedY: CGFloat?
    private var lastFrameTime: CFTimeInterval = 0
    private var displayLink: CADisplayLink?
    private var fallbackTimer: Timer?
    var onActivityChanged: ((Bool) -> Void)?
    var onTargetChanged: ((CGFloat) -> Void)?

    /// Critically damped spring toward the target: position AND velocity are
    /// continuous, so a steadily spun wheel glides at an even speed. ω=24
    /// settles a single notch in ~200ms (browser-like).
    static let springOmega: CGFloat = 24
    private var velocity: CGFloat = 0

    var isActive: Bool { targetY != nil }
    #if DEBUG
    /// Pure user scroll applied by the glide (excludes external compensation).
    var debugAppliedTotal: CGFloat = 0
    #endif

    func handle(_ event: NSEvent, in scrollView: NSScrollView) -> Bool {
        guard !event.hasPreciseScrollingDeltas,
              abs(event.scrollingDeltaY) > 0.01,
              abs(event.scrollingDeltaX) < abs(event.scrollingDeltaY) else {
            reset()
            return false
        }

        if self.scrollView !== scrollView {
            reset()
            self.scrollView = scrollView
        }
        let currentY = scrollView.contentView.bounds.origin.y
        let base = targetY ?? currentY
        // AppKit's default verticalLineScroll is commonly only 10pt; use about
        // three native lines per notch with a 36pt floor.
        let lineDistance = max(scrollView.verticalLineScroll * 3, 36)
        let (minimumY, maximumY) = Self.limits(scrollView)
        let nextY = min(maximumY, max(minimumY, base - event.scrollingDeltaY * lineDistance))
        guard abs(nextY - base) > 0.01 else { return true }

        let starting = targetY == nil
        targetY = nextY
        onTargetChanged?(nextY)
        if starting {
            velocity = 0
            lastAppliedY = currentY
            lastFrameTime = CACurrentMediaTime()
            onActivityChanged?(true)
            startFrames(on: scrollView)
        }
        return true
    }

    func reset() {
        let wasActive = targetY != nil
        stopFrames()
        targetY = nil
        lastAppliedY = nil
        if wasActive { onActivityChanged?(false) }
    }

    private static func limits(_ scrollView: NSScrollView) -> (CGFloat, CGFloat) {
        let minimumY = -scrollView.contentInsets.top
        let maximumY = max(
            minimumY,
            (scrollView.documentView?.frame.height ?? 0)
                - scrollView.contentView.bounds.height
                + scrollView.contentInsets.bottom
        )
        return (minimumY, maximumY)
    }

    private var frameCount = 0

    private func startFrames(on scrollView: NSScrollView) {
        stopFrames()
        frameCount = 0
        if scrollView.window?.screen != nil {
            let link = scrollView.displayLink(target: self, selector: #selector(frameTick))
            link.add(to: .main, forMode: .common)
            displayLink = link
            // A display link never fires while the display sleeps / is locked
            // or detached; fall back to a timer rather than freezing the glide.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak link] in
                guard let self, let link, self.displayLink === link, self.frameCount == 0 else { return }
                link.invalidate()
                self.displayLink = nil
                self.startTimer()
            }
        } else {
            startTimer()
        }
    }

    private func startTimer() {
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            self?.frameTick()
        }
        RunLoop.main.add(timer, forMode: .common)
        fallbackTimer = timer
    }

    private func stopFrames() {
        displayLink?.invalidate()
        displayLink = nil
        fallbackTimer?.invalidate()
        fallbackTimer = nil
    }

    @objc private func frameTick() {
        frameCount += 1
        guard let scrollView, var target = targetY else {
            reset()
            return
        }
        let now = CACurrentMediaTime()
        let dt = min(0.05, max(0, now - lastFrameTime))
        lastFrameTime = now
        var current = scrollView.contentView.bounds.origin.y
        // Someone else moved the viewport (prepend anchor compensation):
        // carry the remaining glide along with the content.
        if let lastAppliedY, abs(current - lastAppliedY) > 0.5 {
            target += current - lastAppliedY
        }
        let (minimumY, maximumY) = Self.limits(scrollView)
        target = min(maximumY, max(minimumY, target))
        targetY = target
        // Semi-implicit Euler in ≤4ms substeps (stable for any frame rate).
        var left = CGFloat(dt)
        let omega = Self.springOmega
        while left > 0 {
            let h = min(left, 0.004)
            let accel = omega * omega * (target - current) - 2 * omega * velocity
            velocity += accel * h
            current += velocity * h
            left -= h
        }
        if abs(target - current) < 0.5, abs(velocity) < 20 {
            current = target
            velocity = 0
        }
        let before = scrollView.contentView.bounds.origin.y
        (scrollView as? MacSmoothScrollView)?.smoothWheelWillMove()
        scrollView.contentView.bounds.origin = NSPoint(x: scrollView.contentView.bounds.origin.x, y: current)
        #if DEBUG
        debugAppliedTotal += scrollView.contentView.bounds.origin.y - before
        #endif
        scrollView.reflectScrolledClipView(scrollView.contentView)
        lastAppliedY = scrollView.contentView.bounds.origin.y
        if current == target, velocity == 0 {
            onTargetChanged?(current)
            reset()
        }
    }
}

final class MacChatScroller: MacTransientScroller {
    var onKnobTrackingChanged: ((Bool) -> Void)?

    override class var isCompatibleWithOverlayScrollers: Bool {
        self == MacChatScroller.self
    }

    override func trackKnob(with event: NSEvent) {
        onKnobTrackingChanged?(true)
        defer { onKnobTrackingChanged?(false) }
        super.trackKnob(with: event)
    }
}

class MacSmoothScrollView: NSScrollView {
    private let smoothWheelController = MacSmoothWheelController()
    private let transientScrollerController = MacTransientOverlayScrollerController()

    var onSmoothWheelActivityChanged: ((Bool) -> Void)? {
        didSet { configureWheelActivity() }
    }
    var onSmoothWheelTargetChanged: ((CGFloat) -> Void)? {
        didSet { smoothWheelController.onTargetChanged = onSmoothWheelTargetChanged }
    }

    /// Called before each smooth-wheel glide frame moves the viewport.
    func smoothWheelWillMove() {}

    func configureTransientOverlayScroller() {
        configureWheelActivity()
        transientScrollerController.attach(to: self)
    }

    private func configureWheelActivity() {
        smoothWheelController.onActivityChanged = { [weak self] active in
            self?.transientScrollerController.setWheelGlideActive(active)
            self?.onSmoothWheelActivityChanged?(active)
        }
    }

    #if DEBUG
    var debugWheelAppliedTotal: CGFloat { smoothWheelController.debugAppliedTotal }
    var debugWheelGlideActive: Bool { smoothWheelController.isActive }
    #endif

    func resetSmoothWheelAnimation() {
        smoothWheelController.reset()
        contentView.layer?.removeAllAnimations()
        transientScrollerController.hideImmediately()
    }

    override func scrollWheel(with event: NSEvent) {
        transientScrollerController.noteScrollEvent(event)
        if smoothWheelController.handle(event, in: self) { return }
        super.scrollWheel(with: event)
    }
}
#endif
