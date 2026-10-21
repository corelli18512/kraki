/// The chat header's glass controls: the shared capsule style and the session
/// mode picker.

#if os(macOS)
import SwiftUI

enum MacChatHeaderMetrics {
    static let controlHeight: CGFloat = 32
    static let topPadding: CGFloat = 8
    static var height: CGFloat { topPadding + controlHeight }
    /// First message rests this far below the list top (under the header).
    static var listTopInset: CGFloat { height + 14 }
}

struct MacGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content.background {
                Capsule().fill(.ultraThinMaterial)
                    .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            }
        }
    }
}

/// Session mode control (same behavior as the iOS header): a glass capsule
/// showing the current mode; clicking expands it into a segmented control in
/// which only the selected mode is drawn (a sliding thumb in the mode color,
/// no track). It closes after 3s without interaction; hovering pauses the
/// countdown and every change restarts it.
struct MacChatModePicker: View {
    private static let allModes: [SessionMode] = SessionMode.allCases
    static var startsExpanded: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["KRAKI_HEADER_MODE_EXPANDED"] == "1"
        #else
        false
        #endif
    }

    let currentMode: SessionMode
    @Binding var expanded: Bool
    let onSelect: (SessionMode) -> Void
    @State private var collapseTask: Task<Void, Never>?
    @State private var hovering = false
    @Namespace private var thumb

    var body: some View {
        Group {
            if expanded {
                expandedPicker
                    .transition(.opacity.combined(with: .scale(scale: 0.94, anchor: .trailing)))
            } else {
                collapsedCapsule
                    .transition(.opacity.combined(with: .scale(scale: 0.94, anchor: .trailing)))
            }
        }
        .frame(height: MacChatHeaderMetrics.controlHeight)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: expanded)
    }

    private var collapsedCapsule: some View {
        Button {
            expanded = true
            scheduleCollapse()
        } label: {
            HStack(spacing: 6) {
                Circle().fill(Color.modeColor(currentMode)).frame(width: 7, height: 7)
                Text(currentMode.chatLocalizedTitle)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(Color.textTitle)
            }
            .padding(.horizontal, 13)
            .frame(height: MacChatHeaderMetrics.controlHeight)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .modifier(MacGlassCapsule())
        .accessibilityIdentifier("mac.chat.mode.collapsed")
        .accessibilityLabel("Session mode, \(currentMode.chatLocalizedTitle)")
        .help(MacControlHelp.modeCapsule(currentMode))
    }

    private var expandedPicker: some View {
        HStack(spacing: 0) {
            ForEach(Self.allModes, id: \.self) { mode in
                let selected = mode == currentMode
                Button {
                    if !selected { onSelect(mode) }
                    scheduleCollapse()
                } label: {
                    Text(mode.chatLocalizedTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(selected ? Color.white : Color.textSecondary)
                        .padding(.horizontal, 13)
                        .frame(height: MacChatHeaderMetrics.controlHeight - 6)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(Color.modeColor(mode))
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mac.chat.mode.\(mode.rawValue)")
                .help(MacControlHelp.mode(mode))
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .frame(height: MacChatHeaderMetrics.controlHeight)
        .fixedSize()
        .modifier(MacGlassCapsule())
        .animation(.spring(response: 0.3, dampingFraction: 0.82), value: currentMode)
        .onHover { inside in
            hovering = inside
            if inside { collapseTask?.cancel() } else { scheduleCollapse() }
        }
        .onAppear { scheduleCollapse() }
        .onDisappear { collapseTask?.cancel() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Session mode picker")
    }

    private func scheduleCollapse() {
        guard !Self.startsExpanded else { return }
        collapseTask?.cancel()
        guard !hovering else { return }
        collapseTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, !hovering else { return }
            expanded = false
        }
    }
}
#endif
