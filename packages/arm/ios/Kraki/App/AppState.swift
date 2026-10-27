import SwiftUI
import Observation

/// Central app state that coordinates all stores and the network layer.
@Observable
final class AppState {
    // MARK: - Stores
    let sessionStore: SessionStore
    let deviceStore: DeviceStore
    let messageDatabase: MessageDatabase
    let messageStore: MessageStore
    /// Disk-backed cache + chunk reassembly for ContentRef attachments
    /// (tool args/result, agent images). iOS-only: the macOS target does not
    /// yet run the attachment-pull pipeline, so the property is nil there.
    private(set) var attachmentStore: AttachmentStore!

    // MARK: - Networking
    private(set) var wsClient: WebSocketClient?
    private(set) var authManager: AuthManager?
    var messageRouter: MessageRouter?
    private(set) var commandSender: CommandSender?
    private(set) var messageProvider: MessageProvider?
    #if DEBUG
    /// Isolated native-page harness hook. When installed, real CommandSender
    /// commands are handed to the harness instead of encryption/Relay I/O.
    /// Ordinary Debug and all Release builds leave this nil.
    @ObservationIgnored var testOutboundMessageHandler: (([String: Any], String?, Bool) -> Bool)?
    #endif
    /// Test-only injection point (headless e2e self-test seeds a provider
    /// without going through the full network setup).
    @MainActor func setMessageProviderForTesting(_ provider: MessageProvider) {
        self.messageProvider = provider
    }
    #if os(iOS)
    private(set) var pushManager: PushManager?
    #endif
    /// Replaced only by the network harness: several harnesses in one test
    /// process must not share UserDefaults.standard.
    private(set) var voiceVocabularyStore = VoiceVocabularyStore()
    private(set) var preferencesManager: PreferencesManager?
    private(set) var pulseManager: PulseManager?
    #if os(macOS)
    /// Direct loopback route to the Tentacle on this Mac (POC). Nil in tests.
    @ObservationIgnored private(set) var localLink: LocalLinkClient?
    #endif
    var sessionSubscriptionController: SessionSubscriptionController!
    /// Region-advertised voice capability from the latest authenticated
    /// handshake. Nil means the microphone affordance stays hidden.
    var voiceCapability: VoiceCapability?
    @ObservationIgnored private(set) var voiceInputController: KrakiVoiceInputController
    @ObservationIgnored lazy var iosVoiceComposer = IOSVoiceComposer(host: self)
    #if os(iOS)
    /// Lets a sent voice message finish its correction after the app is
    /// backgrounded instead of failing it at once (see BackgroundVoiceFinisher).
    @ObservationIgnored var backgroundVoiceClientID: String?
    @ObservationIgnored lazy var backgroundVoiceFinisher = BackgroundVoiceFinisher(hooks: .init(
        isFinishing: { [weak self] in
            if case .staged = self?.iosVoiceComposer.operation?.phase { return true }
            return false
        },
        isDelivered: { [weak self] in
            guard let self, let id = self.backgroundVoiceClientID, let sender = self.commandSender else { return true }
            guard let message = sender.outbox.values.lazy.compactMap({ $0[id] }).first else { return true } // echoed
            return sender.pendingState(message) == .failed
        },
        retire: { [weak self] in self?.iosVoiceComposer.retireKeepingDraft() },
        teardown: { [weak self] in
            self?.backgroundVoiceClientID = nil
            guard self?.isInBackground == true else { return }
            self?.tearDownForBackground()
        },
        beginTask: { expired in
            let id = UIApplication.shared.beginBackgroundTask(withName: "KrakiVoiceFinish", expirationHandler: expired)
            return id == .invalid ? nil : id.rawValue
        },
        endTask: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) }
    ))

    @ObservationIgnored lazy var backgroundSocketGrace = makeBackgroundSocketGrace()
    #endif

    /// The durable outbox lives next to the message database, so each app
    /// flavor (Release / Dev / isolated KRAKI_DATA_DIR test instances) has its
    /// own. (Application Support is shared on unsandboxed macOS.)
    static func pendingOutboxURL() -> URL {
        let url = KrakiDataPaths.persistentDirectory().appendingPathComponent("kraki-pending-outbox.json")
        #if os(iOS)
        // 0.1.2–0.1.3 stored it at the Application Support root (per-app on iOS).
        let fm = FileManager.default
        if let legacy = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("kraki-pending-outbox.json"),
           fm.fileExists(atPath: legacy.path), !fm.fileExists(atPath: url.path) {
            try? fm.moveItem(at: legacy, to: url)
        }
        #endif
        return url
    }

    init() {
        self.sessionStore = SessionStore()
        self.deviceStore = DeviceStore()
        // The message DB caches chat history that Tentacle replay can
        // rebuild, so an unusable file is recreated rather than crashing
        // every launch (see MessageDatabase.openRecovering).
        self.messageDatabase = MessageDatabase.openRecovering()
        self.messageStore = MessageStore(db: messageDatabase)
        // The Keychain-kept lease lets a cold start warm the voice socket
        // in parallel with Head auth instead of after it.
        self.voiceInputController = KrakiVoiceInputController(leaseStore: KeychainVoiceLeaseStore())
        self.voiceInputController.bind(host: self)
        // attachmentStore is set up after the DB-backed stores so the
        // request-pull closure can capture self by weak reference
        // and the rest of setup (router, ws) can read it.
        self.attachmentStore = Self.makeAttachmentStore(for: self)
        bindStores()
        setupNetworking()

        // App-termination flush. SwiftUI's `scenePhase` already drives
        // `handleBackground` (which flushes both stores) when the user
        // sends the app to background — that's the common case. But if
        // the system terminates a backgrounded app while WebSocket
        // background-execution mutations are still happening (e.g. a
        // push that lands in the brief window after scenePhase fires
        // but before suspension completes), `applicationWillTerminate`
        // gives us one last chance to land those mutations on disk.
        // Cheap insurance; KrakiApp's UIApplicationDelegateAdaptor
        // ensures the notification is delivered on the main thread.
        #if os(iOS)
        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            KLog.chat("📂 [snapshot] willTerminate: flushing both stores")
            self?.sessionStore.flushCache()
            self?.deviceStore.flushCache()
        }
        #endif
    }

    /// Paced attachment transfers through this app's encrypted channel.
    /// (Used by the production init too, so it must not be DEBUG-only.)
    /// Cross-store links that need a fully initialized AppState.
    private func bindStores() {
        sessionStore.isDeviceStillPaired = DeviceTrustInbound.ownershipRule(deviceStore)
    }

    static func makeAttachmentStore(for state: AppState) -> AttachmentStore {
        AttachmentStore { [weak state] id, sessionId, index in
            guard let state else { return false }
            return state.sendEncryptedMessage([
                "type": "request_attachment",
                "deviceId": state.deviceId ?? "",
                "sessionId": sessionId,
                "payload": ["id": id, "sessionId": sessionId, "mode": "paced", "index": index],
            ])
        }
    }

    #if DEBUG
    /// The XCTest host itself must not initialize the user's database, Keychain,
    /// network graph or audio before the individual test fixtures are created.

    /// Real networking (WebSocket, auth, Pulse, CommandSender) with an
    /// isolated database, outbox and process-local open-auth identity, for
    /// resilience tests against a local stack. Never production credentials.
    @MainActor
    static func makeNetworkHarness(relayPort: Int, outboxURL: URL? = nil, vocabularyDefaults: UserDefaults? = nil) -> AppState {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-net-harness-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let state: AppState
        do {
            state = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite")))
        } catch {
            fatalError("Failed to create network harness: \(error)")
        }
        state.hasCompletedInitialConnect = false
        state.attachmentStore = makeAttachmentStore(for: state)
        if let vocabularyDefaults { state.voiceVocabularyStore = VoiceVocabularyStore(defaults: vocabularyDefaults) }
        state.setupNetworking(outboxURL: outboxURL ?? root.appendingPathComponent("outbox.json"))
        #if os(macOS)
        state.authManager?.useEphemeralKeysForCurrentProcess()
        #endif
        state.devConnect(port: relayPort)
        return state
    }

    static func makeUnitTestHost() -> AppState {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-unit-host-\(UUID().uuidString)", isDirectory: true)
        do {
            return AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite")))
        } catch {
            fatalError("Failed to create isolated unit-test host: \(error)")
        }
    }

    /// Fully isolated app graph for native Chat snapshot/alignment harnesses.
    /// It uses the real stores/provider/command/subscription objects but omits
    /// Keychain access, auth and WebSocket setup, so production UI can run
    /// unchanged against a static temporary database without side effects.
    init(testDatabase: MessageDatabase, loadPersistedState: Bool = false, voiceController: KrakiVoiceInputController? = nil) {
        self.sessionStore = SessionStore(persistenceEnabled: loadPersistedState)
        self.deviceStore = DeviceStore(persistenceEnabled: loadPersistedState)
        self.messageDatabase = testDatabase
        self.messageStore = MessageStore(db: testDatabase)
        self.voiceInputController = voiceController ?? KrakiVoiceInputController.isolatedForTesting()
        #if os(macOS)
        self.signedOutDefaults = UserDefaults(suiteName: "kraki-test-\(UUID().uuidString)") ?? .standard
        #endif
        if voiceController == nil { self.voiceInputController.bind(host: self) }
        self.attachmentStore = AttachmentStore { _, _, _ in true }
        self.commandSender = CommandSender(appState: self)
        self.messageProvider = MessageProvider(appState: self)
        self.messageRouter = MessageRouter(appState: self)
        self.pulseManager = PulseManager(host: self)
        self.sessionSubscriptionController = SessionSubscriptionController(host: self)
        self.hasStoredCredentials = true
        self.hasCompletedInitialConnect = true
        self.connectionStatus = .disconnected
        bindStores()
    }

    #if os(macOS)
    /// Tests: a local link (no socket) that claims to serve `tentacleId`.
    func linkLocallyForTesting(_ tentacleId: String?) {
        let link = localLink ?? LocalLinkClient(appState: self)
        link.debugSetLinked(tentacleId)
        localLink = link
    }
    #endif
    #endif

    // MARK: - Connection
    var connectionStatus: ConnectionStatus = .awaitingLogin {
        didSet {
            guard connectionStatus != oldValue else { return }
            #if os(macOS)
            if connectionStatus == .connected {
                authRecoveryAttempts = 0
                notConnectedSince = nil
            } else if notConnectedSince == nil {
                notConnectedSince = Date()
            }
            #endif
            if connectionStatus == .connected {
                // Anything still waiting for its echo is re-sent on the new
                // connection (idempotent by clientId in Tentacle).
                commandSender?.resendPendingInputs(reason: "reconnected")
            } else {
                deviceStore.interruptUsageRefreshes()
            }
            updateReconnectingIndicator()
            guard let store = attachmentStore else { return }
            let ready = connectionStatus == .connected
            if Thread.isMainThread {
                MainActor.assumeIsolated { store.setTransportReady(ready) }
            } else {
                Task { @MainActor in store.setTransportReady(ready) }
            }
        }
    }
    var deviceId: String?
    var user: UserInfo?

    /// Read receipts require both a selected conversation and an actually
    /// visible foreground surface. Selection alone is not proof the user saw
    /// an update (for example a minimized/background Mac window).
    #if os(macOS)
    var isAppForeground: Bool = false
    var isConversationWindowVisible: Bool = false
    #else
    var isAppForeground: Bool = true
    var isConversationWindowVisible: Bool = true
    #endif

    func isActivelyViewingSession(_ sessionId: String) -> Bool {
        isAppForeground
            && isConversationWindowVisible
            && sessionStore.activeSessionId == sessionId
    }

    /// Shared automatic Read gate for lifecycle hooks and live Spine events.
    /// Manual Mark Unread suppresses this path until the user leaves/re-enters
    /// the Session or explicitly marks it read.
    func markSessionReadIfVisible(_ sessionId: String, seq: Int? = nil) {
        guard isActivelyViewingSession(sessionId),
              !sessionStore.isAutoReadSuppressed(sessionId),
              let session = sessionStore.sessions[sessionId] else { return }
        let target = seq ?? session.lastSeq
        guard target > 0 else { return }
        sessionStore.observeLastSeq(sessionId, seq: target)
        commandSender?.markRead(sessionId: sessionId, seq: target, automatic: true)
    }

    func beginViewingSession(_ sessionId: String) {
        if sessionStore.activeSessionId != sessionId {
            sessionStore.allowAutoRead(sessionId)
            stability.conversationOpened(
                sessionId: sessionId,
                lastSeq: sessionStore.sessions[sessionId]?.lastSeq ?? 0,
                localSeq: messageStore.persistedHead(sessionId),
                online: connectionStatus == .connected
            )
        }
        sessionStore.activeSessionId = sessionId
        if isAppForeground && isConversationWindowVisible {
            SessionNotifications.removeDelivered(forSession: sessionId)
        }
    }

    #if os(macOS)
    /// Auth and sign-out run on the main thread; run MacNotifications work
    /// synchronously there so a sign-out unregister goes out before the
    /// socket closes, and hop to the main actor otherwise.
    static func onMacNotificationsMain(_ work: @escaping @MainActor (MacNotifications) -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { work(MacNotifications.shared) }
        } else {
            Task { @MainActor in work(MacNotifications.shared) }
        }
    }
    #endif

    func endViewingSession(_ sessionId: String) {
        sessionStore.allowAutoRead(sessionId)
        if sessionStore.activeSessionId == sessionId {
            sessionStore.activeSessionId = nil
        }
    }

    @ObservationIgnored lazy var foregroundActivity = ForegroundActivityReporter(
        eligible: { [weak self] in self?.isAppForeground == true && self?.connectionStatus == .connected },
        platformActive: AppState.isPlatformActiveForActivityReporting,
        send: { [weak self] in self?.wsClient?.sendRaw(#"{"type":"ping","foreground":true}"#, queueOnFailure: false) }
    )

    /// macOS dev-local mode: connected to a local `pnpm dev` relay with no
    /// login. Gating for the welcome screen / sidebar. iOS is always
    /// authenticated and does not set this.
    #if os(macOS)
    var devLocalActive: Bool = false
    #endif

    /// Persistence is isolated by app identity on macOS so the stable Prod
    /// app and the local Debug app can run against the same relay concurrently.
    static let sharedDefaults: UserDefaults = {
        #if KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY && os(iOS)
        return UserDefaults(suiteName: "group.chat.kraki.ios.diag") ?? .standard
        #elseif KRAKI_DIAG && !KRAKI_DIAG_EXISTING_IDENTITY
        return .standard
        #elseif os(macOS)
        #if DEBUG
        return UserDefaults(suiteName: "chat.kraki.mac.dev") ?? .standard
        #else
        return UserDefaults(suiteName: "chat.kraki.mac") ?? .standard
        #endif
        #else
        return UserDefaults(suiteName: "group.chat.kraki.ios") ?? .standard
        #endif
    }()
    /// Key for the persisted relay URL. Set after a successful auth or a
    /// `wrong_region` redirect so we can skip the redirect dance on cold launch.
    static let relayURLKey = "kraki.relayURL"

    static let defaultRelayURL = "wss://relay.kraki.chat"

    /// The relay URL the app will connect to.
    ///
    /// Priority order:
    ///   1. Persisted URL in shared defaults (set after a successful
    ///      auth or `wrong_region` redirect). Must be `wss://` — any
    ///      other scheme (notably `ws://localhost` from a previous
    ///      `devConnect()`) is discarded so a stale dev value doesn't
    ///      strand us on a non-existent local relay, especially on a
    ///      physical device.
    ///   2. `KRAKI_RELAY_URL` env var (DEBUG only; escape hatch for
    ///      pointing a debug build at a non-default relay, e.g. a
    ///      local dev relay — set in the Xcode scheme's Run >
    ///      Environment Variables). Ignored in release.
    ///   3. `defaultRelayURL` (prod relay).
    private static func resolveDefaultRelayURL() -> String {
        if let persisted = AppState.sharedDefaults.string(forKey: AppState.relayURLKey) {
            // Only honour persisted URLs that look like a real prod
            // region (`wss://…`). A `ws://localhost` value can only
            // come from `devConnect()` on the simulator and is
            // meaningless on a physical device — if such a value
            // somehow survives a Debug→install cycle on a real phone
            // we want to fall back to the prod default, not silently
            // keep dialling localhost forever.
            if persisted.hasPrefix("wss://") {
                return persisted
            }
            AppState.sharedDefaults.removeObject(forKey: AppState.relayURLKey)
        }
        #if DEBUG
        if let env = ProcessInfo.processInfo.environment["KRAKI_RELAY_URL"], !env.isEmpty {
            return env
        }
        #endif
        return defaultRelayURL
    }

    var relayURL: String = AppState.resolveDefaultRelayURL()
    var githubClientId: String?
    var relayVersion: String?
    /// `auth_ok.features` of the current relay connection.
    @ObservationIgnored var relayFeatures: Set<String> = []
    var lastError: String?
    /// Progress of a "Delete Account" request from this device.
    var accountDeletion: AccountDeletionState = .idle
    @ObservationIgnored var accountDeletionAttempt: UUID?
    @ObservationIgnored var accountDeletedHandled = false
    /// Shown on the sign-in screen after the account was deleted.
    var accountDeletedNotice = false
    #if os(macOS)
    /// Kraki for Mac turns its built-in Kraki off when the account is deleted.
    @ObservationIgnored var onAccountDeleted: (() -> Void)?
    #endif
    /// 0 means "no reconnect in progress". Incremented by the WS client
    /// on every retry; reset to 0 on a successful connect.
    var reconnectAttempt: Int = 0
    /// Set once after the first successful auth handshake. Survives any
    /// subsequent mid-session disconnect so the UI doesn't bounce back
    /// to the login screen — instead we surface status ambiently in
    /// the brand header.
    var hasCompletedInitialConnect: Bool = false

    /// True when we have credentials stored in the keychain that
    /// haven't been explicitly cleared. Set by `AuthManager` on
    /// successful sign-in and cleared on sign-out. Lets the UI keep
    /// the user "signed in" across cold launches before the WS
    /// handshake completes.
    var hasStoredCredentials: Bool = false

    /// A scanned/opened pairing link waiting for the user's decision
    /// (untrusted relay, or this phone is already connected).
    var pendingPairingPrompt: PairingLinkPrompt?
    /// Key-mismatch warnings the user has already dismissed.
    var acknowledgedKeyWarnings: Set<String> = []

    /// A computer-key warning to show (D4), if any is unacknowledged.
    var keyWarning: (ids: Set<String>, message: String)? {
        let open = deviceStore.keyMismatchDeviceIds.subtracting(acknowledgedKeyWarnings)
        guard !open.isEmpty else { return nil }
        if open.contains(DeviceStore.unmatchedQRMarker) {
            return (open, String(localized: "The relay did not report the computer whose code you scanned with a matching key. Messages are only encrypted to keys Kraki trusts. If this keeps happening, contact support."))
        }
        let names = open.compactMap { deviceStore.devices[$0]?.name }.sorted().joined(separator: ", ")
        return (open, String(localized: "The relay reported a new encryption key for \(names.isEmpty ? String(localized: "a computer") : names). Kraki keeps using the key it trusted, so messages to that computer won't go through. If you reinstalled Kraki there, run `kraki connect` on it and scan the new code."))
    }

    /// True from the moment the user taps "Sign in with GitHub" until
    /// `ASWebAuthenticationSession`'s completion handler fires (success,
    /// error, or user cancel). Drives the LoginView's spinner so the
    /// tap doesn't appear unresponsive while the system browser sheet
    /// is materialising.
    var isOAuthInFlight: Bool = false

    /// True while the WS layer is actively trying to (re)connect after
    /// a drop, or sitting authenticated-pending-handshake. Used by the
    /// brand-header status indicator.
    var isReconnecting: Bool {
        // Closing the socket while in the background is intentional, not a
        // lost connection; foregrounding reconnects at once.
        if isInBackground { return false }
        switch connectionStatus {
        case .connecting, .authenticating, .disconnected:
            #if os(macOS)
            // The Mac shows its authenticated window as soon as it holds a
            // credential (before auth_ok). Until that first sign-in completes
            // the window must say so instead of looking connected-but-empty.
            return hasCompletedInitialConnect || isSigningInWithCredentials
            #else
            return hasCompletedInitialConnect
            #endif
        default:
            return false
        }
    }

    #if os(macOS)
    /// The launch coordinator is still choosing how to sign in.
    @ObservationIgnored var launchResolvingCredentials = false

    /// Holds a stored device or a CLI token, i.e. the window is past the
    /// login screen and a sign-in is expected to succeed.
    var isSigningInWithCredentials: Bool {
        hasStoredCredentials || authManager?.cliGitHubToken != nil
    }
    #endif

    /// User-facing connection notice for the Mac window (nil when online).
    var connectionNotice: String? {
        guard showsReconnecting, connectionStatus != .connected else { return nil }
        return hasCompletedInitialConnect ? String(localized: "Connecting…") : String(localized: "Signing in…")
    }

    /// Title-area status for an open conversation (nil = show its title).
    /// Reconnecting and catching up are silent elsewhere; this is the only
    /// place they surface, and only after they have lasted a moment.
    func conversationTitleStatus(syncing: Bool) -> String? {
        if showsReconnecting { return hasCompletedInitialConnect ? String(localized: "Connecting…") : String(localized: "Signing in…") }
        if syncing { return String(localized: "Syncing…") }
        return nil
    }

    /// What the UI shows: reconnecting only after it has lasted
    /// `reconnectingIndicatorDelay`, so sub-second blips (and a reconnect that
    /// the transport completes on its own quickly) never flash a warning.
    private(set) var showsReconnecting = false
    @ObservationIgnored private var reconnectingIndicatorWork: DispatchWorkItem?
    static let reconnectingIndicatorDelay: TimeInterval = 2

    func updateReconnectingIndicator() {
        guard isReconnecting else {
            reconnectingIndicatorWork?.cancel()
            reconnectingIndicatorWork = nil
            if showsReconnecting {
                showsReconnecting = false
                stability.reconnectingShown(false)
            }
            return
        }
        guard !showsReconnecting, reconnectingIndicatorWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reconnectingIndicatorWork = nil
            if self.isReconnecting {
                self.showsReconnecting = true
                self.stability.reconnectingShown(true)
            }
        }
        reconnectingIndicatorWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reconnectingIndicatorDelay, execute: work)
    }

    /// Opening and outage summaries (metadata only; see StabilityTracker).
    @ObservationIgnored let stability = StabilityTracker()
    @ObservationIgnored let sendMetrics = SendTracker()
    @ObservationIgnored private var pathObserver: NetworkPathObserver?
    @ObservationIgnored private let exitMarker = ForegroundExitMarker(defaults: .standard)


    /// The app leaves the screen in an orderly way (background, sleep, quit):
    /// the next launch will not report an unclean exit.
    func noteOrderlyExit() {
        exitMarker.leftForeground()
    }

    /// The session list was applied: is the open conversation up to date?
    func noteSessionListApplied() {
        let viewed = sessionStore.activeSessionId.flatMap { sid in
            sessionStore.sessions[sid].map { (sessionId: sid, lastSeq: $0.lastSeq, localSeq: messageStore.persistedHead(sid)) }
        }
        stability.sessionListApplied(viewed: viewed)
    }

    /// The conversation view refreshed (cheap: a few comparisons).
    func noteConversationRendered(_ sessionId: String, hasContent: Bool) {
        guard stability.wantsConversationUpdates, let session = sessionStore.sessions[sessionId] else { return }
        stability.conversationRendered(
            sessionId: sessionId,
            localSeq: messageStore.persistedHead(sessionId),
            lastSeq: session.lastSeq,
            hasContent: hasContent
        )
    }

    #if os(macOS)
    func handleSystemWillSleep() {
        stability.systemWillSleep()
        noteOrderlyExit()
    }

    func handleWillTerminate() {
        noteOrderlyExit()
    }
    #endif

    @ObservationIgnored private var stabilityStarted = false

    func startStabilityTracking() {
        guard !stabilityStarted else { return }
        stabilityStarted = true
        #if KRAKI_DIAG || DEBUG
        // Summaries are only sent by diagnostics builds: do not run a path
        // monitor in ordinary releases for records nobody receives.
        pathObserver = NetworkPathObserver { [weak self] kind in self?.stability.pathChanged(to: kind) }
        #endif
        // Read before this process marks itself foreground.
        let previousExit = exitMarker.previousExit()
        stability.previousExit = { previousExit }
        #if KRAKI_DIAG
        stability.onOpen = { open in
            var f: [DiagField: DiagValue] = [.outcome: .tag(open.outcome.rawValue), .gap: .int(open.gap)]
            if let v = open.firstContentMs { f[.firstContentMs] = .number(v) }
            if let v = open.currentMs { f[.viewCurrentMs] = .number(v) }
            f[.reconnecting] = .bool(open.reconnecting)
            KrakiDiag.record(.open, f)
        }
        sendMetrics.onSummary = { send in
            var f: [DiagField: DiagValue] = [
                .kind: .tag(send.kind.rawValue), .outcome: .tag(send.outcome.rawValue),
                .shown: .tag(send.shown.rawValue), .shownMs: .number(send.shownMs),
                .falseAlarm: .bool(send.falseAlarm), .manualRetries: .int(send.manualRetries),
                .autoResends: .int(send.autoResends), .restored: .int(send.restored ? 1 : 0),
                .offline: .bool(send.offlineAtSend), .attachments: .int(send.attachments),
                .textLength: .int(send.textLength), .background: .bool(send.failedInBackground),
            ]
            f.merge(send.diagTimings) { $1 }
            if let v = send.cause { f[.cause] = .tag(v) }
            KrakiDiag.record(.send, f)
        }
        voiceInputController.metrics.onSummary = { voice in
            var f: [DiagField: DiagValue] = [
                .outcome: .tag(voice.outcome.rawValue), .stage: .tag(voice.stage),
                .confirmed: .bool(voice.correctionConfirmed), .textLength: .int(voice.textLength),
                .warm: .bool(voice.warm), .count: .int(voice.leaseRollovers),
                .correctionOn: .bool(voice.correctionEnabled),
            ]
            if let v = voice.cause { f[.cause] = .tag(v) }
            if let v = voice.startMs { f[.startMs] = .number(v) }
            if let v = voice.recordMs { f[.recordMs] = .number(v) }
            if let v = voice.finalizeMs { f[.finalizeMs] = .number(v) }
            KrakiDiag.record(.voiceSummary, f)
        }
        stability.onReady = { ready in KrakiDiag.record(.ready, Self.readyFields(ready)) }
        stability.onOutage = { outage in
            var f: [DiagField: DiagValue] = [
                .source: .tag(outage.reason), .outcome: .tag(outage.outcome.rawValue),
                .path: .tag(outage.path), .attempt: .int(outage.attempts),
                .detectMs: .number(outage.detectMs), .visibleMs: .number(outage.visibleMs),
                .pathChanged: .bool(outage.pathChanged), .afterWake: .bool(outage.afterWake),
            ]
            // As a tag: numbers are encoded non-negative, NSURLError codes are negative.
            if let v = outage.code { f[.code] = .tag(String(v)) }
            if let v = outage.reconnectMs { f[.reconnectMs] = .number(v) }
            if let v = outage.catchupMs { f[.catchupMs] = .number(v) }
            if let v = outage.impactMs { f[.impactMs] = .number(v) }
            KrakiDiag.record(.outage, f)
        }
        #endif
    }

    /// True only when the WS is fully connected and authenticated.
    var isFullyOnline: Bool {
        connectionStatus == .connected
    }

    func setupNetworking(outboxURL: URL? = nil) {
        #if KRAKI_DIAG
        KrakiDiag.start()
        #endif
        let crypto = CryptoManager()
        let keychain = KeychainManager()

        let client = WebSocketClient(relayURL: relayURL)
        let router = MessageRouter(appState: self)
        let auth = AuthManager(
            keychain: keychain,
            crypto: crypto,
            appState: self
        )
        let sender = CommandSender(appState: self, outboxURL: outboxURL ?? Self.pendingOutboxURL())
        let provider = MessageProvider(appState: self)
        #if os(iOS)
        let push = PushManager(appState: self)
        #endif
        let prefs = PreferencesManager(appState: self)

        client.onMessage = { [weak router] data in
            router?.handleRawMessage(data)
        }
        client.onStateChange = { [weak self] state in
            self?.handleConnectionStateChange(state)
        }
        client.isReceivingPayload = { [weak self] in
            guard let last = self?.pulseManager?.lastDeliveryAt else { return false }
            return Date().timeIntervalSince(last) < 25
        }
        client.onRecover = { [weak self] reason, code, quietFor in
            self?.stability.transportLost(reason: reason, code: code, quietFor: quietFor)
        }
        client.onReconnectAttempt = { [weak self] attempt in
            self?.updateReconnectAttempt(attempt)
        }

        self.wsClient = client
        self.authManager = auth
        self.messageRouter = router
        self.commandSender = sender
        self.messageProvider = provider
        #if os(iOS)
        self.pushManager = push
        #endif
        self.preferencesManager = prefs
        // Pulse reliable transport — wraps every consumer message through
        // the endpoint before E2E encryption, and unwraps inbound frames
        // after decryption.
        self.pulseManager = PulseManager(host: self)
        // A new Pulse restarts its generations: nothing pending is measurable.
        sendMetrics.pulseDisconnected()
        #if os(macOS)
        self.localLink = LocalLinkClient(appState: self)
        #endif
        self.sessionSubscriptionController = SessionSubscriptionController(host: self)

        // Mirror the persisted credential state from disk so cold launch
        // with stored creds skips LoginView and lands directly on the
        // session list, per RootView's gating contract. AuthManager has
        // already loaded `storedDeviceId` from UserDefaults in its init.
        self.hasStoredCredentials = (auth.storedDeviceId != nil)

        // DEBUG: automate real-relay pairing in the simulator without
        // requiring camera/UI automation. This exercises the same AuthManager,
        // WebSocket, Pulse, session-list and storage paths as manual pairing;
        // only acquisition of the QR URL is bypassed.
        #if DEBUG
        if let pairingURL = ProcessInfo.processInfo.environment["KRAKI_PAIRING_URL"],
           let components = URLComponents(string: pairingURL),
           let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
           !token.isEmpty {
            prepareDebugPairing(url: pairingURL, token: token, auth: auth)
            if let pairedRelay = components.queryItems?.first(where: { $0.name == "relay" })?.value,
               !pairedRelay.isEmpty, pairedRelay != relayURL {
                relayURL = pairedRelay
                client.setRelayURL(pairedRelay) // schedules exactly one connect
            } else {
                DispatchQueue.main.async { [weak self] in self?.connect() }
            }
            connectionStatus = .authenticating
        } else if ProcessInfo.processInfo.environment["KRAKI_DEV_LOGIN"] == "1" {
            DispatchQueue.main.async { [weak self] in self?.devConnect() }
        }
        #endif
    }

    func connect() {
        connectionStatus = .connecting
        wsClient?.connect()
    }

    #if os(macOS)
    var cliLoginInFlight = false
    /// Test graphs use their own store, so one test's Sign Out never leaks.
    @ObservationIgnored var signedOutDefaults: UserDefaults = .standard
    var cliRecoveryInFlight = false
    // MARK: Sign-in watchdog

    /// When the window holds credentials but has not signed in for a while
    /// (a socket open yet unauthenticated, or no CLI token found at launch),
    /// retry automatically with growing intervals. Ordinary outages are left
    /// to the WebSocket's own reconnect backoff.
    var authWatchdogTask: Task<Void, Never>?
    @ObservationIgnored var notConnectedSince: Date?
    @ObservationIgnored var authRecoveryAttempts = 0
    @ObservationIgnored var lastAuthRecoveryAt: Date?
    #if DEBUG
    @ObservationIgnored var authWatchdogInterval: TimeInterval = 5
    @ObservationIgnored var authStuckThreshold: TimeInterval = 10
    #else
    let authWatchdogInterval: TimeInterval = 5
    let authStuckThreshold: TimeInterval = 10
    #endif
    #endif

    /// Between handleBackground and handleForegroundRehydrate.
    var isInBackground = false
}

// MARK: - Types

enum ConnectionStatus: Equatable {
    case awaitingLogin
    case connecting
    case authenticating
    case connected
    case disconnected
    case error
}

struct UserInfo: Codable, Equatable {
    let id: String
    let login: String
    let provider: String?
    let email: String?
    let preferences: [String: AnyCodable]?

    enum CodingKeys: String, CodingKey {
        case id, login, provider, email, preferences
    }

    init(id: String, login: String, provider: String? = nil, email: String? = nil, preferences: [String: AnyCodable]? = nil) {
        self.id = id
        self.login = login
        self.provider = provider
        self.email = email
        self.preferences = preferences
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        login = try container.decode(String.self, forKey: .login)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        email = try container.decodeIfPresent(String.self, forKey: .email)
        preferences = try container.decodeIfPresent([String: AnyCodable].self, forKey: .preferences)
    }
}

// MARK: - Opening record and background socket grace (same file: private state)

extension AppState {
    /// A head reply was applied (MessageProvider.handleBatch). The stability
    /// records compare against the persisted head, not the last stored row:
    /// the newest seqs can be rows clients never store, and then the catch-up
    /// changes nothing on screen, so no view refresh would tell the tracker
    /// (Mac diag 10-15/10-16: outages re-authenticated in 3 s but read
    /// "caught up" only at the next new message, 216 s / never).
    func noteHeadReplyApplied(_ sessionId: String) {
        guard sessionStore.activeSessionId == sessionId else { return }
        noteConversationRendered(sessionId, hasContent: false)
    }

    /// Starts the opening record: the first call per process is a cold start,
    /// later ones only after the app was hidden or the Mac slept.
    func noteVisible(keptSocket: Bool = false) {
        // Before the opening starts: the Mac becomes active before it first
        // connects, and its cold record had no `previousExit` (it was set
        // only on the first `.connecting`).
        startStabilityTracking()
        stability.appVisible(
            hasCachedContent: !sessionStore.sessions.isEmpty,
            viewing: sessionStore.activeSessionId != nil,
            keptConnection: keptSocket && connectionStatus == .connected
        )
        exitMarker.enteredForeground()
    }

    #if os(iOS)
    func makeBackgroundSocketGrace() -> BackgroundSocketGrace {
        BackgroundSocketGrace(hooks: .init(
            canKeep: { [weak self] in
                guard let self else { return false }
                return self.connectionStatus == .connected
                    && self.wsClient?.isAuthenticated == true
                    && self.relayFeatures.contains("app_visibility")
            },
            hasSendsAwaitingEcho: { [weak self] in
                self?.wsClient?.isAuthenticated == true && self?.commandSender?.hasSendsAwaitingEcho == true
            },
            setVisible: { [weak self] visible in self?.sendAppVisibility(visible) },
            teardown: { [weak self] in
                guard self?.isInBackground == true else { return }
                self?.tearDownForBackground()
            },
            beginTask: { expired in
                let id = UIApplication.shared.beginBackgroundTask(withName: "KrakiSocketGrace", expirationHandler: expired)
                return id == .invalid ? nil : id.rawValue
            },
            endTask: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) }
        ))
    }
    #endif

    /// `auth_ok` capabilities of this relay connection.
    func applyRelayCapabilities(_ authOk: [String: Any]) {
        // A relay that acknowledges inbound data promptly lets Pulse pace large
        // uploads by acks; an older one only acks on idle heartbeats.
        pulseManager?.acksPromptly = (authOk["pulseAckBytes"] as? Int ?? 0) > 0
        relayFeatures = Set(authOk["features"] as? [String] ?? [])
    }
}

#if KRAKI_DIAG
extension AppState {
    /// `ready.summary` fields (metadata only).
    static func readyFields(_ ready: StabilityTracker.Ready) -> [DiagField: DiagValue] {
        var f: [DiagField: DiagValue] = [
            .kind: .tag(ready.kind.rawValue), .outcome: .tag(ready.outcome.rawValue),
            .path: .tag(ready.path), .attempt: .int(ready.attempts), .gap: .int(ready.gap),
            .viewing: .bool(ready.viewing), .kept: .bool(ready.kept),
        ]
        if let v = ready.backgroundMs { f[.backgroundMs] = .number(v) }
        if let v = ready.firstContentMs { f[.firstContentMs] = .number(v) }
        if let v = ready.wsOpenMs { f[.wsOpenMs] = .number(v) }
        if let v = ready.authedMs { f[.authedMs] = .number(v) }
        if let v = ready.listFreshMs { f[.listFreshMs] = .number(v) }
        if let v = ready.viewCurrentMs { f[.viewCurrentMs] = .number(v) }
        if let v = ready.previousExit { f[.previousExit] = .tag(v) }
        if let v = ready.failure { f[.cause] = .tag(v) }
        return f
    }
}
#endif
