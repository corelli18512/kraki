#if os(iOS)
/// SettingsView — App settings matching the web sidebar settings panel.

import SwiftUI
import StoreKit
import UserNotifications

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @AppStorage("colorScheme") private var selectedScheme: AppColorScheme = .system
    @State private var pushToggle: Bool = false
    @State private var pushBusy: Bool = false
    @State private var showLogoutConfirm: Bool = false

    var body: some View {
        Form {
            accountSection
            preferencesSection
            aboutSection
            rateSection
        }
        .formStyle(.grouped)
        .contentMargins(.top, 0)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(Color.surfacePrimary)
        .environment(\.defaultMinListHeaderHeight, 0)
        .task {
            await appState.pushManager?.refreshPermissionStatus()
            pushToggle = (appState.pushManager?.userEnabled ?? false)
                && (appState.pushManager?.permissionStatus == .authorized
                    || appState.pushManager?.permissionStatus == .provisional
                    || appState.pushManager?.permissionStatus == .ephemeral)
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
            if let user = appState.user {
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.krakiPrimary.opacity(0.15))
                        Text(String(user.login.prefix(1)).uppercased())
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(Color.krakiPrimary)
                    }
                    .frame(width: 40, height: 40)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.login)
                            .font(.body.weight(.medium))
                        // Web shows the email in muted text below the
                        // login. Fall back to `provider` (e.g. "github")
                        // when the relay didn't expose an email.
                        if let email = user.email, !email.isEmpty {
                            Text(email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.disabled)
                        } else if let provider = user.provider {
                            Text(provider)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    Button {
                        showLogoutConfirm = true
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 34, height: 34)
                            .background(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color.secondary.opacity(0.12))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .strokeBorder(Color.secondary.opacity(0.18), lineWidth: 0.5)
                            )
                            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Log out")
                }
                .alert("Log out?", isPresented: $showLogoutConfirm) {
                    Button("Log out", role: .destructive) {
                        appState.logout()
                    }
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text("You'll need to scan a pairing QR or sign in again to reconnect.")
                }
            } else {
                Text("Not signed in")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Preferences (Notifications + Theme)

    private var preferencesSection: some View {
        Section {
            notificationsRow
            themeRow
        } header: {
            Text("Preferences")
        }
    }

    /// True iff iOS has explicitly denied notification permission. In
    /// that state we can't grant from inside the app — only deep-link
    /// the user out to Settings.
    private var notificationPermissionDenied: Bool {
        appState.pushManager?.permissionStatus == .denied
    }

    @ViewBuilder
    private var notificationsRow: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications")
                if notificationPermissionDenied {
                    Text("Disabled in iOS Settings — tap the gear to enable.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if notificationPermissionDenied {
                // No toggle: iOS owns the decision once the user has
                // denied. Surface a deep-link to the right settings
                // pane instead.
                Button {
                    // iOS 16+: direct deep-link into our app's
                    // Notifications pane in Settings. The generic
                    // `openSettingsURLString` only lands on the app's
                    // root settings page, which on a fresh install
                    // bounces back to the iOS top-level settings list.
                    let urlString: String
                    if #available(iOS 16.0, *) {
                        urlString = UIApplication.openNotificationSettingsURLString
                    } else {
                        urlString = UIApplication.openSettingsURLString
                    }
                    if let url = URL(string: urlString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.krakiPrimary)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open Notification Settings")
            } else {
                Toggle("", isOn: Binding(
                    get: { pushToggle },
                    set: { newValue in handlePushToggle(newValue) }
                ))
                .labelsHidden()
                .disabled(pushBusy)
            }
        }
    }

    @ViewBuilder
    private var themeRow: some View {
        // Inline layout: "Theme" label on the left, segmented control
        // on the right. We constrain the picker's width so the title
        // stays visible regardless of the locale-localized segment
        // labels.
        LabeledContent {
            Picker("Theme", selection: $selectedScheme) {
                Text("System").tag(AppColorScheme.system)
                Text("Light").tag(AppColorScheme.light)
                Text("Dark").tag(AppColorScheme.dark)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 200)
        } label: {
            Text("Theme")
        }
    }

    private func handlePushToggle(_ newValue: Bool) {
        guard let push = appState.pushManager else { return }
        pushBusy = true
        Task {
            if newValue {
                let granted = await push.enable()
                pushToggle = granted
            } else {
                push.disable()
                pushToggle = false
            }
            pushBusy = false
        }
    }

    // MARK: - About Kraki (relay + client version, logo-and-name in header)

    private var aboutSection: some View {
        Section {
            LabeledContent("Relay version") {
                Text(appState.relayVersion ?? "—")
                    .foregroundStyle(.secondary)
            }
            LabeledContent("Client version") {
                Text(appVersion)
                    .foregroundStyle(.secondary)
            }
        } header: {
            HStack(spacing: 8) {
                Image("KrakiLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text("About Kraki")
            }
        }
    }

    // MARK: - Rate Kraki + Report an issue (standalone two-button section)

    private var rateSection: some View {
        Section {
            HStack(spacing: 12) {
                Button {
                    requestAppStoreReview()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "star.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.krakiPrimary)
                        Text("Rate Kraki")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.krakiPrimary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Divider().frame(height: 22)

                Button {
                    openGitHubIssue()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.bubble.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.krakiPrimary)
                        Text("Report an issue")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.krakiPrimary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
        }
    }

    /// Open Kraki's GitHub issues page with a fresh new-issue draft.
    /// We don't pre-fill a body template so the user lands on
    /// GitHub's own form chooser (UI is friendlier than a long
    /// query-stringed body that gets butchered on mobile Safari).
    private func openGitHubIssue() {
        guard let url = URL(string: "https://github.com/corelli18512/kraki/issues/new") else { return }
        UIApplication.shared.open(url)
    }

    /// Surface the in-app App Store review prompt. iOS rate-limits
    /// this to a few times per year, after which the call becomes a
    /// no-op — so we intentionally don't show any confirmation UI of
    /// our own. Once Kraki has a published App Store ID we can swap
    /// this for a direct `itms-apps://` deep-link with
    /// `?action=write-review` so the user always lands somewhere.
    private func requestAppStoreReview() {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return }
        if #available(iOS 18.0, *) {
            AppStore.requestReview(in: scene)
        } else {
            SKStoreReviewController.requestReview(in: scene)
        }
    }

    // MARK: - Helpers

    /// Short version only (no build number) — used for the Client
    /// version row in About.
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }
}

// MARK: - AppColorScheme

enum AppColorScheme: String, CaseIterable {
    case system
    case light
    case dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

#endif
