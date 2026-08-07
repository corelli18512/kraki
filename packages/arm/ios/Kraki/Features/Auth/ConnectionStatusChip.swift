#if os(iOS)
import SwiftUI

/// Ambient connection-status indicator that lives next to the brand
/// wordmark in `SessionListView`. A reconnect appears after a short grace
/// period so transient sub-second hiccups stay invisible; recovery then shows
/// a brief green confirmation before the fixed slot clears again.
///
/// Design pattern matches WhatsApp / Telegram: small inline chip,
/// pulsing dot, never blocks any interaction. Replaces the older
/// `ConnectionOverlayView` modal.
struct ConnectionStatusChip: View {
    @Environment(AppState.self) private var appState

    private enum IndicatorPhase {
        case hidden
        case reconnecting
        case online
    }

    @State private var phase: IndicatorPhase = .hidden
    @State private var transitionGeneration = 0
    @State private var spin: Double = 0

    var body: some View {
        ZStack {
            if phase == .reconnecting {
                LucideIcon(.loader2, size: 14, strokeWidth: 2.4, color: .krakiPrimary)
                    .rotationEffect(.degrees(spin))
                    .transition(.opacity.combined(with: .scale))
            } else if phase == .online {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.green)
                    .transition(.opacity.combined(with: .scale))
            }
        }
        .frame(width: 14, height: 14)
        .animation(.easeInOut(duration: 0.2), value: phase)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHidden(phase == .hidden)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                spin = 360
            }
            applyConnectionState(immediate: true)
        }
        .onChange(of: appState.connectionStatus) { _, _ in
            applyConnectionState(immediate: false)
        }
    }

    /// Reads the current status for VoiceOver since the spinner alone
    /// has no descriptive label.
    private var accessibilityLabel: String {
        switch phase {
        case .reconnecting: return "Reconnecting"
        case .online: return "Back online"
        case .hidden: return ""
        }
    }

    /// Suppress sub-second transport blips. A reconnect that became visible is
    /// followed by a short green confirmation; the first app launch and an
    /// invisible transient reconnect do not flash an unnecessary success icon.
    private func applyConnectionState(immediate: Bool) {
        transitionGeneration &+= 1
        let generation = transitionGeneration

        if appState.isReconnecting {
            if immediate {
                phase = .reconnecting
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    guard transitionGeneration == generation,
                          appState.isReconnecting else { return }
                    phase = .reconnecting
                }
            }
            return
        }

        if appState.connectionStatus == .connected, phase == .reconnecting {
            phase = .online
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                guard transitionGeneration == generation,
                      appState.connectionStatus == .connected else { return }
                phase = .hidden
            }
        } else {
            phase = .hidden
        }
    }
}

#endif
