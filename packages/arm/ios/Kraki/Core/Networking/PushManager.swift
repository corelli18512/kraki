#if os(iOS)
/// PushManager — APNs registration and lifecycle.
///
/// Owns:
/// - User permission status (`UNAuthorizationStatus`)
/// - Device APNs token (hex string) once granted by the system
/// - "User wants notifications" preference (persisted in UserDefaults)
///
/// Flow:
/// 1. User toggles ON in Settings → `enable()` requests system permission and
///    calls `UIApplication.registerForRemoteNotifications()`.
/// 2. `AppDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
///    forwards the raw token bytes here via `handleDeviceToken(_:)`.
/// 3. `handleDeviceToken` converts to hex, then asks `AppState` to send the
///    `register_push_token` control message to the relay.
/// 4. After every successful auth the registration is sent again (server upserts).
///
/// User toggles OFF → `disable()` sends `unregister_push_token` and forgets the
/// token locally. The system-level subscription stays so re-enabling is fast.

import Foundation
import Observation
import UIKit
import UserNotifications

@Observable
final class PushManager: NSObject {

    // MARK: - Persisted preference

    private static let enabledKey = "kraki.pushNotificationsEnabled"
    private static let pendingUnregisterKey = "kraki.pushPendingUnregister"

    /// `true` once the user has explicitly turned on push in Settings. Persists
    /// across launches; we honour it to decide whether to re-register after auth.
    var userEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    /// Set when `disable()` is called but the relay couldn't be reached.
    /// `onAuthenticated()` retries the unregister whenever this is true.
    private var pendingUnregister: Bool {
        get { UserDefaults.standard.bool(forKey: Self.pendingUnregisterKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.pendingUnregisterKey) }
    }

    /// Monotonically increasing token used to fence delayed
    /// "unregister landed" checks — a follow-up send invalidates any
    /// prior in-flight ack waiter so we only ever clear the flag for
    /// the most recent unregister attempt.
    private var unregisterAckToken: Int = 0

    // MARK: - Observable state

    var permissionStatus: UNAuthorizationStatus = .notDetermined
    /// APNs token in hex form (the format the relay stores and APNs expects).
    var deviceToken: String?
    /// Latest registration round-trip result.
    var registered: Bool = false
    var lastError: String?

    // MARK: - Dependencies

    private weak var appState: AppState?

    // MARK: - Init

    init(appState: AppState) {
        self.appState = appState
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - Public API

    /// Refresh `permissionStatus` from the system. Cheap to call on launch and
    /// when returning to the foreground.
    func refreshPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permissionStatus = settings.authorizationStatus
    }

    /// User toggled the Settings switch ON.
    /// - Requests permission if undetermined.
    /// - Triggers `registerForRemoteNotifications`; AppDelegate completes it.
    /// - Returns `true` if the system granted (or already had) permission.
    @discardableResult
    func enable() async -> Bool {
        userEnabled = true
        let granted = await requestPermissionIfNeeded()
        guard granted else {
            userEnabled = false
            return false
        }
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }

    /// User toggled the Settings switch OFF.
    /// Sends `unregister_push_token` to the relay and forgets the token locally.
    /// We don't unregister with the system — re-enabling stays cheap.
    ///
    /// Always sends the unregister (idempotent on the relay side) even if the
    /// local `deviceToken` is nil — the relay tracks tokens by deviceId/WS
    /// session, not by what we have locally. Persists a "pending unregister"
    /// flag so that if the WebSocket is currently disconnected, we can
    /// retry on next successful auth.
    func disable() {
        userEnabled = false
        pendingUnregister = true
        sendUnregister()
        deviceToken = nil
        registered = false
    }

    /// Called by AppDelegate when APNs hands us the device token.
    func handleDeviceToken(_ data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        KLog.d("📬 APNs token received: …\(hex.suffix(8))")
        // Send registration if we're authenticated and the user wants pushes.
        sendRegisterIfReady()
    }

    /// Called by AppDelegate on registration failure.
    func handleRegistrationFailure(_ error: Error) {
        lastError = error.localizedDescription
        KLog.d("❌ APNs registration failed: \(error.localizedDescription)")
    }

    /// Called by AppState after every successful `auth_ok`. Handles both
    /// pending unregistration (from a prior `disable()` while offline) and
    /// re-registration when push is enabled.
    func onAuthenticated() {
        // If the user disabled push but the unregister never reached the relay,
        // retry now that we're connected.
        if pendingUnregister {
            sendUnregister()
        }

        guard userEnabled else { return }
        // If the system already granted us a token, send it now. Otherwise
        // request one — AppDelegate will route the result back here.
        if deviceToken != nil {
            sendRegisterIfReady()
        } else {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // MARK: - Internal

    private func requestPermissionIfNeeded() async -> Bool {
        await refreshPermissionStatus()
        switch permissionStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            return false
        case .notDetermined:
            do {
                let granted = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
                await refreshPermissionStatus()
                return granted
            } catch {
                lastError = error.localizedDescription
                return false
            }
        @unknown default:
            return false
        }
    }

    /// Build and send `register_push_token` if all preconditions are met.
    private func sendRegisterIfReady() {
        guard userEnabled else { return }
        guard let appState, appState.connectionStatus == .connected else { return }
        guard let token = deviceToken else { return }

        let env = Self.detectAPNSEnvironment()
        let bundleId = Bundle.main.bundleIdentifier ?? "chat.kraki.ios"

        let message: [String: Any] = [
            "type": "register_push_token",
            "payload": [
                "provider": "apns",
                "token": token,
                "environment": env,
                "bundleId": bundleId,
            ],
        ]
        sendControl(message)
        KLog.d("📤 register_push_token (\(env), …\(token.suffix(8)))")
    }

    /// Send `unregister_push_token`. Best-effort; the relay also auto-cleans
    /// stale tokens via APNs 410 responses. If the WebSocket is offline,
    /// `pendingUnregister` stays set so `onAuthenticated()` retries later.
    private func sendUnregister() {
        guard let appState, appState.connectionStatus == .connected else {
            KLog.d("⏸ unregister deferred — WS not connected")
            return
        }
        let message: [String: Any] = [
            "type": "unregister_push_token",
            "payload": ["provider": "apns"],
        ]
        sendControl(message)
        KLog.d("📤 unregister_push_token")
        // Only clear the pending flag once we're confident the message
        // actually reached the relay. The control-plane has no
        // explicit ACK, so we use a short delay-on-connected proxy:
        // if the socket stays up for 5s after sending, assume the
        // frame landed. If we disconnect in that window the flag
        // stays set and `onAuthenticated()` retries on next session.
        let token = unregisterAckToken &+ 1
        unregisterAckToken = token
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self else { return }
            // Bail if a newer send superseded this one or the user
            // re-enabled push in the meantime.
            guard self.unregisterAckToken == token else { return }
            guard let app = self.appState, app.connectionStatus == .connected else { return }
            self.pendingUnregister = false
        }
    }

    /// Send an unencrypted control-plane message.
    /// The relay routes by `type` field at the top level — no envelope/E2E.
    private func sendControl(_ dict: [String: Any]) {
        guard let appState, let ws = appState.wsClient else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        ws.sendRaw(string)
    }

    // MARK: - APNs environment detection

    /// Cached environment string. Reading the embedded mobileprovision
    /// is non-trivial (Data load + plist parse), and the answer is
    /// fixed for the lifetime of the process — recomputing it on
    /// every `register_push_token` is wasted work.
    private static let cachedAPNSEnvironment: String = computeAPNSEnvironment()

    private static func detectAPNSEnvironment() -> String {
        cachedAPNSEnvironment
    }

    /// Detects whether the build is signed for sandbox or production APNs.
    /// Reads `embedded.mobileprovision` and inspects the `aps-environment`
    /// entitlement. Falls back to "production" for App Store builds (which
    /// don't ship a mobileprovision file).
    ///
    /// Apple uses two different terminologies for the same concept:
    ///   - Entitlement key value: "development" / "production"
    ///   - APNs endpoint name:    "sandbox" / "production"
    /// The relay's `ApnsProvider` routes by endpoint name, so we normalize
    /// "development" → "sandbox" here.
    private static func computeAPNSEnvironment() -> String {
        #if DEBUG
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let plistRange = Self.extractPlistRange(in: data),
              let plist = try? PropertyListSerialization.propertyList(
                  from: data.subdata(in: plistRange),
                  options: [],
                  format: nil
              ) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let env = entitlements["aps-environment"] as? String else {
            return "production"
        }
        // Normalize Apple's entitlement value to the relay's expected endpoint name.
        return env == "development" ? "sandbox" : env
        #endif
    }

    /// `embedded.mobileprovision` is a CMS-signed blob with an XML plist
    /// inside. Extract the plist portion by locating its outer tags.
    private static func extractPlistRange(in data: Data) -> Range<Data.Index>? {
        let start = "<?xml".data(using: .utf8)!
        let end = "</plist>".data(using: .utf8)!
        guard let startRange = data.range(of: start),
              let endRange = data.range(of: end) else { return nil }
        return startRange.lowerBound..<endRange.upperBound
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushManager: UNUserNotificationCenterDelegate {

    /// Foreground notification arrival: show banner only if the user is not
    /// already viewing the relevant session.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        let sessionId = userInfo["sessionId"] as? String

        let activeId = appState?.sessionStore.activeSessionId
        if let sessionId, activeId == sessionId {
            // User is already in this session — suppress
            completionHandler([])
        } else {
            completionHandler([.banner, .sound, .list])
        }
    }

    /// User tapped the notification: navigate to the session if one is attached.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let sessionId = userInfo["sessionId"] as? String

        if let sessionId {
            appState?.sessionStore.navigateToSession = sessionId
        }
        completionHandler()
    }
}

#endif
