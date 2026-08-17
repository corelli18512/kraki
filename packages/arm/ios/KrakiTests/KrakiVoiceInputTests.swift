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
    private func lease(
        expiryOffset: Int = 600,
        jti: String = "lease-1",
        issuedAt: Int? = nil,
        expiration: Int? = nil
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
                quotaSeconds: 600,
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

    func testLeaseFromPreviousUTCDateIsRejectedEvenBeforeExpiry() {
        let now = Int(Date().timeIntervalSince1970)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = utc.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(now)))
        let previousDay = utc.date(byAdding: .second, value: -1, to: today)!
        let previousDayLease = lease(
            issuedAt: Int(previousDay.timeIntervalSince1970),
            expiration: now + 600
        )

        XCTAssertFalse(
            KrakiVoiceInputController.isLeaseUsable(previousDayLease, nowUnixSec: now)
        )
    }

    func testForegroundWarmConnectionIsReusedAcrossRecordings() async {
        let host = FakeVoiceHost()
        let factory = FakeVoiceFactory()
        let controller = KrakiVoiceInputController(
            host: host,
            sessionFactory: factory,
            audioPolicy: FakeVoiceAudioPolicy()
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
        XCTAssertEqual(factory.sessions[0].starts.count, 1)
        factory.sessions[0].emit(.final("first", rawText: nil))
        await Task.yield()
        XCTAssertEqual(finals, ["first"])
        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(factory.sessions[0].closeCount, 0)

        await controller.begin(sessionID: "session-2", context: context()) { finals.append($0) }
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
            mode: .execute,
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
        let context = VoiceSessionContextBuilder.build(session: session, recentMessages: [message])
        XCTAssertTrue(context.vocabulary.contains("KrakiVoiceInputController"))
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
}
