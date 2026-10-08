#if DEBUG
import SwiftUI
import VoiceInputCore

/// No credentials, network or microphone: actual ChatView/MessageInputView wired
/// to a deterministic engine and temporary stores for native gesture acceptance.
@MainActor enum IOSVoiceHoldScenarioFixture {
    static let driver = IOSVoiceHoldScenarioDriver()
    static func makeAppState(driver: IOSVoiceHoldScenarioDriver = IOSVoiceHoldScenarioFixture.driver) -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-hold-\(UUID().uuidString)")
        let app = AppState(testDatabase: try! MessageDatabase(databaseURL: root.appendingPathComponent("test.sqlite")), voiceController: driver.voice)
        app.connectionStatus = .connected
        app.voiceCapability = driver.voiceCapability
        app.deviceId = "voice-test-app"
        app.user = UserInfo(id: "voice-test-user", login: "Isolated test")
        for id in ["voice-a", "voice-b"] {
            app.sessionStore.sessions[id] = SessionInfo(id: id, deviceId: "voice-test-device", deviceName: "Isolated Simulator", agent: "pi", title: id == "voice-a" ? "Voice Hold C" : "Other conversation", state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        }
        app.deviceStore.devices["voice-test-device"] = DeviceSummary(id: "voice-test-device", name: "Isolated Simulator", role: .tentacle, kind: .desktop, online: true)
        app.sessionStore.activeSessionId = "voice-a"
        app.testOutboundMessageHandler = { [weak app] payload, sessionID, _ in
            if payload["type"] as? String == "abort_session" { driver.aborts += 1 }
            if payload["type"] as? String == "send_input" {
                driver.lastAnswerTo = (payload["payload"] as? [String: Any])?["answerTo"] as? String ?? ""
                driver.sentCount += 1
                #if os(iOS)
                if UIApplication.shared.applicationState == .background { driver.sentInBackground += 1 }
                #endif
                driver.lastSent = (payload["payload"] as? [String: Any])?["text"] as? String ?? ""
                // Keep the scenario available for the next gesture without inventing a server reply.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    if let sessionID { app?.commandSender?.clearAllPending(sessionID) }
                }
            }
            return true
        }
        return app
    }
}

@Observable final class IOSVoiceHoldScenarioDriver: KrakiVoiceInputHost, VoiceInputSessionFactory {
    var voiceCapability: VoiceCapability? = .init(brokerUrl: "wss://voice.invalid", resource: "voice/doubao")
    var voiceUserID: String? = "voice-test-user"
    var voiceDeviceID: String? = "voice-test-app"
    var voiceTransportReady = true
    var sentCount = 0
    var sentInBackground = 0
    var lastSent = ""
    var starts = 0
    var aborts = 0
    var lastAnswerTo = ""
    @ObservationIgnored private var latestEvent: ((VoiceInputEvent) -> Void)?
    private let automaticCorrections: Bool
    init(automaticCorrections: Bool = true) { self.automaticCorrections = automaticCorrections }
    func emit(_ event: VoiceInputEvent) { latestEvent?(event) }
    func emitLevel(_ level: Float) { emit(.level(level)) }
    @ObservationIgnored lazy var voice = KrakiVoiceInputController(host: self, sessionFactory: self, audioPolicy: ScenarioAudio())
    func requestVoiceLease(resource: String) -> Bool {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(20))
            guard let self else { return }
            let now = Int(Date().timeIntervalSince1970)
            self.voice.receiveLease(.init(payload: .init(ver: 1, iss: "test", sub: "voice-test-user", did: "voice-test-app", iat: now, exp: now + 600, quotaSeconds: 600, resource: resource, jti: UUID().uuidString), signature: "synthetic", alg: "RSA-SHA256"))
        }
        return true
    }
    func makeSession(configuration: VoiceInputConfiguration, onEvent: @escaping (VoiceInputEvent) -> Void, onMetric: @escaping (VoiceInputMetric) -> Void) -> VoiceInputSessionProtocol {
        latestEvent = onEvent
        let session = ScenarioSession(onEvent: onEvent, onStart: { [weak self] in self?.starts += 1 }, automaticCorrections: automaticCorrections)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(40))
            onEvent(.connectionAuthorized)
        }
        return session
    }
    private struct ScenarioAudio: VoiceInputAudioPolicy {
        var permission: VoiceMicrophonePermission { .granted }
        var hasInputDevice: Bool { true }
        func requestPermission() async -> Bool { true }
        func activate() -> Bool { true }
        func deactivate() {}
    }
    private final class ScenarioSession: VoiceInputSessionProtocol {
        let correctionEnabled = true
        let pcmDumpPath: String? = nil
        let onEvent: (VoiceInputEvent) -> Void
        let onStart: () -> Void
        var generation = UUID()
        let automaticCorrections: Bool
        init(onEvent: @escaping (VoiceInputEvent) -> Void, onStart: @escaping () -> Void, automaticCorrections: Bool) {
            self.onEvent = onEvent; self.onStart = onStart; self.automaticCorrections = automaticCorrections
        }
        func startCapture(context: [String: VoiceInputJSONValue], vocabulary: [String]) {
            onStart()
            let id = UUID(); generation = id
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == id else { return }
                self.onEvent(.partial("\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki \u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}"))
                // Deterministic peaks for the shared native level meter.
                for level: Float in [0.01, 0.03, 0.08, 0.2, 0.12, 0.06, 0.025, 0.01] {
                    self.onEvent(.level(level))
                }
            }
        }
        func stopCapture() {
            guard automaticCorrections else { return }
            let id = generation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == id else { return }
                self.onEvent(.correctionDelta("\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}"))
                let delay = Int(ProcessInfo.processInfo.environment["KRAKI_VOICE_TEST_FINAL_MS"] ?? "1800") ?? 1800
                try? await Task.sleep(for: .milliseconds(delay))
                guard self.generation == id else { return }
                self.onEvent(.final("\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki\u{FF0C}\u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}\u{3002}", rawText: "\u{8BF7}\u{628A}\u{8FD9}\u{4E2A}\u{529F}\u{80FD}\u{63A5}\u{5165} Kraki \u{4FDD}\u{7559}\u{539F}\u{6765}\u{7684}\u{8F93}\u{5165}\u{6846}"))
            }
        }
        func close() { generation = UUID() }
    }
}

#if os(iOS)
struct IOSVoiceHoldScenarioView: View {
    @Environment(AppState.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    private var driver: IOSVoiceHoldScenarioDriver { IOSVoiceHoldScenarioFixture.driver }
    private var id: String { app.sessionStore.activeSessionId ?? "voice-a" }
    private var stagedCount: Int {
        (app.commandSender?.pendingInputs(id) ?? []).filter { $0.payload["localState"]?.stringValue == "correcting" }.count
    }
    private var failedCount: Int {
        (app.commandSender?.pendingInputs(id) ?? []).filter { $0.payload["localState"]?.stringValue == "failed" }.count
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Seed draft") { app.iosVoiceComposer.retireKeepingDraft(); app.sessionStore.setDraft(id, "Prefix SUFFIX") }
                Button("Switch") {
                    app.sessionStore.activeSessionId = id == "voice-a" ? "voice-b" : "voice-a"
                }
                Button("Busy") {
                    // Toggle an agent turn so the primary button shows Stop.
                    guard var session = app.sessionStore.sessions[id] else { return }
                    session.state = session.state == .active ? .idle : .active
                    app.sessionStore.sessions[id] = session
                }
                Button("Ask") {
                    // The agent asks a free-form question on the spine.
                    let seq = (app.sessionStore.sessions[id]?.lastSeq ?? 0) + 1
                    app.messageProvider?.setTentacleInfo(sessionId: id, lastSeq: seq, deviceId: "voice-test-device")
                    let message: [String: Any] = [
                        "type": "agent_message", "seq": seq, "sessionId": id, "deviceId": "voice-test-device",
                        "timestamp": ISO8601.now(),
                        "payload": ["content": "\u{6211}\u{9700}\u{8981}\u{786E}\u{8BA4}\u{4E00}\u{4E0B}\u{3002}",
                                    "question": ["id": "q-\(seq)", "text": "\u{65B0}\u{4F1A}\u{8BDD}\u{9ED8}\u{8BA4}\u{7528}\u{54EA}\u{4E2A}\u{6A21}\u{578B}\u{FF1F}"]],
                    ]
                    if let json = try? JSONSerialization.data(withJSONObject: message) {
                        app.messageProvider?.ingestTailCandidate(id, json: json)
                    }
                    app.sessionStore.sessions[id]?.lastSeq = seq
                }
                Button("Reset") {
                    app.iosVoiceComposer.retireKeepingDraft()
                    app.sessionStore.setDraft(id, "")
                    app.commandSender?.reset()
                }
            }.font(.caption).padding(8)
            Text("sent=\(driver.sentCount) bgSent=\(driver.sentInBackground) starts=\(driver.starts) aborts=\(driver.aborts) rec=\(app.iosVoiceComposer.isRecording ? 1 : 0) finishing=\(app.iosVoiceComposer.isFinishing(in: id) ? 1 : 0) staged=\(stagedCount) failed=\(failedCount) session=\(id) appearance=\(colorScheme == .dark ? "dark" : "light")")
                .font(.system(size: 10, design: .monospaced)).accessibilityIdentifier("voice-test-state")
            Text(driver.lastSent).font(.caption2).lineLimit(1).accessibilityIdentifier("voice-test-sent")
            Text("answerTo=\(driver.lastAnswerTo)").font(.caption2).accessibilityIdentifier("voice-test-answer")
            NavigationStack { ChatView(sessionId: id).id(id) }
        }
        .onChange(of: app.iosVoiceComposer.isRecording) { _, recording in if recording { capture("recording", delay: 450) } }
        .onChange(of: stagedCount) { _, count in if count > 0 { capture("bubble-correcting", delay: 120) } }
    }
    private func capture(_ name: String, delay: Int = 150) {
        guard ProcessInfo.processInfo.environment["KRAKI_VOICE_TEST_SCREENSHOTS"] == "1" else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(delay))
            guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first(where: \.isKeyWindow) else { return }
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
            let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            let orientation = window.bounds.width > window.bounds.height ? "landscape" : "portrait"
            let appearance = colorScheme == .dark ? "dark" : "light"
            if let data = image.pngData() {
                try? data.write(to: directory.appendingPathComponent("voice-c-\(name).png"))
                try? data.write(to: directory.appendingPathComponent("voice-c-\(name)-\(orientation)-\(appearance).png"))
            }
        }
    }
}
#endif
#endif
