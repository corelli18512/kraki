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

/// Everything needed to open a broker connection without Head: lets a cold
/// start (or foreground) warm the voice socket in parallel with Head auth.
struct VoiceConnectionIdentity: Codable, Equatable {
    let brokerUrl: String
    let resource: String
    let userID: String
    let deviceID: String
}

struct StoredVoiceLease: Codable, Equatable {
    let lease: VoiceLease
    let identity: VoiceConnectionIdentity
    /// Client-side estimate of audio already sent on this lease.
    var usedSeconds: Double
}

protocol VoiceLeaseStore: AnyObject {
    func load() -> StoredVoiceLease?
    func save(_ lease: StoredVoiceLease)
    func clear()
}

final class InMemoryVoiceLeaseStore: VoiceLeaseStore {
    private var stored: StoredVoiceLease?
    func load() -> StoredVoiceLease? { stored }
    func save(_ lease: StoredVoiceLease) { stored = lease }
    func clear() { stored = nil }
}

/// The lease is a device-bound bearer credential valid until UTC midnight at
/// most; keep it in the Keychain, never synced or backed up.
final class KeychainVoiceLeaseStore: VoiceLeaseStore {
    private let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "chat.kraki.voice-lease",
        kSecAttrAccount as String: "current",
    ]

    func load() -> StoredVoiceLease? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredVoiceLease.self, from: data)
    }

    func save(_ lease: StoredVoiceLease) {
        guard let data = try? JSONEncoder().encode(lease) else { return }
        let update: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

enum VoiceMicrophonePermission: Equatable {
    case granted
    case undetermined
    case denied
}

protocol VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission { get }
    var hasInputDevice: Bool { get }
    func requestPermission() async -> Bool
    func activate() -> Bool
    func deactivate()
}

struct LiveVoiceInputAudioPolicy: VoiceInputAudioPolicy {
    var hasInputDevice: Bool { VoiceAudioInputAvailability.isAvailable }

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

extension SessionStore {
    /// Own the result independently of a Composer's lifetime. Read the current
    /// draft at commit time so a late result cannot restore an obsolete snapshot
    /// over edits made after switching away and back. Never resurrect a session.
    func voiceDraftCommitHandler(for sessionID: String) -> (String) -> Void {
        { [weak self] final in
            guard let self, self.sessions[sessionID] != nil else { return }
            self.setDraft(
                sessionID,
                VoiceDraftMerger.merge(existing: self.drafts[sessionID] ?? "", final: final)
            )
        }
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

/// Opt-in terminal information for hold-to-text; existing onFinal clients keep
/// their original draft-only behavior. A recovered/raw-only result must not send.
struct VoiceInputCompletion {
    let text: String
    let rawText: String
    let completed: Bool
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
    private var completionHandler: ((VoiceInputCompletion) -> Void)?
    private var rawHandler: ((String) -> Void)?
    private var correctionHandler: ((String) -> Void)?
    private var preserveDraftOnDeparture = false
    private var failedSessionID: String?
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
    private var leaseRolloverAttempt = 0
    private var rolloverRawPrefix = ""
    private let leaseStore: VoiceLeaseStore
    private var leaseIdentity: VoiceConnectionIdentity?
    /// Estimated audio seconds already sent on `lease` (broker counts bytes).
    private var leaseUsedSeconds: Double = 0
    private var captureStartedAt: ContinuousClock.Instant?
    private var prefetchTask: Task<Void, Never>?
    // A replacement connection warmed in the background, promoted only while
    // no recording is using the current one, so rotation is never visible.
    private var standbySession: VoiceInputSessionProtocol?
    private var standbyLease: VoiceLease?
    private var standbyIdentity: VoiceConnectionIdentity?
    private var standbyGeneration = UUID()
    private var standbyAuthorized = false
    private var standbyRequested = false
    private var standbyBlockedUntil: ContinuousClock.Instant?

    private static let maxLeaseRolloverAttempts = 3
    /// Start the next lease while idle once less than this much is left.
    private static let rotationReserveSeconds: Double = 90
    /// During one long recording, warm the next lease this long before the
    /// current one runs out.
    private static let prefetchLeadSeconds: Double = 30

    init(
        host: KrakiVoiceInputHost? = nil,
        sessionFactory: VoiceInputSessionFactory = LiveVoiceInputSessionFactory(),
        audioPolicy: VoiceInputAudioPolicy? = nil,
        leaseStore: VoiceLeaseStore? = nil
    ) {
        self.host = host
        self.sessionFactory = sessionFactory
        self.audioPolicy = audioPolicy ?? LiveVoiceInputAudioPolicy()
        self.leaseStore = leaseStore ?? InMemoryVoiceLeaseStore()
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

    private var hostIdentity: VoiceConnectionIdentity? {
        guard let host, let capability = host.voiceCapability,
              let userID = host.voiceUserID, let deviceID = host.voiceDeviceID else { return nil }
        return VoiceConnectionIdentity(
            brokerUrl: capability.brokerUrl,
            resource: capability.resource,
            userID: userID,
            deviceID: deviceID
        )
    }

    private func remainingSeconds(_ lease: VoiceLease, used: Double) -> Double {
        Double(lease.payload.quotaSeconds) - used
    }

    /// Ensure a signed and activated broker connection exists without touching
    /// microphone permission or the audio session. A lease kept from an
    /// earlier launch is used immediately, without waiting for Head.
    func prepare() {
        warmConnectionDesired = true
        guard audioPolicy.permission != .denied else { return }
        if lease == nil { restoreStoredLease() }

        // Head is authoritative once connected: another account, device or
        // broker (or voice switched off) invalidates everything held.
        if let host, host.voiceTransportReady, lease != nil || session != nil {
            if hostIdentity == nil || hostIdentity != leaseIdentity {
                discardStandby()
                closeConnection(keepLease: false)
            }
        }

        if session != nil {
            maintainLease()
            return
        }
        if standbySession != nil {
            // The current socket died while its replacement was warming.
            if standbyAuthorized { promoteStandbyIfPossible() }
            return
        }
        guard !leaseRequestInFlight else { return }

        let now = Int(Date().timeIntervalSince1970)
        if let lease, let identity = leaseIdentity,
           Self.isLeaseUsable(lease, nowUnixSec: now),
           remainingSeconds(lease, used: leaseUsedSeconds) >= 1 {
            openConnection(lease, identity: identity)
            return
        }
        if lease != nil { closeConnection(keepLease: false) }
        KLog.d("🎙️ [voice] stage=warm-lease-request")
        requestLease(standby: false)
    }

    /// Returns false when Head is not reachable yet (Head auth calls prepare).
    @discardableResult
    private func requestLease(standby: Bool) -> Bool {
        guard !leaseRequestInFlight, let host, let identity = hostIdentity,
              host.voiceTransportReady else { return false }
        leaseRequestInFlight = true
        standbyRequested = standby
        guard host.requestVoiceLease(resource: identity.resource) else {
            leaseRequestInFlight = false
            standbyRequested = false
            if !standby { scheduleReconnect() }
            return false
        }
        scheduleLeaseTimeout()
        return true
    }

    private func restoreStoredLease() {
        guard let stored = leaseStore.load() else { return }
        let now = Int(Date().timeIntervalSince1970)
        guard Self.isLeaseUsable(stored.lease, nowUnixSec: now),
              remainingSeconds(stored.lease, used: stored.usedSeconds) >= 1 else {
            leaseStore.clear()
            return
        }
        lease = stored.lease
        leaseIdentity = stored.identity
        leaseUsedSeconds = stored.usedSeconds
        KLog.d("🎙️ [voice] stage=lease-restored used=\(Int(stored.usedSeconds))s")
    }

    private func persistLease() {
        guard let lease, let leaseIdentity else { return }
        leaseStore.save(StoredVoiceLease(lease: lease, identity: leaseIdentity, usedSeconds: leaseUsedSeconds))
    }

    /// Warm the next lease in the background when the current one is close to
    /// its audio allowance or expiry, so the switch happens while idle.
    private func maintainLease() {
        guard warmConnectionDesired, session != nil, standbySession == nil,
              !leaseRequestInFlight, let lease else { return }
        switch state {
        case .idle, .failed: break
        default: return
        }
        if let blocked = standbyBlockedUntil, ContinuousClock.now < blocked { return }
        let now = Int(Date().timeIntervalSince1970)
        let quota = Double(lease.payload.quotaSeconds)
        let lowOnAudio = remainingSeconds(lease, used: leaseUsedSeconds)
            < min(Self.rotationReserveSeconds, quota / 3)
        // Near UTC midnight a new lease would expire at midnight too; the
        // day-boundary refresh rotates right after midnight instead.
        let nearMidnight = 86_400 - now % 86_400 < 150
        let expiringSoon = lease.payload.exp - now < 120 && !nearMidnight
        guard lowOnAudio || expiringSoon else { return }
        KLog.d("🎙️ [voice] stage=lease-prefetch reason=\(lowOnAudio ? "audio" : "expiry")")
        requestLease(standby: true)
    }

    private func blockStandby() {
        standbyBlockedUntil = ContinuousClock.now.advanced(by: .seconds(30))
    }

    private func discardStandby() {
        standbyGeneration = UUID()
        standbySession?.close()
        standbySession = nil
        standbyLease = nil
        standbyIdentity = nil
        standbyAuthorized = false
    }

    private func handleStandby(_ event: VoiceInputEvent) {
        switch event {
        case .connectionAuthorized:
            standbyAuthorized = true
            KLog.d("🎙️ [voice] stage=standby-authorized")
            promoteStandbyIfPossible()
        case .failed(let reason):
            KLog.d("🎙️ [voice] stage=standby-failed reason=\(reason)")
            discardStandby()
            blockStandby()
            if session == nil, warmConnectionDesired {
                scheduleReconnect(immediate: state == .obtainingLease)
            }
        default:
            break
        }
    }

    /// Swap to the warmed replacement connection. Never while a recording or
    /// its transcript is still using the current one.
    private func promoteStandbyIfPossible() {
        guard standbyAuthorized, let next = standbySession,
              let nextLease = standbyLease, let nextIdentity = standbyIdentity else { return }
        switch state {
        case .recording, .finishing:
            return
        case .idle, .failed, .requestingPermission, .obtainingLease:
            break
        }
        let previous = session
        connectionGeneration = standbyGeneration
        standbyGeneration = UUID()
        session = next
        standbySession = nil
        standbyLease = nil
        standbyIdentity = nil
        standbyAuthorized = false
        previous?.close()
        lease = nextLease
        leaseIdentity = nextIdentity
        leaseUsedSeconds = 0
        persistLease()
        isConnectionWarm = true
        reconnectAttempt = 0
        KLog.d("🎙️ [voice] stage=lease-rotated jti=\(nextLease.payload.jti.prefix(8))")
        scheduleRefresh()
        if state == .obtainingLease { startPendingRecording() }
    }

    /// Charge the capture that just ended to the current lease's estimate.
    private func accountCapture() {
        prefetchTask?.cancel()
        prefetchTask = nil
        guard let started = captureStartedAt else { return }
        captureStartedAt = nil
        let elapsed = started.duration(to: .now)
        let seconds = Double(elapsed.components.seconds)
            + Double(elapsed.components.attoseconds) / 1e18
        // Slight over-estimate: the broker also counts pre-roll buffers.
        leaseUsedSeconds += seconds + 0.3
        persistLease()
    }

    /// A recording and its transcript are done with the connection.
    private func didFinishUsingConnection() {
        promoteStandbyIfPossible()
        maintainLease()
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
        standbyRequested = false
        discardStandby()
        closeConnection(keepLease: true)
        recordingCleanup(clearHandlers: true)
        state = .idle
    }

    /// Sign-out: nothing of this identity may survive, including the stored lease.
    func forgetLease() {
        suspendWarmConnection()
        closeConnection(keepLease: false)
    }

    func resumeWarmConnection() {
        prepare()
    }

    /// Main-actor isolated: in Swift 5 mode a nonisolated `async` method runs on
    /// the global executor, which raced main-thread release/cancel/transport
    /// events and could leave the audio session active after a quick release.
    @MainActor
    func begin(
        sessionID: String,
        context: VoiceSessionContext,
        onRecordingStarted: (() -> Void)? = nil,
        onRaw: ((String) -> Void)? = nil,
        onCorrection: ((String) -> Void)? = nil,
        onCompletion: ((VoiceInputCompletion) -> Void)? = nil,
        onFinal: @escaping (String) -> Void
    ) async {
        switch state {
        case .idle, .failed:
            break
        default:
            return
        }
        let currentRecording = UUID()
        recordingGeneration = currentRecording
        leaseRolloverAttempt = 0
        resetPresentation()
        // Attribute even synchronous preflight failures to the initiating
        // conversation, before any fallible capability/transport checks.
        activeSessionID = sessionID
        self.context = context
        recordingStartedHandler = onRecordingStarted
        finalHandler = onFinal
        rawHandler = onRaw
        correctionHandler = onCorrection
        completionHandler = onCompletion

        // An open broker connection needs nothing from Head; only a missing
        // one has to wait for Head to issue a lease.
        guard let host, host.voiceCapability != nil || session != nil else {
            failRecording(VoiceInputError.unavailable, closeTransport: false)
            return
        }
        guard host.voiceTransportReady || session != nil else {
            failRecording(VoiceInputError.offline, closeTransport: false)
            return
        }

        switch audioPolicy.permission {
        case .granted:
            // The auth handshake already warmed the signed broker connection.
            // Do not expose a synthetic permission phase when TCC access was
            // granted previously; proceed directly to audio activation/start.
            KLog.d("🎙️ [voice] stage=permission-ready session=\(sessionID.prefix(12)) warm=\(isConnectionWarm ? 1 : 0)")

        case .denied:
            failRecording(VoiceInputError.microphoneDenied, closeTransport: false)
            return

        case .undetermined:
            // Only a genuinely undecided OS permission belongs in the visible
            // Requesting microphone state. Apple requires this prompt to remain
            // user-initiated, so warm connection setup must not request it.
            state = .requestingPermission
            KLog.d("🎙️ [voice] stage=permission-request session=\(sessionID.prefix(12)) warm=\(isConnectionWarm ? 1 : 0)")
            guard await audioPolicy.requestPermission() else {
                if recordingGeneration == currentRecording {
                    failRecording(VoiceInputError.microphoneDenied, closeTransport: false)
                }
                return
            }
            guard recordingGeneration == currentRecording else { return }
            // The permission callback can win a short race with TCC's visible
            // authorization state. Wait for the same policy used by capture.
            for _ in 0..<20 where audioPolicy.permission != .granted {
                try? await Task.sleep(for: .milliseconds(50))
                guard recordingGeneration == currentRecording else { return }
            }
            guard audioPolicy.permission == .granted else {
                failRecording(VoiceInputError.microphoneDenied, closeTransport: false)
                return
            }
        }
        guard audioPolicy.hasInputDevice else {
            failRecording(VoiceInputError.microphoneUnavailable, closeTransport: false)
            return
        }
        let activated = audioPolicy.activate()
        guard recordingGeneration == currentRecording else {
            // Released/cancelled meanwhile: never leave a record session active
            // (it interrupts or ducks other audio) unless a newer recording owns it.
            if activated, !isBusy { audioPolicy.deactivate() }
            return
        }
        guard activated else {
            failRecording(
                VoiceInputError.gateway("The microphone audio session couldn't be started."),
                closeTransport: false
            )
            return
        }

        if session != nil {
            // Warm, or still authorizing: capture starts immediately and the
            // audio is buffered until the connection is authorized.
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
        accountCapture()
        session?.stopCapture()
    }

    /// Leaving a conversation is not an explicit discard. Keep the original
    /// owner and callback alive while ASR/correction finish on the warm socket.
    /// Both old-view disappearance and new-view appearance may call this.
    func finishForSessionDeparture(_ sessionID: String) {
        guard activeSessionID == sessionID else { return }
        switch state {
        case .recording:
            preserveDraftOnDeparture = true
            finish()
        case .finishing:
            preserveDraftOnDeparture = true
        case .requestingPermission, .obtainingLease:
            // Do not start the microphone later in an invisible conversation.
            // Lease rollover may already hold speech from the prior segment.
            let recoveredText = rawText
            let handler = finalHandler
            let completion = completionHandler
            cancel()
            completion?(VoiceInputCompletion(text: recoveredText, rawText: recoveredText, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
        case .idle, .failed:
            break
        }
    }

    func cancel() {
        closeConnection(keepLease: true)
        recordingCleanup(clearHandlers: true)
        state = .idle
        if warmConnectionDesired { scheduleReconnect(immediate: true) }
    }

    func hasFailure(for sessionID: String) -> Bool {
        guard case .failed = state else { return false }
        return failedSessionID == nil || failedSessionID == sessionID
    }

    func clearFailure() {
        guard case .failed = state else { return }
        failedSessionID = nil
        state = .idle
    }

    func receiveLease(_ lease: VoiceLease) {
        guard leaseRequestInFlight,
              let identity = hostIdentity,
              lease.payload.did == identity.deviceID,
              lease.payload.resource == identity.resource,
              Self.isLeaseUsable(lease, nowUnixSec: Int(Date().timeIntervalSince1970)) else { return }
        leaseRequestInFlight = false
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        let asStandby = standbyRequested && session != nil
        standbyRequested = false
        KLog.d("🎙️ [voice] stage=lease-granted quota=\(lease.payload.quotaSeconds)s standby=\(asStandby ? 1 : 0)")
        if asStandby {
            openStandby(lease, identity: identity)
            return
        }
        self.lease = lease
        leaseIdentity = identity
        leaseUsedSeconds = 0
        persistLease()
        openConnection(lease, identity: identity)
    }

    func receiveLeaseDenied(reason: VoiceLeaseDeniedReason, detail: String?) {
        guard leaseRequestInFlight else { return }
        leaseRequestInFlight = false
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        let wasStandby = standbyRequested
        standbyRequested = false
        if state == .obtainingLease {
            failRecording(VoiceInputError.leaseDenied(reason, detail), closeTransport: false)
        } else if wasStandby {
            // The current connection keeps working until its allowance ends.
            blockStandby()
        } else if reason != .quotaExhausted {
            scheduleReconnect()
        }
    }

    private func connectionConfiguration(_ lease: VoiceLease, identity: VoiceConnectionIdentity) -> VoiceInputConfiguration? {
        guard let gatewayURL = URL(string: identity.brokerUrl) else { return nil }
        return VoiceInputConfiguration(
            gatewayURL: gatewayURL,
            userID: identity.userID,
            correctionEnabled: true,
            authorizationFields: [
                "deviceId": .string(identity.deviceID),
                "authorization": lease.voiceInputJSONValue,
            ],
            startFields: [
                "deviceId": .string(identity.deviceID),
                "sampleRate": .number(16_000),
            ]
        )
    }

    /// Events are routed by generation: the current connection's go to
    /// `handle`, a warming replacement's to `handleStandby`, stale ones nowhere.
    private func makeConnection(
        _ configuration: VoiceInputConfiguration,
        generation: UUID
    ) -> VoiceInputSessionProtocol {
        sessionFactory.makeSession(
            configuration: configuration,
            onEvent: { [weak self] event in
                Task { @MainActor in
                    guard let self else { return }
                    if self.connectionGeneration == generation {
                        self.handle(event)
                    } else if self.standbyGeneration == generation, self.standbySession != nil {
                        self.handleStandby(event)
                    }
                }
            },
            onMetric: { [weak self] metric in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == generation else { return }
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

    private func openStandby(_ lease: VoiceLease, identity: VoiceConnectionIdentity) {
        discardStandby()
        guard let configuration = connectionConfiguration(lease, identity: identity) else { return }
        let generation = UUID()
        standbyGeneration = generation
        standbyLease = lease
        standbyIdentity = identity
        standbySession = makeConnection(configuration, generation: generation)
    }

    private func openConnection(_ lease: VoiceLease, identity: VoiceConnectionIdentity) {
        guard session == nil,
              let configuration = connectionConfiguration(lease, identity: identity) else { return }
        isConnectionWarm = false
        connectionGeneration = UUID()
        session = makeConnection(configuration, generation: connectionGeneration)
    }

    private func startPendingRecording() {
        guard let session, let context else { return }
        state = .recording
        metricStart = .now
        captureStartedAt = .now
        KLog.d("🎙️ [voice] stage=recording warm=\(isConnectionWarm ? 1 : 0)")
        session.startCapture(context: context.fields, vocabulary: context.vocabulary)
        schedulePrefetchDuringRecording()
    }

    /// A single long recording: warm the next lease shortly before this one's
    /// allowance ends, so the rollover is a socket swap, not a new handshake.
    private func schedulePrefetchDuringRecording() {
        prefetchTask?.cancel()
        prefetchTask = nil
        guard let lease, standbySession == nil else { return }
        let lead = remainingSeconds(lease, used: leaseUsedSeconds) - Self.prefetchLeadSeconds
        prefetchTask = Task { @MainActor [weak self] in
            if lead > 0 { try? await Task.sleep(for: .seconds(lead)) }
            guard !Task.isCancelled, let self, self.state == .recording,
                  self.standbySession == nil else { return }
            KLog.d("🎙️ [voice] stage=lease-prefetch reason=long-recording")
            self.requestLease(standby: true)
        }
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
            #if os(iOS)
            // Fast attack, slower release: words read as bumps, not flicker.
            let smoothed = max(value, (levels.last ?? 0) * 0.72)
            #else
            let smoothed = value
            #endif
            level = smoothed
            levels.removeFirst()
            levels.append(smoothed)
        case .partial(let text):
            applyPartial(text)
        case .correctionDelta(let text):
            setCorrectionDelta(text)
        case .final(let text, let gatewayRawText):
            guard state == .recording || state == .finishing else { return }
            let finalText = preserveDraftOnDeparture && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? rawText : resolvedFinalText(text, gatewayRawText: gatewayRawText)
            let handler = finalHandler
            let completion = completionHandler
            let completeRaw = gatewayRawText.map { resolvedFinalText($0, gatewayRawText: $0) } ?? rawText
            let validFinal = !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            // The gateway can silently fall back to raw on corrector failure.
            // Its current contract supplies rawText only for successful changed
            // correction. For unchanged correction, require a complete matching
            // stream, not merely a first/partial delta. Unknown finals stay draft.
            // The gateway returns the corrector's output trimmed, while deltas
            // carry the untrimmed stream; compare trimmed forms.
            let streamedFinal = (pendingCorrectionText ?? correctionText)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let correctionConfirmed = gatewayRawText?.isEmpty == false
                || (!streamedFinal.isEmpty
                    && streamedFinal == finalText.trimmingCharacters(in: .whitespacesAndNewlines))
            let completed = validFinal && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && correctionConfirmed
            recordingCleanup(clearHandlers: true)
            state = .idle
            completion?(VoiceInputCompletion(text: validFinal ? finalText : completeRaw, rawText: completeRaw, completed: completed))
            if !finalText.isEmpty { handler?(finalText) }
            didFinishUsingConnection()
        case .failed(let reason):
            handleConnectionFailure(reason)
        }
    }

    private func handleConnectionFailure(_ reason: String) {
        KLog.d("🎙️ [voice] stage=connection-failed reason=\(reason)")
        let quotaExhausted = reason.localizedCaseInsensitiveContains("quota_exhausted")
        let leaseRejected = Self.isLeaseRejection(reason)
        if quotaExhausted, recoverFromExhaustedLease() { return }
        // A lease kept from an earlier launch turned out to be dead while the
        // user was already speaking: keep the recording, fetch a new lease.
        if leaseRejected, !isConnectionWarm, state == .recording, recoverFromExhaustedLease() { return }

        let leaseDayChanged = reason.localizedCaseInsensitiveContains("wrong_day")
        let requiresFreshLease = quotaExhausted || leaseDayChanged || leaseRejected
        accountCapture()
        closeConnection(keepLease: !requiresFreshLease)
        if isBusy {
            let message = Self.userFacingGatewayError(reason)
            // A partial correction is not a complete transcript. On failure,
            // preserve all received ASR instead, and retire the callback once.
            let recoveredText = preserveDraftOnDeparture ? rawText : ""
            let handler = finalHandler
            let completion = completionHandler
            let raw = rawText
            let owner = activeSessionID
            recordingCleanup(clearHandlers: true)
            failedSessionID = owner
            state = .failed(message)
            completion?(VoiceInputCompletion(text: raw, rawText: raw, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
        }
        guard warmConnectionDesired else { return }
        if standbySession != nil {
            // The replacement is (or will soon be) ready; use it instead.
            promoteStandbyIfPossible()
            return
        }
        // Only well-understood lease turnovers retry immediately; any other
        // rejection gets a fresh lease with backoff so a misconfigured broker
        // can never cause a tight lease-issuance loop.
        scheduleReconnect(immediate: quotaExhausted || leaseDayChanged)
    }

    /// The broker or Head refused this particular lease (expired, revoked,
    /// unknown after a Head reset, or signed by a rotated key). Retrying the
    /// same lease can never succeed; a newly issued one can.
    static func isLeaseRejection(_ reason: String) -> Bool {
        [
            "lease_expired", "lease_revoked", "not_found", "bad_signature",
            "malformed_lease", "not_yet_valid", "authorization_expired",
            "wrong_user", "wrong_device",
        ].contains { reason.localizedCaseInsensitiveContains($0) }
    }

    /// Broker `quota_exhausted` means this signed lease's rolling allowance was
    /// consumed. It is distinct from Head denying a replacement lease because
    /// the account's daily quota is exhausted. Preserve the user's active
    /// recording intent while a fresh lease and warm connection are acquired.
    private func recoverFromExhaustedLease() -> Bool {
        switch state {
        case .recording, .obtainingLease:
            guard leaseRolloverAttempt < Self.maxLeaseRolloverAttempts else { return false }
            leaseRolloverAttempt += 1
            accountCapture()
            checkpointCurrentRawSegment()
            closeConnection(keepLease: false)
            state = .obtainingLease
            metricStart = .now
            KLog.d("🎙️ [voice] stage=lease-rollover attempt=\(leaseRolloverAttempt) standby=\(standbyAuthorized ? "ready" : standbySession != nil ? "warming" : "none")")
            if standbySession != nil {
                // Pre-warmed: continue on it at once (or as soon as it authorizes).
                promoteStandbyIfPossible()
            } else if standbyRequested {
                // Its lease is on the way; receiveLease opens it as current.
                standbyRequested = false
            } else if warmConnectionDesired {
                scheduleReconnect(immediate: true)
            }
            return true

        case .finishing:
            let recoveredText = rawText
            let handler = finalHandler
            let completion = completionHandler
            closeConnection(keepLease: false)
            recordingCleanup(clearHandlers: true)
            state = .idle
            completion?(VoiceInputCompletion(text: recoveredText, rawText: recoveredText, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
            if warmConnectionDesired { scheduleReconnect(immediate: true) }
            return true

        case .requestingPermission:
            closeConnection(keepLease: false)
            if warmConnectionDesired { scheduleReconnect(immediate: true) }
            return true

        case .idle, .failed:
            closeConnection(keepLease: false)
            if warmConnectionDesired { scheduleReconnect(immediate: true) }
            return true
        }
    }

    private func checkpointCurrentRawSegment() {
        let currentConnectionText = VoiceDraftMerger.merge(
            existing: stableRawPrefix,
            final: currentRawSegment
        )
        rolloverRawPrefix = VoiceDraftMerger.merge(
            existing: rolloverRawPrefix,
            final: currentConnectionText
        )
        stableRawPrefix = ""
        currentRawSegment = ""
        rawText = rolloverRawPrefix
    }

    private func scheduleLeaseTimeout() {
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, self.leaseRequestInFlight else { return }
            self.leaseRequestInFlight = false
            if self.standbyRequested {
                self.standbyRequested = false
                self.blockStandby()
            }
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
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let nowDate = Date(timeIntervalSince1970: TimeInterval(now))
        let startOfToday = utc.startOfDay(for: nowDate)
        let nextDay = utc.date(byAdding: .day, value: 1, to: startOfToday)
            ?? nowDate.addingTimeInterval(86_400)
        let dayBoundaryDelay = max(1, Int(ceil(nextDay.timeIntervalSince(nowDate))) + 1)
        // Head caps leases at UTC midnight; renewing just before midnight
        // would only yield another lease ending at midnight. Renew after it.
        let endsWithDay = lease.payload.exp >= Int(nextDay.timeIntervalSince1970) - 150
        let expiryDelay = endsWithDay ? dayBoundaryDelay : max(1, lease.payload.exp - now - 60)
        let delay = min(expiryDelay, dayBoundaryDelay)
        refreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.warmConnectionDesired else { return }
            self.refreshLease()
        }
    }

    /// Expiry or a new UTC day: warm the replacement next to the current
    /// socket (which stays usable meanwhile) and swap when idle.
    private func refreshLease() {
        guard state == .idle || state.failedMessage != nil else {
            scheduleRefreshAfterRecording()
            return
        }
        if session == nil {
            closeConnection(keepLease: false)
            prepare()
            return
        }
        guard standbySession == nil, !leaseRequestInFlight else { return }
        KLog.d("🎙️ [voice] stage=lease-prefetch reason=refresh")
        if !requestLease(standby: true) { scheduleRefreshAfterRecording() }
    }

    private func scheduleRefreshAfterRecording() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self, self.warmConnectionDesired else { return }
            self.refreshLease()
        }
    }

    private func closeConnection(keepLease: Bool) {
        connectionGeneration = UUID()
        refreshTask?.cancel()
        refreshTask = nil
        session?.close()
        session = nil
        isConnectionWarm = false
        if keepLease {
            persistLease()
        } else {
            lease = nil
            leaseIdentity = nil
            leaseUsedSeconds = 0
            leaseStore.clear()
        }
    }

    private func resolvedFinalText(_ text: String, gatewayRawText: String?) -> String {
        let currentConnectionText: String
        if stableRawPrefix.isEmpty {
            currentConnectionText = text
        } else {
            let accumulatedText = VoiceDraftMerger.merge(
                existing: stableRawPrefix,
                final: currentRawSegment
            )
            let gatewayRawLength = gatewayRawText?.count ?? 0
            if text.count + 5 < accumulatedText.count,
               gatewayRawLength + 5 < accumulatedText.count {
                currentConnectionText = VoiceDraftMerger.merge(
                    existing: stableRawPrefix,
                    final: text
                )
            } else {
                currentConnectionText = text
            }
        }
        return VoiceDraftMerger.merge(
            existing: rolloverRawPrefix,
            final: currentConnectionText
        )
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
        let currentConnectionText = VoiceDraftMerger.merge(
            existing: stableRawPrefix,
            final: currentRawSegment
        )
        rawText = VoiceDraftMerger.merge(
            existing: rolloverRawPrefix,
            final: currentConnectionText
        )
        rawHandler?(rawText)
    }

    private static func sharedPrefixLength(_ lhs: String, _ rhs: String) -> Int {
        zip(lhs, rhs).prefix(while: ==).count
    }

    private func setCorrectionDelta(_ text: String) {
        guard state == .finishing, !text.isEmpty else { return }
        pendingCorrectionText = VoiceDraftMerger.merge(
            existing: rolloverRawPrefix,
            final: text
        )
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
        correctionHandler?(text)
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
        let owner = activeSessionID
        let completion = completionHandler
        let raw = rawText
        recordingCleanup(clearHandlers: true)
        failedSessionID = owner
        state = .failed(error.localizedDescription)
        completion?(VoiceInputCompletion(text: raw, rawText: raw, completed: false))
    }

    private func recordingCleanup(clearHandlers: Bool) {
        accountCapture()
        preserveDraftOnDeparture = false
        recordingGeneration = UUID()
        leaseRolloverAttempt = 0
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
            completionHandler = nil
            rawHandler = nil
            correctionHandler = nil
        }
        metricStart = nil
    }

    private func resetPresentation() {
        failedSessionID = nil
        rawText = ""
        stableRawPrefix = ""
        currentRawSegment = ""
        rolloverRawPrefix = ""
        correctionSource = ""
        correctionText = ""
        correctionSourceOffset = 0
        level = 0
        levels = Array(repeating: 0, count: 8)
    }

    private static func userFacingGatewayError(_ reason: String) -> String {
        let lower = reason.lowercased()
        if lower.contains("permission") { return VoiceInputError.microphoneDenied.localizedDescription }
        if lower.contains("audio input unavailable") {
            return VoiceInputError.microphoneUnavailable.localizedDescription
        }
        if lower.contains("quota") {
            return "The voice session couldn't be renewed. Please try again."
        }
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
