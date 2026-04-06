#if os(iOS)
/// SessionInfoSheet — Detail sheet for session metadata, usage, and mode.
///
/// Presented from the session detail "more" button as a medium-detent sheet.

import SwiftUI

struct SessionInfoSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    let session: SessionInfo

    @State private var showDeleteConfirmation = false

    private var usage: SessionUsage? {
        appState.sessionStore.sessionUsage[session.id]
    }

    private var device: DeviceSummary? {
        appState.deviceStore.devices[session.deviceId]
    }

    private var version: String? {
        appState.deviceStore.deviceVersions[session.deviceId]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    sessionSection
                    usageSection
                    deviceSection
                    modeSection
                    deleteSection
                }
                .padding()
            }
            .navigationTitle("Session Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Delete Session", isPresented: $showDeleteConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    appState.commandSender?.deleteSession(sessionId: session.id)
                    dismiss()
                }
            } message: {
                Text("This will permanently delete this session and all its messages.")
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Session

    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Session")

            infoRow("Title", value: session.displayTitle)
            infoRow("Agent", value: session.agent)
            if let model = session.model {
                infoRow("Model", value: model)
            }
            infoRow("Created", value: session.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    // MARK: - Usage

    @ViewBuilder
    private var usageSection: some View {
        if let usage {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Usage")

                tokenRow("Input tokens", count: usage.inputTokens)
                tokenRow("Output tokens", count: usage.outputTokens)
                tokenRow("Cache read", count: usage.cacheReadTokens)
                tokenRow("Cache write", count: usage.cacheWriteTokens)

                Divider()

                infoRow("Total cost", value: formatCost(usage.totalCost))
                infoRow("Duration", value: formatDuration(usage.totalDurationMs))
            }
        }
    }

    // MARK: - Device

    @ViewBuilder
    private var deviceSection: some View {
        if let device {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Device")

                infoRow("Name", value: device.name)
                HStack {
                    Text("Status")
                        .foregroundStyle(.secondary)
                    Spacer()
                    HStack(spacing: 4) {
                        Circle()
                            .fill(device.online ? Color.green : Color.gray)
                            .frame(width: 6, height: 6)
                        Text(device.online ? "Online" : "Offline")
                    }
                }
                .font(.subheadline)

                if let version {
                    infoRow("Version", value: version)
                }
            }
        }
    }

    // MARK: - Mode

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Mode")

            let currentMode = appState.sessionStore.sessionModes[session.id] ?? session.mode

            HStack(spacing: 8) {
                ForEach([SessionMode.safe, .discuss, .execute, .delegate], id: \.self) { mode in
                    Button {
                        appState.commandSender?.setSessionMode(sessionId: session.id, mode: mode)
                    } label: {
                        Text(mode.rawValue.capitalized)
                            .font(.caption.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.bordered)
                    .tint(currentMode == mode ? Color.modeColor(mode) : .gray)
                }
            }
        }
    }

    // MARK: - Delete

    private var deleteSection: some View {
        Button(role: .destructive) {
            showDeleteConfirmation = true
        } label: {
            Label("Delete Session", systemImage: "trash")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(.red)
        .padding(.top, 8)
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private func infoRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }

    private func tokenRow(_ label: String, count: Int) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(formatTokenCount(count))
                .foregroundStyle(.primary)
                .monospacedDigit()
        }
        .font(.subheadline)
    }
}

#endif
