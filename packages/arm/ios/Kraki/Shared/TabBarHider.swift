#if os(iOS)
/// TabBarHider — Hides the parent UITabBarController's tab bar while attached.
///
/// Workaround for iOS 26 where SwiftUI's `.toolbar(.hidden, for: .tabBar)`
/// doesn't animate properly during NavigationStack push/pop transitions
/// (Apple confirmed bug, FB18022139).
///
/// Uses UIKit's `setTabBarHidden(_:animated:)` (iOS 26+) when available,
/// falls back to direct `UITabBar.isHidden` mutation. The UIKit transition
/// coordinator drives the slide animation, including interactive swipe-back.

import SwiftUI
import UIKit

struct TabBarHider: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ uiViewController: Controller, context: Context) {}

    final class Controller: UIViewController {
        /// Hide requests per tab bar controller. A route replacement (pending
        /// placeholder → created Session) can deliver the new page's
        /// viewWillAppear BEFORE the old page's viewWillDisappear; a plain
        /// last-writer-wins toggle then re-shows the tab bar over the chat.
        private static var hideRequests: [ObjectIdentifier: Int] = [:]
        private var requestingHide = false
        private weak var requestedController: UITabBarController?

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard !requestingHide, let tabBarController else { return }
            requestingHide = true
            requestedController = tabBarController
            let key = ObjectIdentifier(tabBarController)
            Self.hideRequests[key, default: 0] += 1
            Self.apply(tabBarController, animated: animated)
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            releaseHide(animated: animated)
        }

        deinit {
            // A replaced route may be torn down without a disappearance pass.
            guard requestingHide, let controller = requestedController else { return }
            let key = ObjectIdentifier(controller)
            Self.hideRequests[key] = max(0, (Self.hideRequests[key] ?? 1) - 1)
            DispatchQueue.main.async { Self.apply(controller, animated: false) }
        }

        private func releaseHide(animated: Bool) {
            guard requestingHide, let controller = requestedController ?? tabBarController else { return }
            requestingHide = false
            let key = ObjectIdentifier(controller)
            Self.hideRequests[key] = max(0, (Self.hideRequests[key] ?? 1) - 1)
            Self.apply(controller, animated: animated)
        }

        private static func apply(_ tabBarController: UITabBarController, animated: Bool) {
            let hidden = (hideRequests[ObjectIdentifier(tabBarController)] ?? 0) > 0
            if #available(iOS 26.0, *) {
                if tabBarController.isTabBarHidden != hidden {
                    tabBarController.setTabBarHidden(hidden, animated: animated)
                }
            } else {
                tabBarController.tabBar.isHidden = hidden
            }
        }
    }
}

extension View {
    /// Hides the parent UITabBarController's tab bar while this view is on screen.
    /// The UIKit transition coordinator handles the slide animation, including
    /// the interactive swipe-back gesture.
    func hidesTabBar() -> some View {
        background(TabBarHider().frame(width: 0, height: 0))
    }
}

#endif
