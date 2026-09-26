#if os(iOS)
import XCTest
import VoiceInputCore
@testable import Kraki

private final class VoiceAudio: VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission = .granted
    var hasInputDevice = true
    var activations = 0
    var deferPermission = false
    var permissionContinuation: CheckedContinuation<Bool, Never>?
    var activateDelay: TimeInterval = 0
    private let lock = NSLock()
    private var _activatedOnMain: [Bool] = []
    private var _events: [String] = []
    var activatedOnMain: [Bool] { lock.withLock { _activatedOnMain } }
    var events: [String] { lock.withLock { _events } }
    func requestPermission() async -> Bool {
        if deferPermission { return await withCheckedContinuation { permissionContinuation = $0 } }
        return permission == .granted
    }
    func activate() -> Bool {
        lock.withLock { _activatedOnMain.append(Thread.isMainThread); _events.append("activate-begin") }
        // Real AVAudioSession activation can take tens to hundreds of ms.
        if activateDelay > 0 { Thread.sleep(forTimeInterval: activateDelay) }
        lock.withLock { activations += 1; _events.append("activate-end") }
        return true
    }
    func deactivate() { lock.withLock { _events.append("deactivate") } }
}
private final class VoiceSession: VoiceInputSessionProtocol {
    let correctionEnabled = true
    let pcmDumpPath: String? = nil
    let event: (VoiceInputEvent) -> Void
    var starts = 0
    var stops = 0
    init(_ event: @escaping (VoiceInputEvent) -> Void) { self.event = event }
    func startCapture(context: [String: VoiceInputJSONValue], vocabulary: [String]) { starts += 1 }
    func stopCapture() { stops += 1 }
    func close() {}
}
private final class VoiceFactory: VoiceInputSessionFactory {
    var sessions: [VoiceSession] = []
    func makeSession(configuration: VoiceInputConfiguration, onEvent: @escaping (VoiceInputEvent) -> Void, onMetric: @escaping (VoiceInputMetric) -> Void) -> VoiceInputSessionProtocol {
        let session = VoiceSession(onEvent); sessions.append(session); return session
    }
}
/// Records the outbox calls a voice send makes.
private final class VoiceHost: IOSVoiceComposerHost, KrakiVoiceInputHost {
    struct Staged { var sessionID: String; var text: String; var original: String; var state: String; var delivery: CommandSender.InputDelivery; var attachments: Int; var uncorrected = "" }
    let sessionStore = SessionStore(persistenceEnabled: false)
    let factory = VoiceFactory()
    let audio = VoiceAudio()
    lazy var voiceInputController = KrakiVoiceInputController(host: self, sessionFactory: factory, audioPolicy: audio)
    var voiceCapability: VoiceCapability? = .init(brokerUrl: "wss://voice.invalid", resource: "voice/doubao")
    var voiceUserID: String? = "test-user"
    var voiceDeviceID: String? = "test-device"
    var voiceTransportReady = true
    var staged: [String: Staged] = [:]
    var order: [String] = []
    var transmitted: [(String, String)] = []
    var acceptsTransport = true
    func requestVoiceLease(resource: String) -> Bool { true }
    func stageVoiceInput(sessionID: String, text: String, attachments: [ImageAttachment]?, delivery: CommandSender.InputDelivery) -> String? {
        let id = UUID().uuidString
        staged[id] = Staged(sessionID: sessionID, text: text, original: text, state: "correcting", delivery: delivery, attachments: attachments?.count ?? 0)
        order.append(id)
        return id
    }
    func updateVoiceInput(sessionID: String, clientID: String, text: String, original: String, uncorrected: NSRange?) {
        guard staged[clientID]?.state == "correcting" else { return }
        staged[clientID]?.text = text; staged[clientID]?.original = original
        staged[clientID]?.uncorrected = uncorrected.map { (text as NSString).substring(with: $0) } ?? ""
    }
    func dispatchVoiceInput(sessionID: String, clientID: String, text: String) -> Bool {
        guard staged[clientID]?.state == "correcting" else { return false }
        staged[clientID]?.text = text
        guard acceptsTransport else { staged[clientID]?.state = "failed"; return false }
        staged[clientID]?.state = "sending"
        transmitted.append((sessionID, text))
        return true
    }
    func failVoiceInput(sessionID: String, clientID: String, text: String) {
        guard staged[clientID]?.state == "correcting" else { return }
        staged[clientID]?.text = text; staged[clientID]?.original = text; staged[clientID]?.state = "failed"
    }
    func discardVoiceInput(sessionID: String, clientID: String) {
        guard staged[clientID]?.state == "correcting" else { return }
        staged[clientID] = nil
    }
    var last: Staged? { order.last.flatMap { staged[$0] } }
    init() {
        for id in ["a", "b"] {
            sessionStore.sessions[id] = SessionInfo(id: id, deviceId: "device", deviceName: "Test", agent: "pi", state: .idle, mode: .discuss, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        }
        sessionStore.activeSessionId = "a"
    }
}

@MainActor final class IOSVoiceComposerTests: XCTestCase {
    private func settle(_ ms: Int = 20) async { try? await Task.sleep(for: .milliseconds(ms)) }
    private func start(_ host: VoiceHost, _ voice: IOSVoiceComposer, session id: String = "a", range: NSRange? = nil) async -> VoiceSession {
        voice.begin(sessionID: id, selection: range, context: .init(fields: [:], vocabulary: []))
        await settle()
        let now = Int(Date().timeIntervalSince1970)
        host.voiceInputController.receiveLease(.init(payload: .init(ver: 1, iss: "test", sub: "test-user", did: "test-device", iat: now, exp: now + 600, quotaSeconds: 600, resource: "voice/doubao", jti: UUID().uuidString), signature: "test", alg: "RSA-SHA256"))
        await settle()
        guard let session = host.factory.sessions.last else {
            XCTFail("No synthetic session; controller=\(host.voiceInputController.state)")
            return VoiceSession { _ in }
        }
        session.event(.connectionAuthorized)
        await settle()
        XCTAssertTrue(host.voiceInputController.isRecording)
        XCTAssertTrue(voice.isRecording(in: id))
        return session
    }
    private func partial(_ text: String, _ session: VoiceSession) async { session.event(.partial(text)); await settle() }
    private func final(_ text: String, raw: String? = nil, _ session: VoiceSession) async { session.event(.final(text, rawText: raw)); await settle() }
    private func make() -> (VoiceHost, IOSVoiceComposer) { let h = VoiceHost(); return (h, IOSVoiceComposer(host: h)) }

    // MARK: Recording

    func testRecordingNeverTouchesDraftAndPreviewsAtCaret() async {
        let (host, voice) = make()
        host.sessionStore.setDraft("a", "Prefix SUFFIX")
        let session = await start(host, voice, range: NSRange(location: 6, length: 0))
        await partial("spoken", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "Prefix SUFFIX", "draft untouched while recording")
        let preview = voice.preview
        XCTAssertEqual(preview.prefix, "Prefix")
        XCTAssertEqual(preview.suffix, " SUFFIX")
        XCTAssertEqual(preview.prefix + preview.spoken + preview.suffix, "Prefix spoken SUFFIX")
    }

    func testCancelKeepsDraftAndIgnoresLateFinal() async {
        let (host, voice) = make()
        host.sessionStore.setDraft("a", "keep")
        let session = await start(host, voice)
        await partial("noise", session)
        voice.cancel()
        XCTAssertNil(voice.operation)
        await final("late", raw: "noise", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "keep")
        XCTAssertTrue(host.staged.isEmpty)
        XCTAssertFalse(host.voiceInputController.isBusy)
    }

    // MARK: Send (↑): bubble corrected in place, transmitted once corrected

    func testSendStagesAtOnceStreamsCorrectionAndTransmitsCorrectedOnce() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("把登录页的报错改成中文", session)
        XCTAssertTrue(voice.send(attachments: nil, delivery: .prompt))
        XCTAssertFalse(voice.isRecording, "composer collapses at once")
        XCTAssertNil(host.sessionStore.drafts["a"], "composer is free for the next message")
        XCTAssertEqual(host.last?.state, "correcting")
        XCTAssertEqual(host.last?.text, "把登录页的报错改成中文")
        XCTAssertTrue(host.transmitted.isEmpty, "nothing leaves the device before correction")
        session.event(.correctionDelta("把登录页的报错")); await settle(40)
        XCTAssertEqual(host.last?.text, "把登录页的报错改成中文",
                       "a partial correction is applied over the transcript; no words disappear")
        XCTAssertEqual(host.last?.original, "把登录页的报错改成中文")
        XCTAssertTrue(voice.isFinishing(in: "a"))
        await final("把登录页的报错改成中文。", raw: "把登录页的报错改成中文", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["把登录页的报错改成中文。"])
        XCTAssertEqual(host.last?.state, "sending")
        XCTAssertNil(voice.operation)
        XCTAssertEqual(voice.dispatchedSessionID, "a")
        await final("duplicate", raw: "x", session)
        XCTAssertEqual(host.transmitted.count, 1)
    }

    func testStreamingCorrectionReplacesWordsInPlaceKeepingTheRest() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("请帮我把登入页的报错改成中文然后跑一下测试", session)
        voice.send(attachments: nil, delivery: .prompt)
        XCTAssertEqual(host.last?.uncorrected, "请帮我把登入页的报错改成中文然后跑一下测试", "all light before correction")
        session.event(.correctionDelta("请帮我把登录页")); await settle(40)
        XCTAssertEqual(host.last?.text, "请帮我把登录页的报错改成中文然后跑一下测试")
        XCTAssertEqual(host.last?.uncorrected, "的报错改成中文然后跑一下测试", "corrected part turns solid")
        session.event(.correctionDelta("请帮我把登录页的报错改成中文，然后")); await settle(40)
        XCTAssertEqual(host.last?.text, "请帮我把登录页的报错改成中文，然后跑一下测试")
        // A shorter/odd delta never moves the covered point backwards.
        session.event(.correctionDelta("请帮我")); await settle(40)
        XCTAssertTrue(host.last?.text.hasSuffix("跑一下测试") == true)
        XCTAssertTrue(host.transmitted.isEmpty)
    }

    func testOverlayJoinsLatinWords() {
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "Please fix", onto: "please fix the login page", coveredPrefix: 10),
                       "Please fix the login page")
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "Done.", onto: "done", coveredPrefix: 4), "Done.")
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "", onto: "raw", coveredPrefix: 0), "raw")
    }

    func testSendWithDraftSelectionCorrectsOnlyTheUtterance() async {
        let (host, voice) = make()
        host.sessionStore.setDraft("a", "Hello there")
        let session = await start(host, voice, range: NSRange(location: 5, length: 0))
        await partial("big", session)
        voice.send(attachments: nil, delivery: .steer)
        XCTAssertEqual(host.last?.text, "Hello big there")
        XCTAssertEqual(host.last?.delivery, .steer)
        await final("large", raw: "big", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["Hello large there"])
    }

    func testUnchangedCorrectionWithUntrimmedStreamStillTransmits() async {
        // Broker streams the corrector's raw cumulative output but sends
        // `output.trim()` as the final; an unchanged correction has no rawText.
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("好的，继续", session); voice.send(attachments: nil, delivery: .prompt)
        session.event(.correctionDelta("好的，继续\n"))
        session.event(.final("好的，继续", rawText: nil)); await settle()
        XCTAssertEqual(host.transmitted.map(\.1), ["好的，继续"])
    }

    func testSilentRawFallbackIsNeverTransmittedAutomatically() async {
        for streamed in ["", "incomplete"] {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw source", session); voice.send(attachments: nil, delivery: .prompt)
            if !streamed.isEmpty { session.event(.correctionDelta(streamed)) }
            await final("raw source", session)
            XCTAssertTrue(host.transmitted.isEmpty)
            XCTAssertEqual(host.last?.state, "failed")
            XCTAssertEqual(host.last?.text, "raw source", "failed bubble offers the original")
        }
    }

    func testTransportFailureAfterCorrectionLeavesRetryableBubble() async {
        let (host, voice) = make()
        host.acceptsTransport = false
        let session = await start(host, voice)
        await partial("raw", session); voice.send(attachments: nil, delivery: .prompt)
        await final("fixed", raw: "raw", session)
        XCTAssertEqual(host.last?.state, "failed")
        XCTAssertEqual(host.last?.text, "fixed")
        XCTAssertNil(voice.dispatchedSessionID)
    }

    func testConnectionFailureWhileCorrectingKeepsOriginalNotPartial() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("full raw", session); voice.send(attachments: nil, delivery: .prompt)
        session.event(.correctionDelta("partial correction")); await settle(40)
        session.event(.failed("synthetic failure")); await settle()
        XCTAssertEqual(host.last?.state, "failed")
        XCTAssertEqual(host.last?.text, "full raw")
        XCTAssertTrue(host.transmitted.isEmpty)
        XCTAssertNil(voice.operation)
    }

    func testUserWithdrawOrSendOriginalWinsOverLateCorrection() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("raw", session); voice.send(attachments: nil, delivery: .prompt)
        // User picked "Send Original" on the bubble.
        let id = host.order[0]
        XCTAssertTrue(host.dispatchVoiceInput(sessionID: "a", clientID: id, text: "raw"))
        await final("fixed", raw: "raw", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["raw"], "a late correction cannot send twice")
    }

    func testNoSpeechSendsWhatWasTypedOrAttachedOrNothing() async {
        for (draft, image, expected) in [("typed", false, ["typed"]), ("", true, ["[image]"]), ("", false, [String]())] {
            let (host, voice) = make()
            if !draft.isEmpty { host.sessionStore.setDraft("a", draft) }
            let session = await start(host, voice)
            voice.send(attachments: image ? [ImageAttachment(type: "image", mimeType: "image/png", data: "AA==")] : nil, delivery: .prompt)
            await final("", session)
            XCTAssertEqual(host.transmitted.map(\.1), expected)
            if expected.isEmpty { XCTAssertTrue(host.staged.isEmpty, "an empty bubble is removed") }
        }
    }

    func testSendBeforeMicStartsNeverOpensMic() async {
        let (host, voice) = make()
        voice.begin(sessionID: "a", selection: nil, context: .init(fields: [:], vocabulary: []))
        voice.send(attachments: nil, delivery: .prompt)
        await settle()
        XCTAssertTrue(host.factory.sessions.isEmpty)
        XCTAssertEqual(host.audio.activations, 0)
        XCTAssertTrue(host.staged.isEmpty && host.transmitted.isEmpty)
    }

    func testSendWhilePermissionPendingCannotOpenMicAfterGrant() async {
        let (host, voice) = make()
        host.audio.permission = .undetermined; host.audio.deferPermission = true
        voice.begin(sessionID: "a", selection: nil, context: .init(fields: [:], vocabulary: []))
        await settle()
        XCTAssertEqual(host.voiceInputController.state, .requestingPermission)
        voice.finishToDraft()
        host.audio.permission = .granted
        host.audio.permissionContinuation?.resume(returning: true)
        host.audio.permissionContinuation = nil
        await settle()
        XCTAssertEqual(host.audio.activations, 0)
        XCTAssertNil(voice.operation)
        XCTAssertTrue(host.factory.sessions.isEmpty)
    }

    func testNewRecordingWaitsForStagedSendToFinish() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("first", session); voice.send(attachments: nil, delivery: .prompt)
        voice.begin(sessionID: "a", selection: nil, context: .init(fields: [:], vocabulary: []))
        XCTAssertFalse(voice.isRecording, "mic is busy while the sent message is corrected")
        await final("First.", raw: "first", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["First."])
    }

    // MARK: Edit (✓): into the real field

    func testEditInsertsRawThenCorrectionReplacesUtteranceWithoutSending() async {
        let (host, voice) = make()
        host.sessionStore.setDraft("a", "前🙂旧后")
        let session = await start(host, voice, range: NSRange(location: 3, length: 1))
        await partial("新", session)
        voice.finishToDraft()
        XCTAssertNotNil(voice.editorRequest)
        XCTAssertEqual(host.sessionStore.drafts["a"], "前🙂新后")
        await final("新词", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "前🙂新词后")
        XCTAssertEqual(voice.selectionRequest, NSRange(location: 5, length: 0))
        XCTAssertTrue(host.staged.isEmpty && host.transmitted.isEmpty)
    }

    func testTypingOrABAFencesLateCorrection() async {
        for mode in 0..<3 {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw", session); voice.finishToDraft()
            switch mode {
            case 0: voice.takeOver(sessionID: "a")
            case 1: host.sessionStore.setDraft("a", "human")
            default: host.sessionStore.setDraft("a", "edited"); host.sessionStore.setDraft("a", "raw")
            }
            await final("late", session)
            XCTAssertEqual(host.sessionStore.drafts["a"], mode == 1 ? "human" : "raw")
        }
    }

    func testNewRecordingSupersedesDraftCorrectionKeepingItsText() async {
        let (host, voice) = make()
        let first = await start(host, voice)
        await partial("first", first); voice.finishToDraft()
        let second = await start(host, voice)
        await partial("second", second)
        await final("LATE", first)
        voice.finishToDraft()
        await final("SECOND", second)
        XCTAssertEqual(host.sessionStore.drafts["a"], "first SECOND")
    }

    // MARK: Lifecycle

    func testDepartWhileRecordingKeepsDraftAtOriginWithoutFocusOrSend() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("raw", session)
        host.sessionStore.activeSessionId = "b"
        host.sessionStore.setDraft("b", "other")
        voice.depart(sessionID: "a")
        XCTAssertNil(voice.editorRequest, "no keyboard in a conversation the user left")
        await final("final", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "final")
        XCTAssertEqual(host.sessionStore.drafts["b"], "other")
        XCTAssertTrue(host.staged.isEmpty)
    }

    func testDepartDoesNotInterruptAStagedSend() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("raw", session); voice.send(attachments: nil, delivery: .prompt)
        voice.depart(sessionID: "a")
        await final("fixed", raw: "raw", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["fixed"], "an explicit send still completes")
    }

    func testBackgroundRetirementKeepsEverythingHeard() async {
        do {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw", session); voice.retireKeepingDraft()
            XCTAssertEqual(host.sessionStore.drafts["a"], "raw")
            await final("late", session)
            XCTAssertEqual(host.sessionStore.drafts["a"], "raw")
        }
        do {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw", session); voice.send(attachments: nil, delivery: .prompt)
            voice.retireKeepingDraft()
            XCTAssertEqual(host.last?.state, "failed")
            XCTAssertEqual(host.last?.text, "raw")
            await final("late", raw: "raw", session)
            XCTAssertTrue(host.transmitted.isEmpty)
        }
    }

    func testLogoutAndDeletedSessionCannotResurrectDraft() async {
        for logout in [false, true] {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw", session); voice.finishToDraft()
            if logout { voice.discard(); host.sessionStore.reset() }
            else { host.sessionStore.sessions.removeValue(forKey: "a"); host.sessionStore.drafts.removeValue(forKey: "a") }
            await final("late", session)
            XCTAssertNil(host.sessionStore.drafts["a"])
        }
    }

    // MARK: Speech controller safety (shared with macOS)

    func testBeginActivatesAudioOnMainActor() async {
        let (host, voice) = make()
        _ = await start(host, voice)
        XCTAssertEqual(host.audio.activatedOnMain, [true])
    }

    func testQuickCancelDuringSlowAudioActivationNeverLeavesAudioActive() async {
        let (host, voice) = make()
        host.audio.activateDelay = 0.3
        voice.begin(sessionID: "a", selection: nil, context: .init(fields: [:], vocabulary: []))
        try? await Task.sleep(for: .milliseconds(60))   // activation in flight
        voice.cancel()
        try? await Task.sleep(for: .milliseconds(500))
        XCTAssertTrue(host.factory.sessions.allSatisfy { $0.starts == 0 })
        XCTAssertEqual(host.audio.events.last, "deactivate", "\(host.audio.events)")
        XCTAssertFalse(host.voiceInputController.isBusy)
    }

    // MARK: Text helpers

    func testSelectionDeliveredBeforeTextCannotTrapOnForeignIndex() {
        let incoming = "Typed normally"
        let end = incoming.endIndex
        XCTAssertNil(IOSVoiceComposer.selectionRange(end..<end, in: ""))
        XCTAssertNil(IOSVoiceComposer.selectionRange(incoming.startIndex..<end, in: "T"))
        let emoji = "a🙂b"
        let lower = emoji.index(after: emoji.startIndex), upper = emoji.index(before: emoji.endIndex)
        XCTAssertEqual(IOSVoiceComposer.selectionRange(lower..<upper, in: emoji), NSRange(location: 1, length: 2))
    }

    func testGraphemeRangeValidationDoesNotSplitEmojiOrCombiningMarks() {
        for text in ["a🙂b", "a👨‍👩‍👧‍👦b", "ae\u{301}b"] {
            let invalid = NSRange(location: 2, length: 0)
            XCTAssertEqual(IOSVoiceComposer.safeRange(invalid, in: text).location, text.utf16.count)
            XCTAssertEqual(IOSVoiceComposer.insert("新", into: text, range: invalid).0, text + "新")
        }
    }

    func testContinuationSeparatesLatinWordsButNotCJKOrPunctuation() {
        func insert(_ text: String, _ base: String, _ location: Int? = nil) -> (String, Int) {
            let at = location ?? base.utf16.count
            let result = IOSVoiceComposer.insert(text, into: base, range: NSRange(location: at, length: 0))
            return (result.0, result.1.location)
        }
        XCTAssertEqual(insert("world", "Hello").0, "Hello world")
        XCTAssertEqual(insert("world", "Hello ").0, "Hello world")
        XCTAssertEqual(insert("world", "Hello,").0, "Hello, world")
        XCTAssertEqual(insert("big", "Hello there", 5).0, "Hello big there")
        XCTAssertEqual(insert("big", "Hello there", 5).1, 9)
        XCTAssertEqual(insert("big", "Hellothere", 5).0, "Hello big there")
        XCTAssertEqual(insert("新话", "前文").0, "前文新话")
        XCTAssertEqual(insert("请帮我", "Prefix SUFFIX").0, "Prefix SUFFIX请帮我")
        XCTAssertEqual(insert("Kraki", "接入").0, "接入Kraki")
        XCTAssertEqual(insert("done", "(").0, "(done")
        XCTAssertEqual(insert("ok", "say .", 4).0, "say ok.")
        XCTAssertEqual(insert("x", "").0, "x")
        XCTAssertEqual(insert("", "keep").0, "keep")
    }
}
#endif
