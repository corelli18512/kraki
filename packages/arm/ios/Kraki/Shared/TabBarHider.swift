#if os(iOS)
/// TabBarHider — Hides the parent UITabBarController's tab bar while the page
/// that carries it is the visible page of the selected tab.
///
/// Why not the platform options: SwiftUI's `.toolbar(.hidden, for: .tabBar)`
/// on iOS 26 brings the bar back late and not with the page (FB18022139,
/// re-verified on iOS 26.5), and UIKit's `hidesBottomBarWhenPushed` cannot be
/// set on SwiftUI NavigationStack destinations before UIKit reads it at push
/// time (verified: the bar stays over the chat).
///
/// Visibility is DERIVED, never toggled. Appearance callbacks only say "the
/// navigation state may have changed"; the tab bar is then set from the truth:
/// is the top page of the selected tab's navigation stack a hiding page?
/// Toggling per callback broke in real gestures because SwiftUI child
/// controllers see appearance callbacks in transition-dependent orders
/// (a cancelled / long-held interactive swipe-back, a replacement route whose
/// new page appears before the old one disappears, multi-level pops), and the
/// last writer won — leaving the tab bar over the composer or missing on the
/// root list. Hiding travels with a push; showing waits until a pop has
/// completed and then slides the bar in (a cancelled swipe never shows it).

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
            Self.reconcile(tabBarController ?? Self.anyTabBarController, animated: true)
        }

        deinit {
            // A replaced route can be torn down without a disappearance pass.
            DispatchQueue.main.async { Self.reconcile(Self.anyTabBarController, animated: true) }
        }

        private func reconcileAlongsideTransition(animated: Bool) {
            guard let tabBarController else { return }
            // Hiding (entering a detail page) runs with the transition so the
            // bar leaves together with the page. Showing never does: while a
            // (possibly interactive) pop is in flight the bar stays hidden, and
            // it slides in only after the pop has actually completed. A
            // cancelled swipe therefore never flashes the bar.
            Self.reconcile(tabBarController, animated: animated)
            if let coordinator = transitionCoordinator ?? navigationController?.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { [weak tabBarController] context in
                    Self.reconcile(tabBarController, animated: !context.isCancelled, ignoringTransition: true)
                    // UIKit finalizes the navigation stack right after this
                    // completion on some paths; verify once more.
                    DispatchQueue.main.async {
                        Self.reconcile(tabBarController, animated: true, ignoringTransition: true)
                    }
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

        /// A navigation transition (push/pop, including an interactive swipe
        /// that is still under the finger) is in progress in the selected tab.
        private static func isTransitioning(_ tabBarController: UITabBarController) -> Bool {
            if tabBarController.transitionCoordinator != nil { return true }
            return registry.allObjects.contains {
                $0.navigationController?.transitionCoordinator != nil
            }
        }

        static func reconcile(_ tabBarController: UITabBarController?, animated: Bool,
                              ignoringTransition: Bool = false) {
            guard let tabBarController else { return }
            let hidden = shouldHide(tabBarController)
            // Defer showing until the transition has finished; its completion
            // reconciles again (see reconcileAlongsideTransition).
            if !hidden, !ignoringTransition, isTransitioning(tabBarController) { return }
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
