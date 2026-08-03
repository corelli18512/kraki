/// LoginView — Mac sign-in screen.
///
/// Mirrors the iOS LoginView visual but uses native window-content
/// layout (no fullScreenCover). Presents a centered card with the
/// Kraki wordmark, a "Sign in with GitHub" button (when the relay
/// advertises a client id), and pairing instructions for the
/// `kraki connect` flow.

#if os(macOS)
import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            Color.surfacePrimary
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                Image("KrakiLogo")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 140, height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 32, style: .continuous))
                    .shadow(color: Color.black.opacity(0.22), radius: 24, y: 12)

                VStack(spacing: 6) {
                    Text("KRAKI")
                        .font(.system(size: 26, weight: .heavy, design: .monospaced))
                        .tracking(4.5)
                        .foregroundStyle(Color.textTitle)
                    Text("Sign in to your relay")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }

                actionArea
                    .padding(.top, 4)

                Spacer()

                statusFooter
            }
            .padding(48)
            .frame(maxWidth: 460)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    @ViewBuilder
    private var actionArea: some View {
        // GitHub OAuth is iOS-only for now (ASWebAuthenticationSession
        // wiring + Associated Domain claim hasn't been ported to mac).
        // Mac users sign in via `kraki connect` pairing in Terminal,
        // which is the supported flow anyway.
        VStack(spacing: 12) {
            Text("Pair this Mac as a tentacle")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)

            VStack(spacing: 8) {
                HStack(spacing: 6) {
                    Text("Run")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.textMuted)
                    Text("kraki connect")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Color.textTitle)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.surfaceSecondary)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(Color.borderPrimary, lineWidth: 1)
                        )
                    Text("in Terminal")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.textMuted)
                }

                Text("Then scan or paste the URL into your phone, or another paired device.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
            }
        }
    }

    @ViewBuilder
    private var statusFooter: some View {
        if !statusSubline.isEmpty {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(statusSubline)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
            }
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
}

#endif
