import AVFoundation
import Foundation
import Observation
import VoiceInputCore

protocol KrakiVoiceInputHost: AnyObject {
    var voiceCapability: VoiceCapability? { get }
    var voiceUserID: String? { get }
    var voiceDeviceID: String? { get }
    var voiceTransportReady: Bool { get }
    func requestVoiceLease(resource: String) -> Bool
}

protocol VoiceInputSessionFactory {
    func makeSession(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping (VoiceInputEvent) -> Void,
        onMetric: @escaping (VoiceInputMetric) -> Void
    ) -> VoiceInputSessionProtocol
}

struct LiveVoiceInputSessionFactory: VoiceInputSessionFactory {
    func makeSession(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping (VoiceInputEvent) -> Void,
        onMetric: @escaping (VoiceInputMetric) -> Void
    ) -> VoiceInputSessionProtocol {
        VoiceInputSession(
            configuration: configuration,
            onEvent: onEvent,
            log: { KLog.d("🎙️ [voice-core] \($0)") },
            onMetric: onMetric
        )
    }
}

enum VoiceMicrophonePermission: Equatable {
    case granted
    case undetermined
    case denied
}

protocol VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission { get }
    func requestPermission() async -> Bool
    func activate() -> Bool
    func deactivate()
}

struct LiveVoiceInputAudioPolicy: VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission {
        #if os(macOS)
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .notDetermined: return .undetermined
        default: return .denied
        }
        #else
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .undetermined: return .undetermined
        default: return .denied
        }
        #endif
    }

    func requestPermission() async -> Bool {
        switch permission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            #if os(macOS)
            return await AVCaptureDevice.requestAccess(for: .audio)
            #else
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
            #endif
        }
    }

    func activate() -> Bool {
        #if os(iOS)
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try audio.setActive(true)
            return true
        } catch {
            KLog.d("🎙️ [voice] audio-session activation failed: \(error.localizedDescription)")
            return false
        }
        #else
        return true
        #endif
    }

    func deactivate() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

enum VoiceDraftMerger {
    static func merge(existing: String, final: String) -> String {
        guard !final.isEmpty else { return existing }
        guard !existing.isEmpty else { return final }
        if existing.last?.isWhitespace == true || final.first?.isWhitespace == true {
            return existing + final
        }
        return existing + " " + final
    }
}

enum VoiceComposerAccessPolicy {
    static func isVisible(capabilityAvailable: Bool) -> Bool {
        capabilityAvailable
    }

    static func canStart(capabilityAvailable: Bool, voiceControllerBusy: Bool) -> Bool {
        capabilityAvailable && !voiceControllerBusy
    }
}

@Observable
final class KrakiVoiceInputController {
    enum State: Equatable {
        case idle
        case requestingPermission
        case obtainingLease
        case recording
        case finishing
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var rawText = ""
    private(set) var correctionSource = ""
    private(set) var correctionText = ""
    private(set) var correctionSourceOffset = 0
    private(set) var level: Float = 0
    private(set) var levels: [Float] = Array(repeating: 0, count: 8)
    private(set) var activeSessionID: String?

    var displayText: String {
        correctionText.isEmpty ? rawText : correctionText
    }

    var isRecording: Bool { state == .recording }
    var isBusy: Bool {
        switch state {
        case .requestingPermission, .obtainingLease, .recording, .finishing:
            return true
        case .idle, .failed:
            return false
        }
    }

    private weak var host: KrakiVoiceInputHost?
    private let sessionFactory: VoiceInputSessionFactory
    private let audioPolicy: VoiceInputAudioPolicy
    private var session: VoiceInputSessionProtocol?
    private var generation = UUID()
    private var context: VoiceSessionContext?
    private var recordingStartedHandler: (() -> Void)?
    private var finalHandler: ((String) -> Void)?
    private var leaseTimeoutTask: Task<Void, Never>?
    private var correctionDisplayTask: Task<Void, Never>?
    private var pendingCorrectionText: String?
    private var stableRawPrefix = ""
    private var currentRawSegment = ""
    private var metricStart: ContinuousClock.Instant?

    init(
        host: KrakiVoiceInputHost? = nil,
        sessionFactory: VoiceInputSessionFactory = LiveVoiceInputSessionFactory(),
        audioPolicy: VoiceInputAudioPolicy? = nil
    ) {
        self.host = host
        self.sessionFactory = sessionFactory
        self.audioPolicy = audioPolicy ?? LiveVoiceInputAudioPolicy()
    }

    func bind(host: KrakiVoiceInputHost) {
        self.host = host
    }

    func begin(
        sessionID: String,
        context: VoiceSessionContext,
        onRecordingStarted: (() -> Void)? = nil,
        onFinal: @escaping (String) -> Void
    ) async {
        switch state {
        case .idle, .failed:
            break
        default:
            return
        }
        guard let host, host.voiceCapability != nil else {
            fail(VoiceInputError.unavailable)
            return
        }
        guard host.voiceTransportReady else {
            fail(VoiceInputError.offline)
            return
        }

        cancelCurrent(resetState: false)
        let current = UUID()
        generation = current
        activeSessionID = sessionID
        self.context = context
        recordingStartedHandler = onRecordingStarted
        finalHandler = onFinal
        rawText = ""
        stableRawPrefix = ""
        currentRawSegment = ""
        correctionSource = ""
        correctionText = ""
        correctionSourceOffset = 0
        level = 0
        levels = Array(repeating: 0, count: 8)
        state = .requestingPermission
        KLog.d("🎙️ [voice] stage=permission session=\(sessionID.prefix(12))")

        let wasUndetermined = audioPolicy.permission == .undetermined
        guard await audioPolicy.requestPermission(), generation == current else {
            if generation == current { fail(VoiceInputError.microphoneDenied) }
            return
        }
        if wasUndetermined {
            // The permission callback can win a short race with TCC's visible
            // authorization state. Do not mint a billable lease until the same
            // policy used by capture confirms that access is really granted.
            for _ in 0..<20 where audioPolicy.permission != .granted {
                try? await Task.sleep(for: .milliseconds(50))
                guard generation == current else { return }
            }
        }
        guard audioPolicy.permission == .granted else {
            fail(VoiceInputError.microphoneDenied)
            return
        }
        guard audioPolicy.activate(), generation == current else {
            if generation == current {
                fail(VoiceInputError.gateway("The microphone audio session couldn't be started."))
            }
            return
        }

        state = .obtainingLease
        KLog.d("🎙️ [voice] stage=lease-request")
        metricStart = .now
        guard let resource = host.voiceCapability?.resource,
              host.requestVoiceLease(resource: resource) else {
            fail(VoiceInputError.offline)
            return
        }
        leaseTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled,
                  let self,
                  self.generation == current,
                  self.state == .obtainingLease else { return }
            self.fail(VoiceInputError.leaseTimedOut)
        }
    }

    func finish() {
        guard state == .recording else { return }
        correctionSource = rawText
        correctionText = ""
        correctionSourceOffset = 0
        pendingCorrectionText = nil
        correctionDisplayTask?.cancel()
        correctionDisplayTask = nil
        state = .finishing
        session?.stopCapture()
    }

    func cancel() {
        cancelCurrent(resetState: true)
    }

    func clearFailure() {
        guard case .failed = state else { return }
        state = .idle
    }

    func receiveLease(_ lease: VoiceLease) {
        guard state == .obtainingLease,
              let host,
              let capability = host.voiceCapability,
              let userID = host.voiceUserID,
              let deviceID = host.voiceDeviceID,
              let context,
              lease.payload.did == deviceID,
              lease.payload.resource == capability.resource,
              lease.payload.exp > Int(Date().timeIntervalSince1970),
              let gatewayURL = try? capability.validatedBrokerURL() else {
            return
        }
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        KLog.d("🎙️ [voice] stage=lease-granted quota=\(lease.payload.quotaSeconds)s")
        let current = generation
        let configuration = VoiceInputConfiguration(
            gatewayURL: gatewayURL,
            userID: userID,
            correctionEnabled: true,
            context: context.fields,
            vocabulary: context.vocabulary,
            startFields: [
                "deviceId": .string(deviceID),
                "sampleRate": .number(16_000),
                "lease": lease.voiceInputJSONValue,
            ]
        )
        session = sessionFactory.makeSession(
            configuration: configuration,
            onEvent: { [weak self] event in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.handle(event)
                }
            },
            onMetric: { [weak self] metric in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    let elapsed = self.metricStart.map { $0.duration(to: .now) }
                    KLog.d("🎙️ [voice] metric=\(metric.rawValue) elapsed=\(elapsed.map(String.init(describing:)) ?? "-")")
                    if metric == .engineStarted,
                       let handler = self.recordingStartedHandler {
                        self.recordingStartedHandler = nil
                        handler()
                    }
                }
            }
        )
        state = .recording
        KLog.d("🎙️ [voice] stage=recording")
    }

    func receiveLeaseDenied(reason: VoiceLeaseDeniedReason, detail: String?) {
        guard state == .obtainingLease else { return }
        fail(VoiceInputError.leaseDenied(reason, detail))
    }

    private func handle(_ event: VoiceInputEvent) {
        switch event {
        case .gatewayReady:
            break
        case .level(let value):
            level = value
            levels.removeFirst()
            levels.append(value)
        case .partial(let text):
            applyPartial(text)
        case .correctionDelta(let text):
            setCorrectionDelta(text)
        case .final(let text, let gatewayRawText):
            let finalText = resolvedFinalText(text, gatewayRawText: gatewayRawText)
            let handler = finalHandler
            terminalCleanup()
            state = .idle
            if !finalText.isEmpty { handler?(finalText) }
        case .failed(let reason):
            fail(VoiceInputError.gateway(Self.userFacingGatewayError(reason)))
        }
    }

    private func resolvedFinalText(_ text: String, gatewayRawText: String?) -> String {
        guard !stableRawPrefix.isEmpty else { return text }
        let accumulatedLength = rawText.count
        let gatewayRawLength = gatewayRawText?.count ?? 0
        // A segmented gateway may finish with only the newest ASR segment.
        // If both corrected and gateway-raw finals are materially shorter than
        // the accumulated HUD transcript, preserve the completed prefix.
        if text.count + 5 < accumulatedLength,
           gatewayRawLength + 5 < accumulatedLength {
            return VoiceDraftMerger.merge(existing: stableRawPrefix, final: text)
        }
        return text
    }

    #if DEBUG
    func debugApplyPartial(_ text: String) {
        applyPartial(text)
    }

    func debugResolvedFinalText(_ text: String, gatewayRawText: String?) -> String {
        resolvedFinalText(text, gatewayRawText: gatewayRawText)
    }
    #endif

    private func applyPartial(_ text: String) {
        guard !text.isEmpty else { return }
        if currentRawSegment.isEmpty {
            currentRawSegment = text
        } else if text.hasPrefix(currentRawSegment)
                    || currentRawSegment.hasPrefix(text)
                    || Self.sharedPrefixLength(text, currentRawSegment) >= min(text.count, currentRawSegment.count) / 2 {
            // Normal ASR growth or an in-place revision of the active segment.
            currentRawSegment = text
        } else if text.count + 5 < currentRawSegment.count {
            // The gateway started a new ASR segment. Preserve the completed
            // segment and append the new speech instead of erasing the HUD.
            stableRawPrefix = VoiceDraftMerger.merge(
                existing: stableRawPrefix,
                final: currentRawSegment
            )
            currentRawSegment = text
        } else {
            // Ambiguous same-sized revision: the recognizer is still refining
            // the active segment, so latest-wins without duplicating words.
            currentRawSegment = text
        }
        rawText = VoiceDraftMerger.merge(existing: stableRawPrefix, final: currentRawSegment)
    }

    private static func sharedPrefixLength(_ lhs: String, _ rhs: String) -> Int {
        zip(lhs, rhs).prefix(while: ==).count
    }

    private func setCorrectionDelta(_ text: String) {
        guard state == .finishing, !text.isEmpty else { return }
        pendingCorrectionText = text
        if correctionText.isEmpty {
            applyPendingCorrectionText()
            return
        }
        guard correctionDisplayTask == nil else { return }
        correctionDisplayTask = Task { @MainActor [weak self] in
            // Later gateway deltas may arrive faster than the display refresh
            // rate. Keep only the newest accumulated prefix.
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled, let self else { return }
            self.correctionDisplayTask = nil
            self.applyPendingCorrectionText()
        }
    }

    private func applyPendingCorrectionText() {
        guard let text = pendingCorrectionText else { return }
        pendingCorrectionText = nil
        correctionText = text
        correctionSourceOffset = max(
            correctionSourceOffset,
            Self.alignedRawPrefixLength(corrected: text, raw: correctionSource)
        )
    }

    /// Align the accumulated corrected prefix with the raw transcript prefix.
    /// Whitespace and case are ignored; ties prefer the longer raw prefix so
    /// filler-word deletions disappear as correction advances.
    static func alignedRawPrefixLength(corrected: String, raw: String) -> Int {
        let rawCharacters = Array(raw)
        var normalizedRaw: [Character] = []
        var rawIndices: [Int] = []
        for (index, character) in rawCharacters.enumerated() {
            let piece = String(character)
            if piece.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            for normalized in piece.lowercased() {
                normalizedRaw.append(normalized)
                rawIndices.append(index)
            }
        }
        let normalizedCorrected = Array(corrected.lowercased()).filter {
            !String($0).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !normalizedCorrected.isEmpty, !normalizedRaw.isEmpty else { return 0 }

        var previous = Array(0...normalizedRaw.count)
        for (index, correctedCharacter) in normalizedCorrected.enumerated() {
            var current = Array(repeating: 0, count: normalizedRaw.count + 1)
            current[0] = index + 1
            for rawIndex in 1...normalizedRaw.count {
                let substitution = previous[rawIndex - 1]
                    + (correctedCharacter == normalizedRaw[rawIndex - 1] ? 0 : 1)
                current[rawIndex] = min(
                    previous[rawIndex] + 1,
                    current[rawIndex - 1] + 1,
                    substitution
                )
            }
            previous = current
        }
        let bestCost = previous.min() ?? 0
        let normalizedOffset = previous.indices.last(where: { previous[$0] == bestCost }) ?? 0
        guard normalizedOffset > 0 else { return 0 }
        return rawIndices[normalizedOffset - 1] + 1
    }

    private func fail(_ error: VoiceInputError) {
        KLog.d("🎙️ [voice] stage=failed reason=\(error.localizedDescription)")
        terminalCleanup()
        state = .failed(error.localizedDescription)
    }

    private func terminalCleanup() {
        correctionDisplayTask?.cancel()
        correctionDisplayTask = nil
        pendingCorrectionText = nil
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        session?.close()
        session = nil
        audioPolicy.deactivate()
        rawText = ""
        stableRawPrefix = ""
        currentRawSegment = ""
        correctionSource = ""
        correctionText = ""
        correctionSourceOffset = 0
        level = 0
        levels = Array(repeating: 0, count: 8)
        activeSessionID = nil
        context = nil
        recordingStartedHandler = nil
        finalHandler = nil
        metricStart = nil
    }

    private func cancelCurrent(resetState: Bool) {
        generation = UUID()
        terminalCleanup()
        if resetState { state = .idle }
    }

    private static func userFacingGatewayError(_ reason: String) -> String {
        let lower = reason.lowercased()
        if lower.contains("permission") { return VoiceInputError.microphoneDenied.localizedDescription }
        if lower.contains("quota") { return "The voice-input quota was exhausted." }
        if lower.contains("lease") || lower.contains("denied") {
            return "The voice session authorization was rejected. Please try again."
        }
        if lower.contains("timed out") || lower.contains("timeout") {
            return "The voice service timed out. Please try again."
        }
        if lower.contains("network") || lower.contains("ws ") || lower.contains("socket") {
            return "The voice service connection was interrupted."
        }
        return "Voice input failed. Please try again."
    }

}
