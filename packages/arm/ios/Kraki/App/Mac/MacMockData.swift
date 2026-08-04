/// MockData+macOS — Seeds AppState with realistic-looking sessions,
/// devices, previews, and a signed-in user so the mac UI can be
/// iterated on without going through the live login + pairing flow.
///
/// Active only when `Kraki-MacMock=1` launch arg is set (default in
/// debug builds). Lives entirely on the mac side; iOS never compiles
/// this file.

#if os(macOS)
import Foundation

@MainActor
enum MacMockData {
    /// Seed the given AppState with mock content. Idempotent — safe
    /// to call multiple times; later calls overwrite earlier seeds.
    static func install(into appState: AppState) {
        installUser(appState)
        installDevices(appState)
        installSessions(appState)
        installPreviews(appState)
        installDrafts(appState)
    }

    // MARK: - User

    private static func installUser(_ appState: AppState) {
        appState.user = UserInfo(
            id: "user-mock-1",
            login: "corelli",
            provider: "github",
            email: "corelli@kraki.chat",
            preferences: nil
        )
        appState.deviceId = "dev-mac-corelli-001abcdef0123456"
        appState.hasStoredCredentials = true
        appState.connectionStatus = .connected
        appState.githubClientId = "Iv1.mockclientid01234"
    }

    // MARK: - Devices

    private static func installDevices(_ appState: AppState) {
        let devices: [DeviceSummary] = [
            DeviceSummary(
                id: "dev-mac-corelli-001abcdef0123456",
                name: "Corelli's MacBook",
                role: .app,
                kind: .desktop,
                publicKey: nil,
                encryptionKey: nil,
                online: true,
                lastSeen: ISO8601Mock.format(Date()),
                createdAt: ISO8601Mock.format(Date(timeIntervalSinceNow: -86_400 * 30))
            ),
            DeviceSummary(
                id: "dev-tentacle-studio-mac",
                name: "Studio Mac",
                role: .tentacle,
                kind: .desktop,
                publicKey: nil,
                encryptionKey: nil,
                online: true,
                lastSeen: ISO8601Mock.format(Date()),
                createdAt: ISO8601Mock.format(Date(timeIntervalSinceNow: -86_400 * 14))
            ),
            DeviceSummary(
                id: "dev-tentacle-cloud-vm",
                name: "Cloud VM (us-east-1)",
                role: .tentacle,
                kind: .vm,
                publicKey: nil,
                encryptionKey: nil,
                online: true,
                lastSeen: ISO8601Mock.format(Date()),
                createdAt: ISO8601Mock.format(Date(timeIntervalSinceNow: -86_400 * 7))
            ),
            DeviceSummary(
                id: "dev-tentacle-iphone",
                name: "iPhone 16 Pro",
                role: .tentacle,
                kind: .ios,
                publicKey: nil,
                encryptionKey: nil,
                online: false,
                lastSeen: ISO8601Mock.format(Date(timeIntervalSinceNow: -3_600 * 2)),
                createdAt: ISO8601Mock.format(Date(timeIntervalSinceNow: -86_400 * 3))
            ),
        ]
        for d in devices {
            appState.deviceStore.devices[d.id] = d
        }

        appState.deviceStore.deviceModels["dev-tentacle-studio-mac"] = [
            "claude-sonnet-4.6", "claude-opus-4.7", "gpt-5.4", "gpt-5.3-codex"
        ]
        appState.deviceStore.deviceModels["dev-tentacle-cloud-vm"] = [
            "claude-sonnet-4.6", "gpt-5.4-mini", "gemini-3.1-pro-preview"
        ]
        appState.deviceStore.deviceModels["dev-tentacle-iphone"] = ["claude-sonnet-4.6"]

        appState.deviceStore.deviceModelDetails["dev-tentacle-studio-mac"] = [
            ModelDetail(id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",
                        supportsReasoningEffort: false,
                        supportedReasoningEfforts: nil,
                        defaultReasoningEffort: nil,
                        contextWindow: 200_000),
            ModelDetail(id: "claude-opus-4.7", name: "Claude Opus 4.7",
                        supportsReasoningEffort: true,
                        supportedReasoningEfforts: [.low, .medium, .high, .xhigh],
                        defaultReasoningEffort: .medium,
                        contextWindow: 200_000),
            ModelDetail(id: "gpt-5.4", name: "GPT-5.4",
                        supportsReasoningEffort: true,
                        supportedReasoningEfforts: [.low, .medium, .high, .xhigh],
                        defaultReasoningEffort: .medium,
                        contextWindow: 400_000),
            ModelDetail(id: "gpt-5.3-codex", name: "GPT-5.3 Codex",
                        supportsReasoningEffort: true,
                        supportedReasoningEfforts: [.low, .medium, .high],
                        defaultReasoningEffort: .high,
                        contextWindow: 400_000),
        ]
    }

    // MARK: - Sessions

    private static func installSessions(_ appState: AppState) {
        let now = Date()
        let studio = "dev-tentacle-studio-mac"
        let studioName = "Studio Mac"
        let cloud  = "dev-tentacle-cloud-vm"
        let cloudName = "Cloud VM"
        let phone  = "dev-tentacle-iphone"
        let phoneName = "iPhone 16 Pro"

        let sessions: [SessionInfo] = [
            // Pinned + live tool running
            SessionInfo(
                id: "sess-mock-1",
                deviceId: studio, deviceName: studioName,
                agent: "claude",
                model: "claude-sonnet-4.6",
                title: "Mac sidebar reskin",
                autoTitle: nil,
                state: .active,
                mode: .execute,
                lastSeq: 142, readSeq: 138, messageCount: 142,
                createdAt: now.addingTimeInterval(-3_600 * 4),
                pinned: true,
                currentToolName: "shell",
                currentToolHeadline: "$ xcodebuild -scheme KrakiMac",
                activity: .toolRunning(toolName: "shell",
                                       headline: "$ xcodebuild -scheme KrakiMac")
            ),
            // Pinned + idle, has draft
            SessionInfo(
                id: "sess-mock-2",
                deviceId: studio, deviceName: studioName,
                agent: "copilot",
                model: "gpt-5.4",
                title: "ChatView refactor",
                autoTitle: nil,
                state: .idle,
                mode: .discuss,
                lastSeq: 87, readSeq: 87, messageCount: 87,
                createdAt: now.addingTimeInterval(-86_400),
                pinned: true
            ),
            // Active + pending question
            SessionInfo(
                id: "sess-mock-3",
                deviceId: cloud, deviceName: cloudName,
                agent: "codex",
                model: "gpt-5.3-codex",
                title: nil,
                autoTitle: "Migrate sessions table to v3 schema",
                state: .active,
                mode: .safe,
                lastSeq: 24, readSeq: 18, messageCount: 24,
                createdAt: now.addingTimeInterval(-1_200),
                pinned: false,
                activity: .agentText("Drafting migration plan…")
            ),
            // Active + pending permission
            SessionInfo(
                id: "sess-mock-4",
                deviceId: studio, deviceName: studioName,
                agent: "claude",
                model: "claude-opus-4.7",
                title: "Refactor ToolStatusIcon",
                autoTitle: nil,
                state: .active,
                mode: .delegate,
                lastSeq: 56, readSeq: 50, messageCount: 56,
                createdAt: now.addingTimeInterval(-2_400),
                pinned: false,
                currentToolName: "patch",
                currentToolHeadline: "Edit Kraki/Shared/ToolStatusIcon.swift",
                activity: .toolRunning(toolName: "patch",
                                       headline: "Edit Kraki/Shared/ToolStatusIcon.swift")
            ),
            // Idle, recent
            SessionInfo(
                id: "sess-mock-5",
                deviceId: cloud, deviceName: cloudName,
                agent: "claude",
                model: "claude-sonnet-4.6",
                title: nil,
                autoTitle: "Investigate flaky session-restore test",
                state: .idle,
                mode: .discuss,
                lastSeq: 31, readSeq: 31, messageCount: 31,
                createdAt: now.addingTimeInterval(-7_200),
                pinned: false
            ),
            // Idle, older
            SessionInfo(
                id: "sess-mock-6",
                deviceId: phone, deviceName: phoneName,
                agent: "copilot",
                model: "gpt-5.4-mini",
                title: "Quick MCP server prototype",
                autoTitle: nil,
                state: .idle,
                mode: .execute,
                lastSeq: 12, readSeq: 12, messageCount: 12,
                createdAt: now.addingTimeInterval(-86_400 * 2),
                pinned: false
            ),
            // Idle, completed earlier today
            SessionInfo(
                id: "sess-mock-7",
                deviceId: studio, deviceName: studioName,
                agent: "codex",
                model: "gpt-5.4",
                title: nil,
                autoTitle: "Add darwin notification routing",
                state: .idle,
                mode: .execute,
                lastSeq: 64, readSeq: 64, messageCount: 64,
                createdAt: now.addingTimeInterval(-86_400 * 1.3),
                pinned: false,
                activity: .toolComplete(toolName: "shell",
                                        headline: "$ swift test --filter Notif",
                                        success: true)
            ),
            // Older idle
            SessionInfo(
                id: "sess-mock-8",
                deviceId: studio, deviceName: studioName,
                agent: "claude",
                model: "claude-sonnet-4.6",
                title: "Tentacle CLI JSON output",
                autoTitle: nil,
                state: .idle,
                mode: .delegate,
                lastSeq: 211, readSeq: 211, messageCount: 211,
                createdAt: now.addingTimeInterval(-86_400 * 3),
                pinned: false
            ),
        ]

        for s in sessions {
            appState.sessionStore.sessions[s.id] = s
        }
        appState.sessionStore.pinnedSessions = Set(sessions.filter(\.pinned).map(\.id))
        appState.sessionStore.activeSessionId = "sess-mock-1"
    }

    // MARK: - Previews

    private static func installPreviews(_ appState: AppState) {
        let now = Date()
        let previews: [String: SessionPreview] = [
            "sess-mock-1": SessionPreview(
                text: "Building KrakiMac (target: macOS) — link step 12 of 14…",
                type: "tool",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-15))
            ),
            "sess-mock-2": SessionPreview(
                text: "ChatListViewController separation looks good. The thread height cache should live on the renderer, not the controller.",
                type: "message",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-3_600 * 4))
            ),
            "sess-mock-3": SessionPreview(
                text: "Should I drop the legacy `messages_v2` table after the migration runs, or keep it as a fallback for one release?",
                type: "question",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-180))
            ),
            "sess-mock-4": SessionPreview(
                text: "Allow patch on ToolStatusIcon.swift?",
                type: "permission",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-90))
            ),
            "sess-mock-5": SessionPreview(
                text: "The flake comes from the in-memory SQLite cache — when two sessions race the snapshot reads, the older one wins.",
                type: "message",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-7_200))
            ),
            "sess-mock-6": SessionPreview(
                text: "Stub the MCP `tools/list` reply with the current tool registry.",
                type: "message",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-86_400 * 2))
            ),
            "sess-mock-7": SessionPreview(
                text: "Tests passed. Notifications now dispatch through MacAppDelegate.",
                type: "message",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-86_400 * 1.3))
            ),
            "sess-mock-8": SessionPreview(
                text: "Shipped: `kraki status --json` now emits the full daemon snapshot.",
                type: "message",
                timestamp: ISO8601Mock.format(now.addingTimeInterval(-86_400 * 3))
            ),
        ]
        for (k, v) in previews {
            appState.sessionStore.sessionPreviews[k] = v
        }
    }

    // MARK: - Drafts

    private static func installDrafts(_ appState: AppState) {
        appState.sessionStore.drafts["sess-mock-2"] = "I think we should split the ChatRenderer into a thread-cached layer and a stateless message renderer so the diff cost shrinks…"
    }
}

// MARK: - ISO8601 helper shim
//
// `ISO8601` is the project's own helper (Core/Helpers); it parses
// strings into Date and formats Dates back. We add a `format` method
// shim only if the project's helper doesn't expose one — this avoids
// fighting whatever signature already exists.

private enum ISO8601Mock {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static func format(_ date: Date) -> String { formatter.string(from: date) }
}
#endif
