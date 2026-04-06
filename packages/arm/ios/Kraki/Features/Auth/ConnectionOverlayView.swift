#if os(iOS)
import SwiftUI

/// Full-screen overlay shown during connection, authentication, disconnection, or errors.
///
/// Mirrors the web RelayBlockingOverlay component.
struct ConnectionOverlayView: View {
    @Environment(AppState.self) private var appState

    let status: ConnectionStatus

    var body: some View {
        ZStack {
            // Semi-transparent backdrop
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                switch status {
                case .connecting:
                    connectingContent
                case .authenticating:
                    authenticatingContent
                case .disconnected:
                    disconnectedContent
                case .error:
                    errorContent
                default:
                    EmptyView()
                }

                // Relay URL
                Text(appState.relayURL)
                    .font(.caption2)
                    .monospaced()
                    .foregroundStyle(.tertiary)
                    .padding(.top, 8)
            }
            .padding(32)
            .frame(maxWidth: 320)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.1), radius: 20, y: 10)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.95)))
    }

    // MARK: - Status Content

    private var connectingContent: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Connecting…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var authenticatingContent: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Authenticating…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var disconnectedContent: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 32))
                .foregroundStyle(.orange)
            Text("Connection Lost")
                .font(.headline)
            Text("Reconnecting…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if appState.reconnectAttempt > 0 {
                Text("Attempt \(appState.reconnectAttempt) of \(appState.maxReconnectAttempts)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var errorContent: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(.red)
            Text("Connection Error")
                .font(.headline)
            if let error = appState.lastError {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else {
                Text("Could not connect to the relay server.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button("Connect Now") {
                appState.connect()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .padding(.top, 4)
        }
    }
}

#endif
