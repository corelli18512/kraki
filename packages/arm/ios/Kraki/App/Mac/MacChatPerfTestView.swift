#if os(macOS) && DEBUG
import SwiftUI

/// Full production MainWindowView running against a cached, privacy-safe copy
/// of production-shaped Session/Device/message data. No custom list, mock
/// pagination or fixture-only layout exists here.
struct MacChatPerfTestView: View {
    @Environment(AppState.self) private var production
    @State private var snapshot: AppState?
    @State private var tentacleCLI = TentacleCLIManager()
    @State private var snapshotError: String?

    var body: some View {
        Group {
            if let snapshot {
                MainWindowView(
                    initialSelectedSessionId: snapshot.sessionStore.activeSessionId
                )
                    .environment(snapshot)
                    .environment(tentacleCLI)
            } else if let snapshotError {
                ContentUnavailableView(
                    "Unable to build mock Chat snapshot",
                    systemImage: "exclamationmark.triangle",
                    description: Text(snapshotError)
                )
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Preparing production-shaped mock data…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfacePrimary)
            }
        }
        .task {
            guard snapshot == nil, snapshotError == nil else { return }
            do {
                let built = try await MacChatMockSnapshotCache.shared.snapshot(from: production)
                snapshot = built
            } catch {
                snapshotError = error.localizedDescription
            }
        }
    }
}
#endif
