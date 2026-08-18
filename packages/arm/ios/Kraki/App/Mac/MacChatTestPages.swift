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

private struct MacChatScenarioPhase {
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

private struct MacChatScenarioDefinition: Identifiable {
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

private struct MacChatScenarioAttachmentFixture {
    let id: String
    let mimeType: String
    let data: Data
}

@Observable
private final class MacChatScenarioHarness {
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
            appState.attachmentStore.ingestChunk(
                id: fixture.id,
                index: 0,
                total: 1,
                mimeType: fixture.mimeType,
                data: fixture.data.base64EncodedString(),
                error: nil
            )
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

        case "approve", "deny", "always_allow":
            guard let sessionID,
                  let payload = message["payload"] as? [String: Any],
                  let permissionID = payload["permissionId"] as? String else { return true }
            let decision = type == "always_allow" ? "always_allow" : type
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(180))
                self?.resolvePermission(sessionID: sessionID, permissionID: permissionID, decision: decision)
            }
            return true

        case "answer":
            guard let sessionID,
                  let payload = message["payload"] as? [String: Any],
                  let questionID = payload["questionId"] as? String,
                  let answer = payload["answer"] as? String else { return true }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(180))
                self?.resolveQuestion(sessionID: sessionID, questionID: questionID, answer: answer)
            }
            return true

        case "send_input":
            guard let sessionID,
                  let payload = message["payload"] as? [String: Any],
                  let text = payload["text"] as? String else { return true }
            let clientID = payload["clientId"] as? String
            let delivery = payload["delivery"] as? String
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(280))
                self?.echoUserInput(
                    sessionID: sessionID,
                    text: text,
                    clientID: clientID,
                    delivery: delivery
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

    private func resolveQuestion(sessionID: String, questionID: String, answer: String) {
        guard var state = currentStates[sessionID],
              var card = state.card,
              var action = card.action,
              action.type == "question",
              action.questionId == questionID else { return }
        action.payload["answer"] = AnyCodable(answer)
        card.action = action
        state.card = card
        currentStates[sessionID] = state
        appState.messageStore.setCardAction(sessionID, action)
        appState.sessionStore.setPreview(
            sessionID,
            text: answer,
            type: "question",
            timestamp: ISO8601.now()
        )
        appendEvent("question · answered")
    }

    private func echoUserInput(
        sessionID: String,
        text: String,
        clientID: String?,
        delivery: String?
    ) {
        guard var state = currentStates[sessionID] else { return }
        let seq = max(
            state.authoritativeLastSeq ?? 0,
            state.messages.map(\.seq).max() ?? 0
        ) + 1
        var payload: [String: AnyCodable] = ["content": AnyCodable(text)]
        if let clientID { payload["clientId"] = AnyCodable(clientID) }
        if let delivery { payload["delivery"] = AnyCodable(delivery) }
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

private extension MacChatScenarioHarness {
    static func buildCatalog() -> (
        scenarios: [MacChatScenarioDefinition],
        attachments: [MacChatScenarioAttachmentFixture]
    ) {
        let imageRed = makePNG(
            size: NSSize(width: 720, height: 420),
            colors: [NSColor.systemRed, NSColor.systemOrange],
            label: "Image A · 720 × 420"
        )
        let imageBlue = makePNG(
            size: NSSize(width: 520, height: 760),
            colors: [NSColor.systemBlue, NSColor.systemPurple],
            label: "Image B · portrait"
        )
        let imageGreen = makePNG(
            size: NSSize(width: 960, height: 320),
            colors: [NSColor.systemGreen, NSColor.systemTeal],
            label: "Image C · panoramic"
        )
        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system;margin:0;padding:28px;background:#10131a;color:#edf2ff}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px}
        .card{min-width:0;padding:18px;border:1px solid #334155;border-radius:14px;background:#18202d}
        .value{font-size:clamp(19px,5vw,28px);font-weight:700;color:#8bd5ff;overflow-wrap:anywhere} h1{margin-top:0}
        </style></head><body><h1>Real HTML Report Artifact</h1>
        <p>This is loaded through AttachmentStore and the production secure WKWebView panel.</p>
        <div class="grid"><div class="card"><div>Sessions</div><div class="value">47</div></div>
        <div class="card"><div>Scenarios</div><div class="value">47</div></div>
        <div class="card"><div>Renderer</div><div class="value">CoreText</div></div></div></body></html>
        """.data(using: .utf8) ?? Data()

        let imageRefID = "scenario-image-ref-a"
        let htmlRefID = "scenario-html-report"
        let attachments = [
            MacChatScenarioAttachmentFixture(id: imageRefID, mimeType: "image/png", data: imageRed),
            MacChatScenarioAttachmentFixture(id: htmlRefID, mimeType: "text/html", data: html),
        ]

        var definitions: [MacChatScenarioDefinition] = []

        func payload(_ values: [String: Any]) -> [String: AnyCodable] {
            values.mapValues { AnyCodable($0) }
        }

        func message(
            _ sessionID: String,
            _ seq: Int,
            _ type: String,
            _ values: [String: Any] = [:]
        ) -> ChatMessage {
            ChatMessage(
                type: type,
                seq: seq,
                sessionId: sessionID,
                deviceId: Self.onlineDeviceA,
                timestamp: String(format: "2026-08-08T00:%02d:%02d.000Z", (seq / 60) % 60, seq % 60),
                payload: payload(values)
            )
        }

        func action(
            _ sessionID: String,
            _ type: String,
            _ values: [String: Any] = [:]
        ) -> ChatMessage {
            ChatMessage(
                type: type,
                seq: 0,
                sessionId: sessionID,
                deviceId: Self.onlineDeviceA,
                timestamp: nil,
                payload: payload(values)
            )
        }

        func preview(_ text: String, _ type: String) -> SessionPreview {
            SessionPreview(text: text, type: type, timestamp: "")
        }

        func phase(
            _ name: String,
            messages: [ChatMessage] = [],
            card: MessageStore.SessionCard? = nil,
            state: SessionState? = nil,
            runtime: SessionRuntimeStatus = .idle,
            online: Bool = true,
            preview: SessionPreview? = nil,
            readSeq: Int? = nil,
            lastSeq: Int? = nil,
            loading: Bool = false,
            draft: String? = nil
        ) -> MacChatScenarioPhase {
            MacChatScenarioPhase(
                name: name,
                messages: messages,
                card: card,
                sessionState: state ?? (card == nil ? .idle : .active),
                runtimeStatus: runtime,
                deviceOnline: online,
                preview: preview,
                readSeq: readSeq,
                authoritativeLastSeq: lastSeq,
                loadingHead: loading,
                sidebarDraft: draft
            )
        }

        func add(
            _ id: String,
            category: String,
            title: String,
            summary: String,
            deviceID: String = Self.onlineDeviceA,
            mode: SessionMode = .discuss,
            pinned: Bool = false,
            phases: [MacChatScenarioPhase],
            traces: [Int: [ChatMessage]] = [:]
        ) {
            definitions.append(MacChatScenarioDefinition(
                id: id,
                category: category,
                title: title,
                summary: summary,
                deviceID: deviceID,
                mode: mode,
                pinned: pinned,
                phases: phases,
                traces: traces,
                ordinal: definitions.count
            ))
        }

        func basicConversation(_ id: String, user: String, agent: String) -> [ChatMessage] {
            [
                message(id, 1, "user_message", ["content": user]),
                message(id, 2, "agent_message", ["content": agent]),
                message(id, 3, "idle", ["reason": "completed"]),
            ]
        }

        add(
            "entry-empty-online",
            category: "Entry & connectivity",
            title: "01 · Entry · Empty online",
            summary: "Online device, authoritative empty head, Composer visible and no-conversation state.",
            phases: [phase("At empty head", online: true, preview: nil, lastSeq: 0)]
        )
        add(
            "entry-empty-offline",
            category: "Entry & connectivity",
            title: "02 · Entry · Empty offline",
            summary: "Offline device with no cache; production offline empty-state and hidden Composer.",
            deviceID: Self.offlineDevice,
            phases: [phase("Offline and uncached", online: false, preview: preview("Device offline", "user_message"))]
        )
        let cachedOfflineID = "entry-cached-offline"
        let cachedOfflineMessages = basicConversation(
            cachedOfflineID,
            user: "Can I still read this while the Tentacle is offline?",
            agent: "Yes. This page is rendered from the local GRDB history window."
        )
        add(
            cachedOfflineID,
            category: "Entry & connectivity",
            title: "03 · Entry · Cached offline",
            summary: "Offline device with cached history; messages remain readable while Composer is absent.",
            deviceID: Self.offlineDevice,
            phases: [phase(
                "Cached tail",
                messages: cachedOfflineMessages,
                online: false,
                preview: preview("Yes. This page is rendered from the local cache.", "agent_message")
            )]
        )
        add(
            "entry-loading-empty",
            category: "Entry & connectivity",
            title: "04 · Entry · Empty initial head fetch",
            summary: "No local messages, online head is known, and the production center loading gate remains active.",
            phases: [phase(
                "Head request in flight",
                state: .active,
                preview: preview("Waiting for authoritative head", "user_message"),
                lastSeq: 18,
                loading: true
            )]
        )
        let reconcileID = "entry-cached-reconciling"
        let reconcileMessages = basicConversation(
            reconcileID,
            user: "Show cached content immediately.",
            agent: "This local tail stays visible while a newer Relay head is reconciled."
        )
        add(
            reconcileID,
            category: "Entry & connectivity",
            title: "05 · Entry · Cached while reconciling",
            summary: "Local presentation must stay visible while the authoritative head request is in flight.",
            phases: [phase(
                "Cached tail + head request",
                messages: reconcileMessages,
                state: .active,
                preview: preview("Reconciling newer head…", "agent_message"),
                lastSeq: 12,
                loading: true
            )]
        )

        let historyID = "history-mixed"
        add(
            historyID,
            category: "History & virtualization",
            title: "06 · History · Mixed bubble geometry",
            summary: "Short/long human and agent bubbles, Markdown, links, quote, table, and code in one real list.",
            phases: [phase(
                "Mixed immutable tail",
                messages: [
                    message(historyID, 1, "user_message", ["content": "hi"]),
                    message(historyID, 2, "agent_message", ["content": "Hello — short agent response."]),
                    message(historyID, 3, "idle"),
                    message(historyID, 4, "user_message", ["content": "Render a longer response with Markdown and wrapping behavior."]),
                    message(historyID, 5, "agent_message", ["content": """
                    ## Production renderer

                    This is the **real cached CoreText bubble** with a [link](https://kraki.chat), `inline code`, and a long sentence that wraps naturally without introducing a TextKit cell.

                    > Quoted guidance remains compact and aligned.

                    | State | Expected |
                    | --- | --- |
                    | cached | visible |
                    | scrolling | smooth |

                    ```swift
                    let renderer = "MacCoreTextLayoutArtifact"
                    print(renderer)
                    ```
                    """, "steps": 4]),
                    message(historyID, 6, "idle"),
                ],
                preview: preview("Production renderer", "agent_message")
            )],
            traces: [5: [
                action(historyID, "agent_narration", ["content": "Preparing the mixed Markdown response."]),
                action(historyID, "tool_start", ["toolName": "read", "headline": "Read MacChatBubbleCell.swift", "toolCallId": "history-read"]),
                action(historyID, "tool_complete", ["toolName": "read", "headline": "Read MacChatBubbleCell.swift", "toolCallId": "history-read", "success": true]),
            ]]
        )

        let longHistoryID = "history-long-pagination"
        var longHistory: [ChatMessage] = []
        var longSeq = 1
        for turn in 1...90 {
            longHistory.append(message(longHistoryID, longSeq, "user_message", [
                "content": "History prompt \(turn): keep pagination anchored while older rows prepend."
            ]))
            longSeq += 1
            longHistory.append(message(longHistoryID, longSeq, "agent_message", [
                "content": turn.isMultiple(of: 7)
                    ? """
                      Turn \(turn) includes a taller response.

                      - viewport virtualization
                      - reusable cells
                      - cached CoreText geometry
                      - stable prepend anchor
                      """
                    : "History response \(turn). Scroll to the top repeatedly to exercise DB-first pagination."
            ]))
            longSeq += 1
            longHistory.append(message(longHistoryID, longSeq, "idle"))
            longSeq += 1
        }
        add(
            longHistoryID,
            category: "History & virtualization",
            title: "07 · History · 90-turn pagination",
            summary: "270 persistent rows; the Mac opens a compact tail and loads older DB pages at the top edge.",
            phases: [phase(
                "Tail window",
                messages: longHistory,
                preview: preview("History response 90", "agent_message")
            )]
        )

        let sparseID = "history-sparse-seq"
        var sparseMessages: [ChatMessage] = []
        var sparseSeq = 1
        for turn in 1...55 {
            sparseMessages.append(message(sparseID, sparseSeq, "user_message", ["content": "Sparse prompt \(turn)"]))
            sparseSeq += 3
            sparseMessages.append(message(sparseID, sparseSeq, "agent_message", ["content": "Sparse persistent seqs page by DB order, not integer adjacency."]))
            sparseSeq += 4
            sparseMessages.append(message(sparseID, sparseSeq, "idle"))
            sparseSeq += 2
        }
        add(
            sparseID,
            category: "History & virtualization",
            title: "08 · History · Sparse protocol seqs",
            summary: "Replayed legacy spine rows retain historical off-spine seq gaps; top pagination must still advance without stalling.",
            phases: [phase(
                "Sparse tail",
                messages: sparseMessages,
                preview: preview("Sparse persistent seqs", "agent_message")
            )]
        )

        let draftShortID = "stream-draft-short"
        add(
            draftShortID,
            category: "Streaming card",
            title: "09 · Stream · Draft only",
            summary: "One live card with short keep-last narration and no action slot.",
            phases: [phase(
                "Short draft",
                messages: [message(draftShortID, 1, "user_message", ["content": "What are you doing?"])],
                card: .init(text: "I’m checking the renderer now…", action: nil),
                preview: preview("I’m checking the renderer now…", "agent_message")
            )]
        )

        let draftLongID = "stream-draft-multiline"
        add(
            draftLongID,
            category: "Streaming card",
            title: "10 · Stream · Multiline Markdown",
            summary: "Growing live narration with headings, lists, quotes, table syntax, and wrapping.",
            phases: [phase(
                "Multiline draft",
                messages: [message(draftLongID, 1, "user_message", ["content": "Stream a structured status update."])],
                card: .init(text: """
                ## Investigating

                I’m comparing the live card against the frozen result.

                - preserve identity
                - grow upward from the Composer
                - do not flash during revision replacement

                > This remains provisional while streaming.

                | Check | State |
                | --- | --- |
                | Layout | running |
                | Cache | warm |
                """, action: nil),
                preview: preview("Investigating the live card", "agent_message")
            )]
        )

        let partialCodeID = "stream-partial-code"
        add(
            partialCodeID,
            category: "Streaming card",
            title: "11 · Stream · Partial code fence",
            summary: "An intentionally incomplete fenced block must stay cheap and visually stable while live.",
            phases: [
                phase(
                    "Fence opened",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\n", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
                phase(
                    "Partial expression",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\nstruct Session {\n    let id: String\n    func render() ->", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
                phase(
                    "Fence completed but still live",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\nstruct Session {\n    let id: String\n    func render() -> Bool { true }\n}\n```", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
            ]
        )

        let toolRunID = "stream-tool-running"
        add(
            toolRunID,
            category: "Streaming card",
            title: "12 · Stream · Tool running",
            summary: "Live draft plus the server-owned tool_start action slot.",
            phases: [phase(
                "Tool in flight",
                messages: [message(toolRunID, 1, "user_message", ["content": "Inspect the current files."])],
                card: .init(
                    text: "I’ll inspect the production Chat path first.",
                    action: action(toolRunID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "scenario-read-1",
                    ])
                ),
                preview: preview("Read MacChatScrollView.swift", "agent_message")
            )]
        )

        let toolCompleteID = "stream-tool-complete"
        add(
            toolCompleteID,
            category: "Streaming card",
            title: "13 · Stream · Tool completed",
            summary: "A completed action occupies the same card slot without changing live bubble identity.",
            phases: [phase(
                "Successful completion",
                messages: [message(toolCompleteID, 1, "user_message", ["content": "Run the focused checks."])],
                card: .init(
                    text: "The focused checks completed.",
                    action: action(toolCompleteID, "tool_complete", [
                        "toolName": "bash",
                        "headline": "xcodebuild KrakiMac",
                        "toolCallId": "scenario-build-1",
                        "success": true,
                    ])
                ),
                preview: preview("The focused checks completed", "agent_message")
            )]
        )

        let toolFailedID = "stream-tool-failed"
        add(
            toolFailedID,
            category: "Streaming card",
            title: "14 · Stream · Tool failed",
            summary: "tool_complete success=false renders the failure glyph inside the live card.",
            phases: [phase(
                "Failed completion",
                messages: [message(toolFailedID, 1, "user_message", ["content": "Run a command that fails."])],
                card: .init(
                    text: "The command returned a non-zero exit status.",
                    action: action(toolFailedID, "tool_complete", [
                        "toolName": "bash",
                        "headline": "swift test --filter MissingSuite",
                        "toolCallId": "scenario-build-fail",
                        "success": false,
                    ])
                ),
                preview: preview("Command failed", "error")
            )]
        )

        let batchID = "stream-tool-batch"
        add(
            batchID,
            category: "Streaming card",
            title: "15 · Stream · Parallel tool batch",
            summary: "tool_batch action with a changing running count.",
            phases: [
                phase(
                    "Three tools",
                    messages: [message(batchID, 1, "user_message", ["content": "Check these in parallel."])],
                    card: .init(text: "Running independent checks.", action: action(batchID, "tool_batch", ["running": 3])),
                    preview: preview("3 tools running", "agent_message")
                ),
                phase(
                    "One tool remains",
                    messages: [message(batchID, 1, "user_message", ["content": "Check these in parallel."])],
                    card: .init(text: "Two checks are done; one remains.", action: action(batchID, "tool_batch", ["running": 1])),
                    preview: preview("1 tool running", "agent_message")
                ),
            ]
        )

        let permissionWriteID = "permission-discuss-write"
        add(
            permissionWriteID,
            category: "Permission",
            title: "16 · Permission · Discuss write",
            summary: "Discuss-mode write request: Approve, Execute, and Deny use the real action callbacks.",
            mode: .discuss,
            phases: [phase(
                "Awaiting write approval",
                messages: [message(permissionWriteID, 1, "user_message", ["content": "Update the implementation."])],
                card: .init(
                    text: "I need permission before editing the file.",
                    action: action(permissionWriteID, "permission", [
                        "id": "perm-discuss-write",
                        "toolName": "write_file",
                        "description": "packages/arm/ios/Kraki/Features/Chat/Mac/MacChatView.swift",
                        "args": ["path": "MacChatView.swift"],
                    ])
                ),
                preview: preview("Permission required", "permission")
            )]
        )

        let permissionSafeID = "permission-safe-read"
        add(
            permissionSafeID,
            category: "Permission",
            title: "17 · Permission · Safe read",
            summary: "Safe-mode read request with Approve, Always, Deny and free-form denial through Composer.",
            mode: .safe,
            phases: [phase(
                "Awaiting read approval",
                messages: [message(permissionSafeID, 1, "user_message", ["content": "Inspect the configuration."])],
                card: .init(
                    text: "The current mode requires explicit permission.",
                    action: action(permissionSafeID, "permission", [
                        "id": "perm-safe-read",
                        "toolName": "read_file",
                        "description": "/Users/example/project/config.json",
                        "args": ["path": "/Users/example/project/config.json"],
                    ])
                ),
                preview: preview("Permission required", "permission")
            )]
        )

        let permissionResolvedID = "permission-resolved"
        let permissionResolvedMessages = [message(permissionResolvedID, 1, "user_message", ["content": "Show every resolved permission state."])]
        func resolvedPermission(_ decision: String) -> MessageStore.SessionCard {
            .init(
                text: "The permission card remains stable while the resolution echo lands.",
                action: action(permissionResolvedID, "permission", [
                    "id": "perm-resolved",
                    "toolName": "write_file",
                    "description": "ScenarioFixture.swift",
                    "decision": decision,
                ])
            )
        }
        add(
            permissionResolvedID,
            category: "Permission",
            title: "18 · Permission · Resolved variants",
            summary: "Cycles through approved, always allowed, and denied resolved-card presentation.",
            phases: [
                phase("Approved", messages: permissionResolvedMessages, card: resolvedPermission("approve"), preview: preview("Approved", "permission")),
                phase("Always allowed", messages: permissionResolvedMessages, card: resolvedPermission("always_allow"), preview: preview("Allowed for session", "permission")),
                phase("Denied", messages: permissionResolvedMessages, card: resolvedPermission("deny"), preview: preview("Denied", "permission")),
            ]
        )

        let questionID = "question-choices"
        add(
            questionID,
            category: "Question",
            title: "19 · Question · Choice buttons",
            summary: "Short choices exercise the production rendered-frame hit routing at every UI zoom.",
            phases: [phase(
                "Awaiting choice",
                messages: [message(questionID, 1, "user_message", ["content": "Ask me which approach to use."])],
                card: .init(
                    text: "I found two reasonable paths.",
                    action: action(questionID, "question", [
                        "id": "question-choice-basic",
                        "question": "Which implementation should I use?",
                        "choices": ["Keep the cached CoreText renderer", "Replace it with a TextKit cell"],
                        "allowFreeform": true,
                    ])
                ),
                preview: preview("Which implementation should I use?", "question")
            )]
        )

        let longQuestionID = "question-long-choices"
        add(
            longQuestionID,
            category: "Question",
            title: "20 · Question · Long Markdown choices",
            summary: "Wrapped multi-line choice rows expose clipping, hover, and hit-frame drift.",
            phases: [phase(
                "Long wrapped choices",
                messages: [message(longQuestionID, 1, "user_message", ["content": "Ask a detailed architectural question."])],
                card: .init(
                    text: "Before continuing, I need an explicit boundary decision.",
                    action: action(longQuestionID, "question", [
                        "id": "question-choice-long",
                        "question": "How should reconnect restore an in-progress card after a rapid Session switch?",
                        "choices": [
                            "Restore the **authoritative subscription snapshot** atomically, preserving the current draft and action slot.",
                            "Keep the stale local card until a later `agent_message_delta` happens to replace it.",
                            "Clear the card and show no streaming state until the final persisted response arrives.",
                        ],
                        "allowFreeform": true,
                    ])
                ),
                preview: preview("How should reconnect restore the card?", "question")
            )]
        )

        let freeQuestionID = "question-freeform"
        add(
            freeQuestionID,
            category: "Question",
            title: "21 · Question · Free-form Composer",
            summary: "No choices: the real Composer changes intent to answerQuestion and submits through CommandSender.",
            phases: [phase(
                "Awaiting free-form answer",
                messages: [message(freeQuestionID, 1, "user_message", ["content": "Ask for a custom value."])],
                card: .init(
                    text: "Please type the exact value in the Composer.",
                    action: action(freeQuestionID, "question", [
                        "id": "question-freeform",
                        "question": "What debounce interval should this scenario use?",
                        "choices": [String](),
                        "allowFreeform": true,
                    ])
                ),
                preview: preview("What debounce interval should this use?", "question")
            )]
        )

        let questionStateID = "question-resolved-cancelled"
        let questionStateMessages = [message(questionStateID, 1, "user_message", ["content": "Show resolved question states."])]
        add(
            questionStateID,
            category: "Question",
            title: "22 · Question · Answered and cancelled",
            summary: "Cycles through pending, answered, and cancelled action-slot branches.",
            phases: [
                phase(
                    "Pending",
                    messages: questionStateMessages,
                    card: .init(text: "Waiting for your selection.", action: action(questionStateID, "question", [
                        "id": "question-state",
                        "question": "Continue with the migration?",
                        "choices": ["Continue", "Stop"],
                    ])),
                    preview: preview("Continue with the migration?", "question")
                ),
                phase(
                    "Answered",
                    messages: questionStateMessages,
                    card: .init(text: "Selection received.", action: action(questionStateID, "question", [
                        "id": "question-state",
                        "question": "Continue with the migration?",
                        "choices": ["Continue", "Stop"],
                        "answer": "Continue",
                    ])),
                    preview: preview("Continue", "question")
                ),
                phase(
                    "Cancelled",
                    messages: questionStateMessages,
                    card: .init(text: "The producer cancelled this prompt.", action: action(questionStateID, "question", [
                        "id": "question-state",
                        "question": "Continue with the migration?",
                        "choices": ["Continue", "Stop"],
                        "cancelled": true,
                    ])),
                    preview: preview("Question cancelled", "question")
                ),
            ]
        )

        let compactID = "runtime-compacting"
        add(
            compactID,
            category: "Runtime state",
            title: "23 · Runtime · Compacting only",
            summary: "Compaction is orthogonal runtime state: bottom status appears without creating a bubble.",
            phases: [phase(
                "Threshold compaction",
                messages: basicConversation(compactID, user: "Continue after compacting.", agent: "The previous turn remains immutable."),
                state: .compacting,
                runtime: .compacting(reason: .threshold),
                preview: preview("Compacting context", "agent_message")
            )]
        )

        let compactCardID = "runtime-compacting-card"
        add(
            compactCardID,
            category: "Runtime state",
            title: "24 · Runtime · Compacting preserves card",
            summary: "Compaction status coexists with an existing live draft/action and must not displace either.",
            phases: [
                phase(
                    "Tool card before compaction",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Inspecting the largest source file.", action: action(compactCardID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "compact-read",
                    ])),
                    state: .active,
                    preview: preview("Inspecting source", "agent_message")
                ),
                phase(
                    "Compaction with same card",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Inspecting the largest source file.", action: action(compactCardID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "compact-read",
                    ])),
                    state: .compacting,
                    runtime: .compacting(reason: .overflow),
                    preview: preview("Compacting context", "agent_message")
                ),
                phase(
                    "Resumed active",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Compaction completed; resuming the same turn.", action: nil),
                    state: .active,
                    preview: preview("Resuming after compaction", "agent_message")
                ),
            ]
        )

        let steerID = "stream-steer"
        add(
            steerID,
            category: "Runtime state",
            title: "25 · Runtime · Steer during stream",
            summary: "A visible delivery=steer human bubble stays inside the current lifecycle and preserves the live card.",
            phases: [phase(
                "Steer appended",
                messages: [
                    message(steerID, 1, "user_message", ["content": "Analyze the current implementation."]),
                    message(steerID, 4, "user_message", ["content": "Also check reconnect behavior.", "delivery": "steer"]),
                ],
                card: .init(text: "I’m incorporating the reconnect requirement without restarting the turn.", action: nil),
                state: .active,
                preview: preview("Also check reconnect behavior", "user_message")
            )]
        )

        let frozenID = "frozen-markdown-steps"
        add(
            frozenID,
            category: "Frozen outcomes",
            title: "26 · Frozen · Markdown with Steps",
            summary: "Persisted final agent bubble with final syntax highlighting and a real Steps affordance.",
            phases: [phase(
                "Completed turn",
                messages: [
                    message(frozenID, 1, "user_message", ["content": "Summarize the result."]),
                    message(frozenID, 2, "agent_message", ["content": """
                    ## Completed

                    The final renderer now owns immutable Markdown and asynchronous highlighting.

                    ```typescript
                    const result = { renderer: 'CoreText', textKitCells: 0, passed: true }
                    ```
                    """, "steps": 3]),
                    message(frozenID, 3, "idle"),
                ],
                preview: preview("Completed", "agent_message")
            )],
            traces: [2: [
                action(frozenID, "agent_narration", ["content": "Checking the final renderer."]),
                action(frozenID, "tool_start", ["toolName": "bash", "headline": "xcodebuild KrakiMac", "toolCallId": "frozen-build"]),
                action(frozenID, "tool_complete", ["toolName": "bash", "headline": "xcodebuild KrakiMac", "toolCallId": "frozen-build", "success": true]),
            ]]
        )

        func terminalAction(_ type: String, values: [String: Any] = [:]) -> [String: AnyCodable] {
            [
                "type": AnyCodable(type),
                "payload": AnyCodable(payload(values)),
            ]
        }

        let abortID = "frozen-user-abort"
        add(
            abortID,
            category: "Frozen outcomes",
            title: "27 · Frozen · User aborted",
            summary: "turn_status owns the draft and renders the frozen user_abort outcome.",
            phases: [phase(
                "Aborted terminal",
                messages: [
                    message(abortID, 1, "user_message", ["content": "Start a long analysis."]),
                    message(abortID, 2, "agent_message", ["content": "This transient agent row must be folded into the terminal."]),
                    message(abortID, 3, "turn_status", [
                        "draft": "I inspected the first half of the pipeline before you stopped the turn.",
                        "finishedAt": "2026-08-08T00:00:03.000Z",
                        "action": terminalAction("user_abort"),
                        "steps": 2,
                    ]),
                    message(abortID, 4, "idle"),
                ],
                preview: preview("I inspected the first half…", "agent_message")
            )]
        )

        let failedID = "frozen-failed"
        add(
            failedID,
            category: "Frozen outcomes",
            title: "28 · Frozen · Failed",
            summary: "turn_status failed outcome with a preserved draft and compact error reason.",
            phases: [phase(
                "Failed terminal",
                messages: [
                    message(failedID, 1, "user_message", ["content": "Apply the migration."]),
                    message(failedID, 2, "agent_message", ["content": "The migration reached the build step."]),
                    message(failedID, 3, "turn_status", [
                        "draft": "The migration reached the build step but could not complete.",
                        "finishedAt": "2026-08-08T00:00:03.000Z",
                        "action": terminalAction("failed", values: ["message": "Build process exited with status 65"]),
                        "steps": 4,
                    ]),
                    message(failedID, 4, "idle"),
                ],
                preview: preview("Turn failed", "error")
            )]
        )

        let interruptedID = "frozen-interrupted-legacy"
        add(
            interruptedID,
            category: "Frozen outcomes",
            title: "29 · Frozen · Legacy interrupted turn",
            summary: "Legacy interrupted_turn compatibility for ordinary abort and process_lost failure.",
            phases: [
                phase(
                    "Legacy abort",
                    messages: [
                        message(interruptedID, 1, "user_message", ["content": "Run the old lifecycle."]),
                        message(interruptedID, 2, "interrupted_turn", [
                            "draft": "Legacy draft preserved after interruption.",
                            "reason": "user_abort",
                            "interruptedAt": "2026-08-08T00:00:02.000Z",
                        ]),
                        message(interruptedID, 3, "idle"),
                    ],
                    preview: preview("Legacy draft preserved", "agent_message")
                ),
                phase(
                    "Legacy process lost",
                    messages: [
                        message(interruptedID, 1, "user_message", ["content": "Run the old lifecycle."]),
                        message(interruptedID, 2, "interrupted_turn", [
                            "draft": "The agent process disappeared during the operation.",
                            "reason": "process_lost",
                            "interruptedAt": "2026-08-08T00:00:02.000Z",
                        ]),
                        message(interruptedID, 3, "idle"),
                    ],
                    preview: preview("Agent process was lost", "error")
                ),
            ]
        )

        let noReplyID = "frozen-no-reply"
        add(
            noReplyID,
            category: "Frozen outcomes",
            title: "30 · Frozen · No reply notice",
            summary: "Kraki-authored system_message kind=no_reply renders as a concluding system bubble.",
            phases: [phase(
                "No reply",
                messages: [
                    message(noReplyID, 1, "user_message", ["content": "This prompt intentionally produces no model response."]),
                    message(noReplyID, 2, "system_message", [
                        "kind": "no_reply",
                        "content": "The agent completed this turn without a text reply.",
                    ]),
                    message(noReplyID, 3, "idle"),
                ],
                preview: preview("The agent completed without a text reply", "agent_message")
            )]
        )

        let errorID = "projection-error-detail"
        add(
            errorID,
            category: "Projection edge cases",
            title: "31 · Projection · Error stays off-spine",
            summary: "A persistent error is turn detail and must not create an extra top-level bubble.",
            phases: [phase(
                "Error then idle",
                messages: [
                    message(errorID, 1, "user_message", ["content": "Trigger an internal error."]),
                    message(errorID, 2, "error", ["message": "Synthetic scenario error detail"]),
                    message(errorID, 3, "idle"),
                ],
                preview: preview("Synthetic scenario error detail", "error"),
                readSeq: 1
            )]
        )

        let duplicateID = "projection-duplicate-terminal"
        add(
            duplicateID,
            category: "Projection edge cases",
            title: "32 · Projection · Duplicate terminal collapse",
            summary: "Reconnect/import history may contain duplicate conclusions; only the final lifecycle owner remains.",
            phases: [phase(
                "Duplicate conclusions",
                messages: [
                    message(duplicateID, 1, "user_message", ["content": "Exercise duplicate terminal recovery."]),
                    message(duplicateID, 2, "agent_message", ["content": "Old conclusion that should be replaced."]),
                    message(duplicateID, 3, "turn_status", [
                        "draft": "First terminal snapshot.",
                        "action": terminalAction("user_abort"),
                    ]),
                    message(duplicateID, 4, "idle"),
                    message(duplicateID, 5, "turn_status", [
                        "draft": "Latest terminal snapshot wins.",
                        "action": terminalAction("failed", values: ["message": "Recovered final status"]),
                    ]),
                    message(duplicateID, 6, "idle"),
                ],
                preview: preview("Latest terminal snapshot wins", "error")
            )]
        )

        let inlineImagesID = "artifact-inline-images"
        let inlineAttachments: [[String: Any]] = [imageRed, imageBlue, imageGreen].enumerated().map { index, data in
            [
                "type": "image",
                "mimeType": "image/png",
                "data": data.base64EncodedString(),
                "name": "scenario-inline-\(index + 1).png",
            ]
        }
        add(
            inlineImagesID,
            category: "Images & artifacts",
            title: "33 · Artifact · Inline image gallery",
            summary: "Three decoded inline images use the real compact stack and full-window preview overlay.",
            phases: [phase(
                "Three images",
                messages: [
                    message(inlineImagesID, 1, "user_message", ["content": "Show the generated images."]),
                    message(inlineImagesID, 2, "agent_message", [
                        "content": "Three differently shaped images are attached.",
                        "attachments": inlineAttachments,
                    ]),
                    message(inlineImagesID, 3, "idle"),
                ],
                preview: preview("Three images attached", "agent_message")
            )]
        )

        let pureImageID = "artifact-pure-image"
        add(
            pureImageID,
            category: "Images & artifacts",
            title: "34 · Artifact · Pure image output",
            summary: "An agent message with images and no text suppresses the empty colored bubble.",
            phases: [phase(
                "Pure image",
                messages: [
                    message(pureImageID, 1, "user_message", ["content": "Return only the image."]),
                    message(pureImageID, 2, "agent_message", [
                        "content": "",
                        "attachments": [inlineAttachments[0]],
                    ]),
                    message(pureImageID, 3, "idle"),
                ],
                preview: preview("Image", "agent_message")
            )]
        )

        let htmlID = "artifact-html-report"
        let htmlRef: [String: Any] = [
            "type": "content_ref",
            "id": htmlRefID,
            "mimeType": "text/html",
            "size": html.count,
            "name": "scenario-report.html",
            "caption": "Scenario report",
        ]
        add(
            htmlID,
            category: "Images & artifacts",
            title: "35 · Artifact · HTML report",
            summary: "Idle-owned HTML ContentRef moves onto the final bubble and opens the real secure artifact panel.",
            phases: [phase(
                "Ready HTML artifact",
                messages: [
                    message(htmlID, 1, "user_message", ["content": "Render the report artifact."]),
                    message(htmlID, 2, "agent_message", ["content": "The report is ready below."]),
                    message(htmlID, 3, "idle", ["turnArtifacts": [htmlRef]]),
                ],
                preview: preview("The report is ready below", "agent_message")
            )]
        )

        let imageRefScenarioID = "artifact-image-ref"
        let imageRef: [String: Any] = [
            "type": "content_ref",
            "id": imageRefID,
            "mimeType": "image/png",
            "size": imageRed.count,
            "name": "scenario-ref.png",
            "caption": "Turn-owned image",
            "width": 720,
            "height": 420,
        ]
        add(
            imageRefScenarioID,
            category: "Images & artifacts",
            title: "36 · Artifact · Turn image ContentRef",
            summary: "A lazy image ref attached to idle is projected onto the concluding agent bubble.",
            phases: [phase(
                "Ready image ref",
                messages: [
                    message(imageRefScenarioID, 1, "user_message", ["content": "Attach the final image to this turn."]),
                    message(imageRefScenarioID, 2, "agent_message", ["content": "The turn-owned image is available."]),
                    message(imageRefScenarioID, 3, "idle", ["turnArtifacts": [imageRef]]),
                ],
                preview: preview("Turn-owned image available", "agent_message")
            )]
        )

        let contentStressID = "content-code-table-stress"
        add(
            contentStressID,
            category: "Images & artifacts",
            title: "37 · Content · Code and table stress",
            summary: "Final immutable bubble with wide table, many code languages, quote, links, and long tokens.",
            phases: [phase(
                "Final highlighted content",
                messages: [
                    message(contentStressID, 1, "user_message", ["content": "Render the final Markdown stress sample."]),
                    message(contentStressID, 2, "agent_message", ["content": """
                    # Final content matrix

                    [Kraki](https://kraki.chat) keeps `inline code`, **bold**, *italic*, and selectable text native.

                    | Session | State | Input Tokens | Output Tokens | Duration |
                    | :--- | :---: | ---: | ---: | ---: |
                    | streaming-card-with-a-long-name | active | 124500 | 18942 | 128.4s |
                    | reconnect-snapshot | idle | 9850 | 3201 | 42.8s |

                    ```swift
                    struct Scenario { let id: String; let connected: Bool }
                    ```

                    ```typescript
                    const session = { id: 'scenario', active: true } satisfies Session
                    ```

                    ```python
                    async def render(session_id: str) -> bool:
                        return await cache.is_ready(session_id)
                    ```

                    > A long_unbroken_token_abcdefghijklmnopqrstuvwxyz0123456789 must wrap inside the cached layout.
                    """]),
                    message(contentStressID, 3, "idle"),
                ],
                preview: preview("Final content matrix", "agent_message")
            )]
        )

        let lifecycleID = "transition-full-lifecycle"
        let lifecycleUser = [message(lifecycleID, 1, "user_message", ["content": "Run the complete production lifecycle."])]
        let lifecycleQuestion = action(lifecycleID, "question", [
            "id": "lifecycle-question",
            "question": "Should I include the reconnect regression?",
            "choices": ["Yes, include it", "No, keep this focused"],
        ])
        add(
            lifecycleID,
            category: "Transitions & reconnect",
            title: "38 · Transition · Full streaming lifecycle",
            summary: "Play through draft → tool → permission → question → final bubble using one stable live-card identity.",
            phases: [
                phase("User prompt accepted", messages: lifecycleUser, state: .active, preview: preview("Run the complete lifecycle", "user_message")),
                phase("Narration delta", messages: lifecycleUser, card: .init(text: "I’ll walk the production state machine in order.", action: nil), preview: preview("Walking the state machine", "agent_message")),
                phase("Tool running", messages: lifecycleUser, card: .init(text: "I’m reading the relevant source first.", action: action(lifecycleID, "tool_start", ["toolName": "read", "headline": "Read MessageStore.swift", "toolCallId": "lifecycle-read"])), preview: preview("Read MessageStore.swift", "agent_message")),
                phase("Permission requested", messages: lifecycleUser, card: .init(text: "The edit requires approval.", action: action(lifecycleID, "permission", ["id": "lifecycle-permission", "toolName": "write_file", "description": "MacChatScenarioTestView.swift"])), preview: preview("Permission required", "permission")),
                phase("Permission resolved", messages: lifecycleUser, card: .init(text: "Approval received; continuing.", action: action(lifecycleID, "permission", ["id": "lifecycle-permission", "toolName": "write_file", "description": "MacChatScenarioTestView.swift", "decision": "approve"])), preview: preview("Approval received", "permission")),
                phase("Question requested", messages: lifecycleUser, card: .init(text: "One behavior remains ambiguous.", action: lifecycleQuestion), preview: preview("Should I include reconnect?", "question")),
                phase("Question answered", messages: lifecycleUser, card: .init(text: "I’ll include reconnect coverage.", action: action(lifecycleID, "question", ["id": "lifecycle-question", "question": "Should I include the reconnect regression?", "choices": ["Yes, include it", "No, keep this focused"], "answer": "Yes, include it"])), preview: preview("Yes, include it", "question")),
                phase("Final persisted conclusion", messages: [
                    lifecycleUser[0],
                    message(lifecycleID, 9, "agent_message", ["content": "The full lifecycle completed without replacing the live Bubble with a second transient card.", "steps": 5]),
                    message(lifecycleID, 10, "idle"),
                ], state: .idle, preview: preview("The full lifecycle completed", "agent_message")),
            ]
        )

        let reconnectID = "transition-reconnect-live"
        let reconnectMessages = [message(reconnectID, 1, "user_message", ["content": "Keep streaming across a reconnect."])]
        add(
            reconnectID,
            category: "Transitions & reconnect",
            title: "39 · Transition · Reconnect live snapshot",
            summary: "Use the Disconnect/Reconnect control: cached page stays mounted and subscription snapshot restores the live card.",
            phases: [
                phase("Live before disconnect", messages: reconnectMessages, card: .init(text: "This draft exists before the socket drops.", action: action(reconnectID, "tool_start", ["toolName": "bash", "headline": "pnpm test", "toolCallId": "reconnect-test"])), preview: preview("This draft exists before disconnect", "agent_message")),
                phase("Authoritative reconnect snapshot", messages: reconnectMessages, card: .init(text: "The reconnect snapshot replaced the draft atomically and retained the action slot.", action: action(reconnectID, "tool_start", ["toolName": "bash", "headline": "pnpm test", "toolCallId": "reconnect-test"])), preview: preview("Reconnect snapshot restored", "agent_message")),
            ]
        )

        let lateID = "transition-late-frame-gate"
        let lateUser = message(lateID, 1, "user_message", ["content": "Do not resurrect a concluded card."])
        add(
            lateID,
            category: "Transitions & reconnect",
            title: "40 · Transition · Late-frame gate",
            summary: "A conclusion closes transient state; late coalesced frames remain absent until the next ordinary user turn.",
            phases: [
                phase("Live card open", messages: [lateUser], card: .init(text: "This draft is still live.", action: nil), preview: preview("This draft is still live", "agent_message")),
                phase("Turn concluded", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle")], state: .idle, preview: preview("The durable conclusion landed", "agent_message")),
                phase("Late frame ignored", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle")], state: .idle, preview: preview("No resurrected card should appear", "agent_message")),
                phase("Next turn reopens gate", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle"), message(lateID, 4, "user_message", ["content": "Start the next ordinary turn."])], card: .init(text: "A new ordinary prompt legitimately opens a fresh live card.", action: nil), state: .active, preview: preview("A fresh live card is open", "agent_message")),
            ]
        )

        func switchScenario(
            id: String,
            title: String,
            deviceID: String,
            text: String,
            actionMessage: ChatMessage
        ) {
            add(
                id,
                category: "Transitions & reconnect",
                title: title,
                summary: "Rapid-switch target with an authoritative subscription card snapshot.",
                deviceID: deviceID,
                phases: [phase(
                    "Live subscription snapshot",
                    messages: [message(id, 1, "user_message", ["content": "Open \(title) while another Session is streaming."])],
                    card: .init(text: text, action: actionMessage),
                    preview: preview(text, actionMessage.type == "question" ? "question" : "agent_message")
                )]
            )
        }
        switchScenario(
            id: "switch-live-a",
            title: "41 · Switch · Live A",
            deviceID: Self.onlineDeviceA,
            text: "Session A is streaming on Tentacle A.",
            actionMessage: action("switch-live-a", "tool_start", ["toolName": "read", "headline": "Read Session A", "toolCallId": "switch-a"])
        )
        switchScenario(
            id: "switch-live-b",
            title: "42 · Switch · Live B same Tentacle",
            deviceID: Self.onlineDeviceA,
            text: "Session B asks a question on the same Tentacle.",
            actionMessage: action("switch-live-b", "question", ["id": "switch-b-question", "question": "Did same-Tentacle replacement keep the correct card?", "choices": ["Yes", "No"]])
        )
        switchScenario(
            id: "switch-live-c",
            title: "43 · Switch · Live C other Tentacle",
            deviceID: Self.onlineDeviceB,
            text: "Session C streams on Tentacle B after releasing Tentacle A.",
            actionMessage: action("switch-live-c", "tool_start", ["toolName": "bash", "headline": "Run on Tentacle B", "toolCallId": "switch-c"])
        )

        let unreadID = "sidebar-unread-agent"
        add(
            unreadID,
            category: "Sidebar projection",
            title: "44 · Sidebar · Unread agent attention",
            summary: "Agent conclusion advances lastSeq while readSeq remains behind, producing one red unread dot.",
            phases: [phase(
                "Unread before entry",
                messages: basicConversation(unreadID, user: "Notify me when complete.", agent: "The requested work is complete."),
                preview: preview("The requested work is complete", "agent_message"),
                readSeq: 1
            )]
        )

        let humanReadID = "sidebar-human-echo-read"
        add(
            humanReadID,
            category: "Sidebar projection",
            title: "45 · Sidebar · Human echo remains read",
            summary: "A contiguous ordinary user_message received while caught up advances both cursors.",
            phases: [phase(
                "Caught-up human append",
                messages: [message(humanReadID, 1, "user_message", ["content": "This human echo should not create unread attention."])],
                preview: preview("This human echo should not create unread attention", "user_message"),
                readSeq: 1
            )]
        )

        let sidebarDraftID = "sidebar-draft"
        add(
            sidebarDraftID,
            category: "Sidebar projection",
            title: "46 · Sidebar · Unsent draft",
            summary: "Draft text remains stored, [draft] is absent, and only the human icon turns red.",
            phases: [phase(
                "Draft retained",
                messages: basicConversation(sidebarDraftID, user: "Previous prompt", agent: "Previous response"),
                preview: preview("Previous response", "agent_message"),
                draft: "Unsent Composer draft retained across Session switches"
            )]
        )

        let pinnedID = "sidebar-pinned-active"
        add(
            pinnedID,
            category: "Sidebar projection",
            title: "47 · Sidebar · Pinned active",
            summary: "Pinned ordering, active dots, title truncation, model metadata, and live preview coexist.",
            pinned: true,
            phases: [phase(
                "Pinned and active",
                messages: [message(pinnedID, 1, "user_message", ["content": "Keep this pinned Session active."])],
                card: .init(text: "Pinned Session is actively producing text for the sidebar projection.", action: nil),
                preview: preview("Pinned Session is actively producing text", "agent_message")
            )]
        )

        return (definitions, attachments)
    }

    static func makePNG(
        size: NSSize,
        colors: [NSColor],
        label: String
    ) -> Data {
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        if let gradient = NSGradient(colors: colors) {
            gradient.draw(in: rect, angle: -24)
        } else {
            NSColor.systemBlue.setFill()
            rect.fill()
        }
        NSColor.black.withAlphaComponent(0.22).setFill()
        NSBezierPath(roundedRect: rect.insetBy(dx: 30, dy: 30), xRadius: 26, yRadius: 26).fill()
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: max(24, min(size.width, size.height) * 0.075), weight: .bold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ]
        (label as NSString).draw(
            in: NSRect(x: 40, y: size.height * 0.42, width: size.width - 80, height: size.height * 0.2),
            withAttributes: attributes
        )
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [.compressionFactor: 0.92]) else {
            return Data()
        }
        return png
    }
}
#endif
