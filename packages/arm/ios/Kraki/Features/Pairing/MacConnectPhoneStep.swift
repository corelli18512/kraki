/// MacConnectPhoneStep — the optional last step of first-run setup.
///
/// Setup (BuiltInSetupView) ends when this Mac is signed in; the phone code
/// needs the signed-in account (to request a code and to see the phone join),
/// so this step is shown over the main window right after sign-in instead of
/// inside the signed-out setup card. It uses the same card language as setup
/// and appears at most once:
///
/// - only after a fresh setup sign-in (`pendingKey`, set by BuiltInSetupView);
/// - never when the account already has a phone (it is cleared instead);
/// - once on screen it stays until "Skip for Now" or "Start Using Kraki": the
///   phone joining is its success state, and a reconnect does not hide it.
///   Quitting while it is pending brings it back on the next launch unless
///   the account has a phone by then.
///
/// Later, the phone is connected from the idle pane link, the Kraki menu
/// ("Connect Your Phone…") or Settings › Devices.

#if os(macOS)
import SwiftUI

struct MacConnectPhoneStep: View {
    static let pendingKey = "setup.connectPhonePending"

    @Environment(AppState.self) private var appState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(Self.pendingKey) private var pending = false
    /// Wait briefly for the account's device list before deciding, so a user
    /// who already has a phone never sees the step flash. Once settled the
    /// decision is latched for the step's lifetime.
    @State private var settled = false

    /// Phones only: a browser or another computer does not count.
    static func hasPhone(_ devices: some Collection<DeviceSummary>, excluding selfId: String?) -> Bool {
        devices.contains { $0.role == .app && $0.id != selfId && ($0.kind == .ios || $0.kind == .android) }
    }

    static func shouldShow(pending: Bool, connected: Bool, devicesKnown: Bool, hasPhone: Bool) -> Bool {
        pending && connected && devicesKnown && !hasPhone
    }

    private var devicesKnown: Bool { !appState.deviceStore.devices.isEmpty }
    private var hasPhone: Bool {
        Self.hasPhone(appState.deviceStore.devices.values, excluding: appState.deviceId)
    }

    var body: some View {
        ZStack {
            if settled && pending {
                MacConnectPhoneStepPage { finish() }
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: settled)
        .task(id: pending && appState.connectionStatus == .connected && devicesKnown) {
            guard !settled, pending, appState.connectionStatus == .connected, devicesKnown else { return }
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            if hasPhone {
                pending = false
            } else if Self.shouldShow(pending: pending, connected: appState.connectionStatus == .connected,
                                      devicesKnown: devicesKnown, hasPhone: false) {
                settled = true
            }
        }
    }

    private func finish() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { pending = false }
    }
}

/// Full-window page: the setup card around the pairing step.
struct MacConnectPhoneStepPage: View {
    var preview: TentacleCLIManager.PairingPayload?
    var previewConnected: DeviceSummary?
    let onFinish: () -> Void

    var body: some View {
        ZStack {
            Color.surfacePrimary.ignoresSafeArea()
            GeometryReader { proxy in
                ScrollView(.vertical) {
                    card
                        .frame(maxWidth: 480)
                        .padding(.horizontal, 48)
                        .padding(.vertical, 40)
                        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var card: some View {
        let step = Group {
            #if DEBUG
            if let preview {
                PairingSheet(preview: preview, connected: previewConnected, presentation: .setupStep(onFinish: onFinish))
            } else {
                PairingSheet(presentation: .setupStep(onFinish: onFinish))
            }
            #else
            PairingSheet(presentation: .setupStep(onFinish: onFinish))
            #endif
        }
        step
            .padding(.horizontal, 22)
            .padding(.vertical, 22)
            .background(Color.surfaceSecondary.opacity(0.55), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.borderPrimary.opacity(0.8), lineWidth: 1)
            )
    }
}
#endif
