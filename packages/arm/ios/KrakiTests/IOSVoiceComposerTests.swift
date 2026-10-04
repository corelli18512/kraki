import XCTest
import VoiceInputCore
import SwiftUI
#if os(iOS)
import UIKit
@testable import Kraki
#else
import AppKit
@testable import Kraki_Dev
#endif

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
    var lastAnswerTo: String?
    func stageVoiceInput(sessionID: String, text: String, attachments: [ImageAttachment]?, delivery: CommandSender.InputDelivery, answerTo: String?) -> String? {
        lastAnswerTo = answerTo
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
            sessionStore.sessions[id] = SessionInfo(id: id, deviceId: "device", deviceName: "Test", agent: "pi", state: .idle, mode: .auto, lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
        }
        sessionStore.activeSessionId = "a"
    }
}

@MainActor final class IOSVoiceComposerTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

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
        await partial("\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}", session)
        XCTAssertTrue(voice.send(attachments: nil, delivery: .prompt))
        XCTAssertFalse(voice.isRecording, "composer collapses at once")
        XCTAssertNil(host.sessionStore.drafts["a"], "composer is free for the next message")
        XCTAssertEqual(host.last?.state, "correcting")
        XCTAssertEqual(host.last?.text, "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}")
        XCTAssertTrue(host.transmitted.isEmpty, "nothing leaves the device before correction")
        session.event(.correctionDelta("\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}")); await settle(40)
        XCTAssertEqual(host.last?.text, "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}",
                       "a partial correction is applied over the transcript; no words disappear")
        XCTAssertEqual(host.last?.original, "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}")
        XCTAssertTrue(voice.isFinishing(in: "a"))
        await final("\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{3002}", raw: "\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{3002}"])
        XCTAssertEqual(host.last?.state, "sending")
        XCTAssertNil(voice.operation)
        XCTAssertEqual(voice.dispatchedSessionID, "a")
        await final("duplicate", raw: "x", session)
        XCTAssertEqual(host.transmitted.count, 1)
    }

    func testStreamingCorrectionReplacesWordsInPlaceKeepingTheRest() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5165}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{7136}\u{540E}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}", session)
        voice.send(attachments: nil, delivery: .prompt)
        XCTAssertEqual(host.last?.uncorrected, "\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5165}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{7136}\u{540E}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}", "all light before correction")
        session.event(.correctionDelta("\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5F55}\u{9875}")); await settle(40)
        XCTAssertEqual(host.last?.text, "\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{7136}\u{540E}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}")
        XCTAssertEqual(host.last?.uncorrected, "\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{7136}\u{540E}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}", "corrected part turns solid")
        session.event(.correctionDelta("\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{FF0C}\u{7136}\u{540E}")); await settle(40)
        XCTAssertEqual(host.last?.text, "\u{8BF7}\u{5E2E}\u{6211}\u{628A}\u{767B}\u{5F55}\u{9875}\u{7684}\u{62A5}\u{9519}\u{6539}\u{6210}\u{4E2D}\u{6587}\u{FF0C}\u{7136}\u{540E}\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}")
        // A shorter/odd delta never moves the covered point backwards.
        session.event(.correctionDelta("\u{8BF7}\u{5E2E}\u{6211}")); await settle(40)
        XCTAssertTrue(host.last?.text.hasSuffix("\u{8DD1}\u{4E00}\u{4E0B}\u{6D4B}\u{8BD5}") == true)
        XCTAssertTrue(host.transmitted.isEmpty)
    }

    func testOverlayJoinsLatinWords() {
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "Please fix", onto: "please fix the login page", coveredPrefix: 10),
                       "Please fix the login page")
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "Done.", onto: "done", coveredPrefix: 4), "Done.")
        XCTAssertEqual(IOSVoiceComposer.overlay(corrected: "", onto: "raw", coveredPrefix: 0), "raw")
    }

    func testVoiceAnswerIsStagedWithAnswerToAndSentCorrected() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{65B9}\u{6848}", session)
        XCTAssertTrue(voice.send(attachments: nil, delivery: .prompt, answerTo: "q-1"))
        XCTAssertEqual(host.lastAnswerTo, "q-1")
        XCTAssertEqual(host.last?.state, "correcting", "answers correct in the bubble like any message")
        XCTAssertTrue(host.transmitted.isEmpty)
        await final("\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{65B9}\u{6848}\u{3002}", raw: "\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{65B9}\u{6848}", session)
        XCTAssertEqual(host.transmitted.map(\.1), ["\u{9009}\u{7B2C}\u{4E8C}\u{4E2A}\u{65B9}\u{6848}\u{3002}"])
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
        await partial("\u{597D}\u{7684}\u{FF0C}\u{7EE7}\u{7EED}", session); voice.send(attachments: nil, delivery: .prompt)
        session.event(.correctionDelta("\u{597D}\u{7684}\u{FF0C}\u{7EE7}\u{7EED}\n"))
        session.event(.final("\u{597D}\u{7684}\u{FF0C}\u{7EE7}\u{7EED}", rawText: nil)); await settle()
        XCTAssertEqual(host.transmitted.map(\.1), ["\u{597D}\u{7684}\u{FF0C}\u{7EE7}\u{7EED}"])
    }

    func testCorrectionFailureStillSendsTheRawTranscript() async {
        // The gateway's fallback when the corrector fails (e.g. the model's
        // usage limit): the complete raw transcript as final, no rawText —
        // possibly after a few correction deltas. The user's words go out.
        for streamed in ["", "incomplete"] {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("raw source", session); voice.send(attachments: nil, delivery: .prompt)
            if !streamed.isEmpty { session.event(.correctionDelta(streamed)) }
            await final("raw source", session)
            XCTAssertEqual(host.transmitted.map(\.1), ["raw source"], "sent uncorrected, never blocked")
            XCTAssertEqual(host.last?.state, "sending")
            XCTAssertEqual(voice.dispatchedSessionID, "a")
            XCTAssertEqual(host.voiceInputController.metrics.summaries.last?.correctionConfirmed, false,
                           "reported as not corrected")
        }
    }

    func testRecordingFailureWithoutFinalStillOffersTheOriginal() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("heard so far", session); voice.send(attachments: nil, delivery: .prompt)
        session.event(.failed("socket disconnected")); await settle()
        XCTAssertTrue(host.transmitted.isEmpty, "no final transcript: the user decides")
        XCTAssertEqual(host.last?.state, "failed")
        XCTAssertEqual(host.last?.text, "heard so far")
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
        host.sessionStore.setDraft("a", "\u{524D}🙂\u{65E7}\u{540E}")
        let session = await start(host, voice, range: NSRange(location: 3, length: 1))
        await partial("\u{65B0}", session)
        voice.finishToDraft()
        XCTAssertNotNil(voice.editorRequest)
        XCTAssertEqual(host.sessionStore.drafts["a"], "\u{524D}🙂\u{65B0}\u{540E}")
        await final("\u{65B0}\u{8BCD}", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "\u{524D}🙂\u{65B0}\u{8BCD}\u{540E}")
        XCTAssertEqual(voice.selectionRequest, NSRange(location: 5, length: 0))
        XCTAssertTrue(host.staged.isEmpty && host.transmitted.isEmpty)
    }

    func testEditStreamsSolidCorrectionOverOnlyTheGreyUtterance() async throws {
        let (host, voice) = make()
        host.sessionStore.setDraft("a", "前🙂旧后")
        let session = await start(host, voice, range: NSRange(location: 3, length: 1))
        await partial("请修改登入页面", session)
        XCTAssertNil(voice.uncorrectedRange(in: "a"), "recording is solid")
        voice.finishToDraft()
        XCTAssertEqual(voice.uncorrectedRange(in: "a"), NSRange(location: 3, length: 7))
        XCTAssertNil(voice.uncorrectedRange(in: "b"))
        session.event(.correctionDelta("请修改登录")); await settle(40)
        XCTAssertEqual(host.sessionStore.drafts["a"], "前🙂请修改登录页面后")
        let pending = try XCTUnwrap(voice.uncorrectedRange(in: "a"))
        XCTAssertEqual((host.sessionStore.drafts["a"]! as NSString).substring(with: pending), "页面")
        let styled = NSMutableAttributedString(string: host.sessionStore.drafts["a"]!)
        VoiceDraftStyling.apply(to: styled, pending: pending)
        #if os(iOS)
        typealias NativeColor = UIColor
        let primaryAlpha = UIColor.label.cgColor.alpha
        #else
        typealias NativeColor = NSColor
        let primaryAlpha = NSColor.labelColor.cgColor.alpha
        #endif
        XCTAssertEqual((styled.attribute(.foregroundColor, at: pending.location, effectiveRange: nil) as? NativeColor)?.cgColor.alpha ?? -1, 0.5, accuracy: 0.01)
        for index in [0, 3, styled.length - 1] {
            XCTAssertEqual((styled.attribute(.foregroundColor, at: index, effectiveRange: nil) as? NativeColor)?.cgColor.alpha ?? -1, primaryAlpha, accuracy: 0.01)
        }
        await final("请修改登录页面。", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "前🙂请修改登录页面。后")
        XCTAssertNil(voice.uncorrectedRange(in: "a"))
        XCTAssertTrue(host.staged.isEmpty && host.transmitted.isEmpty)
    }

    func testHumanTakeoverFencesBothStreamingAndFinalAndClearsTint() async {
        for externalEdit in [false, true] {
            let (host, voice) = make()
            let session = await start(host, voice)
            await partial("please fix the page", session)
            voice.finishToDraft()
            session.event(.correctionDelta("Please fix")); await settle(40)
            let visible = host.sessionStore.drafts["a"]
            if externalEdit { host.sessionStore.setDraft("a", "human text") }
            else { voice.takeOver(sessionID: "a") } // caret/selection/IME without a String change
            if !externalEdit { XCTAssertNil(voice.selectionRequest, "discard queued automatic caret restoration") }
            XCTAssertNil(voice.uncorrectedRange(in: "a"))
            session.event(.correctionDelta("Replacement")); await settle(40)
            await final("Late replacement.", session)
            XCTAssertEqual(host.sessionStore.drafts["a"], externalEdit ? "human text" : visible)
            XCTAssertTrue(host.transmitted.isEmpty)
        }
    }

    func testRetiringDraftKeepsVisibleProgressInsteadOfRestoringRaw() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("please fix the page", session)
        voice.finishToDraft()
        session.event(.correctionDelta("Please fix")); await settle(40)
        let visible = host.sessionStore.drafts["a"]
        XCTAssertTrue(visible?.hasPrefix("Please") == true)
        voice.retireKeepingDraft()
        XCTAssertEqual(host.sessionStore.drafts["a"], visible)
        XCTAssertNil(voice.uncorrectedRange(in: "a"))
        await final("late", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], visible)
    }

    func testLateASRDoesNotRollBackAnEditCorrection() async {
        let (host, voice) = make()
        let session = await start(host, voice)
        await partial("please fix", session)
        voice.finishToDraft()
        session.event(.correctionDelta("Please")); await settle(40)
        await partial("please fix the page", session)
        XCTAssertEqual(host.sessionStore.drafts["a"], "Please fix the page")
        XCTAssertNotNil(voice.uncorrectedRange(in: "a"))
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
            XCTAssertEqual(IOSVoiceComposer.insert("\u{65B0}", into: text, range: invalid).0, text + "\u{65B0}")
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
        XCTAssertEqual(insert("\u{65B0}\u{8BDD}", "\u{524D}\u{6587}").0, "\u{524D}\u{6587}\u{65B0}\u{8BDD}")
        XCTAssertEqual(insert("\u{8BF7}\u{5E2E}\u{6211}", "Prefix SUFFIX").0, "Prefix SUFFIX\u{8BF7}\u{5E2E}\u{6211}")
        XCTAssertEqual(insert("Kraki", "\u{63A5}\u{5165}").0, "\u{63A5}\u{5165}Kraki")
        XCTAssertEqual(insert("done", "(").0, "(done")
        XCTAssertEqual(insert("ok", "say .", 4).0, "say ok.")
        XCTAssertEqual(insert("x", "").0, "x")
        XCTAssertEqual(insert("", "keep").0, "keep")
    }
}
