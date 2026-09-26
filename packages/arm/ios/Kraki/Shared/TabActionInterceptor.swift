#if os(iOS)
import SwiftUI
import UIKit

/// Makes one tab an action button instead of a destination.
///
/// Selecting the iOS 26 search-role "+" tab and snapping the selection back
/// (in SwiftUI) still makes UIKit switch the tab bar controller to the empty
/// tab and back. That re-hosts the Sessions navigation stack: pages pushed
/// afterwards lose their safe-area insets (header under the status bar, Back
/// untappable) and the tab bar stays hidden after returning to the list.
/// Here UIKit is asked first (`shouldSelect…`) and the tab is never selected.
/// All other delegate traffic is forwarded to SwiftUI's own delegate.
struct TabActionInterceptor: UIViewControllerRepresentable {
    let actionTitle: String
    let onAction: () -> Void

    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) {
        probe.actionTitle = actionTitle
        probe.onAction = onAction
        probe.install()
    }

    final class Probe: UIViewController {
        var actionTitle = ""
        var onAction: () -> Void = {}
        private let proxy = DelegateProxy()

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }

        func install() {
            guard let tabs = tabBarController ?? Self.findTabBarController(from: view.window?.rootViewController)
            else { return }
            proxy.actionTitle = actionTitle
            proxy.onAction = { [weak self] in self?.onAction() }
            if tabs.delegate !== proxy {
                proxy.original = tabs.delegate
                tabs.delegate = proxy
            }
        }

        private static func findTabBarController(from vc: UIViewController?) -> UITabBarController? {
            guard let vc else { return nil }
            if let tabs = vc as? UITabBarController { return tabs }
            for child in vc.children {
                if let found = findTabBarController(from: child) { return found }
            }
            return nil
        }
    }

    final class DelegateProxy: NSObject, UITabBarControllerDelegate {
        weak var original: UITabBarControllerDelegate?
        var actionTitle = ""
        var onAction: () -> Void = {}

        private func isAction(_ title: String?) -> Bool { title == actionTitle }

        @available(iOS 18.0, *)
        func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
            if isAction(tab.title) { onAction(); return false }
            return original?.tabBarController?(tabBarController, shouldSelectTab: tab) ?? true
        }

        func tabBarController(_ tabBarController: UITabBarController,
                              shouldSelect viewController: UIViewController) -> Bool {
            if isAction(viewController.tabBarItem.title) { onAction(); return false }
            return original?.tabBarController?(tabBarController, shouldSelect: viewController) ?? true
        }

        override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || (original?.responds(to: selector) ?? false)
        }

        override func forwardingTarget(for selector: Selector!) -> Any? {
            if let original, original.responds(to: selector) { return original }
            return super.forwardingTarget(for: selector)
        }
    }
}
#endif
