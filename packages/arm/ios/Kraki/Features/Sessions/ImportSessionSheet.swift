#if os(iOS)
/// ImportSessionSheet — iOS port of web's `ImportSessionDialog.tsx`.
///
/// Lists local Copilot/VSCode sessions discovered on the chosen
/// tentacle's filesystem and lets the user import one into Kraki.
/// On tap, the picker calls `commandSender.importSession(..)` which
/// optimistically navigates to the (future) session id and closes
/// the sheet. The placeholder spinner in `SessionDetailView` shows
/// until `session_created` lands.

import SwiftUI

struct ImportSessionSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    /// Defaults to the first online tentacle if none selected. When
    /// multiple tentacles exist the user can switch via the picker
    /// in the toolbar.
    @State private var selectedDeviceId: String? = nil
    @State private var search: String = ""
    @State private var liveOnly: Bool = false
    @State private var includeLinked: Bool = false

    private var deviceStore: DeviceStore { appState.deviceStore }
    private var sessionStore: SessionStore { appState.sessionStore }
    private var commandSender: CommandSender? { appState.commandSender }

    private var tentacles: [DeviceSummary] {
        deviceStore.tentacleDevices
            .filter { $0.online }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private var deviceId: String? {
        selectedDeviceId ?? tentacles.first?.id
    }

    private var isLoading: Bool {
        guard let deviceId else { return false }
        return deviceStore.localSessionsLoading.contains(deviceId)
    }

    private var sessions: [LocalSessionSummary] {
        guard let deviceId else { return [] }
        let all = deviceStore.localSessions[deviceId] ?? []
        let lower = search.lowercased()
        return all.filter { s in
            if liveOnly && !s.isLive { return false }
            if !includeLinked && s.linkedKrakiSessionId != nil { return false }
            if !lower.isEmpty {
                let hay = [s.summary, s.cwd, s.gitRoot, s.repository, s.branch]
                    .compactMap { $0?.lowercased() }
                    .joined(separator: " ")
                if !hay.contains(lower) { return false }
            }
            return true
        }
    }

    /// Sessions grouped by gitRoot or cwd, mirroring web's
    /// `buildGroups`. Sorted: live-first within each group, groups
    /// themselves ordered by most-recent activity.
    private var groups: [SessionGroup] {
        var map: [String: [LocalSessionSummary]] = [:]
        for s in sessions {
            let key = s.gitRoot ?? s.cwd
            map[key, default: []].append(s)
        }
        let result: [SessionGroup] = map.map { key, items in
            let sorted = items.sorted { a, b in
                if a.isLive != b.isLive { return a.isLive }
                return b.modifiedTime < a.modifiedTime
            }
            let repo = items.first(where: { $0.repository != nil })?.repository
            return SessionGroup(
                path: key,
                repository: repo,
                sessions: sorted,
                liveCount: items.filter { $0.isLive }.count
            )
        }
        return result.sorted { ($0.sessions.first?.modifiedTime ?? "") > ($1.sessions.first?.modifiedTime ?? "") }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if tentacles.count > 1 {
                    devicePicker
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                }
                filterBar
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)

                if isLoading {
                    loadingView
                } else if sessions.isEmpty {
                    emptyView
                } else {
                    sessionList
                }
            }
            .navigationTitle("Import session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear { refresh() }
        .onChange(of: deviceId) { _, _ in refresh() }
    }

    // MARK: - Top controls

    @ViewBuilder
    private var devicePicker: some View {
        Picker("Device", selection: Binding(
            get: { selectedDeviceId ?? tentacles.first?.id ?? "" },
            set: { selectedDeviceId = $0 }
        )) {
            ForEach(tentacles, id: \.id) { d in
                Text(d.name).tag(d.id)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var filterBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.tertiary)
                TextField("Search summary, path, branch…", text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !search.isEmpty {
                    Button {
                        search = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            HStack(spacing: 12) {
                Toggle("Live only", isOn: $liveOnly)
                    .font(.caption)
                Toggle("Include imported", isOn: $includeLinked)
                    .font(.caption)
            }
            .toggleStyle(.button)
        }
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.large)
            Text("Scanning local sessions…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: 8) {
            Text("🕳")
                .font(.system(size: 40))
            Text("No local sessions found")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if !search.isEmpty || liveOnly {
                Button("Clear filters") {
                    search = ""
                    liveOnly = false
                }
                .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - List

    private var sessionList: some View {
        List {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { s in
                        Button {
                            importSession(s)
                        } label: {
                            sessionRow(s)
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    sectionHeader(for: group)
                }
            }
        }
        .listStyle(.plain)
    }

    @ViewBuilder
    private func sectionHeader(for group: SessionGroup) -> some View {
        HStack(spacing: 6) {
            Image(systemName: group.repository != nil ? "shippingbox" : "folder")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(group.displayLabel)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            if group.liveCount > 0 {
                Text("\(group.liveCount) live")
                    .font(.caption2)
                    .foregroundStyle(.green)
            }
            Spacer()
            Text("\(group.sessions.count)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func sessionRow(_ s: LocalSessionSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if s.isLive {
                    Circle().fill(.green).frame(width: 6, height: 6)
                }
                Text(s.summary?.isEmpty == false ? s.summary! : "(no summary)")
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer()
                if s.linkedKrakiSessionId != nil {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            HStack(spacing: 6) {
                if let branch = s.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let model = s.model {
                    Text(model)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text(SessionTimeFormatter.format(s.modifiedTime))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 4)
    }

    // MARK: - Actions

    private func refresh() {
        guard let deviceId else { return }
        commandSender?.requestLocalSessions(
            targetDeviceId: deviceId,
            search: nil,
            liveOnly: false,
            includeLinked: true  // we filter client-side
        )
    }

    private func importSession(_ s: LocalSessionSummary) {
        guard let deviceId else { return }
        // If the session is already linked, jump straight into the
        // existing Kraki session instead of re-importing.
        if let linked = s.linkedKrakiSessionId {
            sessionStore.navigateToSession = linked
            dismiss()
            return
        }
        var meta: [String: Any] = [
            "cwd": s.cwd,
            "startTime": s.startTime,
            "source": s.source.rawValue,
        ]
        if let summary = s.summary { meta["summary"] = summary }
        if let model = s.model { meta["model"] = model }
        if let branch = s.branch { meta["branch"] = branch }
        commandSender?.importSession(
            localSessionId: s.sessionId,
            targetDeviceId: deviceId,
            meta: meta
        )
        dismiss()
    }
}

// MARK: - Grouping helper

private struct SessionGroup: Identifiable {
    let path: String
    let repository: String?
    let sessions: [LocalSessionSummary]
    let liveCount: Int

    var id: String { path }

    var displayLabel: String {
        if let repository {
            return repository.split(separator: "/").last.map(String.init) ?? repository
        }
        if path.isEmpty || path == "/" { return "System" }
        let parts = path.split(separator: "/").filter { !$0.isEmpty }
        return parts.last.map(String.init) ?? path
    }
}

#endif
