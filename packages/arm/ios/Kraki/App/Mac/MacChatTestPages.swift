#if os(macOS) && DEBUG
import AppKit
import Observation
import SwiftUI

/// Full production MainWindowView running against a cached, privacy-safe copy
/// of production-shaped Session/Device/message data. No custom list, mock
/// pagination or fixture-only layout exists here.
struct MacChatPerfTestView: View {
    @Environment(AppState.self) private var production
    @State private var snapshot: AppState?
    @State private var tentacleCLI = TentacleCLIManager()
    @State private var snapshotError: String?

    var body: some View {
        Group {
            if let snapshot {
                MainWindowView(
                    initialSelectedSessionId: snapshot.sessionStore.activeSessionId
                )
                    .environment(snapshot)
                    .environment(tentacleCLI)
            } else if let snapshotError {
                ContentUnavailableView(
                    "Unable to build mock Chat snapshot",
                    systemImage: "exclamationmark.triangle",
                    description: Text(snapshotError)
                )
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Preparing production-shaped mock data…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfacePrimary)
            }
        }
        .task {
            guard snapshot == nil, snapshotError == nil else { return }
            do {
                let built = try await MacChatMockSnapshotCache.shared.snapshot(from: production)
                snapshot = built
            } catch {
                snapshotError = error.localizedDescription
            }
        }
    }
}

// MARK: - Production Chat scenario page

/// A catalog of isolated protocol/store states rendered by the real macOS
/// MainWindowView, MacChatView, ChatViewModel, TurnSpineProjection, virtualized
/// AppKit list, cached CoreText cells, Composer, and action slots.
///
/// The slim control rail is test-only. Everything below it is the production
/// page. Scenario mutations land in the real stores/DB and real CommandSender
/// output is round-tripped by a Debug-only local responder instead of a Relay.
struct MacChatScenarioTestView: View {
    let selectionScope: String?

    @State private var harness: MacChatScenarioHarness?
    @State private var tentacleCLI = TentacleCLIManager()
    @State private var loadError: String?

    init(selectionScope: String? = nil) {
        self.selectionScope = selectionScope
    }

    var body: some View {
        Group {
            if let harness {
                VStack(spacing: 0) {
                    MacChatScenarioControlBar(harness: harness)
                    Rectangle()
                        .fill(Color.borderPrimary.opacity(0.7))
                        .frame(height: 1)
                    MainWindowView(
                        initialSelectedSessionId: harness.initialScenarioID,
                        selectionNotificationScope: selectionScope
                    )
                        .environment(harness.appState)
                        .environment(tentacleCLI)
                }
                .background(Color.surfacePrimary)
            } else if let loadError {
                ContentUnavailableView(
                    "Unable to build Chat scenarios",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadError)
                )
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Building isolated production Chat scenarios…")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfacePrimary)
            }
        }
        .task {
            guard harness == nil, loadError == nil else { return }
            do {
                let built = try MacChatScenarioHarness.make(selectionScope: selectionScope)
                harness = built
                // MainWindowView owns selection in SceneStorage. Post the
                // semantic selection after its view tree mounts so a stale
                // value restored from another Debug window cannot leave this
                // isolated catalog on Welcome.
                try? await Task.sleep(for: .milliseconds(120))
                built.selectScenario(built.initialScenarioID)
            } catch {
                loadError = error.localizedDescription
            }
        }
    }
}

private struct MacChatScenarioControlBar: View {
    let harness: MacChatScenarioHarness

    private var selected: MacChatScenarioDefinition? { harness.activeScenario }
    private var phaseCount: Int { selected?.phases.count ?? 1 }
    private var phaseIndex: Int { harness.activePhaseIndex }

    var body: some View {
        VStack(spacing: 5) {
            HStack(spacing: 8) {
                Label("Real Chat Scenarios", systemImage: "rectangle.3.group.bubble.left")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textTitle)

                Text("\(harness.scenarios.count) cases")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.textMuted)

                Divider().frame(height: 18)

                Button {
                    harness.selectAdjacentScenario(-1)
                } label: {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(.borderless)
                .help("Previous scenario")

                Menu {
                    ForEach(harness.scenarioCategories, id: \.self) { category in
                        Section(category) {
                            ForEach(harness.scenarios.filter { $0.category == category }) { scenario in
                                Button(scenario.title) { harness.selectScenario(scenario.id) }
                            }
                        }
                    }
                } label: {
                    Text(selected?.title ?? "Select a scenario")
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                        .frame(maxWidth: 330, alignment: .leading)
                }
                .menuStyle(.borderlessButton)
                .fixedSize(horizontal: false, vertical: true)

                Button {
                    harness.selectAdjacentScenario(1)
                } label: {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(.borderless)
                .help("Next scenario")

                Divider().frame(height: 18)

                Button { harness.stepActiveScenario(-1) } label: {
                    Image(systemName: "backward.end")
                }
                .buttonStyle(.borderless)
                .disabled(phaseIndex == 0 || phaseCount <= 1)
                .help("Previous phase")

                Text("\(phaseIndex + 1)/\(phaseCount)")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 38)

                Button { harness.stepActiveScenario(1) } label: {
                    Image(systemName: "forward.end")
                }
                .buttonStyle(.borderless)
                .disabled(phaseIndex + 1 >= phaseCount || phaseCount <= 1)
                .help("Next phase")

                Button {
                    harness.isPlaying ? harness.stopPlaying() : harness.playActiveScenario()
                } label: {
                    Image(systemName: harness.isPlaying ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.borderless)
                .disabled(phaseCount <= 1)
                .help(harness.isPlaying ? "Stop scenario" : "Play all phases")

                Button { harness.resetActiveScenario() } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(.borderless)
                .help("Reset selected scenario")

                Spacer(minLength: 8)

                Menu {
                    Button("Same Tentacle: A → B → A") {
                        harness.rapidSwitch(crossTentacle: false)
                    }
                    Button("Cross Tentacle: A → C → A") {
                        harness.rapidSwitch(crossTentacle: true)
                    }
                    Divider()
                    Button("Pending session · starting") {
                        harness.showPendingSession(failed: false)
                    }
                    Button("Pending session · failed") {
                        harness.showPendingSession(failed: true)
                    }
                } label: {
                    Label("Transitions", systemImage: "arrow.triangle.swap")
                        .font(.system(size: 11, weight: .medium))
                }
                .menuStyle(.borderlessButton)

                Button {
                    harness.isConnected ? harness.disconnect() : harness.reconnect()
                } label: {
                    Label(
                        harness.isConnected ? "Disconnect" : "Reconnect",
                        systemImage: harness.isConnected ? "bolt.horizontal.circle" : "arrow.clockwise.circle"
                    )
                    .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)
            }

            HStack(spacing: 8) {
                Text(selected?.summary ?? "Select a Session in the real sidebar.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)

                Spacer(minLength: 12)

                if let phase = harness.activePhase {
                    Text(phase.name)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.krakiPrimary)
                        .lineLimit(1)
                }

                Circle()
                    .fill(harness.isConnected ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(harness.connectionLabel)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.textMuted)

                if let event = harness.eventLog.last {
                    Text(event)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(Color.textMuted)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .frame(maxWidth: 280, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(height: 58)
        .background(.bar)
    }
}

struct MacChatScenarioPhase {
    let name: String
    var messages: [ChatMessage]
    var card: MessageStore.SessionCard?
    var sessionState: SessionState
    var runtimeStatus: SessionRuntimeStatus
    var deviceOnline: Bool
    var preview: SessionPreview?
    var readSeq: Int?
    var authoritativeLastSeq: Int?
    var loadingHead: Bool
    var sidebarDraft: String?
}

struct MacChatScenarioDefinition: Identifiable {
    let id: String
    let category: String
    let title: String
    let summary: String
    let deviceID: String
    let mode: SessionMode
    let pinned: Bool
    let phases: [MacChatScenarioPhase]
    let traces: [Int: [ChatMessage]]
    let ordinal: Int
}

struct MacChatScenarioAttachmentFixture {
    let id: String
    let mimeType: String
    let data: Data
}

@Observable
final class MacChatScenarioHarness {
    static let onlineDeviceA = "scenario-tentacle-a"
    static let onlineDeviceB = "scenario-tentacle-b"
    static let offlineDevice = "scenario-tentacle-offline"

    let appState: AppState
    let scenarios: [MacChatScenarioDefinition]
    let initialScenarioID: String

    var phaseIndices: [String: Int] = [:]
    var isPlaying = false
    var eventLog: [String] = []

    @ObservationIgnored private let selectionScope: String?
    @ObservationIgnored private var currentStates: [String: MacChatScenarioPhase] = [:]
    @ObservationIgnored private var playTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private let attachmentFixtures: [MacChatScenarioAttachmentFixture]

    var scenarioCategories: [String] {
        var seen = Set<String>()
        return scenarios.compactMap { seen.insert($0.category).inserted ? $0.category : nil }
    }

    var activeScenario: MacChatScenarioDefinition? {
        guard let id = appState.sessionStore.activeSessionId else { return nil }
        return scenarios.first { $0.id == id }
    }

    var activePhaseIndex: Int {
        guard let id = activeScenario?.id else { return 0 }
        return phaseIndices[id] ?? 0
    }

    var activePhase: MacChatScenarioPhase? {
        guard let scenario = activeScenario else { return nil }
        return scenario.phases[min(activePhaseIndex, scenario.phases.count - 1)]
    }

    var isConnected: Bool { appState.connectionStatus == .connected }

    var connectionLabel: String {
        switch appState.connectionStatus {
        case .connected: return "CONNECTED"
        case .connecting: return "CONNECTING"
        case .authenticating: return "AUTHENTICATING"
        case .disconnected: return "RECONNECTING · \(appState.reconnectAttempt)"
        case .error: return "ERROR"
        case .awaitingLogin: return "SIGNED OUT"
        }
    }

    static func make(selectionScope: String?) throws -> MacChatScenarioHarness {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-mac-chat-scenarios-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let app = AppState(testDatabase: database)
        let catalog = buildCatalog()
        let harness = MacChatScenarioHarness(
            appState: app,
            scenarios: catalog.scenarios,
            attachments: catalog.attachments,
            selectionScope: selectionScope
        )
        harness.install()
        return harness
    }

    private init(
        appState: AppState,
        scenarios: [MacChatScenarioDefinition],
        attachments: [MacChatScenarioAttachmentFixture],
        selectionScope: String?
    ) {
        self.appState = appState
        self.scenarios = scenarios
        let requested = ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_SCENARIO_ID"]
        self.initialScenarioID = requested.flatMap { candidate in
            scenarios.contains(where: { $0.id == candidate }) ? candidate : nil
        } ?? scenarios.first?.id ?? ""
        self.attachmentFixtures = attachments
        self.selectionScope = selectionScope
    }

    private func install() {
        appState.hasStoredCredentials = true
        appState.hasCompletedInitialConnect = true
        appState.connectionStatus = .connected
        appState.reconnectAttempt = 0
        appState.deviceId = "scenario-arm"
        appState.user = UserInfo(id: "scenario-user", login: "Scenario Tester")

        installDevices()
        let requestedPhase = ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_SCENARIO_PHASE"]
            .flatMap(Int.init)
            .map { max(0, $0 - 1) }
        for scenario in scenarios {
            let index = scenario.id == initialScenarioID
                ? min(requestedPhase ?? 0, scenario.phases.count - 1)
                : 0
            phaseIndices[scenario.id] = index
            applyPhase(scenarioID: scenario.id, index: index, materializeIfActive: false)
        }
        for fixture in attachmentFixtures {
            appState.attachmentStore.seedForTesting(id: fixture.id, mimeType: fixture.mimeType, data: fixture.data)
        }

        appState.testOutboundMessageHandler = { [weak self] message, routingTarget, connectionScoped in
            self?.handleOutbound(
                message,
                routingTarget: routingTarget,
                connectionScoped: connectionScoped
            ) ?? true
        }
        for deviceID in [Self.onlineDeviceA, Self.onlineDeviceB, Self.offlineDevice] {
            appState.sessionSubscriptionController.onSessionList(tentacleId: deviceID)
        }
        appendEvent("catalog ready · \(scenarios.count) scenarios")
    }

    private func installDevices() {
        let createdAt = "2026-08-08T00:00:00.000Z"
        appState.deviceStore.devices[Self.onlineDeviceA] = DeviceSummary(
            id: Self.onlineDeviceA,
            name: "Scenario Mac A",
            role: .tentacle,
            kind: .desktop,
            publicKey: nil,
            encryptionKey: nil,
            online: true,
            lastSeen: createdAt,
            createdAt: createdAt
        )
        appState.deviceStore.devices[Self.onlineDeviceB] = DeviceSummary(
            id: Self.onlineDeviceB,
            name: "Scenario Mac B",
            role: .tentacle,
            kind: .desktop,
            publicKey: nil,
            encryptionKey: nil,
            online: true,
            lastSeen: createdAt,
            createdAt: createdAt
        )
        appState.deviceStore.devices[Self.offlineDevice] = DeviceSummary(
            id: Self.offlineDevice,
            name: "Offline Scenario Mac",
            role: .tentacle,
            kind: .desktop,
            publicKey: nil,
            encryptionKey: nil,
            online: false,
            lastSeen: createdAt,
            createdAt: createdAt
        )
        let agents = [AgentCapabilities(
            type: "code",
            id: "pi",
            models: ["claude-sonnet-4.6", "gpt-5.6-sol"],
            modelDetails: [
                ModelDetail(
                    id: "claude-sonnet-4.6",
                    name: "Claude Sonnet 4.6",
                    supportsReasoningEffort: true,
                    supportedReasoningEfforts: [.low, .medium, .high],
                    defaultReasoningEffort: .medium,
                    contextWindow: 200_000
                ),
            ]
        )]
        appState.deviceStore.deviceAgents[Self.onlineDeviceA] = agents
        appState.deviceStore.deviceAgents[Self.onlineDeviceB] = agents
        appState.deviceStore.deviceVersions[Self.onlineDeviceA] = "scenario-1.0"
        appState.deviceStore.deviceVersions[Self.onlineDeviceB] = "scenario-1.0"
    }

    func selectScenario(_ id: String) {
        guard scenarios.contains(where: { $0.id == id }) else { return }
        var userInfo: [String: Any] = ["sessionId": id]
        if let selectionScope { userInfo["scope"] = selectionScope }
        NotificationCenter.default.post(
            name: .macSelectSession,
            object: nil,
            userInfo: userInfo
        )
        appendEvent("select · \(id)")
    }

    func selectAdjacentScenario(_ delta: Int) {
        let currentID = appState.sessionStore.activeSessionId ?? initialScenarioID
        let current = scenarios.firstIndex(where: { $0.id == currentID }) ?? 0
        let next = (current + delta + scenarios.count) % scenarios.count
        selectScenario(scenarios[next].id)
    }

    func stepActiveScenario(_ delta: Int) {
        guard let scenario = activeScenario else { return }
        stopPlaying()
        let current = phaseIndices[scenario.id] ?? 0
        let next = min(max(0, current + delta), scenario.phases.count - 1)
        applyPhase(scenarioID: scenario.id, index: next, materializeIfActive: true)
    }

    func resetActiveScenario() {
        guard let id = activeScenario?.id else { return }
        stopPlaying()
        applyPhase(scenarioID: id, index: 0, materializeIfActive: true)
    }

    func playActiveScenario() {
        guard let scenario = activeScenario, scenario.phases.count > 1 else { return }
        stopPlaying()
        isPlaying = true
        let scenarioID = scenario.id
        playTask = Task { @MainActor [weak self] in
            guard let self else { return }
            self.applyPhase(scenarioID: scenarioID, index: 0, materializeIfActive: true)
            for index in 1..<scenario.phases.count {
                try? await Task.sleep(for: .milliseconds(index == scenario.phases.count - 1 ? 900 : 700))
                guard !Task.isCancelled else { return }
                self.applyPhase(scenarioID: scenarioID, index: index, materializeIfActive: true)
            }
            self.isPlaying = false
        }
    }

    func stopPlaying() {
        playTask?.cancel()
        playTask = nil
        isPlaying = false
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        appState.connectionStatus = .disconnected
        appState.reconnectAttempt = max(1, appState.reconnectAttempt + 1)
        appState.sessionSubscriptionController.onDisconnected()
        appendEvent("transport · disconnected; cards/history retained")
    }

    func reconnect() {
        reconnectTask?.cancel()
        appState.connectionStatus = .connecting
        appendEvent("transport · reconnecting")
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(650))
            guard let self, !Task.isCancelled else { return }
            self.appState.connectionStatus = .connected
            self.appState.reconnectAttempt = 0
            for deviceID in [Self.onlineDeviceA, Self.onlineDeviceB, Self.offlineDevice] {
                self.appState.sessionSubscriptionController.onSessionList(tentacleId: deviceID)
            }
            self.appendEvent("transport · connected; subscription snapshot restored")
        }
    }

    func rapidSwitch(crossTentacle: Bool) {
        stopPlaying()
        let first = "switch-live-a"
        let middle = crossTentacle ? "switch-live-c" : "switch-live-b"
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.selectScenario(first)
            try? await Task.sleep(for: .milliseconds(65))
            self.selectScenario(middle)
            try? await Task.sleep(for: .milliseconds(65))
            self.selectScenario(first)
            self.appendEvent(crossTentacle ? "rapid switch · cross Tentacle" : "rapid switch · same Tentacle")
        }
    }

    func showPendingSession(failed: Bool) {
        let id = failed ? "pending-scenario-failed" : "pending-scenario-starting"
        appState.sessionStore.addPendingSession(id)
        if failed {
            appState.sessionStore.setPendingError(
                id,
                reason: "The isolated Tentacle rejected this scenario request."
            )
        }
        appState.sessionStore.navigateToSession = id
        appendEvent(failed ? "pending · failed" : "pending · starting")
    }

    private func applyPhase(
        scenarioID: String,
        index: Int,
        materializeIfActive: Bool
    ) {
        guard let scenario = scenarios.first(where: { $0.id == scenarioID }),
              scenario.phases.indices.contains(index) else { return }
        let phase = scenario.phases[index]
        phaseIndices[scenarioID] = index
        currentStates[scenarioID] = phase

        appState.messageStore.deleteSessionMessages(scenarioID)
        if !phase.messages.isEmpty {
            appState.messageStore.persist(scenarioID, phase.messages)
        }

        let authoritativeLastSeq = phase.authoritativeLastSeq
            ?? phase.messages.map(\.seq).max()
            ?? 0
        let readSeq = min(phase.readSeq ?? authoritativeLastSeq, authoritativeLastSeq)
        let createdAt = Date(timeIntervalSinceReferenceDate: 807_235_200 - Double(scenario.ordinal * 60))
        let usage = SessionUsage(
            inputTokens: 12_400 + scenario.ordinal * 101,
            outputTokens: 2_300 + scenario.ordinal * 17,
            cacheReadTokens: 7_200,
            cacheWriteTokens: 120,
            totalCost: 0.08 + Double(scenario.ordinal) * 0.003,
            totalDurationMs: 42_000 + Double(scenario.ordinal) * 500,
            contextTokens: 54_000 + scenario.ordinal * 350
        )
        let existing = appState.sessionStore.sessions[scenarioID]
        appState.sessionStore.sessions[scenarioID] = SessionInfo(
            id: scenarioID,
            deviceId: scenario.deviceID,
            deviceName: appState.deviceStore.devices[scenario.deviceID]?.name ?? scenario.deviceID,
            agent: "pi",
            model: existing?.model ?? "claude-sonnet-4.6",
            title: scenario.title,
            autoTitle: nil,
            state: phase.sessionState,
            mode: scenario.mode,
            lastSeq: authoritativeLastSeq,
            readSeq: readSeq,
            messageCount: phase.messages.count,
            createdAt: existing?.createdAt ?? createdAt,
            usage: usage,
            pinned: scenario.pinned,
            currentToolName: phase.card?.action?.type == "tool_start" ? phase.card?.action?.toolName : nil,
            currentToolHeadline: phase.card?.action?.type == "tool_start" ? phase.card?.action?.headline : nil,
            activity: activity(for: phase)
        )
        appState.sessionStore.sessionModes[scenarioID] = scenario.mode
        appState.sessionStore.sessionUsage[scenarioID] = usage
        if scenario.pinned {
            appState.sessionStore.pinnedSessions.insert(scenarioID)
        } else {
            appState.sessionStore.pinnedSessions.remove(scenarioID)
        }
        if var preview = phase.preview {
            if preview.timestamp.isEmpty {
                preview = SessionPreview(
                    text: preview.text,
                    type: preview.type,
                    timestamp: isoString(createdAt)
                )
            }
            appState.sessionStore.sessionPreviews[scenarioID] = preview
        } else {
            appState.sessionStore.sessionPreviews.removeValue(forKey: scenarioID)
        }
        if let draft = phase.sidebarDraft, !draft.isEmpty {
            appState.sessionStore.drafts[scenarioID] = draft
        } else {
            appState.sessionStore.drafts.removeValue(forKey: scenarioID)
        }
        if var device = appState.deviceStore.devices[scenario.deviceID] {
            device.online = phase.deviceOnline
            appState.deviceStore.devices[scenario.deviceID] = device
        }

        appState.messageProvider?.setTentacleInfo(
            sessionId: scenarioID,
            lastSeq: authoritativeLastSeq,
            deviceId: scenario.deviceID
        )
        appState.sessionStore.setLoading(scenarioID, phase.loadingHead)
        appState.messageStore.clearRuntimeStatus(scenarioID)
        if case .compacting(let reason) = phase.runtimeStatus {
            appState.messageStore.setCompacting(scenarioID, reason: reason)
        }
        for (bubbleSeq, entries) in scenario.traces {
            appState.messageStore.setTurnSteps(scenarioID, bubbleSeq: bubbleSeq, entries)
        }

        if materializeIfActive, appState.sessionStore.activeSessionId == scenarioID {
            _ = appState.messageStore.loadInitialWindow(scenarioID)
            appState.messageStore.replaceCardFromSubscription(
                scenarioID,
                draft: phase.card?.text ?? "",
                action: phase.card?.action,
                state: phase.sessionState
            )
            if scenarioID == "transition-late-frame-gate", index == 2 {
                // Exercise the real closed-turn guard instead of merely drawing
                // a nil fixture: both late delta and late action must be rejected.
                appState.messageStore.applyCardMessage(
                    scenarioID,
                    "LATE FRAME — this must never become visible",
                    reset: true
                )
                appState.messageStore.applyCardAction(
                    scenarioID,
                    ChatMessage(
                        type: "tool_start",
                        seq: 0,
                        sessionId: scenarioID,
                        deviceId: scenario.deviceID,
                        timestamp: nil,
                        payload: [
                            "toolName": AnyCodable("bash"),
                            "headline": AnyCodable("late stale action"),
                        ]
                    )
                )
                appendEvent(
                    appState.messageStore.cards[scenarioID] == nil
                        ? "late-frame gate · rejected stale delta/action"
                        : "late-frame gate · FAILURE: stale card revived"
                )
            }
        }
        appendEvent("\(scenarioID) · phase \(index + 1): \(phase.name)")
    }

    private func activity(for phase: MacChatScenarioPhase) -> SessionActivity {
        guard phase.sessionState == .active else { return .none }
        guard let action = phase.card?.action else {
            if let text = phase.card?.text, !text.isEmpty { return .agentText(text) }
            return .none
        }
        switch action.type {
        case "tool_start":
            return .toolRunning(toolName: action.toolName ?? "tool", headline: action.headline)
        case "tool_complete":
            return .toolComplete(
                toolName: action.toolName ?? "tool",
                headline: action.headline,
                success: action.payload["success"]?.boolValue
            )
        default:
            return phase.card?.text.isEmpty == false ? .agentText(phase.card?.text ?? "") : .none
        }
    }

    private func handleOutbound(
        _ message: [String: Any],
        routingTarget: String?,
        connectionScoped: Bool
    ) -> Bool {
        let type = message["type"] as? String ?? "unknown"
        let sessionID = message["sessionId"] as? String
        appendEvent("outbound · \(type)\(connectionScoped ? " · connection-scoped" : "")")

        switch type {
        case "set_session_subscription":
            guard appState.connectionStatus == .connected else { return false }
            let payload = message["payload"] as? [String: Any]
            let requestedSessionID = payload?["sessionId"] as? String
            let tentacleID = routingTarget
                ?? requestedSessionID.flatMap { appState.sessionStore.sessions[$0]?.deviceId }
                ?? Self.onlineDeviceA
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(110))
                guard let self, !Task.isCancelled else { return }
                let known = requestedSessionID == nil
                    || self.scenarios.contains(where: { $0.id == requestedSessionID })
                let ack = SessionSubscriptionAck(
                    tentacleId: tentacleID,
                    sessionId: requestedSessionID,
                    accepted: known,
                    snapshot: requestedSessionID.flatMap { self.subscriptionSnapshot(for: $0) },
                    errorMessage: known ? nil : "Unknown isolated scenario"
                )
                self.appState.sessionSubscriptionController.onAck(ack)
            }
            return true

        case "approve", "deny":
            guard let sessionID,
                  let payload = message["payload"] as? [String: Any],
                  let permissionID = payload["permissionId"] as? String else { return true }
            let decision = type
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(180))
                self?.resolvePermission(sessionID: sessionID, permissionID: permissionID, decision: decision)
            }
            return true

        case "send_input":
            guard let sessionID,
                  let payload = message["payload"] as? [String: Any],
                  let text = payload["text"] as? String else { return true }
            let clientID = payload["clientId"] as? String
            let delivery = payload["delivery"] as? String
            let answerTo = payload["answerTo"] as? String
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(280))
                self?.echoUserInput(
                    sessionID: sessionID,
                    text: text,
                    clientID: clientID,
                    delivery: delivery,
                    answerTo: answerTo
                )
            }
            return true

        case "abort_session":
            guard let sessionID else { return true }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(180))
                self?.finishAbort(sessionID: sessionID)
            }
            return true

        case "request_session_messages":
            // Loading scenarios intentionally hold this request open. An
            // authoritative empty Session still receives an empty head batch,
            // which clears the production entry gate and reveals its Composer.
            guard let sessionID,
                  let state = currentStates[sessionID],
                  !state.loadingHead else { return true }
            let head = state.authoritativeLastSeq
                ?? state.messages.map(\.seq).max()
                ?? 0
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(120))
                self?.appState.messageProvider?.handleBatch(
                    sessionId: sessionID,
                    messages: [],
                    lastSeq: head,
                    totalLastSeq: head,
                    containsHead: true
                )
            }
            return true

        default:
            return true
        }
    }

    private func resolvePermission(sessionID: String, permissionID: String, decision: String) {
        guard var state = currentStates[sessionID],
              var card = state.card,
              var action = card.action,
              action.type == "permission",
              action.permissionId == permissionID else { return }
        action.payload["decision"] = AnyCodable(decision)
        card.action = action
        state.card = card
        currentStates[sessionID] = state
        appState.messageStore.setCardAction(sessionID, action)
        appendEvent("permission · \(decision)")
    }

    private func echoUserInput(
        sessionID: String,
        text: String,
        clientID: String?,
        delivery: String?,
        answerTo: String? = nil
    ) {
        guard var state = currentStates[sessionID] else { return }
        let seq = max(
            state.authoritativeLastSeq ?? 0,
            state.messages.map(\.seq).max() ?? 0
        ) + 1
        var payload: [String: AnyCodable] = ["content": AnyCodable(text)]
        if let clientID { payload["clientId"] = AnyCodable(clientID) }
        if let delivery { payload["delivery"] = AnyCodable(delivery) }
        if let answerTo { payload["answerTo"] = AnyCodable(answerTo) }
        let message = ChatMessage(
            type: "user_message",
            seq: seq,
            sessionId: sessionID,
            deviceId: appState.sessionStore.sessions[sessionID]?.deviceId,
            timestamp: ISO8601.now(),
            payload: payload
        )
        state.messages.append(message)
        state.authoritativeLastSeq = seq
        state.sessionState = .active
        currentStates[sessionID] = state
        appState.messageStore.beginCardTurn(sessionID, delivery: delivery)
        appState.messageProvider?.observeLiveMessageSeq(sessionID, seq: seq, kind: "user_message")
        appState.messageStore.ingestBatch(sessionID, [message])
        appState.sessionStore.observeLastSeq(
            sessionID,
            seq: seq,
            advancesReadWhenCaughtUp: true
        )
        appState.sessionStore.setTransientState(sessionID, .active)
        if let clientID { appState.commandSender?.clearPending(sessionID, clientId: clientID) }
        appState.sessionStore.setPreview(
            sessionID,
            text: text,
            type: "user_message",
            timestamp: message.timestamp ?? ISO8601.now()
        )
        appendEvent("echo · user_message \(seq)")
    }

    private func finishAbort(sessionID: String) {
        guard var state = currentStates[sessionID] else { return }
        let seq = max(
            state.authoritativeLastSeq ?? 0,
            state.messages.map(\.seq).max() ?? 0
        ) + 1
        let draft = state.card?.text ?? ""
        let actionPayload: [String: AnyCodable] = [
            "type": AnyCodable("user_abort"),
            "payload": AnyCodable([String: AnyCodable]()),
        ]
        let terminal = ChatMessage(
            type: "turn_status",
            seq: seq,
            sessionId: sessionID,
            deviceId: appState.sessionStore.sessions[sessionID]?.deviceId,
            timestamp: ISO8601.now(),
            payload: [
                "draft": AnyCodable(draft),
                "finishedAt": AnyCodable(ISO8601.now()),
                "action": AnyCodable(actionPayload),
            ]
        )
        state.messages.append(terminal)
        state.card = nil
        state.sessionState = .idle
        state.authoritativeLastSeq = seq
        currentStates[sessionID] = state
        appState.messageStore.ingestBatch(sessionID, [terminal])
        appState.messageStore.endCardTurn(sessionID)
        appState.messageStore.clearRuntimeStatus(sessionID)
        appState.sessionStore.setTransientState(sessionID, .idle)
        appState.sessionStore.observeLastSeq(sessionID, seq: seq)
        appendEvent("abort · frozen terminal \(seq)")
    }

    private func subscriptionSnapshot(for sessionID: String) -> [String: Any]? {
        guard let scenario = scenarios.first(where: { $0.id == sessionID }),
              let phase = currentStates[sessionID],
              let session = appState.sessionStore.sessions[sessionID] else { return nil }
        let preview: [String: Any]? = phase.preview.map {
            ["text": $0.text, "type": $0.type, "timestamp": $0.timestamp]
        }
        var digest: [String: Any] = [
            "id": sessionID,
            "agent": session.agent,
            "model": session.model ?? "claude-sonnet-4.6",
            "title": scenario.title,
            "state": phase.sessionState.rawValue,
            "mode": scenario.mode.rawValue,
            "lastSeq": session.lastSeq,
            "readSeq": session.readSeq,
            "messageCount": phase.messages.count,
            "createdAt": isoString(session.createdAt),
            "pinned": scenario.pinned,
        ]
        if let preview { digest["preview"] = preview }
        if case .compacting(let reason) = phase.runtimeStatus {
            digest["runtimeStatus"] = [
                "status": "compacting",
                "reason": reason?.rawValue as Any,
            ]
        }
        var cardJSON: [String: Any] = ["draft": phase.card?.text ?? ""]
        if let action = phase.card?.action {
            cardJSON["action"] = [
                "type": action.type,
                "payload": action.payload.mapValues(Self.rawJSONValue),
            ]
        }
        return [
            "digest": digest,
            "card": cardJSON,
            "spineHeadSeq": phase.authoritativeLastSeq
                ?? phase.messages.map(\.seq).max()
                ?? 0,
        ]
    }

    private static func rawJSONValue(_ value: AnyCodable) -> Any {
        if let dictionary = value.dictValue {
            return dictionary.mapValues(rawJSONValue)
        }
        if let array = value.arrayValue {
            return array.map(rawJSONValue)
        }
        return value.value ?? NSNull()
    }

    private func appendEvent(_ text: String) {
        eventLog.append(text)
        if eventLog.count > 40 { eventLog.removeFirst(eventLog.count - 40) }
    }

    private func isoString(_ date: Date) -> String {
        Self.isoString(date)
    }

    private static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

// MARK: - Scenario catalog

#endif
