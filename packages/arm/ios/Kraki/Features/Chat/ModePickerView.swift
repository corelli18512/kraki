#if os(iOS)
/// ModePickerView — Liquid glass mode selector with color-shifting tint.
///
/// Collapsed: glass button with mode name + mode-colored tint. Tap to expand.
/// Expanded: GlassEffectContainer with 4 modes. Active mode gets a tinted
/// glass pill that slides between positions via glassEffectID.
/// Glass tint changes color as you switch modes (green→cyan→orange→navy).
/// Auto-collapses after 3s.

import SwiftUI

struct ModePickerView: View {
    let sessionId: String
    @Binding var expanded: Bool

    @Environment(AppState.self) private var appState
    @State private var collapseTask: Task<Void, Never>?

    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[sessionId] ?? .discuss
    }

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    var body: some View {
        ZStack(alignment: .leading) {
            if expanded {
                expandedPicker
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
            } else {
                collapsedPill
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: 32)
        .animation(.easeInOut(duration: 0.22), value: expanded)
    }

    // MARK: - Collapsed
    //
    // Rendered as a 1-item UISegmentedControl so it's pixel-identical to a
    // single segment in the expanded picker (same chrome, corner radius,
    // selected-tint color, font, shadow). The control itself is disabled for
    // hit-testing; the outer Button captures taps and triggers expansion.

    private var collapsedPill: some View {
        TintedSegmentedControl(
            items: [currentMode.rawValue.capitalized],
            selection: .constant(0),
            tintColor: UIColor(modeColor(currentMode))
        )
        .allowsHitTesting(false)
        .frame(height: 32)
        .fixedSize(horizontal: true, vertical: false)
        .contentShape(Rectangle())
        .onTapGesture { expand() }
    }

    // MARK: - Expanded

    private var expandedPicker: some View {
        TintedSegmentedControl(
            items: Self.allModes.map { $0.rawValue.capitalized },
            selection: Binding(
                get: { Self.allModes.firstIndex(of: currentMode) ?? 1 },
                set: { selectMode(Self.allModes[$0]) }
            ),
            tintColor: UIColor(modeColor(currentMode))
        )
        .frame(maxWidth: .infinity)
        .frame(height: 32)
        .animation(.easeInOut(duration: 0.3), value: currentMode)
    }

    // MARK: - Actions

    private func expand() {
        withAnimation { expanded = true }
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

    /// Mode colors — kept in sync with `Color.modeColor` in Theme.swift.
    private func modeColor(_ mode: SessionMode) -> Color {
        Color.modeColor(mode)
    }
}

// MARK: - UIKit Segmented Control with dynamic tint

/// UISegmentedControl whose grey track is invisible while the selected thumb
/// (iOS 26 liquid lens: slides, drags, recolors) is untouched. The public
/// `setBackgroundImage` route switches the control to its legacy rendering
/// (no lens, image-sized height), so this hides only the control's DIRECT
/// UIImageView children (the per-segment track images). If a future iOS
/// changes that structure, the worst case is the track showing again.
final class TrackHiddenSegmentedControl: UISegmentedControl {
    override func layoutSubviews() {
        super.layoutSubviews()
        for view in subviews where view is UIImageView {
            view.alpha = 0
        }
    }
}

struct TintedSegmentedControl: UIViewRepresentable {
    let items: [String]
    @Binding var selection: Int
    let tintColor: UIColor
    /// Touch lifecycle: `true` when a finger goes down on the control, `false`
    /// when it lifts / cancels or the value changes. Lets hosts keep
    /// transient UI open while the user is interacting.
    var onInteraction: ((Bool) -> Void)? = nil
    /// Hide the grey track so only the selected thumb is drawn.
    var transparentTrack: Bool = false

    func makeUIView(context: Context) -> UISegmentedControl {
        let control: UISegmentedControl = transparentTrack
            ? TrackHiddenSegmentedControl(items: items)
            : UISegmentedControl(items: items)
        control.selectedSegmentIndex = selection
        control.selectedSegmentTintColor = tintColor
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        control.addTarget(context.coordinator, action: #selector(Coordinator.began), for: .touchDown)
        if transparentTrack {
            context.coordinator.hideTrack(of: control)
        }
        control.addTarget(context.coordinator, action: #selector(Coordinator.ended),
                          for: [.touchUpInside, .touchUpOutside, .touchCancel])
        return control
    }

    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.parent = self
        control.selectedSegmentIndex = selection
        UIView.animate(withDuration: 0.3) {
            control.selectedSegmentTintColor = tintColor
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator: NSObject {
        var parent: TintedSegmentedControl
        init(_ parent: TintedSegmentedControl) { self.parent = parent }

        @objc func changed(_ control: UISegmentedControl) {
            parent.selection = control.selectedSegmentIndex
            parent.onInteraction?(false)
        }

        @objc func began() { parent.onInteraction?(true) }

        private var trackObservation: NSKeyValueObservation?

        func hideTrack(of control: UISegmentedControl) {
            control.backgroundColor = .clear
        }
        @objc func ended() { parent.onInteraction?(false) }
    }
}

#endif
