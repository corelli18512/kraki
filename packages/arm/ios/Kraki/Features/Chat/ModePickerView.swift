#if os(iOS)
/// ModePickerView — Exact match of web MessageInput.tsx mobile mode switcher.
///
/// Collapsed: single colored pill with mode name, tap to expand.
/// Expanded: slides in from right, all 4 modes with sliding capsule background
/// using matchedGeometryEffect. Auto-collapses after 3s.

import SwiftUI

struct ModePickerView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @Namespace private var modeNamespace
    @State private var expanded = false
    @State private var closing = false
    @State private var collapseTask: Task<Void, Never>?

    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[sessionId] ?? .discuss
    }

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    var body: some View {
        ZStack(alignment: .trailing) {
            if expanded {
                expandedPicker
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                collapsedPill
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: expanded)
    }

    // MARK: - Collapsed

    private var collapsedPill: some View {
        Button { expand() } label: {
            Text(currentMode.rawValue.capitalized)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(modeTextColorDark(currentMode))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
        }
        .if_available_glass()
        .tint(modePillColor(currentMode))
    }

    // MARK: - Expanded

    private var expandedPicker: some View {
        HStack(spacing: 0) {
            ForEach(Self.allModes, id: \.self) { mode in
                Button { selectMode(mode) } label: {
                    Text(mode.rawValue.capitalized)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(mode == currentMode ? modeTextColorDark(mode) : .secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background {
                            if mode == currentMode {
                                Capsule()
                                    .fill(.ultraThinMaterial)
                                    .matchedGeometryEffect(id: "modePill", in: modeNamespace)
                            }
                        }
                        .animation(.easeInOut(duration: 0.5), value: currentMode)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(.ultraThinMaterial, in: Capsule())
    }

    // MARK: - Actions

    private func expand() {
        expanded = true
        scheduleCollapse()
    }

    private func selectMode(_ mode: SessionMode) {
        appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
        collapseTask?.cancel()
        collapseTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await MainActor.run { withAnimation { expanded = false } }
        }
    }

    private func scheduleCollapse() {
        collapseTask?.cancel()
        collapseTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await MainActor.run { withAnimation { expanded = false } }
        }
    }

    // MARK: - Colors

    /// Pill background color (vibrant, 80% opacity) matching web
    private func modePillColor(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return Color(hex: 0x34D399).opacity(0.8)  // emerald-400/80
        case .discuss:  return Color.ocean400.opacity(0.8)
        case .execute:  return Color(hex: 0xFBBF24).opacity(0.8)  // amber-400/80
        case .delegate: return Color.kraki400.opacity(0.8)
        }
    }

    /// Text color on the colored pill (dark variant for contrast)
    private func modeTextColorDark(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return Color(hex: 0x064E3B) // emerald-900
        case .discuss:  return Color.ocean900
        case .execute:  return Color(hex: 0x78350F) // amber-900
        case .delegate: return Color.kraki900
        }
    }
}

#endif
