/// MacNotifications — local notifications for the macOS app.
///
/// The Mac does not use APNs. While Kraki runs (it stays in the menu bar when
/// its window is closed) it registers a `local` push token with the relay.
/// The relay then forwards the same end-to-end encrypted preview it would
/// push to an offline phone as a `notification_preview` control message; the
/// Mac decrypts it and posts a local notification formatted exactly like the
/// iPhone's (`PushPreviewFormat`).
///
/// Routing:
///   - Window visible + selected Session is the source → no notification
///   - Otherwise → notification; click activates Kraki and opens the Session
///   - Opening a Session removes its notifications.
/// After ⌘Q nothing is delivered (accepted 2026-10-02).

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

    /// Preferences › Notifications toggle (`@AppStorage`, default on).
    static let enabledKey = "notifications.enabled"

    var isEnabled: Bool {
        UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    /// Request authorization (idempotent — UN handles repeat calls).
    func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])
    }

    /// After every auth: ask macOS for permission the first time, then
    /// (re)register this Mac with the relay so it receives previews.
    func onAuthenticated(appState: AppState) {
        guard !NativeTestRuntime.isRunningTests else { return }
        guard isEnabled else {
            sendTokenControl(register: false, appState: appState)
            return
        }
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                await self.requestAuthorization()
            }
        }
        sendTokenControl(register: true, appState: appState)
    }

    /// Preferences toggle changed.
    func setEnabled(_ enabled: Bool, appState: AppState) {
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        if enabled {
            onAuthenticated(appState: appState)
        } else {
            sendTokenControl(register: false, appState: appState)
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        }
    }

    func handleSignOut(appState: AppState) {
        guard !NativeTestRuntime.isRunningTests else { return }
        sendTokenControl(register: false, appState: appState)
        SessionNotifications.removeAllDelivered()
    }

    /// The relay forwarded an encrypted preview (`{blob, key}` for this Mac).
    func present(decryptedPreview json: String, appState: AppState) {
        guard isEnabled else { return }
        let preview = PushPreviewFormat.content(fromJSON: json)
        guard let sessionId = preview.sessionId else { return }
        if appState.isActivelyViewingSession(sessionId) { return }
        post(sessionId: sessionId, title: preview.title, body: preview.body)
    }

    private func sendTokenControl(register: Bool, appState: AppState) {
        guard appState.connectionStatus == .connected,
              let ws = appState.wsClient,
              let deviceId = appState.deviceId else { return }
        let payload: [String: Any] = register
            ? ["provider": "local", "token": deviceId]
            : ["provider": "local"]
        let message: [String: Any] = [
            "type": register ? "register_push_token" : "unregister_push_token",
            "payload": payload,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else { return }
        ws.sendRaw(string)
    }

    /// Schedule a local notification. `sessionId` groups the notification
    /// (`threadIdentifier`) and is round-tripped via userInfo so a click can
    /// switch Sessions in the main window.
    func post(sessionId: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["sessionId": sessionId]
        content.threadIdentifier = sessionId
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
