#if os(iOS)
import SwiftUI

/// Login screen — mirrors the web DashboardPage.tsx "awaiting_login" state.
///
/// Full-screen centered layout with animated logo, sign-in options,
/// and pairing instructions.
struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var logoScale: CGFloat = 0.6
    @State private var showPairing = false
    @State private var showOAuth = false

    private var githubClientId: String? {
        appState.githubClientId
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Animated logo placeholder
            Text("🦑")
                .font(.system(size: 80))
                .scaleEffect(logoScale)
                .onAppear {
                    withAnimation(.spring(response: 0.6, dampingFraction: 0.6)) {
                        logoScale = 1.0
                    }
                }

            Text("Welcome to Kraki")
                .font(.title)
                .fontWeight(.bold)
                .padding(.top, 12)

            Text("Remote control for coding agents")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Spacer()

            // GitHub OAuth
            if let clientId = githubClientId {
                Button {
                    showOAuth = true
                } label: {
                    Label {
                        Text("Sign in with GitHub")
                    } icon: {
                        GitHubIcon()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.black)
                .controlSize(.large)

                // Divider with "or"
                HStack(spacing: 12) {
                    Rectangle()
                        .fill(.tertiary)
                        .frame(height: 1)
                    Text("or")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Rectangle()
                        .fill(.tertiary)
                        .frame(height: 1)
                }
                .padding(.vertical, 20)
            }

            // QR pairing instructions
            Text("Scan a pairing QR code from your terminal to connect.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            (Text("Run ") + Text("`kraki connect`").monospaced() + Text(" to generate a new one."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)

            Button {
                showPairing = true
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
            .padding(.top, 16)

            // Relay URL
            Text(appState.relayURL)
                .font(.caption2)
                .monospaced()
                .foregroundStyle(.tertiary)
                .padding(.top, 24)
                .padding(.bottom, 16)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fullScreenCover(isPresented: $showPairing) {
            PairingView()
                .environment(appState)
        }
        .sheet(isPresented: $showOAuth) {
            if let clientId = githubClientId {
                OAuthView(clientId: clientId)
                    .environment(appState)
            }
        }
    }
}

// MARK: - GitHub Icon

/// Minimal GitHub mark rendered as a Shape path.
private struct GitHubIcon: View {
    var body: some View {
        Image(systemName: "network")
            .imageScale(.medium)
    }
}

#endif
