/// Archived sessions (F2).
///
/// Computers archive sessions with no messages for N days (pinned ones
/// never). They are not part of `session_list`; the apps show a collapsed
/// "Archived (N)" entry and ask the computers for the list on demand.
/// Opening one restores it.

import SwiftUI

struct ArchivedEntry: Identifiable {
    let deviceId: String
    let digest: SessionDigest
    var id: String { digest.id }
}

extension AppState {
    /// Ask every computer that has archived sessions for its list.
    func loadArchivedSessions() {
        for (deviceId, info) in sessionStore.archiveInfo where info.count > 0 {
            commandSender?.requestArchivedSessions(targetDeviceId: deviceId)
        }
    }

    var archivedEntries: [ArchivedEntry] {
        sessionStore.archivedSessions
            .flatMap { deviceId, list in list.map { ArchivedEntry(deviceId: deviceId, digest: $0) } }
            .sorted { ($0.digest.lastActivityAt ?? "") > ($1.digest.lastActivityAt ?? "") }
    }
}

#if os(macOS)
/// Collapsed "Archived (N)" group at the bottom of the Mac sidebar. Expanded,
/// it shows the archived sessions with the normal sidebar rows; opening one
/// restores it.
struct ArchivedSessionsSection: View {
    @Environment(AppState.self) private var appState
    @Binding var selectedSessionId: String?
    var deviceFilter: String?
    @State private var expanded = false

    var body: some View {
        let count = appState.sessionStore.archivedCount(deviceId: deviceFilter)
        if count > 0 {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                    if expanded { appState.loadArchivedSessions() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Image(systemName: "archivebox")
                            .font(.system(size: 11))
                        Text("Archived (\(count))")
                            .font(.system(size: 12))
                        Spacer()
                    }
                    .foregroundStyle(Color.textMuted)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sidebar-archived")

                if expanded {
                    let sessions = appState.sessionStore.archivedSessionInfos(deviceId: deviceFilter)
                    if sessions.isEmpty {
                        ProgressView().controlSize(.small).padding(.leading, 34).padding(.vertical, 6)
                    }
                    ForEach(sessions) { session in
                        MacSidebarSessionRow(session: session, isSelected: selectedSessionId == session.id)
                            .contentShape(Rectangle())
                            .onTapGesture { open(session.id) }
                    }
                }
            }
            .padding(.top, 6)
        }
    }

    private func open(_ sessionId: String) {
        if let entry = appState.archivedEntries.first(where: { $0.id == sessionId }) {
            appState.commandSender?.openArchivedSession(entry.digest, deviceId: entry.deviceId)
        }
        selectedSessionId = sessionId
    }
}
#endif

/// Settings rows: auto-archive days + delete archived sessions.
struct ArchiveSettingsSection: View {
    @Environment(AppState.self) private var appState
    @State private var confirmDelete = false

    private static let choices = [7, 14, 30, 60, 90, 0]

    var body: some View {
        let info = appState.sessionStore.archiveInfo
        if !info.isEmpty {
            let days = info.values.first?.days ?? 14
            Section {
                Picker("Archive After", selection: Binding(
                    get: { days },
                    set: { value in
                        for deviceId in info.keys {
                            appState.commandSender?.setAutoArchiveDays(targetDeviceId: deviceId, days: value)
                        }
                    }
                )) {
                    ForEach(Self.choices, id: \.self) { d in
                        Text(d == 0 ? "Never" : "\(d) days").tag(d)
                    }
                }
                let count = appState.sessionStore.archivedCount
                if count > 0 {
                    Button("Delete \(count) Archived Session\(count == 1 ? "" : "s")…", role: .destructive) {
                        confirmDelete = true
                    }
                    .confirmationDialog(
                        "Delete archived sessions from your computers? This can't be undone.",
                        isPresented: $confirmDelete,
                        titleVisibility: .visible
                    ) {
                        Button("Delete", role: .destructive) {
                            for (deviceId, i) in info where i.count > 0 {
                                appState.commandSender?.deleteArchivedSessions(targetDeviceId: deviceId)
                            }
                        }
                    }
                }
            } header: {
                Text("Sessions")
            } footer: {
                Text("Sessions without new messages for this long are archived. Pinned sessions are never archived.")
            }
        }
    }
}
