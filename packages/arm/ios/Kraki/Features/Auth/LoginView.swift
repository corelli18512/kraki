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
    @State private var showOAuth = false

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
                    } else {
                        VStack(spacing: 0) { actionArea }
                    }
                }
                .frame(minHeight: 220)
                .animation(.easeInOut(duration: 0.25), value: isConnecting)

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
        .onAppear { startAnimations() }
        .fullScreenCover(isPresented: $showPairing) {
            PairingView()
                .environment(appState)
        }
        .sheet(isPresented: $showOAuth) {
            if let clientId = appState.githubClientId {
                OAuthView(clientId: clientId)
                    .environment(appState)
            }
        }
    }

    // MARK: - Action Area & Inline Status

    /// True while the auth/connect handshake is in flight. Drives the
    /// in-place swap of the action area for a status panel.
    private var isConnecting: Bool {
        switch appState.connectionStatus {
        case .connecting, .authenticating: return true
        default: return false
        }
    }

    /// User-facing wording for each in-flight status. Tries to describe
    /// what's actually happening rather than echoing an internal state
    /// name.
    private var statusHeadline: String {
        switch appState.connectionStatus {
        case .connecting:     return "Connecting to relay…"
        case .authenticating: return "Signing you in…"
        default:              return ""
        }
    }

    private var statusSubline: String {
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
                showOAuth = true
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

    private func startAnimations() {
        // Logo: circle-clip reveal over 4s, blur-to-clear over 3s — both start immediately
        withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 4)) {
            clipRadius = 1.5 // circle scale >1 to fill the square
        }
        withAnimation(.easeOut(duration: 3)) {
            logoBlur = 0
            logoOpacity = 1
        }

        // Title: fade-up at 1s
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            withAnimation(.easeOut(duration: 1)) {
                showTitle = true
            }
        }

        // Subtitle (OAuth available only) + GitHub button: same 1s timing
        // "or" divider: fade-up at 1.3s
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
            withAnimation(.easeOut(duration: 1)) {
                showDivider = true
            }
        }

        // Instructions + relay URL: fade-up at 1.6s
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 1)) {
                showInstructions = true
            }
        }
    }
}

// MARK: - GitHub SVG Mark

/// GitHub's octocat logo as a SwiftUI Shape — exact SVG path from the web app.
private struct GitHubMark: View {
    var body: some View {
        GitHubShape()
            .fill(.white)
    }
}

private struct GitHubShape: Shape {
    func path(in rect: CGRect) -> Path {
        // GitHub Octicon mark, viewBox 0 0 16 16. Re-translated from
        // the canonical SVG `d` attribute via a relative-to-absolute
        // helper so the curve control points are correct.
        let scale = min(rect.width, rect.height) / 16
        var inner = Path()
        var cur = CGPoint(x: 8, y: 0)
        inner.move(to: cur)

        func absC(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat, _ y: CGFloat) {
            inner.addCurve(
                to: CGPoint(x: x, y: y),
                control1: CGPoint(x: x1, y: y1),
                control2: CGPoint(x: x2, y: y2)
            )
            cur = CGPoint(x: x, y: y)
        }
        func relC(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat, _ y: CGFloat) {
            absC(cur.x + x1, cur.y + y1, cur.x + x2, cur.y + y2, cur.x + x, cur.y + y)
        }

        // From SVG d: M8 0 C3.58 0 0 3.58 0 8 c0 3.54 2.29 6.53 5.47 7.59 ...
        absC(3.58, 0, 0, 3.58, 0, 8)
        relC(0, 3.54, 2.29, 6.53, 5.47, 7.59)
        relC(0.4, 0.07, 0.55, -0.17, 0.55, -0.38)
        relC(0, -0.19, -0.01, -0.82, -0.01, -1.49)
        relC(-2.01, 0.37, -2.53, -0.49, -2.69, -0.94)
        relC(-0.09, -0.23, -0.48, -0.94, -0.82, -1.13)
        relC(-0.28, -0.15, -0.68, -0.52, -0.01, -0.53)
        relC(0.63, -0.01, 1.08, 0.58, 1.23, 0.82)
        relC(0.72, 1.21, 1.87, 0.87, 2.33, 0.66)
        relC(0.07, -0.52, 0.28, -0.87, 0.51, -1.07)
        relC(-1.78, -0.2, -3.64, -0.89, -3.64, -3.95)
        relC(0, -0.87, 0.31, -1.59, 0.82, -2.15)
        relC(-0.08, -0.2, -0.36, -1.02, 0.08, -2.12)
        relC(0, 0, 0.67, -0.21, 2.2, 0.82)
        // a 7.59 7.59 0 0 1 2-.27 → tiny near-horizontal arc, approximate
        // as a flat cubic so we don't need an arc primitive.
        relC(0.67, -0.09, 1.33, -0.18, 2, -0.27)
        // a 7.594 7.594 0 0 1 2 .27 → mirror arc on the right side.
        relC(0.67, 0.09, 1.33, 0.18, 2, 0.27)
        relC(1.53, -1.04, 2.2, -0.82, 2.2, -0.82)
        relC(0.44, 1.1, 0.16, 1.92, 0.08, 2.12)
        relC(0.51, 0.56, 0.82, 1.27, 0.82, 2.15)
        relC(0, 3.07, -1.87, 3.75, -3.65, 3.95)
        relC(0.29, 0.25, 0.54, 0.73, 0.54, 1.48)
        relC(0, 1.07, -0.01, 1.93, -0.01, 2.2)
        relC(0, 0.21, 0.15, 0.46, 0.55, 0.38)
        // A8.013 8.013 0 0 0 16 8 → final near-vertical arc back up.
        absC(13.71, 14.53, 16, 11.54, 16, 8)
        // c0-4.42-3.58-8-8-8
        relC(0, -4.42, -3.58, -8, -8, -8)
        inner.closeSubpath()

        return inner
            .applying(.init(scaleX: scale, y: scale))
            .offsetBy(dx: (rect.width - 16 * scale) / 2,
                      dy: (rect.height - 16 * scale) / 2)
    }
}

#endif
