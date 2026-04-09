#if os(iOS)
/// SessionListView — The main sessions list screen.
///
/// Mirrors SessionList.tsx + Sidebar brand header.

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
        .navigationBarHidden(true)
        .safeAreaInset(edge: .top) {
            brandHeader
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

    // MARK: - Brand Header (custom, not toolbar)

    private var brandHeader: some View {
        HStack(spacing: 6) {
            Image("KrakiLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 22, height: 22)

            HStack(spacing: 0.5) {
                Text("K").foregroundColor(Color(hex: 0x00c9a7))
                Text("R").foregroundColor(Color(hex: 0x00b4d8))
                Text("A").foregroundColor(Color(hex: 0x06b6d4))
                Text("K").foregroundColor(Color(hex: 0xea6046))
                Text("I").foregroundColor(Color(hex: 0x0891b2))
            }
            .font(.system(size: 15, weight: .heavy, design: .monospaced))
            .tracking(2)

            Text("Preview")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color.krakiPrimary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.krakiPrimary.opacity(0.15), in: Capsule())

            Spacer()

            Button {
                showNewSession = true
            } label: {
                Image(systemName: "plus")
                    .imageScale(.medium)
                    .foregroundColor(.krakiPrimary)
                    .padding(6)
            }
            .if_available_glass()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color.surfacePrimary)
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
                    HStack(spacing: 4) {
                        LucideIcon(.pin, size: 12, color: .secondary)
                        Text("Pinned")
                            .font(.caption)
                            .textCase(.uppercase)
                    }
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
        .scrollContentBackground(.hidden)
        .background(Color.surfacePrimary)
        .refreshable {
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
        VStack(spacing: 16) {
            Spacer()

            Text("No sessions")
                .font(.title3)
                .foregroundStyle(.secondary)

            if hasTentacle {
                if #available(iOS 26.0, *) {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .buttonStyle(.glass)
                    .tint(.krakiPrimary)
                    .padding(.top, 4)
                } else {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .tint(.krakiPrimary)
                    .padding(.top, 4)
                }
            } else {
                Text("npx @kraki/tentacle")
                    .font(.system(size: 13, design: .monospaced))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            }

            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfacePrimary)
    }
}

// MARK: - Color hex helper

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - Glass button helper

extension View {
    @ViewBuilder
    func if_available_glass() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

#endif
