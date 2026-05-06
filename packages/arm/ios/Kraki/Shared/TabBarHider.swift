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
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            setTabBarVisibility(hidden: true, animated: animated)
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            setTabBarVisibility(hidden: false, animated: animated)
        }

        private func setTabBarVisibility(hidden: Bool, animated: Bool) {
            guard let tabBarController = self.tabBarController else { return }
            if #available(iOS 26.0, *) {
                tabBarController.setTabBarHidden(hidden, animated: animated)
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
