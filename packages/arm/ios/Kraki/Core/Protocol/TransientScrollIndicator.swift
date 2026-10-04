import Foundation
import CoreGraphics

/// Shared Session/Chat timing. Native scrolling, pagination and list layout
/// never depend on this decorative controller. All calls are on the main thread.
final class TransientScrollIndicatorVisibility {
    enum Activity: Hashable { case scroll, wheelGlide, knob, hover }
    static let idleDelay: TimeInterval = 1.2
    static let fadeDuration: TimeInterval = 0.3
    var onVisibilityChanged: ((Bool, TimeInterval) -> Void)?
    private(set) var isVisible = false
    private(set) var activities: Set<Activity> = []
    private var hideWork: DispatchWorkItem?
    private var generation = 0
    private let schedule: (TimeInterval, DispatchWorkItem) -> Void

    init(schedule: @escaping (TimeInterval, DispatchWorkItem) -> Void = {
        DispatchQueue.main.asyncAfter(deadline: .now() + $0, execute: $1)
    }) {
        self.schedule = schedule
    }

    deinit { hideWork?.cancel() }

    func setActive(_ active: Bool, for activity: Activity) {
        if active {
            guard activities.insert(activity).inserted else { return }
            reveal()
        } else if activities.remove(activity) != nil {
            scheduleHide()
        }
    }

    /// Discrete wheel ticks have no paired begin/end. A native smooth-wheel
    /// glide holds its own activity, so its final frame starts the idle delay.
    func pulse() {
        reveal()
        scheduleHide()
    }

    func reset() {
        cancelHide()
        activities.removeAll()
        isVisible = false
        onVisibilityChanged?(false, 0)
    }

    private func cancelHide() {
        generation += 1
        hideWork?.cancel(); hideWork = nil
    }

    private func reveal() {
        cancelHide()
        let changed = !isVisible
        isVisible = true
        if changed { onVisibilityChanged?(true, 0) }
    }

    private func scheduleHide() {
        guard activities.isEmpty, isVisible else { return }
        cancelHide()
        let token = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == token, self.activities.isEmpty else { return }
            self.hideWork = nil
            self.isVisible = false
            self.onVisibilityChanged?(false, Self.fadeDuration)
        }
        hideWork = work
        schedule(Self.idleDelay, work)
    }
}

/// Scroll range includes content insets; the track excludes chrome. Rubber
/// banding clamps the indicator without changing the scroll view's geometry.
enum TransientScrollIndicatorGeometry {
    static func thumb(track: CGRect, viewport: CGFloat, content: CGFloat, offset: CGFloat,
                      minimumLength: CGFloat = 24) -> CGRect? {
        guard viewport.isFinite, content.isFinite, offset.isFinite,
              track.height.isFinite, track.height > 0, viewport > 0,
              content > viewport + 1 else { return nil }
        let length = min(track.height, max(minimumLength, track.height * viewport / content))
        let progress = min(1, max(0, offset / (content - viewport)))
        return CGRect(x: track.minX, y: track.minY + (track.height - length) * progress,
                      width: track.width, height: length)
    }
}

#if os(iOS)
import UIKit

/// Opt-in for the two main lists only. UIKit has no public fade-delay API;
/// this non-interactive sibling overlay avoids private indicator APIs and
/// repeated flashScrollIndicators calls. Geometry work is O(1), no cell work.
final class IOSTransientScrollIndicator {
    private weak var scrollView: UIScrollView?
    private let thumb = UIView()
    let visibility = TransientScrollIndicatorVisibility()
    private var observations: [NSKeyValueObservation] = []

    init() {
        thumb.isUserInteractionEnabled = false
        thumb.isAccessibilityElement = false
        thumb.accessibilityElementsHidden = true
        thumb.backgroundColor = .secondaryLabel
        thumb.layer.cornerRadius = 1.5
        thumb.alpha = 0
        visibility.onVisibilityChanged = { [weak self] visible, duration in
            guard let self else { return }
            self.updateGeometry()
            self.thumb.layer.removeAllAnimations()
            UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : duration,
                           delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.thumb.alpha = self.visibility.isVisible ? 0.65 : 0
            }
        }
    }

    func attach(to scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { updateGeometry(); return }
        visibility.reset()
        observations.removeAll()
        thumb.removeFromSuperview()
        self.scrollView = scrollView
        scrollView.showsVerticalScrollIndicator = false
        // This view lives in viewport coordinates, not in reusable list cells.
        scrollView.superview?.addSubview(thumb)
        observations = [
            scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.updateGeometry() },
            scrollView.observe(\.bounds, options: [.new]) { [weak self] _, _ in self?.updateGeometry() },
            scrollView.observe(\.adjustedContentInset, options: [.new]) { [weak self] _, _ in self?.updateGeometry() },
            scrollView.observe(\.verticalScrollIndicatorInsets, options: [.new]) { [weak self] _, _ in self?.updateGeometry() }
        ]
        updateGeometry()
    }

    deinit {
        observations.forEach { $0.invalidate() }
        thumb.removeFromSuperview()
    }

    func beginScrolling() { visibility.setActive(true, for: .scroll); updateGeometry() }
    func didScroll() {
        guard let scrollView else { return }
        if scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating {
            visibility.setActive(true, for: .scroll)
        }
        updateGeometry()
    }
    func endDragging(willDecelerate: Bool) { if !willDecelerate { endScrolling() } }
    func endScrolling() { visibility.setActive(false, for: .scroll); updateGeometry() }
    func hide() { visibility.reset() }

    func updateGeometry() {
        guard let scrollView, let parent = scrollView.superview else { return }
        if thumb.superview !== parent { thumb.removeFromSuperview(); parent.addSubview(thumb) }
        guard scrollView.window != nil else {
            thumb.isHidden = true
            if visibility.isVisible { visibility.reset() }
            return
        }
        let insets = scrollView.adjustedContentInset
        let indicator = scrollView.verticalScrollIndicatorInsets
        let top = max(scrollView.safeAreaInsets.top, indicator.top) + 2
        let bottom = max(scrollView.safeAreaInsets.bottom, indicator.bottom) + 2
        let track = CGRect(x: scrollView.bounds.maxX - 5, y: scrollView.bounds.minY + top,
                           width: 3, height: max(0, scrollView.bounds.height - top - bottom))
        let rect = TransientScrollIndicatorGeometry.thumb(track: track, viewport: scrollView.bounds.height,
            content: scrollView.contentSize.height + insets.top + insets.bottom,
            offset: scrollView.contentOffset.y + insets.top)
        thumb.isHidden = rect == nil
        if let rect {
            // Frame changes should not inherit collection batch/keyboard fades.
            UIView.performWithoutAnimation { thumb.frame = scrollView.convert(rect, to: parent) }
        }
    }

    #if DEBUG
    var debugThumb: UIView { thumb }
    #endif
}
#endif
