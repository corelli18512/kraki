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
                    .foregroundStyle(.primary)
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

                // GitHub OAuth button — #24292f bg, white text, GitHub mark
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
                    .padding(.vertical, 24)
                    .opacity(showDivider ? 1 : 0)
                    .offset(y: showDivider ? 0 : 8)
                }

                // Pairing instructions — fade-up, 1.6s delay
                VStack(spacing: 4) {
                    Text("Scan a pairing QR code from your terminal to connect.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)

                    (Text("Run ")
                        .foregroundStyle(Color.secondary.opacity(0.6))
                     + Text("kraki connect")
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .monospaced()
                     + Text(" to generate a new one.")
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    )
                    .font(.system(size: 12))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                }
                .padding(.top, oauthAvailable ? 0 : 24)
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
                .controlSize(.regular)
                .padding(.top, 16)
                .opacity(showInstructions ? 1 : 0)
                .offset(y: showInstructions ? 0 : 8)

                // Relay URL pill — monospace, bg-surface-secondary, rounded-lg
                Text(appState.relayURL)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(8)
                    .padding(.top, 24)
                    .opacity(showInstructions ? 1 : 0)
                    .offset(y: showInstructions ? 0 : 8)

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
        // GitHub mark viewBox="0 0 16 16", scaled to fit rect
        let scale = min(rect.width, rect.height) / 16
        var path = Path()

        // Translated from the SVG path d="M8 0C3.58 0 0 3.58 0 8c0 3.54..."
        path.addPath(
            Path { p in
                p.move(to: CGPoint(x: 8, y: 0))
                p.addCurve(to: CGPoint(x: 0, y: 8),
                           control1: CGPoint(x: 3.58, y: 0),
                           control2: CGPoint(x: 0, y: 3.58))
                p.addCurve(to: CGPoint(x: 5.47, y: 15.59),
                           control1: CGPoint(x: 0, y: 11.54),
                           control2: CGPoint(x: 2.29, y: 14.53))
                p.addCurve(to: CGPoint(x: 5.87, y: 15.21),
                           control1: CGPoint(x: 5.87, y: 15.66),
                           control2: CGPoint(x: 6.02, y: 15.59))
                p.addCurve(to: CGPoint(x: 5.86, y: 13.72),
                           control1: CGPoint(x: 5.87, y: 15.02),
                           control2: CGPoint(x: 5.86, y: 14.39))
                p.addCurve(to: CGPoint(x: 3.17, y: 14.66),
                           control1: CGPoint(x: 3.85, y: 14.09),
                           control2: CGPoint(x: 3.33, y: 14.66))
                p.addCurve(to: CGPoint(x: 2.35, y: 13.53),
                           control1: CGPoint(x: 2.48, y: 14.66),
                           control2: CGPoint(x: 2.44, y: 14.43))
                p.addCurve(to: CGPoint(x: 1.53, y: 12.4),
                           control1: CGPoint(x: 2.26, y: 13.3),
                           control2: CGPoint(x: 1.87, y: 12.59))
                p.addCurve(to: CGPoint(x: 1.54, y: 11.87),
                           control1: CGPoint(x: 1.25, y: 12.25),
                           control2: CGPoint(x: 0.85, y: 11.88))
                p.addCurve(to: CGPoint(x: 2.77, y: 12.69),
                           control1: CGPoint(x: 2.17, y: 11.86),
                           control2: CGPoint(x: 2.62, y: 12.45))
                p.addCurve(to: CGPoint(x: 5.1, y: 13.35),
                           control1: CGPoint(x: 3.49, y: 13.9),
                           control2: CGPoint(x: 4.64, y: 13.56))
                p.addCurve(to: CGPoint(x: 5.61, y: 12.28),
                           control1: CGPoint(x: 5.17, y: 12.83),
                           control2: CGPoint(x: 5.38, y: 12.48))
                p.addCurve(to: CGPoint(x: 1.97, y: 8.33),
                           control1: CGPoint(x: 3.83, y: 12.08),
                           control2: CGPoint(x: 1.97, y: 11.39))
                p.addCurve(to: CGPoint(x: 2.79, y: 6.18),
                           control1: CGPoint(x: 1.97, y: 7.46),
                           control2: CGPoint(x: 2.28, y: 6.74))
                p.addCurve(to: CGPoint(x: 2.87, y: 4.06),
                           control1: CGPoint(x: 2.71, y: 5.98),
                           control2: CGPoint(x: 2.43, y: 5.16))
                p.addCurve(to: CGPoint(x: 5.07, y: 4.88),
                           control1: CGPoint(x: 2.87, y: 4.06),
                           control2: CGPoint(x: 3.54, y: 3.84))
                p.addCurve(to: CGPoint(x: 8, y: 4.61),
                           control1: CGPoint(x: 5.71, y: 4.7),
                           control2: CGPoint(x: 6.39, y: 4.61))
                p.addCurve(to: CGPoint(x: 10.93, y: 4.88),
                           control1: CGPoint(x: 8.68, y: 4.61),
                           control2: CGPoint(x: 9.36, y: 4.7))
                p.addCurve(to: CGPoint(x: 13.13, y: 4.06),
                           control1: CGPoint(x: 12.46, y: 3.84),
                           control2: CGPoint(x: 13.13, y: 4.06))
                p.addCurve(to: CGPoint(x: 13.21, y: 6.18),
                           control1: CGPoint(x: 13.57, y: 5.16),
                           control2: CGPoint(x: 13.29, y: 5.98))
                p.addCurve(to: CGPoint(x: 14.03, y: 8.33),
                           control1: CGPoint(x: 13.72, y: 6.74),
                           control2: CGPoint(x: 14.03, y: 7.46))
                p.addCurve(to: CGPoint(x: 10.38, y: 12.28),
                           control1: CGPoint(x: 14.03, y: 11.4),
                           control2: CGPoint(x: 12.16, y: 12.08))
                p.addCurve(to: CGPoint(x: 10.92, y: 13.76),
                           control1: CGPoint(x: 10.67, y: 12.53),
                           control2: CGPoint(x: 10.92, y: 13.01))
                p.addCurve(to: CGPoint(x: 10.91, y: 15.96),
                           control1: CGPoint(x: 10.92, y: 14.83),
                           control2: CGPoint(x: 10.91, y: 15.69))
                p.addCurve(to: CGPoint(x: 16, y: 8),
                           control1: CGPoint(x: 10.91, y: 16.17),
                           control2: CGPoint(x: 11.06, y: 16.42))
                p.addCurve(to: CGPoint(x: 8, y: 0),
                           control1: CGPoint(x: 16, y: 3.58),
                           control2: CGPoint(x: 12.42, y: 0))
                p.closeSubpath()
            }
            .applying(.init(scaleX: scale, y: scale))
            .offsetBy(dx: (rect.width - 16 * scale) / 2,
                      dy: (rect.height - 16 * scale) / 2)
        )

        return path
    }
}

#endif
