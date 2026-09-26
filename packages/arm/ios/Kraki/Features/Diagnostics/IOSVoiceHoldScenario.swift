#if os(iOS) && DEBUG
import SwiftUI
import VoiceInputCore

/// No credentials, network or microphone: actual ChatView/MessageInputView wired
/// to a deterministic engine and temporary stores for native gesture acceptance.
@MainActor enum IOSVoiceHoldScenarioFixture {
    static let driver = IOSVoiceHoldScenarioDriver()
    static func makeAppState() -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-hold-\(UUID().uuidString)")
        let app = AppState(testDatabase: try! MessageDatabase(databaseURL: root.appendingPathComponent("test.sqlite")), voiceController: driver.voice)
        app.connectionStatus = .connected
        app.voiceCapability = driver.voiceCapability
        app.deviceId = "voice-test-app"
        app.user = UserInfo(id: "voice-test-user", login: "Isolated test")
        for id in ["voice-a", "voice-b"] {
            app.sessionStore.sessions[id] = SessionInfo(id: id, deviceId: "voice-test-device", deviceName: "Isolated Simulator", agent: "pi", title: id == "voice-a" ? "Voice Hold C" : "Other conversation", state: .idle, mode: .discuss, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        }
        app.deviceStore.devices["voice-test-device"] = DeviceSummary(id: "voice-test-device", name: "Isolated Simulator", role: .tentacle, kind: .desktop, online: true)
        app.sessionStore.activeSessionId = "voice-a"
        app.testOutboundMessageHandler = { [weak app] payload, sessionID, _ in
            if payload["type"] as? String == "abort_session" { driver.aborts += 1 }
            if payload["type"] as? String == "send_input" {
                driver.sentCount += 1
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
    var lastSent = ""
    var starts = 0
    var aborts = 0
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
        let session = ScenarioSession(onEvent: onEvent, onStart: { [weak self] in self?.starts += 1 })
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
        init(onEvent: @escaping (VoiceInputEvent) -> Void, onStart: @escaping () -> Void) { self.onEvent = onEvent; self.onStart = onStart }
        func startCapture(context: [String: VoiceInputJSONValue], vocabulary: [String]) {
            onStart()
            let id = UUID(); generation = id
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == id else { return }
                self.onEvent(.partial("请把这个功能接入 Kraki 保留原来的输入框"))
            }
        }
        func stopCapture() {
            let id = generation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == id else { return }
                self.onEvent(.correctionDelta("请把这个功能"))
                let delay = Int(ProcessInfo.processInfo.environment["KRAKI_VOICE_TEST_FINAL_MS"] ?? "1800") ?? 1800
                try? await Task.sleep(for: .milliseconds(delay))
                guard self.generation == id else { return }
                self.onEvent(.final("请把这个功能接入 Kraki，保留原来的输入框。", rawText: "请把这个功能接入 Kraki 保留原来的输入框"))
            }
        }
        func close() { generation = UUID() }
    }
}

struct IOSVoiceHoldScenarioView: View {
    @Environment(AppState.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    private var driver: IOSVoiceHoldScenarioDriver { IOSVoiceHoldScenarioFixture.driver }
    private var id: String { app.sessionStore.activeSessionId ?? "voice-a" }
    private var stagedCount: Int {
        (app.commandSender?.pendingInputs(id) ?? []).filter { $0.payload["localState"]?.stringValue == "correcting" }.count
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
                Button("Reset") {
                    app.iosVoiceComposer.retireKeepingDraft()
                    app.sessionStore.setDraft(id, "")
                    app.commandSender?.reset()
                }
            }.font(.caption).padding(8)
            Text("sent=\(driver.sentCount) starts=\(driver.starts) aborts=\(driver.aborts) rec=\(app.iosVoiceComposer.isRecording ? 1 : 0) finishing=\(app.iosVoiceComposer.isFinishing(in: id) ? 1 : 0) staged=\(stagedCount) session=\(id) appearance=\(colorScheme == .dark ? "dark" : "light")")
                .font(.system(size: 10, design: .monospaced)).accessibilityIdentifier("voice-test-state")
            Text(driver.lastSent).font(.caption2).lineLimit(1).accessibilityIdentifier("voice-test-sent")
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
