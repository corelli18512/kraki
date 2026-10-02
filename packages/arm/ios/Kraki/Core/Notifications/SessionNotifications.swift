import Foundation
import UserNotifications

/// Notification Center housekeeping shared by iOS and macOS. Notifications are
/// grouped by Session (`threadIdentifier` = sessionId), which is also the key
/// used to remove them once the human has seen the Session.
enum SessionNotifications {
    /// Remove this Session's delivered notifications.
    static func removeDelivered(forSession sessionId: String) {
        guard !NativeTestRuntime.isRunningTests else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let ids = notifications
                .filter {
                    $0.request.content.threadIdentifier == sessionId
                        || ($0.request.content.userInfo["sessionId"] as? String) == sessionId
                }
                .map(\.request.identifier)
            guard !ids.isEmpty else { return }
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    /// Sign-out: nothing from the previous account may stay on screen.
    static func removeAllDelivered() {
        guard !NativeTestRuntime.isRunningTests else { return }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.setBadgeCount(0)
    }
}
