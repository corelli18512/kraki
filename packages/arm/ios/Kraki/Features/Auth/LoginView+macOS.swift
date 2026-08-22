/// Shared macOS entry gate for cold launch and signed-out states.
///
/// Signed Out owns the full window surface without mounting authenticated UI.
/// During authenticated cold launch, the shell may be staged underneath this
/// gate for one window-backed layout pass; Session navigation remains queued,
/// so Chat, Composer, CoreText cells, and restored Session state do not mount
/// before the gate leaves.

#if os(macOS)
import AppKit
import SwiftUI

enum MacEntryGateMode: Equatable {
    case launching
    case signedOut
}

struct MacEntryGateView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let mode: MacEntryGateMode
    var isCheckingCredentials: Bool = false
    var loginCheckFailed: Bool = false
    var onRetry: () -> Void = {}
    var onLaunchActivityCommitted: () -> Void = {}

    @State private var appeared = false

    var body: some View {
        Group {
            switch mode {
            case .launching:
                ZStack {
                    Color.surfacePrimary
                    launchLogo

                    // Keep the Logo physically centered. The indicator is
                    // positioned independently below it and does not change
                    // the Logo's center or the launch-gate layout contract.
                    MacLaunchActivityIndicator(
                        reduceMotion: reduceMotion,
                        onAnimationCommitted: onLaunchActivityCommitted
                    )
                    .frame(width: 128, height: 2)
                    .offset(y: 119)
                    .accessibilityLabel("Opening Kraki")
                }
                .ignoresSafeArea()
            case .signedOut:
                ZStack {
                    Color.surfacePrimary
                        .ignoresSafeArea()
                    signedOutContent
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier(mode == .launching ? "mac.entry.launching" : "mac.entry.signedOut")
        .accessibilityElement(children: .contain)
        .task(id: mode) {
            guard mode == .signedOut, !appeared else { return }
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.easeOut(duration: 0.24)) {
                    appeared = true
                }
            }
        }
    }

    private var launchLogo: some View {
        Image("KrakiLogo")
            .resizable()
            .interpolation(.high)
            .frame(width: 176, height: 176)
            .accessibilityLabel("Kraki")
    }

    private var signedOutContent: some View {
        ZStack {
            entryBackdrop

            VStack(spacing: 0) {
                Spacer(minLength: 48)

                signedOutBrand

                signedOutActions
                    .frame(maxWidth: 420, minHeight: 210, alignment: .top)
                    .padding(.top, 24)

                Spacer(minLength: 36)

                footerStatus
                    .frame(minHeight: 24)
            }
            .padding(.horizontal, 48)
            .padding(.vertical, 34)
        }
    }

    private var entryBackdrop: some View {
        ZStack {
            Circle()
                .fill(Color.krakiPrimary.opacity(0.09))
                .frame(width: 520, height: 520)
                .blur(radius: 80)
                .offset(x: 220, y: -210)

            Circle()
                .fill(Color.cyan.opacity(0.055))
                .frame(width: 440, height: 440)
                .blur(radius: 90)
                .offset(x: -260, y: 240)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var signedOutBrand: some View {
        VStack(spacing: 16) {
            Image("KrakiLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 112, height: 112)
                .clipShape(RoundedRectangle(cornerRadius: 27, style: .continuous))
                .shadow(color: Color.black.opacity(0.24), radius: 26, y: 13)
                .scaleEffect(appeared ? 1 : 0.97)
                .opacity(appeared ? 1 : 0)

            VStack(spacing: 5) {
                Text("KRAKI")
                    .font(.system(size: 24, weight: .heavy, design: .monospaced))
                    .tracking(4.2)
                    .foregroundStyle(Color.textTitle)

                Text("Connect this Mac to your relay")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 5)
        }
    }

    private var signedOutActions: some View {
        VStack(spacing: 16) {
            VStack(spacing: 7) {
                Text("Sign in with the Kraki CLI")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)

                Text("Run this command in Terminal, then return to Kraki.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: 8) {
                Text("kraki connect")
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.textTitle)

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("kraki connect", forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.textSecondary)
                .help("Copy command")
                .accessibilityLabel("Copy kraki connect command")
            }
            .padding(.leading, 13)
            .padding(.trailing, 7)
            .frame(height: 38)
            .background(Color.surfaceSecondary, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(Color.borderPrimary, lineWidth: 1)
            )

            Button {
                onRetry()
            } label: {
                HStack(spacing: 8) {
                    if isCheckingCredentials {
                        ProgressView().controlSize(.small)
                    }
                    Text(isCheckingCredentials ? "Checking…" : "Check Again")
                        .font(.system(size: 12.5, weight: .semibold))
                }
                .frame(minWidth: 116, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.krakiPrimary)
            .disabled(isCheckingCredentials)
            .accessibilityIdentifier("mac.login.checkAgain")

            Text("Kraki also checks again automatically when you return from Terminal.")
                .font(.system(size: 10.5))
                .foregroundStyle(Color.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        .background(Color.surfaceSecondary.opacity(0.55), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.borderPrimary.opacity(0.8), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var footerStatus: some View {
        if mode == .signedOut {
            if isCheckingCredentials {
                Text("Looking for a signed-in Kraki CLI…")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
            } else if loginCheckFailed {
                Text("No signed-in Kraki CLI was found.")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Color.orange)
            } else if !connectionStatusText.isEmpty {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.mini)
                    Text(connectionStatusText)
                        .font(.system(size: 10.5))
                        .foregroundStyle(Color.textMuted)
                }
            }
        }
    }

    private var connectionStatusText: String {
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

/// Compatibility wrapper used anywhere that explicitly requests the macOS
/// login page. It intentionally reuses the exact same full-window entry gate as
/// cold launch; only the center action block changes.
struct LoginView: View {
    var isCheckingCredentials: Bool = false
    var loginCheckFailed: Bool = false
    var onRetry: () -> Void = {}

    var body: some View {
        MacEntryGateView(
            mode: .signedOut,
            isCheckingCredentials: isCheckingCredentials,
            loginCheckFailed: loginCheckFailed,
            onRetry: onRetry
        )
    }
}

#endif
