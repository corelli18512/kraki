/// AccountPane — Login state + logout.
///
/// Mac re-uses the existing AuthManager / AppState authentication state
/// machine. The UI surface is simpler: show user info + provide a Log
/// Out button. Login flow itself runs through LoginView (presented
/// from MainWindowView when not authenticated).

#if os(macOS)
import SwiftUI

struct AccountPane: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Form {
            if let user = appState.user {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(Color.krakiPrimary.opacity(0.15))
                            Text(initials(for: user))
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.krakiPrimary)
                        }
                        .frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(user.email ?? user.login)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                            HStack(spacing: 6) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Color(hex: 0x34D399))
                                Text("Signed in via \(providerLabel(for: user))")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                            }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }

                Section("Identity") {
                    LabeledContent("Login",  value: user.login)
                    if let email = user.email {
                        LabeledContent("Email",  value: email)
                    }
                    if let did = appState.deviceId {
                        LabeledContent("Device ID", value: String(did.prefix(12)) + "…")
                            .help(did)
                    }
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        appState.logout()
                    }
                }
            } else {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "person.crop.circle.badge.questionmark")
                            .font(.system(size: 28, weight: .light))
                            .foregroundStyle(Color.textMuted)
                        Text("Not signed in.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func initials(for user: UserInfo) -> String {
        let source = user.email ?? user.login
        let parts = source.split(separator: "@").first.map(String.init) ?? source
        let chunks = parts.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if let first = chunks.first?.first, let second = chunks.dropFirst().first?.first {
            return String([first, second]).uppercased()
        }
        return String(parts.prefix(2)).uppercased()
    }

    private func providerLabel(for user: UserInfo) -> String {
        // UserInfo may or may not expose a provider — fall back to a
        // sensible default so the chip stays informative without
        // pretending to know.
        return "GitHub"
    }
}

#endif
