#if os(iOS)
/// TabBarHider — Hides the parent UITabBarController's tab bar while the page
/// that carries it is the visible page of the selected tab.
///
/// Workaround for iOS 26 where SwiftUI's `.toolbar(.hidden, for: .tabBar)`
/// doesn't animate properly during NavigationStack push/pop transitions
/// (Apple confirmed bug, FB18022139).
///
/// Visibility is DERIVED, never toggled. Appearance callbacks only say "the
/// navigation state may have changed"; the tab bar is then set from the truth:
/// is the top page of the selected tab's navigation stack a hiding page?
/// Toggling per callback broke in real gestures because SwiftUI child
/// controllers see appearance callbacks in transition-dependent orders
/// (a cancelled / long-held interactive swipe-back, a replacement route whose
/// new page appears before the old one disappears, multi-level pops), and the
/// last writer won — leaving the tab bar over the composer or missing on the
/// root list. After every transition (completed OR cancelled) the state is
/// re-derived once more without animation.

import SwiftUI
import UIKit

struct TabBarHider: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ uiViewController: Controller, context: Context) {}

    final class Controller: UIViewController {
        private static let registry = NSHashTable<Controller>.weakObjects()

        override func viewDidLoad() {
            super.viewDidLoad()
            Self.registry.add(self)
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            Self.registry.add(self)
            reconcileAlongsideTransition(animated: animated)
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            Self.reconcile(tabBarController, animated: false)
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            reconcileAlongsideTransition(animated: animated)
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            Self.reconcile(tabBarController ?? Self.anyTabBarController, animated: false)
        }

        deinit {
            // A replaced route can be torn down without a disappearance pass.
            DispatchQueue.main.async { Self.reconcile(Self.anyTabBarController, animated: false) }
        }

        private func reconcileAlongsideTransition(animated: Bool) {
            guard let tabBarController else { return }
            // Animate with the (possibly interactive) transition so the bar
            // tracks the swipe; then settle to the final truth whether the
            // transition completed or was cancelled.
            Self.reconcile(tabBarController, animated: animated)
            if let coordinator = transitionCoordinator ?? navigationController?.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { [weak tabBarController] _ in
                    Self.reconcile(tabBarController, animated: false)
                    // UIKit finalizes the navigation stack right after this
                    // completion on some paths; verify once more.
                    DispatchQueue.main.async { Self.reconcile(tabBarController, animated: false) }
                }
            }
        }

        // MARK: Truth

        private static var anyTabBarController: UITabBarController? {
            registry.allObjects.lazy.compactMap(\.tabBarController).first
        }

        /// True when this hider's page is the top page of its navigation stack
        /// and that stack belongs to the selected tab of `tabBarController`.
        fileprivate func isVisiblePage(in tabBarController: UITabBarController) -> Bool {
            guard isViewLoaded,
                  let navigation = navigationController,
                  let top = navigation.topViewController,
                  isDescendant(of: top) else { return false }
            guard let selected = tabBarController.selectedViewController else { return false }
            return navigation.isDescendant(of: selected)
        }

        static func shouldHide(_ tabBarController: UITabBarController) -> Bool {
            registry.allObjects.contains { $0.isVisiblePage(in: tabBarController) }
        }

        static func reconcile(_ tabBarController: UITabBarController?, animated: Bool) {
            guard let tabBarController else { return }
            let hidden = shouldHide(tabBarController)
            if #available(iOS 26.0, *) {
                if tabBarController.isTabBarHidden != hidden {
                    tabBarController.setTabBarHidden(hidden, animated: animated)
                }
            } else if tabBarController.tabBar.isHidden != hidden {
                tabBarController.tabBar.isHidden = hidden
            }
        }
    }
}

private extension UIViewController {
    func isDescendant(of ancestor: UIViewController) -> Bool {
        var current: UIViewController? = self
        while let controller = current {
            if controller === ancestor { return true }
            current = controller.parent
        }
        return false
    }
}

extension View {
    /// Hides the parent UITabBarController's tab bar while this view is the
    /// visible page of the selected tab. Tracks interactive swipe-back.
    func hidesTabBar() -> some View {
        background(TabBarHider().frame(width: 0, height: 0))
    }
}

#endif
