import XCTest
import VoiceInputCore
@testable import Kraki

@MainActor
private final class FakeVoiceHost: KrakiVoiceInputHost {
    var voiceCapability: VoiceCapability? = VoiceCapability(
        brokerUrl: "wss://voice.example.test/voice",
        resource: "voice/doubao"
    )
    var voiceUserID: String? = "user-1"
    var voiceDeviceID: String? = "device-1"
    var voiceTransportReady = true
    var requestedResources: [String] = []
    var onLeaseRequest: (() -> Void)?

    func requestVoiceLease(resource: String) -> Bool {
        onLeaseRequest?()
        requestedResources.append(resource)
        return voiceTransportReady
    }
}

private final class FakeVoiceSession: VoiceInputSessionProtocol {
    let correctionEnabled: Bool
    let pcmDumpPath: String? = nil
    private let onEvent: (VoiceInputEvent) -> Void
    private let onMetric: (VoiceInputMetric) -> Void
    private(set) var stopCount = 0
    private(set) var closeCount = 0
    private(set) var starts: [([String: VoiceInputJSONValue], [String])] = []

    init(
        correctionEnabled: Bool,
        onEvent: @escaping (VoiceInputEvent) -> Void,
        onMetric: @escaping (VoiceInputMetric) -> Void
    ) {
        self.correctionEnabled = correctionEnabled
        self.onEvent = onEvent
        self.onMetric = onMetric
    }

    func startCapture(
        context: [String: VoiceInputJSONValue],
        vocabulary: [String]
    ) {
        starts.append((context, vocabulary))
    }
    func stopCapture() { stopCount += 1 }
    func close() { closeCount += 1 }
    func emit(_ event: VoiceInputEvent) { onEvent(event) }
    func emitMetric(_ metric: VoiceInputMetric) { onMetric(metric) }
}

private final class FakeVoiceFactory: VoiceInputSessionFactory {
    private(set) var configurations: [VoiceInputConfiguration] = []
    private(set) var sessions: [FakeVoiceSession] = []

    func makeSession(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping (VoiceInputEvent) -> Void,
        onMetric: @escaping (VoiceInputMetric) -> Void
    ) -> VoiceInputSessionProtocol {
        configurations.append(configuration)
        let session = FakeVoiceSession(
            correctionEnabled: configuration.correctionEnabled,
            onEvent: onEvent,
            onMetric: onMetric
        )
        sessions.append(session)
        return session
    }
}

@MainActor
private final class FakeVoiceAudioPolicy: VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission = .granted
    var hasInputDevice = true
    var permissionRequestSucceeds = true
    var activationSucceeds = true
    private(set) var permissionRequestCount = 0
    private(set) var activationCount = 0
    private(set) var deactivationCount = 0
    var onPermissionRequest: (() -> Void)?
    var onActivation: (() -> Void)?

    func requestPermission() async -> Bool {
        onPermissionRequest?()
        permissionRequestCount += 1
        if permission == .undetermined, permissionRequestSucceeds {
            permission = .granted
        }
        return permissionRequestSucceeds && permission == .granted
    }
    func activate() -> Bool {
        onActivation?()
        activationCount += 1
        return activationSucceeds
    }
    func deactivate() { deactivationCount += 1 }
}

@MainActor
private final class SuspendedVoiceAudioPolicy: VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission = .undetermined
    var hasInputDevice = true
    private(set) var activationCount = 0
    private(set) var requestStarted = false
    private var continuation: CheckedContinuation<Bool, Never>?

    func requestPermission() async -> Bool {
        requestStarted = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func resolvePermission(granted: Bool) {
        permission = granted ? .granted : .denied
        continuation?.resume(returning: granted)
        continuation = nil
    }

    func activate() -> Bool {
        activationCount += 1
        return true
    }

    func deactivate() {}
}

@MainActor
final class KrakiVoiceInputTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    func testRoutineTestHostCannotRequestLiveMicrophone() async {
        XCTAssertTrue(NativeTestRuntime.isRunningTests)
        XCTAssertFalse(NativeTestRuntime.allowsLiveAudio)
        let policy = LiveVoiceInputAudioPolicy()
        XCTAssertEqual(policy.permission, .denied)
        XCTAssertFalse(policy.hasInputDevice)
        let granted = await policy.requestPermission()
        XCTAssertFalse(granted)
        XCTAssertFalse(policy.activate())
        policy.deactivate()
    }

    func testDefaultUIFixtureVoiceDoesNotRequestLeaseOrRecord() async {
        let host = FakeVoiceHost()
        let controller = KrakiVoiceInputController.isolatedForTesting()
        controller.bind(host: host)
        controller.prepare()
        XCTAssertTrue(host.requestedResources.isEmpty)
        await controller.begin(sessionID: "session-1", context: context()) { _ in
            XCTFail("An isolated UI fixture must not record")
        }
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
        XCTAssertFalse(controller.isConnectionWarm)
        XCTAssertTrue(host.requestedResources.isEmpty)
    }

    func testUnitTestHostHasNoProductionNetworkGraph() {
        let app = AppState.makeUnitTestHost()
        XCTAssertNil(app.wsClient)
        XCTAssertNil(app.authManager)
        XCTAssertTrue(app.sessionStore.sessions.isEmpty)
    }

    private func lease(
        expiryOffset: Int = 600,
        jti: String = "lease-1",
        issuedAt: Int? = nil,
        expiration: Int? = nil,
        quota: Int = 600
    ) -> VoiceLease {
        let now = Int(Date().timeIntervalSince1970)
        return VoiceLease(
            payload: VoiceLeasePayload(
                ver: 1,
                iss: "kraki-head",
                sub: "user-1",
                did: "device-1",
                iat: issuedAt ?? now,
                exp: expiration ?? now + expiryOffset,
                quotaSeconds: quota,
                resource: "voice/doubao",
                jti: jti
            ),
            signature: "signature",
            alg: "RSA-SHA256"
        )
    }

    private func context() -> VoiceSessionContext {
        VoiceSessionContext(
            fields: ["sessionId": .string("session-1")],
            vocabulary: ["Kraki"]
        )
    }

    private func draftStore() -> SessionStore {
        let store = SessionStore(persistenceEnabled: false)
        for id in ["session-1", "session-2"] {
            store.sessions[id] = SessionInfo(
                id: id, deviceId: "device-1", deviceName: "Test", agent: "pi",
                state: .idle, mode: .auto, lastSeq: 0, readSeq: 0,
                messageCount: 0, createdAt: Date(), pinned: false
            )
        }
        return store
    }

    private func departureFixture(onFinal: @escaping (String) -> Void) async -> (
        host: FakeVoiceHost, factory: FakeVoiceFactory, controller: KrakiVoiceInputController
    ) {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory, audioPolicy: FakeVoiceAudioPolicy()
        )
        await controller.begin(sessionID: "session-1", context: context(), onFinal: onFinal)
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        return (host, factory, controller)
    }

    func testSessionDepartureFinishesOnceAndCommitsToOriginalDraftAfterSwitch() async {
        let store = draftStore()
        store.setDraft("session-1", "existing")
        store.setDraft("session-2", "other conversation")
        let fixture = await departureFixture(onFinal: store.voiceDraftCommitHandler(for: "session-1"))
        let session = fixture.factory.sessions[0]
        session.emit(.partial("raw speech"))
        await Task.yield()

        // Old view disappears, new view appears, then the user switches again.
        fixture.controller.finishForSessionDeparture("session-1")
        fixture.controller.finishForSessionDeparture("session-1")
        fixture.controller.finishForSessionDeparture("session-2")
        XCTAssertEqual(fixture.controller.state, .finishing)
        XCTAssertEqual(fixture.controller.activeSessionID, "session-1")
        XCTAssertEqual(session.stopCount, 1)
        XCTAssertEqual(session.closeCount, 0)
        XCTAssertEqual(store.drafts["session-1"], "existing")
        await fixture.controller.begin(sessionID: "session-2", context: context()) { _ in
            XCTFail("A second recording cannot take over pending correction")
        }
        session.emit(.correctionDelta("corrected"))
        await Task.yield()
        XCTAssertEqual(store.drafts["session-1"], "existing")
        session.emit(.final("corrected speech", rawText: "raw speech"))
        await Task.yield()
        XCTAssertEqual(store.drafts["session-1"], "existing corrected speech")
        XCTAssertEqual(store.drafts["session-2"], "other conversation")
        XCTAssertEqual(fixture.controller.state, .idle)
        XCTAssertNil(fixture.controller.activeSessionID)
        session.emit(.final("duplicate", rawText: nil))
        await Task.yield()
        XCTAssertEqual(store.drafts["session-1"], "existing corrected speech")
    }

    func testDepartureDuringCorrectionPreservesLatestDraftEdits() async {
        let store = draftStore()
        store.setDraft("session-1", "obsolete prefix")
        let fixture = await departureFixture(onFinal: store.voiceDraftCommitHandler(for: "session-1"))
        let session = fixture.factory.sessions[0]
        fixture.controller.finish()
        fixture.controller.finishForSessionDeparture("session-1")
        // Returning to the conversation or another editor may replace the draft.
        store.setDraft("session-1", "edited prefix")
        session.emit(.final("voice result", rawText: nil))
        await Task.yield()
        XCTAssertEqual(session.stopCount, 1)
        XCTAssertEqual(store.drafts["session-1"], "edited prefix voice result")
    }

    func testDepartureFailurePreservesCompleteRawNotPartialCorrection() async {
        for reason in ["timed out waiting for transcript", "socket disconnected"] {
            var finals: [String] = []
            let fixture = await departureFixture { finals.append($0) }
            let session = fixture.factory.sessions[0]
            session.emit(.partial("complete raw transcript with important tail"))
            await Task.yield()
            fixture.controller.finishForSessionDeparture("session-1")
            session.emit(.correctionDelta("short correction"))
            session.emit(.failed(reason))
            await Task.yield()
            XCTAssertEqual(finals, ["complete raw transcript with important tail"])
            XCTAssertFalse(fixture.controller.isBusy)
            XCTAssertTrue(fixture.controller.hasFailure(for: "session-1"))
            XCTAssertFalse(fixture.controller.hasFailure(for: "session-2"))
            session.emit(.final("late corrected result", rawText: nil))
            await Task.yield()
            XCTAssertEqual(finals.count, 1)
            fixture.controller.clearFailure()
            XCTAssertFalse(fixture.controller.hasFailure(for: "session-1"))
            fixture.controller.suspendWarmConnection()
        }
    }

    func testSynchronousPreflightFailureBelongsToInitiatingConversation() async {
        let savedWait = KrakiVoiceInputController.connectionWaitTimeout
        KrakiVoiceInputController.connectionWaitTimeout = 0.2
        defer { KrakiVoiceInputController.connectionWaitTimeout = savedWait }
        for unavailable in [false, true] {
            let host = FakeVoiceHost()
            if unavailable { host.voiceCapability = nil }
            else { host.voiceTransportReady = false }
            let factory = FakeVoiceFactory()
            let audio = FakeVoiceAudioPolicy()
            let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
            for id in ["session-1", "session-2"] {
                await controller.begin(sessionID: id, context: context()) { _ in XCTFail("No speech") }
                XCTAssertTrue(controller.hasFailure(for: id))
                XCTAssertFalse(controller.hasFailure(for: id == "session-1" ? "session-2" : "session-1"))
            }
            XCTAssertEqual(audio.activationCount, 0)
            XCTAssertTrue(factory.sessions.isEmpty)
        }
    }

    // MARK: Pressed while Kraki is reconnecting

    private func waitFor(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    }

    func testPressWhileReconnectingWaitsThenStartsWhenConnected() async {
        let host = FakeVoiceHost()
        host.voiceTransportReady = false
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
        let start = Task { await controller.begin(sessionID: "session-1", context: context()) { _ in } }
        await waitFor { controller.state == .waitingForConnection }
        XCTAssertEqual(controller.state, .waitingForConnection, "the voice UI shows Connecting…, not an error")
        XCTAssertTrue(controller.isBusy)
        XCTAssertFalse(controller.hasFailure(for: "session-1"))
        XCTAssertEqual(audio.activationCount, 0, "no microphone before the connection is back")
        XCTAssertEqual(VoiceComposerPresentation.statusText(state: controller.state, rawText: "", displayText: ""), "Connecting…")

        host.voiceTransportReady = true
        await start.value
        XCTAssertEqual(controller.state, .obtainingLease, "continues by itself once connected")
        XCTAssertEqual(audio.activationCount, 1)
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
        controller.cancel()
    }

    func testReleaseWhileWaitingForConnectionNeverOpensTheMicrophone() async {
        let host = FakeVoiceHost()
        host.voiceTransportReady = false
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
        let start = Task { await controller.begin(sessionID: "session-1", context: context()) { _ in } }
        await waitFor { controller.state == .waitingForConnection }
        controller.cancel()
        host.voiceTransportReady = true
        await start.value
        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(audio.activationCount, 0)
        XCTAssertTrue(factory.sessions.isEmpty)
        XCTAssertTrue(host.requestedResources.isEmpty)
    }

    func testWaitingForConnectionGivesUpWithAClearMessage() async {
        let savedWait = KrakiVoiceInputController.connectionWaitTimeout
        KrakiVoiceInputController.connectionWaitTimeout = 0.3
        defer { KrakiVoiceInputController.connectionWaitTimeout = savedWait }
        let host = FakeVoiceHost()
        host.voiceTransportReady = false
        let audio = FakeVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: FakeVoiceFactory(), audioPolicy: audio)
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
        XCTAssertEqual(controller.state, .failed("Couldn't connect to Kraki. Check your connection and try again."))
        XCTAssertEqual(audio.activationCount, 0)
    }

    func testFailureOwnershipResetsForNextConversation() async {
        let fixture = await departureFixture { _ in }
        fixture.controller.finishForSessionDeparture("session-1")
        fixture.factory.sessions[0].emit(.failed("socket disconnected"))
        await Task.yield()
        XCTAssertTrue(fixture.controller.hasFailure(for: "session-1"))
        await fixture.controller.begin(sessionID: "session-2", context: context()) { _ in }
        XCTAssertFalse(fixture.controller.hasFailure(for: "session-1"))
        fixture.factory.sessions.last?.emit(.failed("socket disconnected"))
        await Task.yield()
        XCTAssertTrue(fixture.controller.hasFailure(for: "session-2"))
        XCTAssertFalse(fixture.controller.hasFailure(for: "session-1"))
        fixture.controller.suspendWarmConnection()
        XCTAssertFalse(fixture.controller.hasFailure(for: "session-2"))
    }

    func testDepartureEmptyFinalUsesReceivedRaw() async {
        var finals: [String] = []
        let fixture = await departureFixture { finals.append($0) }
        let session = fixture.factory.sessions[0]
        session.emit(.partial("received speech"))
        await Task.yield()
        fixture.controller.finishForSessionDeparture("session-1")
        session.emit(.final("", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals, ["received speech"])
    }

    func testDepartureBeforeAnyTranscriptDoesNotCreateDraftOnFailure() async {
        let store = draftStore()
        let fixture = await departureFixture(onFinal: store.voiceDraftCommitHandler(for: "session-1"))
        fixture.controller.finishForSessionDeparture("session-1")
        fixture.factory.sessions[0].emit(.failed("timed out waiting for transcript"))
        await Task.yield()
        XCTAssertNil(store.drafts["session-1"])
        fixture.controller.suspendWarmConnection()
    }

    func testDepartureWhileObtainingLeaseDoesNotStartInvisibleRecording() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory, audioPolicy: FakeVoiceAudioPolicy()
        )
        await controller.begin(sessionID: "session-1", context: context()) { _ in XCTFail("No speech") }
        controller.finishForSessionDeparture("session-1")
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(factory.sessions[0].starts.isEmpty)
    }

    func testDepartureWhilePermissionPendingCannotResumeCapture() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = SuspendedVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
        let start = Task { @MainActor in
            await controller.begin(sessionID: "session-1", context: context()) { _ in XCTFail("No speech") }
        }
        while !audio.requestStarted { await Task.yield() }
        controller.finishForSessionDeparture("session-1")
        audio.resolvePermission(granted: true)
        await start.value
        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(audio.activationCount, 0)
        XCTAssertTrue(factory.sessions.isEmpty)
    }

    func testDepartureDuringLeaseRolloverPreservesEarlierSpeechWithoutRestart() async {
        var finals: [String] = []
        let fixture = await departureFixture { finals.append($0) }
        let old = fixture.factory.sessions[0]
        old.emit(.partial("speech from prior lease"))
        await Task.yield()
        old.emit(.failed("quota_exhausted"))
        await Task.yield()
        XCTAssertEqual(fixture.controller.state, .obtainingLease)
        fixture.controller.finishForSessionDeparture("session-1")
        XCTAssertEqual(finals, ["speech from prior lease"])
        XCTAssertEqual(fixture.controller.state, .idle)
        old.emit(.final("stale result", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals.count, 1)
        fixture.controller.suspendWarmConnection()
    }

    func testExplicitCancelAndIdentityTeardownStillDiscardPendingDeparture() async {
        for identityTeardown in [false, true] {
            var finals: [String] = []
            let fixture = await departureFixture { finals.append($0) }
            let session = fixture.factory.sessions[0]
            session.emit(.partial("do not restore after explicit discard"))
            await Task.yield()
            fixture.controller.finishForSessionDeparture("session-1")
            if identityTeardown { fixture.controller.suspendWarmConnection() }
            else { fixture.controller.cancel() }
            session.emit(.final("late result", rawText: nil))
            session.emit(.failed("late failure"))
            await Task.yield()
            XCTAssertTrue(finals.isEmpty)
            XCTAssertEqual(fixture.controller.state, .idle)
            fixture.controller.suspendWarmConnection()
        }
    }

    func testVoiceDraftCommitCannotResurrectDeletedSessionOrOldDraft() {
        let store = draftStore()
        store.setDraft("session-1", "obsolete")
        let commit = store.voiceDraftCommitHandler(for: "session-1")
        store.setDraft("session-1", "")
        commit("new voice")
        XCTAssertEqual(store.drafts["session-1"], "new voice")
        store.sessions.removeValue(forKey: "session-1")
        store.setDraft("session-1", "")
        commit("late voice")
        XCTAssertNil(store.drafts["session-1"])
    }

    func testCapabilityJSONDecodesAndInvalidShapeIsAbsent() {
        XCTAssertEqual(
            VoiceCapability(json: [
                "brokerUrl": "wss://cn.stt.kraki.chat/voice",
                "resource": "voice/doubao",
            ]),
            VoiceCapability(
                brokerUrl: "wss://cn.stt.kraki.chat/voice",
                resource: "voice/doubao"
            )
        )
        XCTAssertNil(VoiceCapability(json: ["resource": "voice/doubao"]))
    }

    func testCapabilityOnlyAcceptsKrakisOwnTLSBroker() {
        func capability(_ url: String) -> VoiceCapability? {
            VoiceCapability(json: ["brokerUrl": url, "resource": "voice/doubao"])
        }
        XCTAssertNotNil(capability("wss://cn.stt.kraki.chat/voice"))
        XCTAssertNotNil(capability("wss://kraki.chat/voice"))
        XCTAssertNil(capability("ws://cn.stt.kraki.chat/voice"), "cleartext")
        XCTAssertNil(capability("wss://evil.example/voice"), "not Kraki's")
        XCTAssertNil(capability("wss://kraki.chat.evil.example/voice"))
        XCTAssertNil(capability("wss://notkraki.chat/voice"))
        XCTAssertNil(capability("https://cn.stt.kraki.chat/voice"))
        // Debug builds (tests) also accept a local broker.
        XCTAssertNotNil(capability("ws://127.0.0.1:4500/voice"))
    }

    func testSecretShapedTermsNeverLeaveTheDevice() {
        let sensitive = [
            "ghp_0123456789abcdefABCDEF0123456789abcd", "github_pat_11ABCDEFG0123456789",
            "sk-proj-AbC123dEf456GhI789", "xoxb-1234-5678-abcdEFGH", "AKIAIOSFODNN7EXAMPLE",
            "AIzaSyD-1234567890abcdefghijk", "eyJhbGciOiJIUzI1NiJ9", "glpat-xxxxxxxxxxxxxxxxxxxx",
            "https://internal.corp.example/x", "build01.corp.internal:8443", "alice@example.com",
            "packages/arm/ios", "C:\\Users\\me", "3f9a1c2b7d4e5f60a1b2", "Zk3q9Xv2Lm8Rt5Wy1Pc7",
        ]
        for token in sensitive {
            XCTAssertTrue(VoiceContextTermFilter.isSensitive(token), token)
        }
        let useful = ["KrakiVoiceInputController", "PostgreSQL", "Next.js", "gpt-5.6-sol", "InternalCodename-v2",
                      "snake_case_name", "iPhone", "README.md"]
        for token in useful {
            XCTAssertFalse(VoiceContextTermFilter.isSensitive(token), token)
        }
    }

    func testContextTermsDropSecretsFromMessagesAndTitle() {
        let session = SessionInfo(id: "s", deviceId: "d", deviceName: "D", agent: "pi",
                                  title: "ghp_0123456789abcdefABCDEF0123456789abcd",
                                  state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                                  createdAt: Date(), pinned: false)
        let message = ChatMessage(type: "user_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable(
                                    "use sk-proj-AbC123dEf456GhI789 on build01.corp.internal:8443 for PaymentService")])
        let context = VoiceSessionContextBuilder.build(session: session, recentMessages: [message],
                                                       userVocabulary: [], shareConversation: true)
        XCTAssertTrue(context.vocabulary.contains("PaymentService"))
        XCTAssertFalse(context.vocabulary.contains { $0.contains("sk-proj") || $0.contains("ghp_") || $0.contains("corp.internal") })
        guard case .object(let sessionFields)? = context.fields["session"] else { return XCTFail("missing session") }
        XCTAssertEqual(sessionFields["title"], .string(""))
    }

    func testVoiceTranscriptRevisionChangesWhenLatestTextChanges() {
        let first = VoiceComposerPresentation.transcriptPieces(
            prefix: "",
            state: .recording,
            rawText: "first line",
            correctionSource: "",
            correctionText: "",
            correctionSourceOffset: 0
        )
        let second = VoiceComposerPresentation.transcriptPieces(
            prefix: "",
            state: .recording,
            rawText: "first line and the newest words",
            correctionSource: "",
            correctionText: "",
            correctionSourceOffset: 0
        )
        XCTAssertNotEqual(
            VoiceComposerPresentation.transcriptRevision(first),
            VoiceComposerPresentation.transcriptRevision(second)
        )
        XCTAssertEqual(
            VoiceComposerPresentation.transcriptRevision(first),
            VoiceComposerPresentation.transcriptRevision(first)
        )
    }

    func testVoiceComposerAccessAllowsSteeringAndStructuredAnswers() {
        XCTAssertTrue(VoiceComposerAccessPolicy.isVisible(capabilityAvailable: true))
        XCTAssertTrue(VoiceComposerAccessPolicy.canStart(
            capabilityAvailable: true,
            voiceControllerBusy: false
        ))
        XCTAssertEqual(
            MessageComposerPolicy.intent(
                isBusy: true,
                hasPermission: false,
                hasQuestion: false
            ),
            .steer
        )
        XCTAssertEqual(
            MessageComposerPolicy.intent(
                isBusy: true,
                hasPermission: false,
                hasQuestion: true
            ),
            .answerQuestion
        )
        XCTAssertFalse(VoiceComposerAccessPolicy.canStart(
            capabilityAvailable: true,
            voiceControllerBusy: true
        ))
        XCTAssertFalse(VoiceComposerAccessPolicy.isVisible(capabilityAvailable: false))
    }

    func testFirstPermissionGestureWaitsBeforeLeaseAndThenStartsNormally() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        audio.permission = .undetermined
        var order: [String] = []
        audio.onPermissionRequest = { order.append("permission") }
        audio.onActivation = { order.append("activation") }
        host.onLeaseRequest = { order.append("lease") }
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: audio
        )

        await controller.begin(sessionID: "session-1", context: context()) { _ in }

        XCTAssertEqual(controller.state, .obtainingLease)
        XCTAssertEqual(audio.permissionRequestCount, 1)
        XCTAssertEqual(audio.activationCount, 1)
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
        XCTAssertEqual(order, ["permission", "activation", "lease"])
        XCTAssertTrue(factory.sessions.isEmpty)

        controller.receiveLease(lease())
        XCTAssertEqual(controller.state, .obtainingLease)
        XCTAssertEqual(factory.sessions.count, 1)
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
    }

    func testMissingMicrophoneShowsActionableFailureWithoutStartingOrLosingDraft() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        audio.hasInputDevice = false
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: audio)
        var draft = "existing synthetic draft"
        await controller.begin(sessionID: "session-1", context: context(), onRecordingStarted: {
            draft = ""
        }) { draft = $0 }
        XCTAssertEqual(controller.state, .failed(VoiceInputError.microphoneUnavailable.localizedDescription))
        XCTAssertEqual(draft, "existing synthetic draft")
        XCTAssertFalse(controller.isBusy)
        XCTAssertEqual(audio.activationCount, 0)
        XCTAssertTrue(host.requestedResources.isEmpty)
        XCTAssertTrue(factory.sessions.isEmpty)
        // A newly connected device can be retried; failure is not sticky.
        audio.hasInputDevice = true
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .obtainingLease)
        XCTAssertEqual(audio.activationCount, 1)
    }

    func testMicrophoneDisappearingAfterPreflightUsesTheSameActionableFailure() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: FakeVoiceAudioPolicy())
        var draft = "existing synthetic draft"
        await controller.begin(sessionID: "session-1", context: context(), onRecordingStarted: {
            draft = ""
        }) { draft = $0 }
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        factory.sessions[0].emit(.failed("audio input unavailable; connect a microphone"))
        await Task.yield()
        XCTAssertEqual(controller.state, .failed(VoiceInputError.microphoneUnavailable.localizedDescription))
        XCTAssertFalse(controller.isBusy)
        XCTAssertEqual(draft, "existing synthetic draft")
    }

    func testDeniedPermissionFailsWithoutRequestingItAgain() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        audio.permission = .denied
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: audio
        )

        await controller.begin(sessionID: "session-1", context: context()) { _ in }

        XCTAssertEqual(controller.state, .failed(VoiceInputError.microphoneDenied.localizedDescription))
        XCTAssertEqual(audio.permissionRequestCount, 0)
        XCTAssertEqual(audio.activationCount, 0)
        XCTAssertTrue(host.requestedResources.isEmpty)
        XCTAssertTrue(factory.sessions.isEmpty)
    }

    func testCancelWhilePermissionPromptIsOpenDoesNotResumeRecordingSetup() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = SuspendedVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: audio
        )

        let beginTask = Task {
            await controller.begin(sessionID: "session-1", context: context()) { _ in }
        }
        while !audio.requestStarted { await Task.yield() }
        XCTAssertEqual(controller.state, .requestingPermission)

        controller.cancel()
        audio.resolvePermission(granted: true)
        await beginTask.value

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(audio.activationCount, 0)
        XCTAssertTrue(host.requestedResources.isEmpty)
        XCTAssertTrue(factory.sessions.isEmpty)
    }

    func testRecordingStartedCallbackFiresOnceForAudioEngineStart() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        var recordingStartedCount = 0

        await controller.begin(
            sessionID: "session-1",
            context: context(),
            onRecordingStarted: { recordingStartedCount += 1 },
            onFinal: { _ in }
        )
        XCTAssertEqual(recordingStartedCount, 0)

        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(recordingStartedCount, 0)

        factory.sessions[0].emitMetric(.webSocketOpened)
        XCTAssertEqual(recordingStartedCount, 0)

        factory.sessions[0].emitMetric(.engineStarted)
        await Task.yield()
        XCTAssertEqual(recordingStartedCount, 1)

        factory.sessions[0].emitMetric(.engineStarted)
        await Task.yield()
        XCTAssertEqual(recordingStartedCount, 1)
    }

    func testBeginRequestsLeaseForAdvertisedResourceAndBuildsNestedStartFields() async throws {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: audio
        )
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .obtainingLease)
        XCTAssertEqual(audio.permissionRequestCount, 0)
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])

        controller.receiveLease(lease())
        XCTAssertEqual(factory.sessions.count, 1)
        let authorize = try XCTUnwrap(factory.configurations.first?.gatewayAuthorizeMessage())
        XCTAssertEqual(authorize["deviceId"] as? String, "device-1")
        let nested = try XCTUnwrap(authorize["authorization"] as? [String: Any])
        XCTAssertEqual(nested["alg"] as? String, "RSA-SHA256")
        let payload = try XCTUnwrap(nested["payload"] as? [String: Any])
        XCTAssertEqual(payload["did"] as? String, "device-1")
        XCTAssertEqual(payload["resource"] as? String, "voice/doubao")

        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
        XCTAssertEqual(factory.sessions[0].starts[0].1, ["Kraki"])
    }

    func testPartialAndCorrectionNeverCommitButFinalCommitsExactlyOnce() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        let session = factory.sessions[0]

        session.emit(.partial("raw Cracky Voice input controller tail"))
        session.emit(.level(0.25))
        session.emit(.level(0.75))
        await Task.yield()
        XCTAssertEqual(controller.rawText, "raw Cracky Voice input controller tail")
        XCTAssertEqual(controller.levels.count, 8)
        XCTAssertEqual(controller.levels.suffix(2), [0.25, 0.75])
        XCTAssertTrue(finals.isEmpty)

        controller.finish()
        XCTAssertEqual(controller.correctionSource, "raw Cracky Voice input controller tail")
        session.emit(.correctionDelta("raw Kraki VoiceInputController"))
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(controller.correctionText, "raw Kraki VoiceInputController")
        XCTAssertGreaterThan(controller.correctionSourceOffset, 0)
        XCTAssertTrue(finals.isEmpty)

        session.emit(.final("authoritative", rawText: "raw"))
        await Task.yield()
        XCTAssertEqual(finals, ["authoritative"])
        XCTAssertEqual(controller.state, .idle)

        session.emit(.final("late duplicate", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals, ["authoritative"])
    }

    func testRuntimeVoiceFailuresKeepRawDraftAndExplainTheFailingStage() async {
        let cases = [
            ("audio capture stalled", "microphone stopped", "capture_stalled"),
            ("audio input changed during recording", "audio input changed", "capture_interrupted"),
            ("audio input format changed or is invalid", "audio input changed", "capture_interrupted"),
            ("voice upload stalled", "couldn't be uploaded", "upload_stalled"),
            ("ASR closed without final transcript", "recognition ended", "asr_final_missing"),
        ]
        for (reason, expected, cause) in cases {
            let host = FakeVoiceHost()
            let factory = FakeVoiceFactory()
            let controller = KrakiVoiceInputController(host: host, sessionFactory: factory,
                                                       audioPolicy: FakeVoiceAudioPolicy())
            var results: [VoiceInputCompletion] = []
            await controller.begin(sessionID: "session-1", context: context(), onCompletion: { results.append($0) }) { _ in }
            controller.receiveLease(lease())
            factory.sessions[0].emit(.connectionAuthorized)
            await Task.yield()
            factory.sessions[0].emit(.partial("keep every received word"))
            await Task.yield()
            factory.sessions[0].emit(.failed(reason))
            await Task.yield()
            guard case .failed(let message) = controller.state else { XCTFail(reason); continue }
            XCTAssertTrue(message.lowercased().contains(expected.lowercased()))
            XCTAssertEqual(results.count, 1)
            XCTAssertEqual(results.first?.rawText, "keep every received word")
            XCTAssertEqual(results.first?.completed, false)
            XCTAssertEqual(VoiceTracker.classify(gatewayReason: reason), cause)
            controller.suspendWarmConnection()
        }
    }

    func testPartialSegmentResetAppendsInsteadOfErasingEarlierSpeech() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        let session = factory.sessions[0]

        session.emit(.partial("This is the first completed spoken sentence"))
        session.emit(.partial("This is the first completed spoken sentence with a revision"))
        session.emit(.partial("and now the next sentence"))
        await Task.yield()

        XCTAssertEqual(
            controller.rawText,
            "This is the first completed spoken sentence with a revision and now the next sentence"
        )
        session.emit(.partial("and now the next sentence continues"))
        await Task.yield()
        XCTAssertEqual(
            controller.rawText,
            "This is the first completed spoken sentence with a revision and now the next sentence continues"
        )
    }

    func testSegmentedFinalPreservesAccumulatedPrefix() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        let session = factory.sessions[0]

        session.emit(.partial("The first spoken segment is complete and should remain"))
        session.emit(.partial("the second segment"))
        await Task.yield()
        session.emit(.final("the corrected second segment", rawText: "the second segment"))
        await Task.yield()

        XCTAssertEqual(
            finals,
            ["The first spoken segment is complete and should remain the corrected second segment"]
        )
    }

    func testCorrectionAlignmentIgnoresWhitespaceAndPrefersConsumedRawPrefix() {
        let raw = "Use State, um, then Cracky Voice input controller"
        let corrected = "useState, then KrakiVoiceInputController"
        let offset = KrakiVoiceInputController.alignedRawPrefixLength(
            corrected: corrected,
            raw: raw
        )
        XCTAssertGreaterThan(offset, 0)
        XCTAssertLessThanOrEqual(offset, raw.count)
        XCTAssertTrue(String(Array(raw).dropFirst(offset)).count < raw.count)
    }

    func testCorrectionAlignmentOnLongDictationFindsTheConsumedPrefix() {
        // A long dictation: the corrected text covers the first half of the
        // raw text, with small edits. The banded alignment must still find
        // the end of that half, and stay fast.
        let sentence = "please refactor the voice input controller and keep the tests green "
        let raw = String(repeating: sentence, count: 40)
        let half = String(repeating: sentence, count: 20)
        let corrected = half.replacingOccurrences(of: "voice input controller", with: "VoiceInputController")
        let started = Date()
        let offset = KrakiVoiceInputController.alignedRawPrefixLength(corrected: corrected, raw: raw)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        XCTAssertEqual(Double(offset), Double(half.count), accuracy: 3)
    }

    func testCancelSuppressesLateGrantAndLateFinal() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        controller.cancel()
        controller.receiveLease(lease())
        XCTAssertEqual(factory.sessions.count, 1)
        XCTAssertEqual(controller.state, .idle)
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertTrue(controller.isConnectionWarm)

        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        let old = factory.sessions[0]
        controller.cancel()
        old.emit(.final("late", rawText: nil))
        await Task.yield()
        XCTAssertTrue(finals.isEmpty)
    }

    func testLeaseIsNotBoundToItsIssuanceUTCDay() {
        let now = Int(Date().timeIntervalSince1970)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = utc.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(now)))
        let previousDay = utc.date(byAdding: .second, value: -1, to: today)!
        let previousDayLease = lease(
            issuedAt: Int(previousDay.timeIntervalSince1970),
            expiration: now + 600
        )
        // Head charges usage to the day it happens; midnight changes nothing.
        XCTAssertTrue(KrakiVoiceInputController.isLeaseUsable(previousDayLease, nowUnixSec: now))
        XCTAssertFalse(KrakiVoiceInputController.isLeaseUsable(lease(expiration: now + 3), nowUnixSec: now))
    }

    func testForegroundWarmConnectionSkipsGrantedPermissionUIAndIsReusedAcrossRecordings() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let audio = FakeVoiceAudioPolicy()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: audio
        )
        controller.prepare()
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
        controller.receiveLease(lease())
        XCTAssertEqual(factory.sessions.count, 1)
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertTrue(controller.isConnectionWarm)
        XCTAssertEqual(controller.state, .idle)

        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        XCTAssertEqual(audio.permissionRequestCount, 0)
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
        factory.sessions[0].emit(.final("first", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals, ["first"])
        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(factory.sessions[0].closeCount, 0)

        await controller.begin(sessionID: "session-2", context: context()) { finals.append($0) }
        XCTAssertEqual(audio.permissionRequestCount, 0)
        XCTAssertEqual(factory.sessions.count, 1)
        XCTAssertEqual(factory.sessions[0].starts.count, 2)
        factory.sessions[0].emit(.final("second", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals, ["first", "second"])
    }

    func testWrongDayConnectionDiscardsLeaseAndRequestsReplacement() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        controller.prepare()
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()

        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .recording)
        factory.sessions[0].emit(.failed("denied: lease_wrong_day"))
        for _ in 0..<20 where host.requestedResources.count < 2 {
            await Task.yield()
        }

        XCTAssertEqual(controller.state, .failed("The voice session authorization was rejected. Please try again."))
        XCTAssertEqual(host.requestedResources, ["voice/doubao", "voice/doubao"])
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        XCTAssertEqual(factory.sessions.count, 1)
    }

    private func storedLease(
        _ lease: VoiceLease,
        userID: String = "user-1"
    ) -> InMemoryVoiceLeaseStore {
        let store = InMemoryVoiceLeaseStore()
        store.save(StoredVoiceLease(
            lease: lease,
            identity: VoiceConnectionIdentity(
                brokerUrl: "wss://voice.example.test/voice",
                resource: "voice/doubao",
                userID: userID,
                deviceID: "device-1"
            )
        ))
        return store
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<40 where !condition() { await Task.yield() }
    }

    func testColdStartWarmsStoredLeaseBeforeHeadAndRecordsImmediately() async {
        let host = FakeVoiceHost()
        host.voiceTransportReady = false  // Head still connecting
        let factory = FakeVoiceFactory()
        let store = storedLease(lease())
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: store
        )
        controller.prepare()
        XCTAssertEqual(factory.sessions.count, 1)
        XCTAssertTrue(host.requestedResources.isEmpty)

        // Pressing before the broker authorized still records at once.
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
    }

    func testDeadStoredLeaseWhileSpeakingFailsVisiblyAndFetchesFreshLease() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let store = storedLease(lease())
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: store
        )
        controller.prepare()
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .recording)
        // Rejected before authorization: the buffered audio is lost, so the
        // recording must not silently continue without its beginning.
        factory.sessions[0].emit(.failed("denied: lease_revoked"))
        await Task.yield()
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
        XCTAssertNil(store.load())
        let deadline = Date().addingTimeInterval(5)
        while host.requestedResources.isEmpty, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
    }

    func testQuotaExhaustedBeforeAuthorizationFailsInsteadOfDroppingSpeech() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: storedLease(lease())
        )
        controller.prepare()
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        factory.sessions[0].emit(.failed("denied: quota_exhausted"))
        await Task.yield()
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
        XCTAssertEqual(factory.sessions.count, 1)
    }

    func testQuotaExhaustedBeforeAuthorizationAfterReleaseAlsoFailsVisibly() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: storedLease(lease())
        )
        controller.prepare()
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        controller.finish()
        XCTAssertEqual(controller.state, .finishing)
        factory.sessions[0].emit(.failed("denied: quota_exhausted"))
        await Task.yield()
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
    }

    func testIdentityChangeDuringKeptLeaseRecordingEndsItCleanly() async {
        let host = FakeVoiceHost()
        host.voiceTransportReady = false
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: storedLease(lease())
        )
        controller.prepare()
        var completions: [VoiceInputCompletion] = []
        await controller.begin(
            sessionID: "session-1", context: context(),
            onCompletion: { completions.append($0) }
        ) { _ in }
        factory.sessions[0].emit(.partial("hello"))
        await Task.yield()
        // Head connects and reports another account.
        host.voiceTransportReady = true
        host.voiceUserID = "user-2"
        controller.prepare()
        XCTAssertFalse(controller.isBusy)
        XCTAssertTrue(controller.hasFailure(for: "session-1"))
        XCTAssertEqual(completions.first?.rawText, "hello")
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
    }

    func testRenewalBeforeExpiryWaitsForIdleAndNeverShowsAuthorizing() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let now = Int(Date().timeIntervalSince1970)
        let store = storedLease(lease(issuedAt: now - 100, expiration: now + 8))
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: store
        )
        controller.prepare()
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()
        // The renewal is requested well before expiry, while idle.
        let deadline = Date().addingTimeInterval(4)
        while host.requestedResources.isEmpty, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])

        // The user starts speaking before the renewal arrives: nothing swaps.
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        controller.receiveLease(lease(expiryOffset: 86_400, jti: "lease-2"))
        XCTAssertEqual(factory.sessions.count, 1)
        XCTAssertEqual(factory.sessions[0].closeCount, 0)
        XCTAssertEqual(controller.state, .recording)

        // Once the transcript is in, the connection switches to the new lease.
        factory.sessions[0].emit(.final("hello", rawText: nil))
        await settle { factory.sessions.count == 2 }
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        XCTAssertEqual(store.load()?.lease.payload.jti, "lease-2")

        // A press during its re-authorization records at once.
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[1].starts.count, 1)
    }


    func testStoredLeaseOfAnotherAccountIsDiscarded() async {
        let host = FakeVoiceHost()
        host.voiceUserID = "user-2"
        let factory = FakeVoiceFactory()
        let store = storedLease(lease(), userID: "user-1")
        let controller = KrakiVoiceInputController(
            host: host, sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy(), leaseStore: store
        )
        controller.prepare()
        XCTAssertTrue(factory.sessions.isEmpty)
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
        XCTAssertNil(store.load())
    }

    func testRejectedLeaseIsDiscardedAndReplacedWithBackoff() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        controller.prepare()
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()

        factory.sessions[0].emit(.failed("denied: lease_revoked"))
        await Task.yield()
        // Not an immediate retry…
        XCTAssertEqual(host.requestedResources, ["voice/doubao"])
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        // …but after backoff a fresh lease is requested instead of reusing the dead one.
        let deadline = Date().addingTimeInterval(5)
        while host.requestedResources.count < 2, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(host.requestedResources, ["voice/doubao", "voice/doubao"])
        XCTAssertEqual(factory.sessions.count, 1)

        XCTAssertTrue(KrakiVoiceInputController.isLeaseRejection("denied: bad_signature"))
        XCTAssertTrue(KrakiVoiceInputController.isLeaseRejection("lease_expired"))
        XCTAssertFalse(KrakiVoiceInputController.isLeaseRejection("socket closed"))
    }

    func testQuotaExhaustedConnectionRollsLeaseAndContinuesRecording() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        controller.prepare()
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()

        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        XCTAssertEqual(controller.state, .recording)
        factory.sessions[0].emit(.partial("hi"))
        await Task.yield()
        factory.sessions[0].emit(.failed("denied: quota_exhausted"))
        for _ in 0..<20 where host.requestedResources.count < 2 {
            await Task.yield()
        }

        XCTAssertEqual(controller.state, .obtainingLease)
        XCTAssertEqual(controller.rawText, "hi")
        XCTAssertEqual(host.requestedResources, ["voice/doubao", "voice/doubao"])
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        XCTAssertTrue(finals.isEmpty)

        controller.receiveLease(lease(jti: "lease-2"))
        XCTAssertEqual(factory.sessions.count, 2)
        factory.sessions[1].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)
        XCTAssertEqual(factory.sessions[1].starts.count, 1)

        factory.sessions[1].emit(.partial("first segment after rollover"))
        await Task.yield()
        factory.sessions[1].emit(.partial("next"))
        await Task.yield()
        XCTAssertEqual(controller.rawText, "hi first segment after rollover next")
        controller.finish()
        factory.sessions[1].emit(.correctionDelta("corrected segment after rollover next"))
        await Task.yield()
        XCTAssertEqual(controller.displayText, "hi corrected segment after rollover next")
        factory.sessions[1].emit(
            .final(
                "corrected segment after rollover next",
                rawText: "first segment after rollover next"
            )
        )
        await Task.yield()
        XCTAssertEqual(finals, ["hi corrected segment after rollover next"])
        XCTAssertEqual(controller.state, .idle)
    }

    func testRepeatedBrokerQuotaExhaustionUsesRenewalErrorNotDailyQuotaError() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        controller.prepare()
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()

        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        factory.sessions[0].emit(.failed("denied: quota_exhausted"))
        for _ in 0..<20 where host.requestedResources.count < 2 {
            await Task.yield()
        }
        controller.receiveLease(lease(jti: "lease-2"))
        factory.sessions[1].emit(.connectionAuthorized)
        await Task.yield()
        XCTAssertEqual(controller.state, .recording)

        factory.sessions[1].emit(.failed("denied: quota_exhausted"))
        for _ in 0..<20 where host.requestedResources.count < 3 {
            await Task.yield()
        }

        XCTAssertEqual(
            controller.state,
            .failed("The voice session couldn't be renewed. Please try again.")
        )
        XCTAssertEqual(host.requestedResources.count, 3)
        XCTAssertTrue(finals.isEmpty)
    }

    func testQuotaExhaustedWhileFinishingCommitsRawDraftAndWarmsReplacement() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
        )
        controller.prepare()
        controller.receiveLease(lease())
        factory.sessions[0].emit(.connectionAuthorized)
        await Task.yield()

        var finals: [String] = []
        await controller.begin(sessionID: "session-1", context: context()) { finals.append($0) }
        factory.sessions[0].emit(.partial("recover this raw draft"))
        await Task.yield()
        controller.finish()
        XCTAssertEqual(controller.state, .finishing)

        factory.sessions[0].emit(.failed("denied: quota_exhausted"))
        for _ in 0..<20 where host.requestedResources.count < 2 {
            await Task.yield()
        }

        XCTAssertEqual(finals, ["recover this raw draft"])
        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(host.requestedResources, ["voice/doubao", "voice/doubao"])
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
    }

    func testLeaseDenialsRemainDistinct() async {
        let host = FakeVoiceHost()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: FakeVoiceFactory(),
            audioPolicy: FakeVoiceAudioPolicy()
        )
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        controller.receiveLeaseDenied(reason: .quotaExhausted, detail: nil)
        XCTAssertEqual(controller.state, .failed("Today's voice-input quota has been used."))

        controller.clearFailure()
        await controller.begin(sessionID: "session-1", context: context()) { _ in }
        controller.receiveLeaseDenied(reason: .notEntitled, detail: nil)
        XCTAssertEqual(controller.state, .failed("Voice input isn't enabled for this account."))
    }

    func testSessionContextExtractsTermsWithoutCopyingFullMessage() {
        let session = SessionInfo(
            id: "session-1",
            deviceId: "device-1",
            deviceName: "Mac",
            agent: "pi",
            model: "gpt-5.6-sol",
            title: "Northstar Studio",
            autoTitle: nil,
            state: .idle,
            mode: .auto,
            lastSeq: 1,
            readSeq: 1,
            messageCount: 1,
            createdAt: Date(),
            pinned: false
        )
        let secretSentence = "Please update KrakiVoiceInputController in packages/arm/ios and never copy this whole sentence."
        let message = ChatMessage(
            type: "user_message",
            seq: 1,
            sessionId: session.id,
            deviceId: session.deviceId,
            timestamp: nil,
            payload: ["content": AnyCodable(secretSentence)]
        )
        let context = VoiceSessionContextBuilder.build(session: session, recentMessages: [message], userVocabulary: [])
        XCTAssertTrue(context.vocabulary.contains("KrakiVoiceInputController"))
        XCTAssertFalse(context.vocabulary.contains { $0.contains("\u{514B}\u{62C9}\u{5947}") }, "no built-in product vocabulary")
        XCTAssertFalse(context.vocabulary.contains(secretSentence))
        guard case .object(let sessionFields)? = context.fields["session"],
              case .array(let terms)? = sessionFields["terms"] else {
            return XCTFail("Missing bounded session terms")
        }
        XCTAssertLessThanOrEqual(terms.count, 32)
    }

    func testDraftMergerPreservesExistingDraft() {
        XCTAssertEqual(VoiceDraftMerger.merge(existing: "", final: "hello"), "hello")
        XCTAssertEqual(VoiceDraftMerger.merge(existing: "prefix", final: "hello"), "prefix hello")
        XCTAssertEqual(VoiceDraftMerger.merge(existing: "prefix ", final: "hello"), "prefix hello")
    }

    func testUserVocabularyComesFirstAndIsTheOnlyFixedVocabulary() {
        let session = SessionInfo(id: "s", deviceId: "d", deviceName: "D", agent: "pi", title: "Tentacle work",
                                  state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                                  createdAt: Date(), pinned: false)
        let context = VoiceSessionContextBuilder.build(
            session: session, recentMessages: [],
            userVocabulary: VoiceVocabulary.parse("# mine\nKraki = \u{514B}\u{62C9}\u{5947}, \u{514B}\u{62C9}\u{57FA}\n\n  Tentacle  \nkraki = dup\n")
        )
        XCTAssertEqual(Array(context.vocabulary.prefix(2)), ["Kraki = \u{514B}\u{62C9}\u{5947}, \u{514B}\u{62C9}\u{57FA}", "Tentacle"])
        XCTAssertFalse(context.vocabulary.contains("Tentacle work") && context.vocabulary.filter { $0 == "Tentacle" }.count > 1)
        XCTAssertEqual(VoiceVocabulary.parse("kraki = a\nKRAKI = a\n").count, 1, "case-insensitive duplicates")
        let many = (0..<150).map { "term\($0)" }.joined(separator: "\n")
        XCTAssertEqual(VoiceVocabulary.parse(many).count, VoiceVocabulary.maxEntries)
    }

    func testVocabularyStoreSavesEntriesAsCorrectorLines() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kraki-vocab-\(UUID().uuidString)"))
        let store = VoiceVocabularyStore(defaults: defaults)
        XCTAssertTrue(store.terms.isEmpty)
        store.upsert(VoiceTerm(term: "PostgreSQL", heardAs: "post gress\u{FF0C}\u{7834}\u{56DB}\u{683C}\u{3001} "))
        store.upsert(VoiceTerm(term: "Kubernetes"))
        store.upsert(VoiceTerm(term: "  "))                       // a row still being typed
        store.upsert(VoiceTerm(term: "postgresql", heardAs: "x")) // duplicate: first wins
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["PostgreSQL = post gress, \u{7834}\u{56DB}\u{683C}", "Kubernetes"])
        XCTAssertEqual(store.savedCount, 3)
        XCTAssertTrue(store.isDuplicate("POSTGRESQL", excluding: nil))

        var edited = store.terms[1]; edited.heardAs = "\u{9177}\u{4F2F}\u{5185}\u{63D0}\u{65AF}"
        store.upsert(edited)
        store.remove(store.terms[0].id)
        let reloaded = VoiceVocabularyStore(defaults: defaults)
        XCTAssertEqual(reloaded.terms.map(\.line), ["Kubernetes = \u{9177}\u{4F2F}\u{5185}\u{63D0}\u{65AF}", "postgresql = x"])

        XCTAssertEqual(VoiceVocabulary.parse("# note\nFoo \u{FF1D} \u{798F}\u{6B27}\n= orphan\n"), ["Foo = \u{798F}\u{6B27}"], "old text format still loads")
    }

    func testWithoutConversationContextOnlyCustomWordsLeaveTheDevice() {
        let session = SessionInfo(id: "s", deviceId: "d", deviceName: "D", agent: "pi", title: "Secret project",
                                  state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0,
                                  createdAt: Date(), pinned: false)
        let message = ChatMessage(type: "user_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: nil,
                                  payload: ["content": AnyCodable("ship InternalCodename-v2 today")])
        let off = VoiceSessionContextBuilder.build(session: session, recentMessages: [message],
                                                   userVocabulary: ["Kraki = \u{514B}\u{62C9}\u{5947}"], shareConversation: false)
        XCTAssertEqual(off.vocabulary, ["Kraki = \u{514B}\u{62C9}\u{5947}"])
        XCTAssertNil(off.fields["session"])
        XCTAssertNil(off.fields["sessionId"])
        let on = VoiceSessionContextBuilder.build(session: session, recentMessages: [message],
                                                  userVocabulary: [], shareConversation: true)
        XCTAssertTrue(on.vocabulary.contains("InternalCodename-v2"))
        XCTAssertNotNil(on.fields["session"])
    }

    func testCorrectionSettingReachesTheConnectionAndReopensItWhenChanged() async {
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: VoiceInputSettings.correctionKey) }
        defaults.set(false, forKey: VoiceInputSettings.correctionKey)
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(host: host, sessionFactory: factory, audioPolicy: FakeVoiceAudioPolicy())
        controller.prepare()
        controller.receiveLease(lease())
        XCTAssertEqual(factory.configurations.last?.correctionEnabled, false)

        defaults.set(true, forKey: VoiceInputSettings.correctionKey)
        controller.applySettings() // idle: reopened at once with the new setting
        XCTAssertEqual(factory.sessions.count, 2)
        XCTAssertEqual(factory.sessions[0].closeCount, 1)
        XCTAssertEqual(factory.configurations.last?.correctionEnabled, true)
        controller.applySettings()
        XCTAssertEqual(factory.sessions.count, 2, "no reconnect when nothing changed")
    }

    func testCustomWordEdgeCasesNeverCorruptStorage() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kraki-vocab-\(UUID().uuidString)"))
        let store = VoiceVocabularyStore(defaults: defaults)
        store.upsert(VoiceTerm(term: "Foo", heardAs: "\u{798F}\u{6B27}\n\u{5BCC}\u{6B27}"))     // newline in the multi-line field
        store.upsert(VoiceTerm(term: "a=b", heardAs: "x"))              // '=' in the word
        store.upsert(VoiceTerm(term: "#tag"))                           // would read back as a comment
        store.upsert(VoiceTerm(term: String(repeating: "x", count: 130)))
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["Foo = \u{798F}\u{6B27}, \u{5BCC}\u{6B27}"])
        XCTAssertNotNil(store.terms[1].problem)
        XCTAssertNotNil(store.terms[2].problem)
        XCTAssertNotNil(store.terms[3].problem)
        XCTAssertEqual(VoiceVocabularyStore(defaults: defaults).terms.map(\.line), ["Foo = \u{798F}\u{6B27}, \u{5BCC}\u{6B27}"])
    }
}
