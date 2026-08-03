/// MacNotifications — Thin wrapper over UNUserNotificationCenter for
/// local notifications on macOS.
///
/// We don't register APNs from the mac app (yet). Push from iOS-side
/// continues to drive APNs registration; the mac surfaces incoming
/// websocket events as local notifications when the window is hidden
/// or another session is selected.
///
/// Routing rules (per plan §Notification matrix):
///   - Window visible + selected session is the source → no notification
///   - Window visible + different session              → notification, click switches session
///   - Window hidden / minimized                       → notification, click unhides + switches
///
/// This file is the routing primitive. AppState (or whatever future
/// `MessageRouter+macUnreadHook` does) calls `MacNotifications.shared
/// .post(for: sessionInfo, message: text)` from the appropriate seam.

#if os(macOS)
import Foundation
import UserNotifications
import AppKit

@MainActor
final class MacNotifications: NSObject {
    static let shared = MacNotifications()

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Request authorization (idempotent — UN handles repeat calls).
    func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])
    }

    /// Schedule a local notification for an incoming message.
    /// `sessionId` is round-tripped via userInfo so the notification
    /// click can switch sessions in the main window.
    func post(sessionId: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["sessionId": sessionId]
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "kraki-msg-\(sessionId)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

extension MacNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Always banner+sound. Caller decides whether to emit at all
        // based on visibility + active session rules.
        handler([.banner, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler handler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let sessionId = userInfo["sessionId"] as? String {
            DispatchQueue.main.async {
                NSApp.activate(ignoringOtherApps: true)
                NotificationCenter.default.post(
                    name: .macSelectSession,
                    object: nil,
                    userInfo: ["sessionId": sessionId]
                )
            }
        }
        handler()
    }
}

extension Notification.Name {
    static let macSelectSession = Notification.Name("mac.selectSession")
}

#endif
