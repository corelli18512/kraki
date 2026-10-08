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
            // VoiceInputCore emits bounded, metadata-only diagnostics. Keep
            // these in ordinary Release too; never log transcript/provider text.
            log: { KLog.diag("🎙️ [voice-core] \($0)") },
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

/// The lease is a device-bound bearer credential (about a day long); keep it
/// in the Keychain, never synced or backed up.
final class KeychainVoiceLeaseStore: VoiceLeaseStore {
    /// Production apps keep the historical service name. Any other bundle
    /// (Dev, Diag, test scopes) gets its own item: a lease is bound to the
    /// Head that issued it, and reading another app's item makes macOS ask
    /// for the login keychain password because its ACL names that app.
    static let service: String = {
        let bundleID = Bundle.main.bundleIdentifier ?? ""
        switch bundleID {
        case "", "chat.kraki.ios", "chat.kraki.mac":
            return "chat.kraki.voice-lease"
        default:
            return "chat.kraki.voice-lease.\(bundleID)"
        }
    }()

    private let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KeychainVoiceLeaseStore.service,
        kSecAttrAccount as String: "current",
    ]

    #if os(macOS) && DEBUG
    // Ad-hoc signed Debug builds: see DevSecretFileStore.
    private static let devFileName = "voice-lease.json"
    #endif

    func load() -> StoredVoiceLease? {
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            guard let data = DevSecretFileStore.read(Self.devFileName) else { return nil }
            return try? JSONDecoder().decode(StoredVoiceLease.self, from: data)
        }
        #endif
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
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            DevSecretFileStore.write(data, name: Self.devFileName)
            return
        }
        #endif
        let update: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func clear() {
        #if os(macOS) && DEBUG
        if DevSecretFileStore.isEnabled {
            DevSecretFileStore.delete(Self.devFileName)
            return
        }
        #endif
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

#if DEBUG
/// Test hosts must not prompt for OS permission or touch real audio by default.
/// Ordinary Debug app launches are unaffected. Hardware acceptance is a separate,
/// explicit opt-in, never enabled by a unit-test scheme or CI.
enum NativeTestRuntime {
    static var isRunningTests: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["KRAKI_TEST_ISOLATION"] == "1"
            || env["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }

    /// Routine local test runs (no KRAKI_RUN_UI_TESTS=1): the hosting app
    /// must show nothing — no main window, Dock icon or menu bar item — and
    /// never activate, so it cannot take the developer's focus.
    static var isHeadlessTestHost: Bool {
        isRunningTests && ProcessInfo.processInfo.environment["KRAKI_RUN_UI_TESTS"] != "1"
    }

    static var allowsLiveAudio: Bool {
        !isRunningTests || ProcessInfo.processInfo.environment["KRAKI_ALLOW_TEST_MICROPHONE"] == "1"
    }
}

private struct IsolatedVoiceAudioPolicy: VoiceInputAudioPolicy {
    var permission: VoiceMicrophonePermission { .denied }
    var hasInputDevice: Bool { false }
    func requestPermission() async -> Bool { false }
    func activate() -> Bool { false }
    func deactivate() {}
}

private struct IsolatedVoiceSessionFactory: VoiceInputSessionFactory {
    func makeSession(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping (VoiceInputEvent) -> Void,
        onMetric: @escaping (VoiceInputMetric) -> Void
    ) -> VoiceInputSessionProtocol { IsolatedVoiceSession() }
}

private final class IsolatedVoiceSession: VoiceInputSessionProtocol {
    let correctionEnabled = false
    let pcmDumpPath: String? = nil
    func startCapture(context: [String: VoiceInputJSONValue], vocabulary: [String]) {}
    func stopCapture() {}
    func close() {}
}
#else
/// Release builds are never test hosts.
enum NativeTestRuntime {
    static let isRunningTests = false
    static let isHeadlessTestHost = false
    static let allowsLiveAudio = true
}
#endif

struct LiveVoiceInputAudioPolicy: VoiceInputAudioPolicy {
    var hasInputDevice: Bool {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return false }
        #endif
        return VoiceAudioInputAvailability.isAvailable
    }

    var permission: VoiceMicrophonePermission {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return .denied }
        #endif
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
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return false }
        #endif
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
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return }
        #endif
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
    /// How long a press waits for Kraki to reconnect before giving up.
    static var connectionWaitTimeout: TimeInterval = 20

    enum State: Equatable {
        case idle
        /// Pressed while Kraki is (re)connecting: the voice UI is shown and
        /// recording starts by itself once the connection is back.
        case waitingForConnection
        case requestingPermission
        case obtainingLease
        case recording
        case finishing
        case failed(String)
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { metrics.stateChanged(state.metricTag) } }
    }
    /// One summary per recording attempt (metadata only).
    @ObservationIgnored let metrics = VoiceTracker()
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
        if audioActivationInFlight { return true }
        switch state {
        case .waitingForConnection, .requestingPermission, .obtainingLease, .recording, .finishing:
            return true
        case .idle, .failed:
            return false
        }
    }

    private weak var host: KrakiVoiceInputHost?
    private let sessionFactory: VoiceInputSessionFactory
    private let audioPolicy: VoiceInputAudioPolicy
    /// AVAudioSession setCategory/setActive block for tens to hundreds of ms
    /// (diag: recording.begin was the longest main-thread stall, up to 507 ms).
    /// Both run here, off the main thread, on ONE serial queue so a release
    /// issued while activation is in flight still deactivates after it.
    @ObservationIgnored private let audioSessionQueue = DispatchQueue(
        label: "chat.kraki.voice.audio-session", qos: .userInitiated)

    /// The press is being turned into a recording while `state` still reads
    /// idle (activation used to block the main thread, so there was no such
    /// window): counts as busy so a second press cannot start alongside it.
    @ObservationIgnored private var audioActivationInFlight = false

    private func activateAudio() async -> Bool {
        let policy = audioPolicy
        return await withCheckedContinuation { continuation in
            audioSessionQueue.async { continuation.resume(returning: policy.activate()) }
        }
    }

    private func deactivateAudio() {
        let policy = audioPolicy
        audioSessionQueue.async { policy.deactivate() }
    }
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
    /// A renewal received while the current connection was in use; adopted
    /// as soon as no recording or transcript needs that connection.
    private var nextLease: (lease: VoiceLease, identity: VoiceConnectionIdentity)?
    private var renewalRequested = false

    private static let maxLeaseRolloverAttempts = 1

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

    #if DEBUG
    /// UI fixtures get neither a real microphone nor a warm broker WebSocket.
    /// Voice-specific tests inject their own deterministic factory/audio policy.
    static func isolatedForTesting() -> KrakiVoiceInputController {
        KrakiVoiceInputController(
            sessionFactory: IsolatedVoiceSessionFactory(),
            audioPolicy: IsolatedVoiceAudioPolicy()
        )
    }
    #endif

    func bind(host: KrakiVoiceInputHost) {
        self.host = host
    }

    /// A lease is a device credential, not a usage allowance: Head grants the
    /// audio budget incrementally on the broker connection, charged to the
    /// UTC day the audio is used. Only its signed validity window matters.
    static func isLeaseUsable(_ lease: VoiceLease, nowUnixSec: Int) -> Bool {
        lease.payload.exp > nowUnixSec + 5 && lease.payload.iat <= nowUnixSec + 30
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

    /// Ensure a signed and activated broker connection exists without touching
    /// microphone permission or the audio session. A lease kept from an
    /// earlier launch is used immediately, without waiting for Head.
    func prepare() {
        warmConnectionDesired = true
        guard audioPolicy.permission != .denied else { return }
        if lease == nil { restoreStoredLease() }

        // Head is authoritative once connected: another account, device or
        // broker (or voice switched off) invalidates everything held.
        if let host, host.voiceTransportReady, lease != nil || session != nil,
           hostIdentity == nil || hostIdentity != leaseIdentity {
            nextLease = nil
            abandonRecordingForIdentityChange()
            closeConnection(keepLease: false)
        }

        if session != nil {
            adoptNextLeaseIfIdle()
            return
        }
        if let next = nextLease {
            nextLease = nil
            adopt(next.lease, identity: next.identity)
        }
        guard !leaseRequestInFlight else { return }

        let now = Int(Date().timeIntervalSince1970)
        if let lease, let identity = leaseIdentity, Self.isLeaseUsable(lease, nowUnixSec: now) {
            openConnection(lease, identity: identity)
            return
        }
        if lease != nil { closeConnection(keepLease: false) }
        KLog.d("🎙️ [voice] stage=warm-lease-request")
        requestLease(renewal: false)
    }

    /// A recording started on a kept lease cannot continue once Head reports
    /// another account, device or broker (or voice switched off): end it,
    /// keeping whatever was already transcribed.
    private func abandonRecordingForIdentityChange() {
        guard isBusy else { return }
        KLog.d("🎙️ [voice] stage=identity-changed busy=1")
        let recoveredText = rawText
        let handler = finalHandler
        let completion = completionHandler
        let owner = activeSessionID
        recordingCleanup(clearHandlers: true)
        failedSessionID = owner
        metrics.cause("identity_changed")
        state = .failed(
            VoiceInputError.gateway("Voice input was reset for this account. Please try again.")
                .localizedDescription
        )
        completion?(VoiceInputCompletion(text: recoveredText, rawText: recoveredText, completed: false))
        if !recoveredText.isEmpty { handler?(recoveredText) }
    }

    /// Returns false when Head is not reachable yet (Head auth calls prepare).
    @discardableResult
    private func requestLease(renewal: Bool) -> Bool {
        #if KRAKI_DIAG
        KrakiDiag.record(.voice, session: activeSessionID, [.source: .tag(renewal ? "lease.renewal" : "lease.request")])
        #endif
        guard !leaseRequestInFlight, let host, let identity = hostIdentity,
              host.voiceTransportReady else { return false }
        leaseRequestInFlight = true
        renewalRequested = renewal
        guard host.requestVoiceLease(resource: identity.resource) else {
            leaseRequestInFlight = false
            renewalRequested = false
            if !renewal { scheduleReconnect() }
            return false
        }
        scheduleLeaseTimeout()
        return true
    }

    private func restoreStoredLease() {
        guard let stored = leaseStore.load() else { return }
        guard Self.isLeaseUsable(stored.lease, nowUnixSec: Int(Date().timeIntervalSince1970)) else {
            leaseStore.clear()
            return
        }
        lease = stored.lease
        leaseIdentity = stored.identity
        KLog.d("🎙️ [voice] stage=lease-restored")
    }

    private func adopt(_ newLease: VoiceLease, identity: VoiceConnectionIdentity) {
        lease = newLease
        leaseIdentity = identity
        leaseStore.save(StoredVoiceLease(lease: newLease, identity: identity))
    }

    /// Switch to a renewed lease while nothing is using the connection. A
    /// press during the short re-authorization still records immediately
    /// (audio is buffered until the new connection is authorized).
    private func adoptNextLeaseIfIdle() {
        guard let next = nextLease else { return }
        switch state {
        case .recording, .finishing, .waitingForConnection, .requestingPermission, .obtainingLease:
            return
        case .idle, .failed:
            break
        }
        nextLease = nil
        KLog.d("🎙️ [voice] stage=lease-renewed jti=\(next.lease.payload.jti.prefix(8))")
        closeConnection(keepLease: true)
        adopt(next.lease, identity: next.identity)
        openConnection(next.lease, identity: next.identity)
    }

    /// A recording and its transcript are done with the connection.
    private func didFinishUsingConnection() {
        adoptNextLeaseIfIdle()
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
        renewalRequested = false
        closeConnection(keepLease: true)
        if let next = nextLease {
            nextLease = nil
            adopt(next.lease, identity: next.identity)
        }
        recordingCleanup(clearHandlers: true)
        metrics.outcome(.suspended)
        state = .idle
    }

    /// Sign-out: nothing of this identity may survive, including the stored lease.
    func forgetLease() {
        suspendWarmConnection()
        nextLease = nil
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
        guard !audioActivationInFlight else { return }
        #if KRAKI_DIAG
        KrakiDiag.record(.voice, session: sessionID, [.source: .tag("recording.begin")])
        #endif
        metrics.begin(warm: isConnectionWarm, correctionEnabled: VoiceInputSettings.correctionEnabled)
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
        // one has to wait for Head to issue a lease. Like a phone call app,
        // a press while Kraki is reconnecting is not an error: show the
        // voice UI as "Connecting…" and start once the connection is back.
        if session == nil, host?.voiceTransportReady != true {
            state = .waitingForConnection
            KLog.d("🎙️ [voice] stage=wait-connection session=\(sessionID.prefix(12))")
            let deadline = Date().addingTimeInterval(Self.connectionWaitTimeout)
            while self.host?.voiceTransportReady != true {
                try? await Task.sleep(for: .milliseconds(100))
                guard recordingGeneration == currentRecording else { return }
                if Date() >= deadline {
                    failRecording(VoiceInputError.offline, closeTransport: false)
                    return
                }
            }
            // A warm connection may have opened while waiting.
            KLog.d("🎙️ [voice] stage=connected-after-wait session=\(sessionID.prefix(12))")
        }
        guard let host, host.voiceCapability != nil || session != nil else {
            failRecording(VoiceInputError.unavailable, closeTransport: false)
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
        audioActivationInFlight = true
        let activated = await activateAudio()
        audioActivationInFlight = false
        guard recordingGeneration == currentRecording else {
            // Released/cancelled meanwhile: never leave a record session active
            // (it interrupts or ducks other audio) unless a newer recording owns it.
            if activated, !isBusy { deactivateAudio() }
            return
        }
        guard activated else {
            failRecording(
                VoiceInputError.gateway("The microphone audio session couldn't be started."),
                closeTransport: false
            )
            return
        }

        if let warm = session, warm.correctionEnabled != VoiceInputSettings.correctionEnabled {
            // The correction setting changed since this connection opened:
            // reopen with the new one (the lease is kept).
            closeConnection(keepLease: true)
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
        #if KRAKI_DIAG
        KrakiDiag.record(.voice, session: activeSessionID, [.source: .tag("recording.finish"), .textLength: .int(rawText.utf8.count)])
        #endif
        correctionSource = rawText
        correctionText = ""
        correctionSourceOffset = 0
        pendingCorrectionText = nil
        correctionDisplayTask?.cancel()
        correctionDisplayTask = nil
        state = .finishing
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
        case .waitingForConnection, .requestingPermission, .obtainingLease:
            // Do not start the microphone later in an invisible conversation.
            // Lease rollover may already hold speech from the prior segment.
            let recoveredText = rawText
            let handler = finalHandler
            let completion = completionHandler
            metrics.outcome(.departed)
            cancel()
            completion?(VoiceInputCompletion(text: recoveredText, rawText: recoveredText, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
        case .idle, .failed:
            break
        }
    }

    func cancel() {
        #if KRAKI_DIAG
        KrakiDiag.record(.voice, session: activeSessionID, [.source: .tag("recording.cancel")])
        #endif
        closeConnection(keepLease: true)
        recordingCleanup(clearHandlers: true)
        metrics.outcome(.cancelled, overwrite: false)
        state = .idle
        if warmConnectionDesired { scheduleReconnect(immediate: true) }
    }

    /// Settings → Voice Input changed. An idle warm connection opened with the
    /// other correction setting is reopened now, so the next press is fast.
    func applySettings() {
        guard !isBusy, let warm = session, warm.correctionEnabled != VoiceInputSettings.correctionEnabled else { return }
        closeConnection(keepLease: true)
        if warmConnectionDesired { prepare() }
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
        let renewal = renewalRequested && session != nil
        renewalRequested = false
        KLog.d("🎙️ [voice] stage=lease-granted renewal=\(renewal ? 1 : 0)")
        if renewal {
            nextLease = (lease, identity)
            adoptNextLeaseIfIdle()
            return
        }
        adopt(lease, identity: identity)
        openConnection(lease, identity: identity)
    }

    func receiveLeaseDenied(reason: VoiceLeaseDeniedReason, detail: String?) {
        guard leaseRequestInFlight else { return }
        leaseRequestInFlight = false
        leaseTimeoutTask?.cancel()
        leaseTimeoutTask = nil
        let renewal = renewalRequested
        renewalRequested = false
        if state == .obtainingLease {
            failRecording(VoiceInputError.leaseDenied(reason, detail), closeTransport: false)
        } else if renewal {
            // The current lease is still valid; try again later.
            scheduleRefresh(retry: true)
        } else if reason != .quotaExhausted {
            scheduleReconnect()
        }
    }

    private func connectionConfiguration(_ lease: VoiceLease, identity: VoiceConnectionIdentity) -> VoiceInputConfiguration? {
        guard let gatewayURL = URL(string: identity.brokerUrl) else { return nil }
        return VoiceInputConfiguration(
            gatewayURL: gatewayURL,
            userID: identity.userID,
            correctionEnabled: VoiceInputSettings.correctionEnabled,
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

    private func openConnection(_ lease: VoiceLease, identity: VoiceConnectionIdentity) {
        guard session == nil,
              let configuration = connectionConfiguration(lease, identity: identity) else { return }
        isConnectionWarm = false
        connectionGeneration = UUID()
        let current = connectionGeneration
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
        guard let session, let context else { return }
        state = .recording
        metricStart = .now
        KLog.d("🎙️ [voice] stage=recording warm=\(isConnectionWarm ? 1 : 0)")
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
            // Gateway contract: `rawText` accompanies the final only when the
            // corrector succeeded AND changed the text. Without it the final
            // *is* the complete raw ASR transcript: an unchanged correction, or
            // the gateway's fallback when the corrector failed (quota, timeout).
            // It is never a partial correction, so it is sent as is: a failed
            // correction must not stop the user's words from going out.
            // Whether a correction was actually applied is only reported.
            // (The gateway returns the corrector's output trimmed, while deltas
            // carry the untrimmed stream; compare trimmed forms.)
            let streamedFinal = (pendingCorrectionText ?? correctionText)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let correctionConfirmed = gatewayRawText?.isEmpty == false
                || (!streamedFinal.isEmpty
                    && streamedFinal == finalText.trimmingCharacters(in: .whitespacesAndNewlines))
            let completed = validFinal && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            metrics.finalReceived(textLength: finalText.utf8.count, correctionConfirmed: correctionConfirmed)
            if !correctionConfirmed {
                KLog.d("🎙️ [voice] stage=final correction=unconfirmed sending=raw")
            }
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
        KLog.diag("🎙️ [voice] stage=connection-failed cause=\(VoiceTracker.classify(gatewayReason: reason))")
        let quotaExhausted = reason.localizedCaseInsensitiveContains("quota_exhausted")
        let leaseDayChanged = reason.localizedCaseInsensitiveContains("wrong_day")
        let leaseRejected = Self.isLeaseRejection(reason) || leaseDayChanged
        // Rolling over keeps an authorized recording going. Before
        // authorization, buffered speech is gone with the socket: fail
        // visibly (below) rather than continue with its beginning missing.
        let bufferedSpeechLost = !isConnectionWarm && (state == .recording || state == .finishing)
        if quotaExhausted, !bufferedSpeechLost, recoverFromExhaustedLease() { return }

        let requiresFreshLease = quotaExhausted || leaseRejected
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
            metrics.cause(VoiceTracker.classify(gatewayReason: reason))
            state = .failed(message)
            completion?(VoiceInputCompletion(text: raw, rawText: raw, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
        }
        guard warmConnectionDesired else { return }
        if nextLease != nil {
            prepare()
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
            metrics.rollover()
            checkpointCurrentRawSegment()
            closeConnection(keepLease: false)
            state = .obtainingLease
            metricStart = .now
            KLog.d("🎙️ [voice] stage=lease-rollover attempt=\(leaseRolloverAttempt)")
            if let next = nextLease {
                nextLease = nil
                adopt(next.lease, identity: next.identity)
                openConnection(next.lease, identity: next.identity)
            } else if renewalRequested {
                // Its lease is on the way; receiveLease opens it as current.
                renewalRequested = false
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
            // The quota ran out while finishing: the raw draft is kept.
            metrics.cause("quota")
            metrics.outcome(.ended)
            state = .idle
            completion?(VoiceInputCompletion(text: recoveredText, rawText: recoveredText, completed: false))
            if !recoveredText.isEmpty { handler?(recoveredText) }
            if warmConnectionDesired { scheduleReconnect(immediate: true) }
            return true

        case .waitingForConnection, .requestingPermission:
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
            if self.renewalRequested {
                self.renewalRequested = false
                self.scheduleRefresh(retry: true)
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

    /// Renew well before expiry, at an idle moment, so a renewal never
    /// interrupts speech. Nothing happens at UTC midnight: usage is charged
    /// by Head to the day it happens, independent of the lease.
    private func scheduleRefresh(retry: Bool = false) {
        refreshTask?.cancel()
        guard let lease else { return }
        let now = Int(Date().timeIntervalSince1970)
        let lifetime = max(60, lease.payload.exp - lease.payload.iat)
        let lead = min(3600, lifetime / 4)
        var delay = max(1, lease.payload.exp - now - lead)
        if retry { delay = min(delay, 300) }
        refreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.warmConnectionDesired else { return }
            self.refreshLease()
        }
    }

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
        guard nextLease == nil, !leaseRequestInFlight else { return }
        KLog.d("🎙️ [voice] stage=lease-renewal")
        if !requestLease(renewal: true) { scheduleRefresh(retry: true) }
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
        if !keepLease {
            lease = nil
            leaseIdentity = nil
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

        // Edit distance between the corrected text and every raw prefix,
        // computed only in a band around the diagonal: a correction moves
        // text by far less than `band` characters, and the full O(n·m) table
        // ran on every correction delta (16 ms cadence), ~1M operations per
        // frame for long dictations.
        let n = normalizedRaw.count
        let band = 128
        let infinity = Int.max / 4
        var previous = [Int](repeating: infinity, count: n + 1)
        for j in 0...min(n, band) { previous[j] = j }
        for (index, correctedCharacter) in normalizedCorrected.enumerated() {
            let row = index + 1
            var current = [Int](repeating: infinity, count: n + 1)
            let lower = max(1, row - band)
            let upper = min(n, row + band)
            if row <= band { current[0] = row }
            if lower <= upper {
                for rawIndex in lower...upper {
                    let substitution = previous[rawIndex - 1]
                        + (correctedCharacter == normalizedRaw[rawIndex - 1] ? 0 : 1)
                    current[rawIndex] = min(
                        previous[rawIndex] + 1,
                        current[rawIndex - 1] + 1,
                        substitution
                    )
                }
            }
            previous = current
        }
        let bestCost = previous.min() ?? 0
        let normalizedOffset = previous.indices.last(where: { previous[$0] == bestCost }) ?? 0
        guard normalizedOffset > 0 else { return 0 }
        return rawIndices[normalizedOffset - 1] + 1
    }

    private func failRecording(_ error: VoiceInputError, closeTransport: Bool) {
        KLog.diag("🎙️ [voice] stage=failed cause=\(error.metricCause)")
        if closeTransport { closeConnection(keepLease: true) }
        let owner = activeSessionID
        let completion = completionHandler
        let raw = rawText
        recordingCleanup(clearHandlers: true)
        failedSessionID = owner
        metrics.cause(error.metricCause)
        state = .failed(error.localizedDescription)
        completion?(VoiceInputCompletion(text: raw, rawText: raw, completed: false))
    }

    private func recordingCleanup(clearHandlers: Bool) {
        preserveDraftOnDeparture = false
        recordingGeneration = UUID()
        leaseRolloverAttempt = 0
        correctionDisplayTask?.cancel()
        correctionDisplayTask = nil
        pendingCorrectionText = nil
        deactivateAudio()
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
        if lower.contains("audio capture stalled") {
            return "The microphone stopped providing audio. Please try again."
        }
        if lower.contains("audio input changed") || lower.contains("audio input format") {
            return "The audio input changed during recording. Please try again."
        }
        if lower.contains("voice upload") {
            return "Voice audio couldn't be uploaded. Check your connection and try again."
        }
        if lower.contains("asr closed without final") || lower.contains("asr_closed_without_final") {
            return "Speech recognition ended before returning a transcript. Please try again."
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

    var metricTag: String {
        switch self {
        case .idle: return "idle"
        case .waitingForConnection: return "waitingForConnection"
        case .requestingPermission: return "requestingPermission"
        case .obtainingLease: return "obtainingLease"
        case .recording: return "recording"
        case .finishing: return "finishing"
        case .failed: return "failed"
        }
    }
}

extension VoiceInputError {
    /// Coarse failure class for voice summaries (never the message text).
    var metricCause: String {
        switch self {
        case .unavailable: return "unavailable"
        case .invalidBrokerURL: return "config"
        case .offline: return "offline"
        case .microphoneDenied: return "permission"
        case .microphoneUnavailable: return "mic_unavailable"
        case .leaseInFlight: return "lease_busy"
        case .leaseTimedOut: return "lease_timeout"
        case .leaseDenied(let reason, _): return "lease_denied_\(reason.rawValue)"
        case .gateway(let reason):
            return reason.localizedCaseInsensitiveContains("audio session")
                ? "audio_session" : VoiceTracker.classify(gatewayReason: reason)
        }
    }
}
