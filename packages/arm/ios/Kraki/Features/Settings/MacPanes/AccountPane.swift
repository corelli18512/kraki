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
    @State private var confirmSignOut = false

    var body: some View {
        Form {
            if let user = appState.user {
                Section {
                    HStack(spacing: 14) {
                        AccountAvatar(user: user, size: 48, initials: initials(for: user))
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
                }

                Section {
                    Button("Sign Out…", role: .destructive) {
                        confirmSignOut = true
                    }
                    .confirmationDialog(
                        "Sign out of Kraki on this Mac?",
                        isPresented: $confirmSignOut,
                        titleVisibility: .visible
                    ) {
                        Button("Sign Out", role: .destructive) { appState.logout() }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Conversations cached on this Mac are removed. Your computers keep all sessions; sign in again to see them.")
                    }
                }

                DeleteAccountSection()
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
    }

    private func initials(for user: UserInfo) -> String {
        Self.initials(from: user.email ?? user.login)
    }

    static func initials(from source: String) -> String {
        let parts = source.split(separator: "@").first.map(String.init) ?? source
        // Chinese, Japanese and Korean names: one character. Two would split
        // the given name ("王小明" is not "王小").
        if let first = parts.first, first.unicodeScalars.first.map(Self.isCJK) == true {
            return String(first)
        }
        let chunks = parts.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if let first = chunks.first?.first, let second = chunks.dropFirst().first?.first {
            return String([first, second]).uppercased()
        }
        return String(parts.prefix(2)).uppercased()
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        if scalar.properties.isIdeographic { return true }
        switch scalar.value {
        case 0x3040...0x30FF, 0x31F0...0x31FF, // kana
             0x1100...0x11FF, 0x3130...0x318F, 0xAC00...0xD7AF: // hangul
            return true
        default:
            return false
        }
    }

    private func providerLabel(for user: UserInfo) -> String {
        switch user.provider {
        case "github", nil: return "GitHub"
        case let other?: return other.capitalized
        }
    }
}

#endif
