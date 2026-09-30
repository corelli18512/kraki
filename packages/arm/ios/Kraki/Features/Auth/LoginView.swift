#if os(iOS)
import SwiftUI

/// Login screen — pixel-identical to web DashboardPage.tsx "awaiting_login" state.
///
/// Layout: centered flex column, p-8
/// Logo: 160×160, circle-clip reveal (0→75%, 4s) + blur-to-clear (3s)
/// Text: staggered fade-up animations (1s, 1.3s, 1.6s delays)
/// GitHub button: dark bg (#24292f), white text, GitHub SVG mark
/// Relay URL: monospace, bg-surface-secondary rounded-lg pill
struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var showPairing = false

    // Animation states
    @State private var clipRadius: CGFloat = 0
    @State private var logoBlur: CGFloat = 12
    @State private var logoOpacity: Double = 0
    @State private var showTitle = false
    @State private var showSubtitle = false
    @State private var showDivider = false
    @State private var showInstructions = false

    private var oauthAvailable: Bool {
        appState.githubClientId != nil
    }

    var body: some View {
        ZStack {
            // Force dark surface beneath everything regardless of the
            // app's theme setting. RootView's adaptive surfacePrimary
            // is light in light mode, so without this the page reads
            // as light no matter what we set preferredColorScheme to.
            Color.kraki950.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo — 160×160, circle-clip reveal + blur animation
                Image("KrakiLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 160, height: 160)
                    .blur(radius: logoBlur)
                    .opacity(logoOpacity)
                    .clipShape(Circle().scale(clipRadius))
                    .padding(.bottom, 16)

                // "Welcome to Kraki" — fade-up, 1s delay
                Text("Welcome to Kraki")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.textTitle)
                    .opacity(showTitle ? 1 : 0)
                    .offset(y: showTitle ? 0 : 8)

                // Subtitle — only when OAuth available, fade-up 1s delay
                if oauthAvailable {
                    Text("Sign in to connect to your coding agent sessions.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                        .padding(.top, 8)
                        .opacity(showTitle ? 1 : 0)
                        .offset(y: showTitle ? 0 : 8)
                }

                Spacer()

                // Action area: GitHub button + "or" + Scan QR, OR the
                // inline status panel while the connection is in flight.
                // Swapping in place avoids a separate full-screen overlay
                // and keeps the logo + title visible the whole time.
                // The fixed minHeight reserves the same vertical real
                // estate for both branches so the logo doesn't shift up
                // when the action area is swapped for the spinner.
                ZStack {
                    if isConnecting {
                        inlineStatusPanel
                            .transition(.opacity)
                    } else {
                        VStack(spacing: 0) { actionArea }
                            .transition(.opacity)
                    }
                }
                .frame(minHeight: 220)
                // Instant flip on tap → spinner with no fade delay.
                // The reverse direction (spinner → login) keeps a brief
                // cross-fade so OAuth cancel doesn't feel jarring.
                .animation(isConnecting ? nil : .easeInOut(duration: 0.2), value: isConnecting)

                // Relay URL pill — hidden on the login screen to keep
                // the page clean. Layout-only placeholder preserves
                // the spacing of the staggered fade-up sequence.
                Color.clear
                    .frame(height: 0)
                    .padding(.top, 24)

                #if DEBUG
                // Dev bypass — connect to local relay with open auth
                Button {
                    appState.devConnect()
                } label: {
                    Label("Dev Login (localhost)", systemImage: "hammer.fill")
                        .font(.system(size: 13))
                }
                .buttonStyle(.bordered)
                .tint(.orange)
                .controlSize(.small)
                .padding(.top, 8)
                .padding(.bottom, 16)
                .opacity(showInstructions ? 1 : 0)
                .offset(y: showInstructions ? 0 : 8)
                #else
                Spacer().frame(height: 16)
                #endif
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .preferredColorScheme(.dark)
        .environment(\.colorScheme, .dark)
        .task { await runIntroAnimations() }
        .fullScreenCover(isPresented: $showPairing) {
            PairingView()
                .environment(appState)
        }
    }

    // MARK: - Action Area & Inline Status

    /// True while the auth/connect handshake is in flight. Drives the
    /// in-place swap of the action area for a status panel.
    private var isConnecting: Bool {
        if appState.isOAuthInFlight { return true }
        switch appState.connectionStatus {
        case .connecting, .authenticating: return true
        default: return false
        }
    }

    /// User-facing wording for each in-flight status. Tries to describe
    /// what's actually happening rather than echoing an internal state
    /// name.
    private var statusHeadline: String {
        if appState.isOAuthInFlight { return "Signing you in…" }
        switch appState.connectionStatus {
        case .connecting:     return "Connecting to relay…"
        case .authenticating: return "Signing you in…"
        default:              return ""
        }
    }

    private var statusSubline: String {
        if appState.isOAuthInFlight {
            return "Opening GitHub to confirm your sign-in."
        }
        switch appState.connectionStatus {
        case .connecting:
            return "Establishing a secure channel to your relay."
        case .authenticating:
            return "Verifying your account and pairing this device."
        default:
            return ""
        }
    }

    /// The default login action area: GitHub button, "or" divider,
    /// pairing instructions, and Scan QR button.
    @ViewBuilder
    private var actionArea: some View {
        // GitHub OAuth button — only shown once the relay has reported
        // its `githubClientId` via `auth_info_response`. Against a
        // relay that doesn't have GitHub OAuth configured (e.g. local
        // dev), `githubClientId` stays nil and we fall through to the
        // pairing-only layout.
        if let clientId = appState.githubClientId {
            Button {
                appState.authManager?.startGitHubOAuth(clientId: clientId)
            } label: {
                HStack(spacing: 8) {
                    GitHubMark()
                        .frame(width: 20, height: 20)
                    Text("Sign in with GitHub")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color(red: 0.141, green: 0.161, blue: 0.184)) // #24292f
                .cornerRadius(8)
                .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
            }
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .accessibilityIdentifier("login.github.\(clientId.prefix(8))")

            // "or" divider — fade-up, 1.3s delay
            HStack(spacing: 12) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.3))
                    .frame(width: 48, height: 1)
                Text("or")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                Rectangle()
                    .fill(Color.secondary.opacity(0.3))
                    .frame(width: 48, height: 1)
            }
            .padding(.top, 18)
            .padding(.bottom, 18)
            .opacity(showDivider ? 1 : 0)
            .offset(y: showDivider ? 0 : 8)
        }

        // Pairing instructions — fade-up, 1.6s delay.
        VStack(spacing: 8) {
            Text("Scan a pairing QR code from your terminal to connect.")
                .font(.system(size: 12))
                .foregroundStyle(Color.secondary.opacity(0.6))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)

            HStack(spacing: 4) {
                Text("Run")
                    .foregroundStyle(Color.secondary.opacity(0.6))
                Text("kraki connect")
                    .monospaced()
                    .foregroundStyle(Color.textTitle.opacity(0.85))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.white.opacity(0.08))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
                Text("to generate a new one.")
                    .foregroundStyle(Color.secondary.opacity(0.6))
            }
            .font(.system(size: 12))
        }
        .opacity(showInstructions ? 1 : 0)
        .offset(y: showInstructions ? 0 : 8)

        // Scan QR button
        Button {
            showPairing = true
        } label: {
            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                .font(.system(size: 14))
        }
        .buttonStyle(.bordered)
        .tint(Color.kraki300)
        .controlSize(.regular)
        .padding(.top, 16)
        .opacity(showInstructions ? 1 : 0)
        .offset(y: showInstructions ? 0 : 8)
    }

    /// Replaces the action area while connecting/authenticating. Sized
    /// to roughly match the action area's natural height so the layout
    /// doesn't jump when switching in/out of this state.
    @ViewBuilder
    private var inlineStatusPanel: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
                .tint(Color.kraki300)

            VStack(spacing: 6) {
                Text(statusHeadline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.textTitle)
                Text(statusSubline)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
        }
        .transition(.opacity.combined(with: .offset(y: 6)))
    }

    // MARK: - Staggered Animations (matching web CSS timings)
    //
    // Driven by a single cancellable `.task` so the staggered fade
    // ins cleanly abort if the view disappears mid-animation
    // (previously, three fire-and-forget `DispatchQueue.asyncAfter`
    // closures could outlive the view and mutate state of a
    // never-shown LoginView).

    @MainActor
    private func runIntroAnimations() async {
        // Logo: circle-clip reveal over 4s, blur-to-clear over 3s — both start immediately
        withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 4)) {
            clipRadius = 1.5 // circle scale >1 to fill the square
        }
        withAnimation(.easeOut(duration: 3)) {
            logoBlur = 0
            logoOpacity = 1
        }

        // Title: fade-up at 1s
        try? await Task.sleep(for: .seconds(1))
        if Task.isCancelled { return }
        withAnimation(.easeOut(duration: 1)) { showTitle = true }

        // "or" divider: fade-up at 1.3s
        try? await Task.sleep(for: .milliseconds(300))
        if Task.isCancelled { return }
        withAnimation(.easeOut(duration: 1)) { showDivider = true }

        // Instructions + relay URL: fade-up at 1.6s
        try? await Task.sleep(for: .milliseconds(300))
        if Task.isCancelled { return }
        withAnimation(.easeOut(duration: 1)) { showInstructions = true }
    }
}

// GitHubMark / GitHubShape live in GitHubMark.swift (shared with macOS).

#endif
