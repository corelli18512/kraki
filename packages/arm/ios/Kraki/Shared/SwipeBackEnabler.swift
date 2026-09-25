#if os(iOS)
/// Keeps the system edge swipe-back working on pages that hide the
/// navigation bar and draw their own header.
///
/// UIKit's default delegate for `interactivePopGestureRecognizer` refuses to
/// begin while the navigation bar is hidden. This installs a delegate that
/// allows the gesture whenever there is a page to go back to and no
/// transition is already running (beginning on the root page, or during a
/// push, is what freezes navigation, so those stay refused).

import SwiftUI
import UIKit

struct SwipeBackEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ uiViewController: Controller, context: Context) {}

    final class Controller: UIViewController {
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            install()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }

        private func install() {
            guard let navigation = navigationController,
                  let gesture = navigation.interactivePopGestureRecognizer else { return }
            let delegate = PopGestureDelegate.shared(for: navigation)
            if gesture.delegate !== delegate { gesture.delegate = delegate }
            gesture.isEnabled = true
        }
    }

    final class PopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
        private static var byNavigation: [ObjectIdentifier: PopGestureDelegate] = [:]
        private weak var navigation: UINavigationController?

        static func shared(for navigation: UINavigationController) -> PopGestureDelegate {
            let key = ObjectIdentifier(navigation)
            if let existing = byNavigation[key], existing.navigation === navigation { return existing }
            let created = PopGestureDelegate()
            created.navigation = navigation
            byNavigation[key] = created
            return created
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigation else { return false }
            return navigation.viewControllers.count > 1 && navigation.transitionCoordinator == nil
        }

        /// Let the edge pan win over content scroll views (the chat list).
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            false
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            false
        }
    }
}

extension View {
    /// Keep edge swipe-back available on a page without a navigation bar.
    func enablesSwipeBack() -> some View {
        background(SwipeBackEnabler().frame(width: 0, height: 0))
    }
}
#endif
