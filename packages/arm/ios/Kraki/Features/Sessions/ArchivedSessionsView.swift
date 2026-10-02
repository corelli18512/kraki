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

struct ArchivedSessionRow: View {
    @Environment(AppState.self) private var appState
    let entry: ArchivedEntry

    private var title: String {
        let t = entry.digest.title ?? entry.digest.autoTitle ?? ""
        return t.isEmpty ? "Untitled session" : t
    }

    private var subtitle: String {
        var parts: [String] = []
        if appState.deviceStore.tentacleDevices.count > 1,
           let name = appState.deviceStore.device(for: entry.deviceId)?.name {
            parts.append(name)
        }
        if let iso = entry.digest.lastActivityAt, let date = ISO8601.parse(iso) {
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(Color.textPrimary)
                .lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#if os(iOS)
/// Pushed from the bottom of the session list.
struct ArchivedSessionsView: View {
    @Environment(AppState.self) private var appState
    let onOpen: (String) -> Void

    var body: some View {
        let entries = appState.archivedEntries
        List {
            if entries.isEmpty {
                HStack {
                    Spacer()
                    if appState.sessionStore.archivedCount > 0 { ProgressView() } else { Text("No archived sessions").foregroundStyle(.secondary) }
                    Spacer()
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(entries) { entry in
                        Button {
                            appState.commandSender?.openArchivedSession(entry.digest, deviceId: entry.deviceId)
                            onOpen(entry.id)
                        } label: {
                            ArchivedSessionRow(entry: entry)
                        }
                    }
                } footer: {
                    Text("Opening a session moves it back to your list.")
                }
            }
        }
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { appState.loadArchivedSessions() }
    }
}
#endif

#if os(macOS)
/// Inline, collapsed group at the bottom of the Mac sidebar.
struct ArchivedSessionsSection: View {
    @Environment(AppState.self) private var appState
    let onOpen: (String) -> Void
    @State private var expanded = false

    var body: some View {
        let count = appState.sessionStore.archivedCount
        if count > 0 {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    expanded.toggle()
                    if expanded { appState.loadArchivedSessions() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
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

                if expanded {
                    let entries = appState.archivedEntries
                    if entries.isEmpty {
                        ProgressView().controlSize(.small).padding(.leading, 34).padding(.vertical, 6)
                    }
                    ForEach(entries) { entry in
                        Button {
                            appState.commandSender?.openArchivedSession(entry.digest, deviceId: entry.deviceId)
                            onOpen(entry.id)
                        } label: {
                            ArchivedSessionRow(entry: entry)
                                .padding(.leading, 34)
                                .padding(.trailing, 14)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.top, 6)
        }
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
