#if os(iOS)
/// AppDelegate — Bridges UIKit lifecycle callbacks SwiftUI doesn't expose.
///
/// SwiftUI's lifecycle has no direct hook for
/// `application:didRegisterForRemoteNotificationsWithDeviceToken:`, so we
/// adopt `UIApplicationDelegateAdaptor` to receive APNs registration results
/// and forward them to `PushManager`.
///
/// The delegate finds `PushManager` via a static `@MainActor` reference set
/// by `KrakiApp` at launch (intentionally simple — there's only one app
/// instance per process).

import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate {

    /// Wired by `KrakiApp` once `AppState` exists.
    static var pushManager: PushManager?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Self.pushManager?.handleDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Self.pushManager?.handleRegistrationFailure(error)
    }
}

#endif
