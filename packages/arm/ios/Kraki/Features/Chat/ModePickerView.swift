#if os(iOS)
/// ModePickerView — Liquid glass mode selector with color-shifting tint.
///
/// Collapsed: glass button with mode name + mode-colored tint. Tap to expand.
/// Expanded: GlassEffectContainer with 4 modes. Active mode gets a tinted
/// glass pill that slides between positions via glassEffectID.
/// Glass tint changes color as you switch modes (green→cyan→orange→coral).
/// Auto-collapses after 3s.

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
        ZStack(alignment: .trailing) {
            if expanded {
                expandedPicker
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                collapsedPill
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: expanded)
    }

    // MARK: - Collapsed

    @ViewBuilder
    private var collapsedPill: some View {
        if #available(iOS 26.0, *) {
            Button { expand() } label: {
                Text(currentMode.rawValue.capitalized)
                    .font(.system(size: 11, weight: .medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.glass(.regular.tint(modeColor(currentMode))))
        } else {
            Button { expand() } label: {
                Text(currentMode.rawValue.capitalized)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(modeTextColorDark(currentMode))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(modePillColor(currentMode), in: Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Expanded

    @ViewBuilder
    private var expandedPicker: some View {
        Picker("Mode", selection: Binding(
            get: { currentMode },
            set: { selectMode($0) }
        )) {
            ForEach(Self.allModes, id: \.self) { mode in
                Text(mode.rawValue.capitalized).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .tint(modeColor(currentMode))
        .frame(maxWidth: 300)
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

    /// Glass tint color per mode (used on iOS 26 GlassEffect)
    private func modeColor(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return Color(hex: 0x34D399) // emerald
        case .discuss:  return Color.ocean500
        case .execute:  return Color(hex: 0xFBBF24) // amber
        case .delegate: return Color.krakiPrimary    // coral
        }
    }

    /// Solid pill color for pre-iOS 26 fallback
    private func modePillColor(_ mode: SessionMode) -> Color {
        modeColor(mode).opacity(0.8)
    }

    /// Dark text for pre-iOS 26 solid pill
    private func modeTextColorDark(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return Color(hex: 0x064E3B)
        case .discuss:  return Color.ocean900
        case .execute:  return Color(hex: 0x78350F)
        case .delegate: return Color.kraki900
        }
    }
}

#endif
