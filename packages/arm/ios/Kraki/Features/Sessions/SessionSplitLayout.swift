#if os(iOS)
import SwiftUI

/// Two-column Sessions layout on wide windows (iPhone Duo inner display,
/// iPad, large iPhones in landscape): the Session list beside the open chat,
/// as in the Mac main window. Decided by available width, not by device.
enum SessionSplitLayout {
    /// Narrower than this keeps the single-column iPhone layout (iPhone Duo
    /// outer display, and either app in Split View).
    static let minimumWidth: CGFloat = 700
    /// The list column (the Mac sidebar is 280 pt; iOS rows are larger).
    static let sidebarWidth: CGFloat = 320

    static func isWide(_ width: CGFloat) -> Bool { width >= minimumWidth }
}

struct SessionSplitContext: Equatable {
    /// The list is shown beside the chat.
    var active = false
    /// This chat is the one shown beside the list (no Back button: the list
    /// is right there), not a page pushed on top of it (a fork).
    var isDetailRoot = false
}

extension EnvironmentValues {
    @Entry var sessionSplit = SessionSplitContext()
}

/// A zero-size UIKit view carrying an identifier, so layout tests can find a
/// SwiftUI view in the UIKit hierarchy (SwiftUI's accessibility tree is built
/// lazily and is not a reliable test handle).
struct ViewMarker: UIViewRepresentable {
    let id: String
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false; view.accessibilityIdentifier = id
        view.isAccessibilityElement = false
        return view
    }
    func updateUIView(_ view: UIView, context: Context) { view.accessibilityIdentifier = id }
}

/// The detail column when no Session is selected (the Mac shows its welcome
/// pane there).
struct SessionSplitPlaceholder: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        VStack(spacing: 14) {
            Image("KrakiLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 56, height: 56)
                .opacity(0.9)
            Text(appState.sessionStore.sessions.isEmpty ? "No sessions yet" : "Select a session")
                .font(.headline)
                .foregroundStyle(Color.textPrimary)
            Text(appState.sessionStore.sessions.isEmpty
                 ? "Tap + to start a session on one of your computers."
                 : "Choose a session from the list to continue the conversation.")
                .font(.subheadline)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfacePrimary)
        .background(ViewMarker(id: "session-split-placeholder"))
    }
}
#endif
