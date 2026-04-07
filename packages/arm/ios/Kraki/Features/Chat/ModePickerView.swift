#if os(iOS)
/// ModePickerView — Session mode selector pill, mirroring the mode switcher in MessageInput.tsx.
///
/// Collapsed: shows a small capsule with the current mode name and color dot.
/// Expanded (on tap): shows all 4 mode buttons in a row; auto-collapses after 3 seconds.

import SwiftUI

struct ModePickerView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var expanded = false
    @State private var collapseTask: Task<Void, Never>?

    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[sessionId] ?? .discuss
    }

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    var body: some View {
        HStack {
            Spacer()

            if expanded {
                expandedPicker
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.8, anchor: .trailing).combined(with: .opacity),
                        removal: .scale(scale: 0.8, anchor: .trailing).combined(with: .opacity)
                    ))
            } else {
                collapsedPill
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.8, anchor: .trailing).combined(with: .opacity),
                        removal: .scale(scale: 0.8, anchor: .trailing).combined(with: .opacity)
                    ))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: expanded)
    }

    // MARK: - Collapsed Pill

    private var collapsedPill: some View {
        Button {
            expand()
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(modeColor(currentMode))
                    .frame(width: 6, height: 6)
                Text(currentMode.rawValue.capitalized)
                    .font(.caption2)
                    .fontWeight(.medium)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(modeColor(currentMode).opacity(0.15), in: Capsule())
            .foregroundStyle(modeColor(currentMode))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Expanded Picker

    private var expandedPicker: some View {
        HStack(spacing: 0) {
            ForEach(Self.allModes, id: \.self) { mode in
                Button {
                    selectMode(mode)
                } label: {
                    Text(mode.rawValue.capitalized)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .foregroundStyle(mode == currentMode ? modeTextColor(mode) : .secondary)
                        .background {
                            if mode == currentMode {
                                Capsule()
                                    .fill(modeColor(mode).opacity(0.2))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(.secondary.opacity(0.08), in: Capsule())
    }

    // MARK: - Actions

    private func expand() {
        expanded = true
        scheduleCollapse()
    }

    private func selectMode(_ mode: SessionMode) {
        appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
        collapse()
    }

    private func collapse() {
        collapseTask?.cancel()
        withAnimation { expanded = false }
    }

    private func scheduleCollapse() {
        collapseTask?.cancel()
        collapseTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation { expanded = false }
            }
        }
    }

    // MARK: - Colors

    private func modeColor(_ mode: SessionMode) -> Color {
        Color.modeColor(mode)
    }

    private func modeTextColor(_ mode: SessionMode) -> Color {
        modeColor(mode)
    }
}

#endif
