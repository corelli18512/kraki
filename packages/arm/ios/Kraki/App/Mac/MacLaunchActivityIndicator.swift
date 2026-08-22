#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI

/// A tiny indeterminate launch indicator backed by a render-server animation.
///
/// The animation is committed before the authenticated shell is mounted. Once
/// Core Animation owns the repeating motion, a synchronous first-layout burst
/// on the main thread does not turn the launch gate into a frozen-looking
/// surface. The view intentionally owns no launch-routing state.
struct MacLaunchActivityIndicator: NSViewRepresentable {
    let reduceMotion: Bool
    let onAnimationCommitted: () -> Void

    func makeNSView(context: Context) -> LaunchActivityIndicatorView {
        let view = LaunchActivityIndicatorView()
        view.reduceMotion = reduceMotion
        view.onAnimationCommitted = onAnimationCommitted
        return view
    }

    func updateNSView(_ nsView: LaunchActivityIndicatorView, context: Context) {
        nsView.onAnimationCommitted = onAnimationCommitted
        nsView.setReduceMotion(reduceMotion)
    }

    final class LaunchActivityIndicatorView: NSView {
        private static let trackHeight: CGFloat = 2
        private static let indicatorWidth: CGFloat = 58
        private static let animationDuration: CFTimeInterval = 1.25
        private static let animationKey = "kraki.launch.activity"

        var onAnimationCommitted: (() -> Void)?
        var reduceMotion = false

        private var didCommitAnimation = false
        private var trackLayer: CALayer?
        private var indicatorLayer: CAGradientLayer?

        override var isFlipped: Bool { true }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            installLayersIfNeeded()
            startOrUpdateAnimation()
        }

        override func layout() {
            super.layout()
            installLayersIfNeeded()
            updateLayerFrames()
        }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            updateColors()
        }

        func setReduceMotion(_ value: Bool) {
            guard reduceMotion != value else { return }
            reduceMotion = value
            startOrUpdateAnimation()
        }

        private func installLayersIfNeeded() {
            guard trackLayer == nil else { return }

            wantsLayer = true
            let root = layer ?? CALayer()
            layer = root
            root.masksToBounds = true

            let track = CALayer()
            root.addSublayer(track)
            trackLayer = track

            let indicator = CAGradientLayer()
            indicator.startPoint = CGPoint(x: 0, y: 0.5)
            indicator.endPoint = CGPoint(x: 1, y: 0.5)
            root.addSublayer(indicator)
            indicatorLayer = indicator

            updateLayerFrames()
            updateColors()
        }

        private func updateLayerFrames() {
            guard let trackLayer, let indicatorLayer else { return }
            let bounds = self.bounds
            trackLayer.frame = CGRect(
                x: 0,
                y: max(0, (bounds.height - Self.trackHeight) / 2),
                width: bounds.width,
                height: Self.trackHeight
            )
            indicatorLayer.frame = CGRect(
                x: -Self.indicatorWidth,
                y: max(0, (bounds.height - Self.trackHeight) / 2),
                width: Self.indicatorWidth,
                height: Self.trackHeight
            )
        }

        private func updateColors() {
            guard let trackLayer, let indicatorLayer else { return }
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let primary = NSColor(
                calibratedRed: dark ? 0x5E / 255 : 0x0B / 255,
                green: dark ? 0xA0 / 255 : 0x5B / 255,
                blue: dark ? 0xD7 / 255 : 0x9C / 255,
                alpha: 1
            )
            let cyan = NSColor(
                calibratedRed: dark ? 0x22 / 255 : 0x08 / 255,
                green: dark ? 0xD3 / 255 : 0x91 / 255,
                blue: dark ? 0xEE / 255 : 0xB2 / 255,
                alpha: 1
            )
            trackLayer.backgroundColor = primary.withAlphaComponent(dark ? 0.16 : 0.11).cgColor
            indicatorLayer.colors = [
                NSColor.clear.cgColor,
                primary.withAlphaComponent(0.74).cgColor,
                cyan.withAlphaComponent(0.96).cgColor,
                primary.withAlphaComponent(0.74).cgColor,
                NSColor.clear.cgColor,
            ]
        }

        private func startOrUpdateAnimation() {
            guard window != nil else { return }
            installLayersIfNeeded()
            guard let indicatorLayer else { return }

            indicatorLayer.removeAnimation(forKey: Self.animationKey)
            updateLayerFrames()

            if reduceMotion {
                // Reduce Motion keeps a visible, non-moving center segment so
                // the gate still communicates activity without spatial motion.
                indicatorLayer.position.x = bounds.midX
                indicatorLayer.opacity = 0.8
                didCommitAnimationIfNeeded()
                return
            }

            indicatorLayer.opacity = 1
            let startX = -Self.indicatorWidth / 2
            let endX = bounds.width + Self.indicatorWidth / 2
            indicatorLayer.position.x = startX

            let animation = CABasicAnimation(keyPath: "position.x")
            animation.fromValue = startX
            animation.toValue = endX
            animation.duration = Self.animationDuration
            animation.repeatCount = .infinity
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            // Use the layer's local clock so the first motion starts from the
            // same committed frame even when the view is inside a retained
            // SwiftUI/AppKit hierarchy.
            animation.beginTime = indicatorLayer.convertTime(CACurrentMediaTime(), from: nil)
            indicatorLayer.add(animation, forKey: Self.animationKey)
            didCommitAnimationIfNeeded()
        }

        private func didCommitAnimationIfNeeded() {
            guard !didCommitAnimation else { return }
            didCommitAnimation = true
            // Flush this transaction before releasing launch bootstrap. The
            // callback is deferred one turn so the render server receives the
            // layer tree before MainWindowView can synchronously materialize.
            CATransaction.flush()
            DispatchQueue.main.async { [weak self] in
                self?.onAnimationCommitted?()
            }
        }
    }
}
#endif
