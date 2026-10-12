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
        guard !SessionNotifications.isTestHost else { return }
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
        guard !SessionNotifications.isTestHost else { return }
        sendTokenControl(register: false, appState: appState)
        SessionNotifications.removeAllDelivered()
    }

    /// The relay forwarded an encrypted preview (`{blob, key}` for this Mac).
    /// Notification ids already handled, shared by both routes (local link
    /// and Head). Persisted so a late Head copy is still recognised after the
    /// App restarts.
    let deduper = NotificationDeduper(defaults: .standard)

    #if DEBUG
    /// Tests observe posts here instead of Notification Center.
    var postHandlerForTesting: ((_ sessionId: String, _ title: String, _ body: String) -> Void)?
    #endif

    /// `route` is "link" or "head" (diagnostics only).
    func present(decryptedPreview json: String, appState: AppState, route: String = "head") {
        // Claim the id before any other rule. A copy skipped because the
        // Session was on screen must also suppress the other route's copy,
        // which can arrive much later when the user has moved on.
        if let nid = Self.notificationId(in: json), !deduper.claim(nid) {
            KLog.d("🔔 duplicate notification dropped nid=\(nid.prefix(8)) route=\(route)")
            return
        }
        guard isEnabled else { return }
        let preview = PushPreviewFormat.content(fromJSON: json)
        guard let sessionId = preview.sessionId else { return }
        if appState.isActivelyViewingSession(sessionId) { return }
        KLog.d("🔔 notification posted route=\(route)")
        post(sessionId: sessionId, title: preview.title, body: preview.body)
    }

    static func notificationId(in json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let nid = object["nid"] as? String, !nid.isEmpty, nid.count <= 64 else { return nil }
        return nid
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
        #if DEBUG
        if let postHandlerForTesting {
            postHandlerForTesting(sessionId, title, body)
            return
        }
        #endif
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

/// Remembers recently handled notification ids (bounded, persisted).
final class NotificationDeduper {
    static let defaultsKey = "notifications.recentIds"
    static let capacity = 512

    private let defaults: UserDefaults
    private var order: [String]
    private var seen: Set<String>

    init(defaults: UserDefaults) {
        self.defaults = defaults
        let stored = defaults.stringArray(forKey: Self.defaultsKey) ?? []
        order = Array(stored.suffix(Self.capacity))
        seen = Set(order)
    }

    /// True the first time `id` is seen; false for every later copy.
    func claim(_ id: String) -> Bool {
        guard !seen.contains(id) else { return false }
        seen.insert(id)
        order.append(id)
        if order.count > Self.capacity {
            let overflow = order.count - Self.capacity
            for old in order.prefix(overflow) { seen.remove(old) }
            order.removeFirst(overflow)
        }
        defaults.set(order, forKey: Self.defaultsKey)
        return true
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
                    userInfo: ["sessionId": sessionId, "fromNotification": true]
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
