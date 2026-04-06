#if os(iOS)
/// SessionListView — The main sessions list screen.
///
/// Mirrors SessionList.tsx:
/// - Two sections: Pinned (if any) and Recent
/// - Swipe actions: pin/unpin, read/unread, fork, delete
/// - Empty state with "New Session" button
/// - "+" toolbar button → NewSessionSheet
/// - Pull to refresh
/// - NavigationLink to SessionDetailView

import SwiftUI

struct SessionListView: View {
    @Environment(AppState.self) private var appState

    @State private var showNewSession = false
    @State private var deleteCandidate: SessionInfo?

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var sorted: [SessionInfo] { sessionStore.sortedSessions }

    private var pinnedList: [SessionInfo] {
        sorted.filter(\.pinned)
    }

    private var unpinnedList: [SessionInfo] {
        sorted.filter { !$0.pinned }
    }

    private var hasTentacle: Bool {
        deviceStore.tentacleDevices.contains { $0.online }
    }

    var body: some View {
        Group {
            if sorted.isEmpty {
                emptyState
            } else {
                sessionList
            }
        }
        .navigationTitle("Sessions")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showNewSession = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet()
                .environment(appState)
        }
        .alert(
            "Delete Session?",
            isPresented: .init(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            presenting: deleteCandidate
        ) { session in
            Button("Cancel", role: .cancel) { deleteCandidate = nil }
            Button("Delete", role: .destructive) {
                appState.commandSender?.deleteSession(sessionId: session.id)
                deleteCandidate = nil
            }
        } message: { _ in
            Text("This will permanently delete this session and all its messages. This cannot be undone.")
        }
        .navigationDestination(for: String.self) { sessionId in
            SessionDetailView(sessionId: sessionId)
        }
    }

    // MARK: - Session List

    private var sessionList: some View {
        List {
            if !pinnedList.isEmpty {
                Section {
                    ForEach(pinnedList) { session in
                        sessionRow(session)
                    }
                } header: {
                    Label("Pinned", systemImage: "pin.fill")
                        .font(.caption)
                        .textCase(.uppercase)
                }
            }

            Section {
                ForEach(unpinnedList) { session in
                    sessionRow(session)
                }
            } header: {
                if !pinnedList.isEmpty {
                    Text("Recent")
                        .font(.caption)
                        .textCase(.uppercase)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            // WebSocket pushes updates automatically. Pull-to-refresh provides
            // tactile feedback; the brief delay satisfies the refreshable contract.
            try? await Task.sleep(for: .milliseconds(300))
        }
    }

    private func sessionRow(_ session: SessionInfo) -> some View {
        NavigationLink(value: session.id) {
            SessionCardView(session: session)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                appState.commandSender?.pinSession(sessionId: session.id, pinned: !session.pinned)
            } label: {
                Label(
                    session.pinned ? "Unpin" : "Pin",
                    systemImage: session.pinned ? "pin.slash" : "pin"
                )
            }
            .tint(.teal)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                deleteCandidate = session
            } label: {
                Label("Delete", systemImage: "trash")
            }

            Button {
                appState.commandSender?.forkSession(sessionId: session.id)
            } label: {
                Label("Fork", systemImage: "arrow.triangle.branch")
            }
            .tint(.indigo)

            Button {
                let isUnread = (sessionStore.unreadCounts[session.id] ?? 0) > 0
                if isUnread {
                    appState.commandSender?.markRead(sessionId: session.id, seq: session.lastSeq)
                } else {
                    appState.commandSender?.markUnread(sessionId: session.id)
                }
            } label: {
                let isUnread = (sessionStore.unreadCounts[session.id] ?? 0) > 0
                Label(
                    isUnread ? "Read" : "Unread",
                    systemImage: isUnread ? "envelope.open" : "envelope.badge"
                )
            }
            .tint(.blue)
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()

            Text("🦑")
                .font(.system(size: 48))

            Text("No sessions yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if hasTentacle {
                Text("Start a coding agent on your connected device")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)

                Button {
                    showNewSession = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .padding(.top, 4)
            } else {
                Text("Connect an agent via tentacle to get started")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)

                Text("npx @kraki/tentacle")
                    .font(.caption2)
                    .monospaced()
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                    .padding(.top, 4)
            }

            Spacer()
        }
        .padding(.horizontal, 32)
    }
}

#endif
