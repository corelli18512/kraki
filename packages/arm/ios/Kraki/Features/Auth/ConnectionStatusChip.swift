#if os(iOS)
import SwiftUI

/// Ambient connection-status indicator that lives next to the brand
/// wordmark in `SessionListView`. Visible only while the WS is away
/// from `.connected`, after a short grace period so transient sub-
/// second hiccups don't flicker into view.
///
/// Design pattern matches WhatsApp / Telegram: small inline chip,
/// pulsing dot, never blocks any interaction. Replaces the older
/// `ConnectionOverlayView` modal.
struct ConnectionStatusChip: View {
    @Environment(AppState.self) private var appState

    /// Becomes true after a 1-second grace once the WS leaves
    /// `.connected`. Resets immediately on reconnect so the indicator
    /// disappears the instant we're back online.
    @State private var visible = false
    /// Drives the spinner rotation. Animated via a continuous linear
    /// transform when the indicator is visible.
    @State private var spin: Double = 0

    var body: some View {
        LucideIcon(.loader2, size: 14, strokeWidth: 2.4, color: .krakiPrimary)
            .rotationEffect(.degrees(spin))
            .opacity(visible ? 1 : 0)
            .scaleEffect(visible ? 1 : 0.85)
            .animation(.easeInOut(duration: 0.2), value: visible)
            .accessibilityLabel(accessibilityLabel)
            .onAppear {
                withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                    spin = 360
                }
                applyVisibility(immediate: true)
            }
            .onChange(of: appState.connectionStatus) { _, _ in
                applyVisibility(immediate: false)
            }
    }

    /// Reads the current status for VoiceOver since the spinner alone
    /// has no descriptive label.
    private var accessibilityLabel: String {
        switch appState.connectionStatus {
        case .connecting:     return "Connecting"
        case .authenticating: return "Signing in"
        case .disconnected:   return "Reconnecting"
        case .error:          return "Connection error"
        default:              return ""
        }
    }

    /// Hide instantly on reconnect; show with a 1s grace on drop so we
    /// don't flicker into view for sub-second hiccups.
    private func applyVisibility(immediate: Bool) {
        if appState.isReconnecting {
            if immediate {
                visible = true
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    if appState.isReconnecting { visible = true }
                }
            }
        } else {
            visible = false
        }
    }
}

#endif
