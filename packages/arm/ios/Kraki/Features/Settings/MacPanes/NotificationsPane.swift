/// NotificationsPane — Toggle + System Settings deeplink.
///
/// macOS notifications are governed by the system Settings app; we
/// surface the deeplink so the user can grant permission without
/// leaving Kraki.

#if os(macOS)
import SwiftUI
import UserNotifications

struct NotificationsPane: View {
    @State private var authStatus: UNAuthorizationStatus = .notDetermined
    @AppStorage("notifications.enabled") private var enabled: Bool = true

    var body: some View {
        Form {
            Section("System permission") {
                LabeledContent("Status", value: statusText)
                HStack {
                    Button("Request permission") {
                        Task { await requestPermission() }
                    }
                    .disabled(authStatus == .authorized || authStatus == .denied)
                    Button("Open System Settings…") {
                        openSystemNotificationSettings()
                    }
                }
            }

            Section("In-app") {
                Toggle("Show notifications for new messages", isOn: $enabled)
                Text("Notifications appear only when the window is hidden or another session is selected.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .task { await refreshStatus() }
    }

    private var statusText: String {
        switch authStatus {
        case .authorized: return "Granted"
        case .provisional: return "Provisional"
        case .denied: return "Denied (use System Settings)"
        case .notDetermined: return "Not requested"
        case .ephemeral: return "Ephemeral"
        @unknown default: return "Unknown"
        }
    }

    private func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run { authStatus = settings.authorizationStatus }
    }

    private func requestPermission() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .badge, .sound])
        await refreshStatus()
    }

    private func openSystemNotificationSettings() {
        let bundleId = Bundle.main.bundleIdentifier ?? "chat.kraki.mac"
        let urlString = "x-apple.systempreferences:com.apple.preference.notifications?id=\(bundleId)"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}

#endif
