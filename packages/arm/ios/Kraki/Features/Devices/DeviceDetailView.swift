#if os(iOS)
/// DeviceDetailView — Full device info panel with models, sessions, and removal.
///
/// Mirrors DevicePanel.tsx. Shows device metadata, supported models,
/// sessions on the device, and a remove button for offline non-current devices.

import SwiftUI

struct DeviceDetailView: View {
    @Environment(AppState.self) private var appState
    let device: DeviceSummary

    @State private var showRemoveConfirmation = false
    @State private var modelsExpanded = false

    private var isCurrentDevice: Bool {
        device.id == appState.deviceId
    }

    private var models: [String]? {
        appState.deviceStore.deviceModels[device.id]
    }

    private var version: String? {
        appState.deviceStore.deviceVersions[device.id]
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
    }

    private var statusLabel: String {
        if device.online, let m = models, !m.isEmpty { return "Online" }
        if device.online { return "Connecting…" }
        return "Offline"
    }

    private var statusColor: Color {
        if device.online, let m = models, !m.isEmpty { return .green }
        if device.online { return .orange }
        return .gray
    }

    var body: some View {
        List {
            // Info rows
            Section {
                infoRow("Status", value: statusLabel, valueColor: statusColor)
                infoRow("Added", value: formatDate(device.createdAt))
                infoRow("Last online", value: device.online ? "Now" : formatDate(device.lastSeen))
                if let version {
                    infoRow("Version", value: version)
                }
                if isCurrentDevice {
                    infoRow("This device", value: "Yes", valueColor: Color.krakiPrimary)
                }
            }

            // Models (expandable)
            if let models, !models.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $modelsExpanded) {
                        FlowLayout(spacing: 6) {
                            ForEach(models, id: \.self) { model in
                                Text(model)
                                    .font(.caption)
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
                                    Text(session.displayTitle)
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
        .navigationDestination(for: SessionNavID.self) { nav in
            SessionDetailView(sessionId: nav.id)
                .environment(appState)
        }
        .alert("Remove Device", isPresented: $showRemoveConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) {
                appState.commandSender?.removeDevice(deviceId: device.id)
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
    /// it. Same formatter → same output ("HH:mm" / "yesterday" / "Xd
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
        guard let iso, !iso.isEmpty else { return "—" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return "—" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

// MARK: - FlowLayout

/// Simple flow layout for wrapping tags (model badges, etc.).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var height: CGFloat = 0
        for (i, row) in rows.enumerated() {
            let rowHeight = row.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
            height += rowHeight + (i > 0 ? spacing : 0)
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
            var x = bounds.minX
            for subview in row {
                let size = subview.sizeThatFits(.unspecified)
                subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += rowHeight + spacing
        }
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[LayoutSubview]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[LayoutSubview]] = [[]]
        var currentWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if currentWidth + size.width > maxWidth, !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentWidth = 0
            }
            rows[rows.count - 1].append(subview)
            currentWidth += size.width + spacing
        }
        return rows
    }
}

#endif
