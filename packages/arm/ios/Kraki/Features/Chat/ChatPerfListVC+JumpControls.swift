/// The ↓ jump-to-latest and ↑ previous-reply controls of the iOS chat list.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    // MARK: - Jump-to-latest button

    /// Agent-hue tint for the jump button, matching `ChatView.agentTintColor`
    /// (per-session hue, brighter in dark mode). Dynamic so it follows the
    /// interface style.
    func agentTint() -> UIColor {
        let sid = sessionId
        return UIColor { tc in
            let dark = tc.userInterfaceStyle == .dark
            let hue = stringToHue(sid) / 360
            let (h, s, b) = hslToHSB(h: hue, s: dark ? 0.75 : 0.70, l: dark ? 0.65 : 0.45)
            return UIColor(hue: CGFloat(h), saturation: CGFloat(s), brightness: CGFloat(b), alpha: 1)
        }
    }

    /// The ↑/↓ controls use the same regular Liquid Glass as the composer
    /// capsule (they only show away from the conversation bottom). Glass must not
    /// be clipped with masksToBounds, stroked, or faded through alpha — each
    /// makes it fall back to an opaque fill. It is shaped with a capsule
    /// corner configuration and shown/hidden by setting its effect.
    static var jumpControlEffect: UIVisualEffect {
        if #available(iOS 26.0, *) { return UIGlassEffect(style: .regular) }
        return UIBlurEffect(style: .systemUltraThinMaterial)
    }

    static func makeJumpControlBackground(tint: UIColor) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: jumpControlEffect)
        if #available(iOS 26.0, *) {
            view.cornerConfiguration = .capsule()
        } else {
            view.layer.cornerRadius = jumpControlSize / 2
            view.layer.masksToBounds = true
            view.layer.borderWidth = 0.5
            view.layer.borderColor = tint.withAlphaComponent(0.25).cgColor
        }
        return view
    }

    static func prepareHiddenJumpMaterial(_ view: UIVisualEffectView) {
        if #available(iOS 26.0, *) {} else { view.alpha = 0 }
        view.isHidden = true
    }

    func setupJumpButton() {
        let tint = agentTint()
        let symbolConfiguration = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)

        let blur = Self.makeJumpControlBackground(tint: tint)
        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.isUserInteractionEnabled = false
        Self.prepareHiddenJumpMaterial(blur)

        jumpButton.translatesAutoresizingMaskIntoConstraints = false
        // Keep the material view OUTSIDE the UIButton. UIKit may reorder a
        // button's internal image view during layout; when the blur is a
        // button subview it can end up covering an otherwise valid symbol.
        jumpButton.setImage(
            // Double chevron: "all the way to the newest", distinct from the
            // single-step ↑ control above it.
            // Smaller point size: the stacked glyph is ~19×19 at 16pt vs the
            // single chevron's ~19×12; 13pt gives the same visual footprint.
            UIImage(systemName: "chevron.down.2",
                    withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
                ?? UIImage(systemName: "chevron.down", withConfiguration: symbolConfiguration),
            for: .normal
        )
        jumpButton.tintColor = tint
        jumpButton.contentHorizontalAlignment = .center
        jumpButton.contentVerticalAlignment = .center
        jumpButton.imageView?.contentMode = .scaleAspectFit
        jumpButton.addTarget(self, action: #selector(onBottomTapped), for: .touchUpInside)
        jumpButton.alpha = 0
        jumpButton.isHidden = true
        jumpButton.accessibilityLabel = String(localized: "Jump to latest")

        blur.accessibilityIdentifier = "jump-latest-material"
        view.addSubview(blur)
        view.addSubview(jumpButton)
        jumpButtonBlur = blur

        let bottom = jumpButton.bottomAnchor.constraint(
            equalTo: view.safeAreaLayoutGuide.bottomAnchor,
            constant: -Self.jumpBottomGap(bottomContentInset)
        )
        jumpButtonBottomConstraint = bottom
        NSLayoutConstraint.activate([
            jumpButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            bottom,
            jumpButton.widthAnchor.constraint(equalToConstant: Self.jumpControlSize),
            jumpButton.heightAnchor.constraint(equalToConstant: Self.jumpControlSize),
            blur.leadingAnchor.constraint(equalTo: jumpButton.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: jumpButton.trailingAnchor),
            blur.topAnchor.constraint(equalTo: jumpButton.topAnchor),
            blur.bottomAnchor.constraint(equalTo: jumpButton.bottomAnchor),
        ])

        let latestStart = latestMessageStartButton.bottomAnchor.constraint(equalTo: jumpButton.bottomAnchor)
        latestStartBottomConstraint = latestStart
        let startBlur = Self.makeJumpControlBackground(tint: tint)
        startBlur.translatesAutoresizingMaskIntoConstraints = false
        startBlur.isUserInteractionEnabled = false
        Self.prepareHiddenJumpMaterial(startBlur)

        latestMessageStartButton.translatesAutoresizingMaskIntoConstraints = false
        latestMessageStartButton.setImage(
            UIImage(systemName: "chevron.up", withConfiguration: symbolConfiguration)
                ?? UIImage(systemName: "arrow.up", withConfiguration: symbolConfiguration),
            for: .normal
        )
        latestMessageStartButton.tintColor = tint
        latestMessageStartButton.contentHorizontalAlignment = .center
        latestMessageStartButton.contentVerticalAlignment = .center
        latestMessageStartButton.imageView?.contentMode = .scaleAspectFit
        latestMessageStartButton.addTarget(self, action: #selector(onLatestMessageStartTapped), for: .touchUpInside)
        latestMessageStartButton.alpha = 0
        latestMessageStartButton.isHidden = true
        latestMessageStartButton.accessibilityLabel = String(localized: "Jump to previous reply start")

        startBlur.accessibilityIdentifier = "jump-start-material"
        view.addSubview(startBlur)
        view.addSubview(latestMessageStartButton)
        latestMessageStartButtonBlur = startBlur

        // Unseen reply: a plain red dot on the round ↓ control (there is at
        // most one reply to catch up on, so no count).
        unseenBadge.translatesAutoresizingMaskIntoConstraints = false
        unseenBadge.backgroundColor = .systemRed
        unseenBadge.layer.cornerRadius = 6.5
        unseenBadge.layer.borderWidth = 1.5
        unseenBadge.layer.borderColor = UIColor.systemBackground.cgColor
        unseenBadge.isHidden = true
        unseenBadge.isUserInteractionEnabled = false
        unseenBadge.isAccessibilityElement = false
        jumpButton.addSubview(unseenBadge)
        NSLayoutConstraint.activate([
            unseenBadge.widthAnchor.constraint(equalToConstant: 13),
            unseenBadge.heightAnchor.constraint(equalToConstant: 13),
            unseenBadge.centerXAnchor.constraint(equalTo: jumpButton.trailingAnchor, constant: -5),
            unseenBadge.centerYAnchor.constraint(equalTo: jumpButton.topAnchor, constant: 5),
        ])

        NSLayoutConstraint.activate([
            latestMessageStartButton.trailingAnchor.constraint(equalTo: jumpButton.trailingAnchor),
            latestStart,
            latestMessageStartButton.widthAnchor.constraint(equalToConstant: Self.jumpControlSize),
            latestMessageStartButton.heightAnchor.constraint(equalTo: jumpButton.heightAnchor),
            startBlur.leadingAnchor.constraint(equalTo: latestMessageStartButton.leadingAnchor),
            startBlur.trailingAnchor.constraint(equalTo: latestMessageStartButton.trailingAnchor),
            startBlur.topAnchor.constraint(equalTo: latestMessageStartButton.topAnchor),
            startBlur.bottomAnchor.constraint(equalTo: latestMessageStartButton.bottomAnchor),
        ])
    }
}
#endif
