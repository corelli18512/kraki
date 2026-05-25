#if os(iOS)
/// PermissionCardView — Amber-bordered action card for tool permission requests.
///
/// Mirrors PermissionInput.tsx. Shows the tool, description, args summary,
/// and approve / allow-in-session / deny buttons.

import SwiftUI

// MARK: - Single Permission Card

struct PermissionCardView: View {
    @Environment(AppState.self) private var appState
    let permission: PendingPermission

    private var sessionMode: SessionMode {
        appState.sessionStore.sessionModes[permission.sessionId] ?? .discuss
    }

    /// Tool names that mutate the workspace; in `.discuss` mode these
    /// must be explicitly approved/denied by the user instead of
    /// auto-approving like read-only tools. Declared static so the
    /// set isn't reallocated on every body recomputation.
    private static let writeTools: Set<String> = [
        "write_file", "edit_file", "create_file", "write", "edit", "create",
    ]

    private var isWriteInDiscuss: Bool {
        sessionMode == .discuss && Self.writeTools.contains(permission.toolName ?? "")
    }

    private var argsSummary: String? {
        getArgsSummary(toolName: permission.toolName, args: permission.args)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack(alignment: .top, spacing: 8) {
                LucideIcon(.lock, size: 18, color: .orange)

                VStack(alignment: .leading, spacing: 4) {
                    Text(isWriteInDiscuss ? "Write Approval — Discuss Mode" : "Permission Request")
                        .font(.headline)
                        .foregroundStyle(.primary)

                    Text(permission.description)
                        .font(.body)
                        .foregroundStyle(.primary)

                    if let summary = argsSummary {
                        Text(summary)
                            .font(.monoSmall)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }

                    if let toolName = permission.toolName {
                        Text(toolName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospaced()
                    }
                }
            }

            Divider()

            // Button row
            HStack(spacing: 8) {
                Button {
                    appState.commandSender?.approve(sessionId: permission.sessionId, permissionId: permission.id)
                } label: {
                    Text("Approve")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)

                if isWriteInDiscuss {
                    Button {
                        // Mirror the web fix in commit cdf6139: flip
                        // mode AND approve the pending write. The two
                        // wire messages travel independently; sending
                        // mode first means any subsequent writes in
                        // the same turn ride execute without
                        // re-prompting.
                        appState.commandSender?.setSessionMode(sessionId: permission.sessionId, mode: .execute)
                        appState.commandSender?.approve(sessionId: permission.sessionId, permissionId: permission.id)
                    } label: {
                        Text("Switch to Execute")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                    .tint(.orange)
                } else {
                    Button {
                        appState.commandSender?.alwaysAllow(sessionId: permission.sessionId, permissionId: permission.id, toolKind: permission.toolName)
                    } label: {
                        Text("Allow in Session")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                    .tint(.blue)
                }

                Button {
                    appState.commandSender?.deny(sessionId: permission.sessionId, permissionId: permission.id)
                } label: {
                    Text("Deny")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        }
        .padding()
        .background(Color.orange.opacity(0.05))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.orange)
                .frame(height: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .sensoryFeedback(.impact(flexibility: .solid, intensity: 0.5), trigger: permission.id)
    }
}

// MARK: - Stacked Permissions

/// Scrollable stack of pending permission cards for a session.
struct PermissionStackView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    private var permissions: [PendingPermission] {
        appState.messageStore.permissionsForSession(sessionId)
            .sorted { $0.timestamp < $1.timestamp }
    }

    var body: some View {
        if !permissions.isEmpty {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(permissions) { permission in
                        PermissionCardView(permission: permission)
                    }
                }
                .padding(.horizontal)
            }
            .frame(maxHeight: WindowSize.height * 0.4)
        }
    }
}

#endif
