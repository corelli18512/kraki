#if os(iOS)
/// DeviceDetailView — Full device info panel with models, sessions, and removal.
///
/// Mirrors DevicePanel.tsx. Shows device metadata, supported models,
/// sessions on the device, and a remove button for offline non-current devices.

import SwiftUI

struct DeviceDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    private let deviceId: String
    /// Shown for the moment between the device leaving the account and this
    /// page closing; set once, when the page opens.
    @State private var lastKnown: DeviceSummary

    init(device: DeviceSummary) {
        deviceId = device.id
        _lastKnown = State(initialValue: device)
    }

    /// Live from the store, so a rename (from here or any other device) shows.
    private var device: DeviceSummary { appState.deviceStore.devices[deviceId] ?? lastKnown }

    /// Removed (here or from another device): the page closes rather than
    /// staying open on a device that is gone (K-193).
    private var isRemoved: Bool { appState.deviceStore.devices[deviceId] == nil }

    @State private var showRemoveConfirmation = false
    @State private var showRename = false
    @State private var nameDraft = ""
    @State private var modelsExpanded = false
    /// Rename/Remove could not be sent (relay link down): said here instead
    /// of dropping the action silently (K-025).
    @State private var actionError: String?

    private var isCurrentDevice: Bool {
        device.id == appState.deviceId
    }

    private var models: [String]? {
        let list = appState.deviceStore.models(for: device.id)
        return list.isEmpty ? nil : list
    }

    private var agentNames: String {
        appState.deviceStore.agents(for: device.id).map { AgentInfo.from($0.id).label }.joined(separator: ", ")
    }

    private var version: String? {
        appState.deviceStore.displayVersion(for: device.id)
    }

    private var deviceSessions: [SessionInfo] {
        // Match the session list ordering exactly: pinned first, then
        // most recent activity (preview timestamp), then createdAt.
        // Filtered down to this device.
        let previews = appState.sessionStore.sessionPreviews
        return appState.sessionStore.sessions.values
            .filter { $0.deviceId == device.id }
            .sorted { a, b in
                if a.pinned != b.pinned { return a.pinned }
                let aTs = previews[a.id]?.timestamp ?? ""
                let bTs = previews[b.id]?.timestamp ?? ""
                if aTs != bTs { return bTs < aTs }
                return a.createdAt > b.createdAt
            }
    }

    private var canRemove: Bool {
        !device.online && !isCurrentDevice
            && !DeviceUpdateSection.blocksRemoval(appState.deviceStore.updateProgress[device.id], now: Date())
    }

    private var statusLabel: String {
        if appState.deviceStore.isOnlineAndGreeted(device.id) { return String(localized: "Online") }
        if device.online { return String(localized: "Connecting…") }
        return String(localized: "Offline")
    }

    private var statusColor: Color {
        if appState.deviceStore.isOnlineAndGreeted(device.id) { return .green }
        if device.online { return .orange }
        return .gray
    }

    var body: some View {
        List {
            if let actionError {
                Section {
                    Label(actionError, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("device.actionError")
                }
            }

            // Info rows
            Section {
                Button {
                    nameDraft = device.name
                    showRename = true
                } label: {
                    HStack {
                        Text("Name").foregroundStyle(.secondary)
                        Spacer()
                        Text(verbatim: device.name).foregroundStyle(.primary).lineLimit(1)
                        Image(systemName: "pencil").font(.caption).foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
                .accessibilityLabel("Rename \(device.name)")
                .accessibilityIdentifier("device.rename")
                infoRow(String(localized: "Status"), value: statusLabel, valueColor: statusColor)
                if !agentNames.isEmpty {
                    infoRow(String(localized: "Coding agents"), value: agentNames)
                } else if appState.deviceStore.agentAvailability(for: device.id) == .noAgents {
                    infoRow(String(localized: "Coding agents"), value: String(localized: "None installed"))
                }
                if DeviceDates.parse(device.createdAt) != nil {
                    infoRow(String(localized: "Added"), value: formatDate(device.createdAt))
                }
                infoRow(String(localized: "Last online"), value: device.online ? String(localized: "Now") : formatDate(device.lastSeen))
                if let version {
                    infoRow(String(localized: "Version"), value: version)
                }
            }

            if DeviceUpdateSection.isShown(appState.deviceStore, device.id) {
                DeviceUpdateSection(device: device)
            }

            // Subscription accounts signed in on this device. Each account's card in
            // Devices › Accounts merges it across every device that shares it.
            // As in Devices: only when an account has reported, never as an
            // empty card with a Refresh button.
            let accounts = appState.deviceStore.usageForDevice(device.id)
            if device.online, !accounts.isEmpty {
                Section {
                    ForEach(accounts) { reading in
                        AccountUsageRow(merged: reading)
                    }
                } header: {
                    AccountUsageSectionHeader(deviceIds: [device.id])
                } footer: {
                    AccountUsageRefreshNotice(deviceIds: [device.id])
                }
            }

            // Models (expandable)
            if let models, !models.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $modelsExpanded) {
                        FlowLayout(spacing: 6) {
                            ForEach(models, id: \.self) { model in
                                Text(verbatim: model)
                                    .font(.caption)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(Color(.systemGray6))
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, -16)
                    } label: {
                        Text("Supported Models (\(models.count))")
                            .font(.subheadline)
                    }
                }
            }

            // Sessions (native list rows, no title)
            Section {
                if deviceSessions.isEmpty {
                    Text("No sessions on this device")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(deviceSessions) { session in
                        NavigationLink(value: SessionNavID(id: session.id)) {
                            HStack {
                                AgentAvatar(agent: session.agent, sessionId: session.id, size: .sm, status: session.state)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(verbatim: session.displayTitle)
                                        .font(.subheadline)
                                        .lineLimit(1)
                                    Text(sessionListTimestamp(for: session))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                    }
                }
            }

            // Remove
            if canRemove {
                Section {
                    Button(role: .destructive) {
                        showRemoveConfirmation = true
                    } label: {
                        Label("Remove Device", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 0)
        .background(Color.surfacePrimary)
        .navigationTitle(device.name)
        .navigationBarTitleDisplayMode(.inline)
        .hidesTabBar()
        .onChange(of: isRemoved, initial: true) { _, removed in
            if removed { dismiss() }
        }
        .navigationDestination(for: SessionNavID.self) { nav in
            SessionDetailView(sessionId: nav.id)
                .id(nav.id)
                .environment(appState)
        }
        .alert("Rename Device", isPresented: $showRename) {
            TextField(device.ownName, text: $nameDraft)
                .onChange(of: nameDraft) { _, value in
                    let clamped = DeviceName.clampDraft(value)
                    if clamped != value { nameDraft = clamped }
                }
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                if let name = DeviceName.renameValue(draft: nameDraft, for: device) {
                    let sent = appState.commandSender?.renameDevice(deviceId: device.id, name: name) ?? false
                    actionError = sent ? nil : String(localized: "Couldn't rename the device while offline. Try again when connected.")
                }
            }
        } message: {
            Text("Shown on all your devices. Leave it empty to use \"\(device.ownName)\".")
        }
        .alert("Remove Device", isPresented: $showRemoveConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) {
                let sent = appState.commandSender?.removeDevice(deviceId: device.id) ?? false
                actionError = sent ? nil : String(localized: "Couldn't remove the device while offline. Try again when connected.")
            }
        } message: {
            Text("Are you sure you want to remove \(device.name)? The device will need to reconnect and re-authenticate to appear again.")
        }
    }

    // MARK: - Info Row

    private func infoRow(_ label: String, value: String, valueColor: Color = .primary) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(valueColor)
        }
        .font(.subheadline)
    }

    // MARK: - Helpers

    /// Mirrors SessionCardView's `timestampView`: prefer the preview's
    /// last-activity timestamp; fall back to converting `createdAt`
    /// (which is a `Date`) into ISO so SessionTimeFormatter can read
    /// it. Same formatter → same output (short time / "yesterday" / "Xd
    /// ago") as the session list, keeping the two views in sync.
    private func sessionListTimestamp(for session: SessionInfo) -> String {
        if let preview = appState.sessionStore.sessionPreviews[session.id],
           !preview.timestamp.isEmpty {
            return SessionTimeFormatter.format(preview.timestamp)
        }
        return SessionTimeFormatter.format(Self.isoFormatter.string(from: session.createdAt))
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func formatDate(_ iso: String?) -> String {
        guard let date = DeviceDates.parse(iso) else { return "—" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

// MARK: - FlowLayout

/// Simple flow layout for wrapping tags (model badges, etc.). A tag wider
/// than the row is offered the row's width instead of overflowing it (K-190).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var height: CGFloat = 0
        for (i, row) in rows.enumerated() {
            let rowHeight = row.map(\.size.height).max() ?? 0
            height += rowHeight + (i > 0 ? spacing : 0)
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: ProposedViewSize(width: bounds.width, height: nil), subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map(\.size.height).max() ?? 0
            var x = bounds.minX
            for item in row {
                item.subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += rowHeight + spacing
        }
    }

    /// Each tag at its ideal size, capped to the available width.
    private func size(of subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        guard ideal.width > maxWidth else { return ideal }
        return subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[(subview: LayoutSubview, size: CGSize)]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[(subview: LayoutSubview, size: CGSize)]] = [[]]
        var currentWidth: CGFloat = 0

        for subview in subviews {
            let size = size(of: subview, maxWidth: maxWidth)
            if currentWidth + size.width > maxWidth, !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentWidth = 0
            }
            rows[rows.count - 1].append((subview, size))
            currentWidth += size.width + spacing
        }
        return rows
    }
}

#endif
