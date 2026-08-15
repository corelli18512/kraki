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
    private(set) var isConnectionWarm = false

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
    private var connectionGeneration = UUID()
    private var recordingGeneration = UUID()
    private var lease: VoiceLease?
    private var leaseRequestInFlight = false
    private var context: VoiceSessionContext?
    private var recordingStartedHandler: (() -> Void)?
    private var finalHandler: ((String) -> Void)?
    private var leaseTimeoutTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var correctionDisplayTask: Task<Void, Never>?
    private var pendingCorrectionText: String?
    private var stableRawPrefix = ""
    private var currentRawSegment = ""
    private var metricStart: ContinuousClock.Instant?
    private var reconnectAttempt = 0
    private var warmConnectionDesired = false

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

    /// Lease validity has two independent boundaries: its signed expiry and
    /// the UTC calendar day on which it was issued. Head's daily accounting
    /// intentionally rejects activation after that day, even when `exp` has
    /// not elapsed yet.
    static func isLeaseUsable(_ lease: VoiceLease, nowUnixSec: Int) -> Bool {
        guard lease.payload.exp > nowUnixSec + 5,
              lease.payload.iat <= nowUnixSec + 30 else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let issuedDay = calendar.dateComponents(
            [.era, .year, .month, .day],
            from: Date(timeIntervalSince1970: TimeInterval(lease.payload.iat))
        )
        let currentDay = calendar.dateComponents(
            [.era, .year, .month, .day],
            from: Date(timeIntervalSince1970: TimeInterval(nowUnixSec))
        )
        return issuedDay == currentDay
    }

    /// Ensure a signed and activated broker connection exists without touching
    /// microphone permission or the audio session.
    func prepare() {
        warmConnectionDesired = true
        guard session == nil, !leaseRequestInFlight,
              let host,
              let capability = host.voiceCapability,
              host.voiceTransportReady,
              host.voiceUserID != nil,
              host.voiceDeviceID != nil,
              audioPolicy.permission != .denied else { return }

        let now = Int(Date().timeIntervalSince1970)
        if let lease, Self.isLeaseUsable(lease, nowUnixSec: now) {
            openConnection(lease, capability: capability)
            return
        }

        lease = nil
        leaseRequestInFlight = true
        KLog.d("🎙️ [voice] stage=warm-lease-request")
        guard host.requestVoiceLease(resource: capability.resource) else {
            leaseRequestInFlight = false
            scheduleReconnect()
            return
        }
        scheduleLeaseTimeout()
    }

    func suspendWarmConnection() {
        warmConnectionDesired = false
        reconnectTask?.cancel()
        reconnectTask = nil
        refreshTask?.cancel()
        refreshTask = nil
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        leaseRequestInFlight = false
        closeConnection(keepLease: true)
        recordingCleanup(clearHandlers: true)
        state = .idle
    }

    func resumeWarmConnection() {
        prepare()
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
            failRecording(VoiceInputError.unavailable, closeTransport: false)
            return
        }
        guard host.voiceTransportReady else {
            failRecording(VoiceInputError.offline, closeTransport: false)
            return
        }

        let currentRecording = UUID()
        recordingGeneration = currentRecording
        resetPresentation()
        activeSessionID = sessionID
        self.context = context
        recordingStartedHandler = onRecordingStarted
        finalHandler = onFinal
        state = .requestingPermission
        KLog.d("🎙️ [voice] stage=permission session=\(sessionID.prefix(12)) warm=\(isConnectionWarm ? 1 : 0)")

        let wasUndetermined = audioPolicy.permission == .undetermined
        guard await audioPolicy.requestPermission() else {
            if recordingGeneration == currentRecording {
                failRecording(VoiceInputError.microphoneDenied, closeTransport: false)
            }
            return
        }
        guard recordingGeneration == currentRecording else { return }
        if wasUndetermined {
            for _ in 0..<20 where audioPolicy.permission != .granted {
                try? await Task.sleep(for: .milliseconds(50))
                guard recordingGeneration == currentRecording else { return }
            }
        }
        guard audioPolicy.permission == .granted else {
            failRecording(VoiceInputError.microphoneDenied, closeTransport: false)
            return
        }
        guard audioPolicy.activate(), recordingGeneration == currentRecording else {
            if recordingGeneration == currentRecording {
                failRecording(
                    VoiceInputError.gateway("The microphone audio session couldn't be started."),
                    closeTransport: false
                )
            }
            return
        }

        if isConnectionWarm, session != nil {
            startPendingRecording()
        } else {
            state = .obtainingLease
            metricStart = .now
            prepare()
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
        closeConnection(keepLease: true)
        recordingCleanup(clearHandlers: true)
        state = .idle
        if warmConnectionDesired { scheduleReconnect(immediate: true) }
    }

    func clearFailure() {
        guard case .failed = state else { return }
        state = .idle
    }

    func receiveLease(_ lease: VoiceLease) {
        guard leaseRequestInFlight,
              let host,
              let capability = host.voiceCapability,
              let deviceID = host.voiceDeviceID,
              lease.payload.did == deviceID,
              lease.payload.resource == capability.resource,
              Self.isLeaseUsable(lease, nowUnixSec: Int(Date().timeIntervalSince1970)) else { return }
        leaseRequestInFlight = false
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        self.lease = lease
        KLog.d("🎙️ [voice] stage=lease-granted quota=\(lease.payload.quotaSeconds)s")
        openConnection(lease, capability: capability)
    }

    func receiveLeaseDenied(reason: VoiceLeaseDeniedReason, detail: String?) {
        guard leaseRequestInFlight else { return }
        leaseRequestInFlight = false
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        if state == .obtainingLease {
            failRecording(VoiceInputError.leaseDenied(reason, detail), closeTransport: false)
        } else if reason != .quotaExhausted {
            scheduleReconnect()
        }
    }

    private func openConnection(_ lease: VoiceLease, capability: VoiceCapability) {
        guard session == nil,
              let host,
              let userID = host.voiceUserID,
              let deviceID = host.voiceDeviceID,
              let gatewayURL = try? capability.validatedBrokerURL() else { return }

        reconnectTask?.cancel()
        reconnectTask = nil
        isConnectionWarm = false
        connectionGeneration = UUID()
        let current = connectionGeneration
        let configuration = VoiceInputConfiguration(
            gatewayURL: gatewayURL,
            userID: userID,
            correctionEnabled: true,
            authorizationFields: [
                "deviceId": .string(deviceID),
                "authorization": lease.voiceInputJSONValue,
            ],
            startFields: [
                "deviceId": .string(deviceID),
                "sampleRate": .number(16_000),
            ]
        )
        session = sessionFactory.makeSession(
            configuration: configuration,
            onEvent: { [weak self] event in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == current else { return }
                    self.handle(event)
                }
            },
            onMetric: { [weak self] metric in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == current else { return }
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
    }

    private func startPendingRecording() {
        guard let session, let context, isConnectionWarm else { return }
        state = .recording
        metricStart = .now
        KLog.d("🎙️ [voice] stage=recording warm=1")
        session.startCapture(context: context.fields, vocabulary: context.vocabulary)
    }

    private func handle(_ event: VoiceInputEvent) {
        switch event {
        case .connectionAuthorized:
            isConnectionWarm = true
            reconnectAttempt = 0
            KLog.d("🎙️ [voice] stage=connection-authorized")
            scheduleRefresh()
            if state == .obtainingLease { startPendingRecording() }
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
            recordingCleanup(clearHandlers: true)
            state = .idle
            if !finalText.isEmpty { handler?(finalText) }
        case .failed(let reason):
            handleConnectionFailure(reason)
        }
    }

    private func handleConnectionFailure(_ reason: String) {
        KLog.d("🎙️ [voice] stage=connection-failed reason=\(reason)")
        let quotaExhausted = reason.localizedCaseInsensitiveContains("quota_exhausted")
        let leaseDayChanged = reason.localizedCaseInsensitiveContains("wrong_day")
        let requiresFreshLease = quotaExhausted || leaseDayChanged
        closeConnection(keepLease: !requiresFreshLease)
        if isBusy {
            let message = Self.userFacingGatewayError(reason)
            recordingCleanup(clearHandlers: true)
            state = .failed(message)
        }
        if warmConnectionDesired { scheduleReconnect(immediate: requiresFreshLease) }
    }

    private func scheduleLeaseTimeout() {
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, self.leaseRequestInFlight else { return }
            self.leaseRequestInFlight = false
            if self.state == .obtainingLease {
                self.failRecording(VoiceInputError.leaseTimedOut, closeTransport: false)
            } else {
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect(immediate: Bool = false) {
        guard warmConnectionDesired, reconnectTask == nil else { return }
        reconnectAttempt += 1
        let exponent = min(5, max(0, reconnectAttempt - 1))
        let base = immediate ? 0.0 : min(30.0, pow(2.0, Double(exponent)))
        let jitter = immediate ? 0.0 : Double.random(in: 0...(base * 0.2))
        reconnectTask = Task { @MainActor [weak self] in
            if base + jitter > 0 {
                try? await Task.sleep(for: .seconds(base + jitter))
            }
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            self.prepare()
        }
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        guard let lease else { return }
        let now = Int(Date().timeIntervalSince1970)
        let expiryDelay = max(1, lease.payload.exp - now - 60)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let nowDate = Date(timeIntervalSince1970: TimeInterval(now))
        let startOfToday = utc.startOfDay(for: nowDate)
        let nextDay = utc.date(byAdding: .day, value: 1, to: startOfToday)
            ?? nowDate.addingTimeInterval(86_400)
        let dayBoundaryDelay = max(1, Int(ceil(nextDay.timeIntervalSince(nowDate))) + 1)
        let delay = min(expiryDelay, dayBoundaryDelay)
        refreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.warmConnectionDesired else { return }
            if self.state == .idle || self.state.failedMessage != nil {
                self.closeConnection(keepLease: false)
                self.prepare()
            } else {
                self.scheduleRefreshAfterRecording()
            }
        }
    }

    private func scheduleRefreshAfterRecording() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self, self.warmConnectionDesired else { return }
            if self.state == .idle || self.state.failedMessage != nil {
                self.closeConnection(keepLease: false)
                self.prepare()
            } else {
                self.scheduleRefreshAfterRecording()
            }
        }
    }

    private func closeConnection(keepLease: Bool) {
        connectionGeneration = UUID()
        refreshTask?.cancel()
        refreshTask = nil
        session?.close()
        session = nil
        isConnectionWarm = false
        if !keepLease { lease = nil }
    }

    private func resolvedFinalText(_ text: String, gatewayRawText: String?) -> String {
        guard !stableRawPrefix.isEmpty else { return text }
        let accumulatedLength = rawText.count
        let gatewayRawLength = gatewayRawText?.count ?? 0
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
            currentRawSegment = text
        } else if text.count + 5 < currentRawSegment.count {
            stableRawPrefix = VoiceDraftMerger.merge(
                existing: stableRawPrefix,
                final: currentRawSegment
            )
            currentRawSegment = text
        } else {
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

    private func failRecording(_ error: VoiceInputError, closeTransport: Bool) {
        KLog.d("🎙️ [voice] stage=failed reason=\(error.localizedDescription)")
        if closeTransport { closeConnection(keepLease: true) }
        recordingCleanup(clearHandlers: true)
        state = .failed(error.localizedDescription)
    }

    private func recordingCleanup(clearHandlers: Bool) {
        recordingGeneration = UUID()
        correctionDisplayTask?.cancel()
        correctionDisplayTask = nil
        pendingCorrectionText = nil
        audioPolicy.deactivate()
        resetPresentation()
        activeSessionID = nil
        context = nil
        if clearHandlers {
            recordingStartedHandler = nil
            finalHandler = nil
        }
        metricStart = nil
    }

    private func resetPresentation() {
        rawText = ""
        stableRawPrefix = ""
        currentRawSegment = ""
        correctionSource = ""
        correctionText = ""
        correctionSourceOffset = 0
        level = 0
        levels = Array(repeating: 0, count: 8)
    }

    private static func userFacingGatewayError(_ reason: String) -> String {
        let lower = reason.lowercased()
        if lower.contains("permission") { return VoiceInputError.microphoneDenied.localizedDescription }
        if lower.contains("quota") { return "The voice-input quota was exhausted." }
        if lower.contains("lease") || lower.contains("denied") || lower.contains("authorization") {
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

private extension KrakiVoiceInputController.State {
    var failedMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}
