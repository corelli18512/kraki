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
    private(set) var messageRouter: MessageRouter?
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
    private(set) var preferencesManager: PreferencesManager?
    private(set) var pulseManager: PulseManager?
    private(set) var sessionSubscriptionController: SessionSubscriptionController!
    /// Region-advertised voice capability from the latest authenticated
    /// handshake. Nil means the microphone affordance stays hidden.
    var voiceCapability: VoiceCapability?
    @ObservationIgnored private(set) var voiceInputController: KrakiVoiceInputController

    init() {
        self.sessionStore = SessionStore()
        self.deviceStore = DeviceStore()
        // The message DB is the persistence backbone for chat
        // history. Failing to open it is fatal — without it the chat
        // surface can't function and silent degradation would mask
        // the failure. Loud crash on launch is the right signal.
        do {
            self.messageDatabase = try MessageDatabase()
        } catch {
            fatalError("Failed to open message database: \(error)")
        }
        self.messageStore = MessageStore(db: messageDatabase)
        self.voiceInputController = KrakiVoiceInputController()
        self.voiceInputController.bind(host: self)
        // attachmentStore is set up after the DB-backed stores so the
        // request-pull closure can capture self by weak reference
        // and the rest of setup (router, ws) can read it.
        self.attachmentStore = AttachmentStore { [weak self] id, sessionId in
            guard let self else { return }
            self.sendEncryptedMessage([
                "type": "request_attachment",
                "deviceId": self.deviceId ?? "",
                "sessionId": sessionId,
                "payload": ["id": id, "sessionId": sessionId],
            ])
        }
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

    #if DEBUG
    /// Fully isolated app graph for native Chat snapshot/alignment harnesses.
    /// It uses the real stores/provider/command/subscription objects but omits
    /// Keychain, auth, WebSocket and Pulse setup, so production UI can run
    /// unchanged against a static temporary database without side effects.
    init(testDatabase: MessageDatabase, loadPersistedState: Bool = false) {
        self.sessionStore = SessionStore(persistenceEnabled: loadPersistedState)
        self.deviceStore = DeviceStore(persistenceEnabled: loadPersistedState)
        self.messageDatabase = testDatabase
        self.messageStore = MessageStore(db: testDatabase)
        self.voiceInputController = KrakiVoiceInputController()
        self.voiceInputController.bind(host: self)
        self.attachmentStore = AttachmentStore { _, _ in }
        self.commandSender = CommandSender(appState: self)
        self.messageProvider = MessageProvider(appState: self)
        self.sessionSubscriptionController = SessionSubscriptionController(host: self)
        self.hasStoredCredentials = true
        self.hasCompletedInitialConnect = true
        self.connectionStatus = .disconnected
    }
    #endif

    // MARK: - Connection
    var connectionStatus: ConnectionStatus = .awaitingLogin
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
        }
        sessionStore.activeSessionId = sessionId
    }

    func endViewingSession(_ sessionId: String) {
        sessionStore.allowAutoRead(sessionId)
        if sessionStore.activeSessionId == sessionId {
            sessionStore.activeSessionId = nil
        }
    }

    func updateReadVisibility(appForeground: Bool, conversationVisible: Bool) {
        let becameReadable = appForeground && conversationVisible
            && (!isAppForeground || !isConversationWindowVisible)
        isAppForeground = appForeground
        isConversationWindowVisible = conversationVisible
        guard becameReadable, let sessionId = sessionStore.activeSessionId else { return }
        markSessionReadIfVisible(sessionId)
    }

    /// macOS dev-local mode: connected to a local `pnpm dev` relay with no
    /// login. Gating for the welcome screen / sidebar. iOS is always
    /// authenticated and does not set this.
    #if os(macOS)
    var devLocalActive: Bool = false
    #endif

    /// Persistence is isolated by app identity on macOS so the stable Prod
    /// app and the local Debug app can run against the same relay concurrently.
    private static let sharedDefaults: UserDefaults = {
        #if os(macOS)
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
    private static let relayURLKey = "kraki.relayURL"

    private static let defaultRelayURL = "wss://relay.kraki.chat"

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
    var lastError: String?
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
        switch connectionStatus {
        case .connecting, .authenticating, .disconnected:
            return hasCompletedInitialConnect
        default:
            return false
        }
    }

    /// True only when the WS is fully connected and authenticated.
    var isFullyOnline: Bool {
        connectionStatus == .connected
    }

    func setupNetworking() {
        let crypto = CryptoManager()
        let keychain = KeychainManager()

        let client = WebSocketClient(relayURL: relayURL)
        let router = MessageRouter(appState: self)
        let auth = AuthManager(
            keychain: keychain,
            crypto: crypto,
            appState: self
        )
        let sender = CommandSender(appState: self)
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
            auth.clearStoredCredentials()
            auth.pairingToken = token
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
    private var cliLoginInFlight = false

    /// Reuse the locally-installed `kraki` CLI's login (relay + GitHub token
    /// from `~/.kraki` / `gh auth token`) to authenticate this Mac as an arm
    /// device — no manual pairing required. Returns true when a CLI login was
    /// found and a connection has been started; false when the CLI isn't
    /// installed/logged in (caller falls back to the login screen).
    @discardableResult
    func attemptCLILogin() async -> Bool {
        // SwiftUI WindowGroup tasks can be recreated while the app is already
        // connecting/authenticating. Loading the CLI token twice used to call
        // connect twice and leave parallel sockets behind.
        if cliLoginInFlight { return true }
        if authManager?.cliGitHubToken != nil {
            guard connectionStatus == .awaitingLogin || connectionStatus == .disconnected else {
                return true
            }
            connect()
            return true
        }
        cliLoginInFlight = true
        defer { cliLoginInFlight = false }
        guard let creds = await AuthManager.loadCLICredentials() else { return false }
        // Token auth is independent of the old device's Keychain ACL. Use
        // process-local keys so a denied Keychain prompt cannot strand the
        // Mac before the relay refreshes this device's public keys.
        authManager?.useEphemeralKeysForCurrentProcess()
        let relayChanged = creds.relay != relayURL
        if relayChanged {
            relayURL = creds.relay
            wsClient?.setRelayURL(creds.relay)
        }
        authManager?.cliGitHubToken = creds.token
        KLog.d("🔑 Reusing local kraki CLI login → \(creds.relay)")
        // setRelayURL schedules the replacement connection itself. Calling
        // connect again here would briefly create two authenticated sockets.
        if !relayChanged {
            connect()
        }
        return true
    }
    #endif

    /// Connect to local relay with open auth — DEBUG only.
    /// Bypasses pairing and OAuth for fast dev iteration.
    ///
    /// The default `relayURL` is `wss://relay.kraki.chat` (prod) for
    /// all build configurations, so this dev path explicitly forces
    /// the URL to the local `pnpm dev` relay (`ws://localhost:4400`,
    /// matching `scripts/dev-local.ts`'s default relay port). On the iOS
    /// Simulator `localhost` resolves to the host Mac, so this just
    /// works when the dev daemon is up.
    func devConnect() {
        #if DEBUG
        // Local dev is a process-scoped open-auth identity. Keep production
        // pairing/device credentials and RSA keys intact so entering dev mode
        // cannot sign the user's real app out.
        authManager?.pairingToken = nil
        authManager?.usesEphemeralOpenAuth = true
        // `KRAKI_LOCAL_RELAY_PORT` env override matches `scripts/dev-local.ts`.
        let port = ProcessInfo.processInfo.environment["KRAKI_LOCAL_RELAY_PORT"] ?? "4400"
        let devURL = "ws://localhost:\(port)"
        relayURL = devURL
        // Intentionally NOT persisting to App Group — the dev URL is
        // ephemeral; cold launch should always default back to prod.
        // Otherwise a debug install can leave `ws://localhost:4000`
        // baked into shared defaults on a physical phone where it
        // can never resolve.
        connectionStatus = .connecting
        if wsClient?.relayURL != devURL {
            // setRelayURL tears down the old socket and schedules the replacement
            // on the next runloop. Do not also call connect() here: that creates
            // two local sockets with different open-auth device IDs/Pulse epochs.
            wsClient?.setRelayURL(devURL)
        } else {
            wsClient?.connect()
        }
        #endif
    }

    func disconnect() {
        wsClient?.disconnect()
        connectionStatus = .disconnected
    }

    /// Switch to a new relay URL (e.g. after a `wrong_region` redirect),
    /// persist it across launches, and reconnect.
    func redirectToRelay(_ newURL: String) {
        KLog.d("🔀 Redirecting to relay: \(newURL)")
        relayURL = newURL
        Self.sharedDefaults.set(newURL, forKey: Self.relayURLKey)
        wsClient?.setRelayURL(newURL)
    }

    /// Clear any persisted relay URL so the next launch falls back to the
    /// default. Used during logout so a fresh login goes through the
    /// dispatcher and gets re-pinned to the correct region.
    func clearStoredRelayURL() {
        Self.sharedDefaults.removeObject(forKey: Self.relayURLKey)
        relayURL = Self.defaultRelayURL
    }

    /// Sign the user out: drop the WS, wipe stored credentials, and
    /// reset everything to the pre-login state so RootView routes
    /// back to the login screen.
    func logout() {
        wsClient?.disconnect()
        authManager?.clearStoredCredentials()
        clearStoredRelayURL()
        deviceId = nil
        user = nil
        githubClientId = nil
        relayVersion = nil
        voiceCapability = nil
        voiceInputController.suspendWarmConnection()
        #if os(iOS)
        pushManager?.syncApplicationBadge(unreadSessionIDs: [])
        #endif
        lastError = nil
        reconnectAttempt = 0
        hasCompletedInitialConnect = false
        connectionStatus = .awaitingLogin
        sessionStore.reset()
        deviceStore.reset()
        messageStore.reset()
        commandSender?.reset()
        sessionSubscriptionController?.setDesired(nil)
        sessionSubscriptionController?.onDisconnected()
    }

    /// Called when the app returns to foreground. Reset backoff and
    /// kick a fresh connect immediately so the user doesn't have to
    /// wait out a long backoff timer that started in the background.
    func handleForegroundRehydrate() {
        updateReadVisibility(appForeground: true, conversationVisible: true)
        #if os(iOS)
        Task { await pushManager?.handleForeground() }
        #endif
        voiceInputController.resumeWarmConnection()
        guard hasCompletedInitialConnect else { return }
        guard connectionStatus != .connected else { return }
        wsClient?.resetBackoffAndReconnect()
    }

    /// Called when the app moves to background. Close the WS so the
    /// relay marks this device offline immediately and starts routing
    /// to APNs. Otherwise the relay would skip APNs for ~30s while it
    /// waits for a pong from the dead socket.
    ///
    /// Called when the app moves to background. We pre-empt the
    /// system-level idle-timeout disconnect by tearing down the WS
    /// before iOS suspends us. That way the relay marks this device
    /// offline immediately and starts routing to APNs. Otherwise the
    /// relay would skip APNs for ~30s while it waits for a pong from
    /// the dead socket.
    ///
    /// GRDB DatabasePool checkpoints WAL on its own — no explicit
    /// flush needed for messages. We still flush the SessionStore /
    /// DeviceStore JSON snapshots so debounced writes don't get lost.
    func handleInactive() {
        updateReadVisibility(appForeground: false, conversationVisible: false)
    }

    func handleBackground() {
        updateReadVisibility(appForeground: false, conversationVisible: false)
        voiceInputController.suspendWarmConnection()
        sessionStore.flushCache()
        deviceStore.flushCache()
        wsClient?.disconnect()
    }

    /// Called by the WS client whenever it bumps its retry counter.
    func updateReconnectAttempt(_ attempt: Int) {
        reconnectAttempt = attempt
    }

    private func handleConnectionStateChange(_ state: WebSocketState) {
        switch state {
        case .connected:
            connectionStatus = .authenticating
            authManager?.bootstrapAuth()
        case .disconnected:
            sessionSubscriptionController?.onDisconnected()
            messageProvider?.onDisconnected()
            if connectionStatus == .connected {
                connectionStatus = .disconnected
            }
            pulseManager?.onDisconnected()
        case .connecting:
            connectionStatus = .connecting
        }
    }

    /// Called by AuthManager after the relay answers a pre-auth
    /// `auth_info` query. Stashes the GitHub OAuth client id and drops
    /// the connection status back to `.awaitingLogin` so the LoginView
    /// becomes interactive (otherwise it would be stuck on the
    /// "Signing you in…" panel waiting for an auth handshake that
    /// hasn't been initiated yet).
    func onAuthInfoReceived(githubClientId: String?) {
        self.githubClientId = githubClientId
        // If a user-initiated auth (OAuth code, pairing token) raced
        // ahead of this response, leave its `.authenticating` in place.
        if connectionStatus == .authenticating {
            connectionStatus = .awaitingLogin
        }
    }

    // Called by AuthManager after successful auth
    func onAuthenticated(deviceId: String, user: UserInfo?, devices: [DeviceSummary], githubClientId: String?, relayVersion: String?) {
        self.deviceId = deviceId
        self.user = user
        self.githubClientId = githubClientId
        self.relayVersion = relayVersion
        self.connectionStatus = .connected
        self.reconnectAttempt = 0
        self.lastError = nil
        // First-time login crosses the line into MainTabView. Mid-
        // session reconnects re-enter this method too, which is fine
        // — setting it to true again is a no-op.
        self.hasCompletedInitialConnect = true

        // The relay rejects Pulse frames before auth and only starts its peer
        // endpoint after sending auth_ok. Start our endpoint at the same
        // boundary; doing this on raw WebSocket connect loses the hello on a
        // challenge reconnect and leaves session_list/history requests stuck.
        pulseManager?.onConnected()

        deviceStore.setDevices(devices)

        // Drain any queued encrypted messages
        messageRouter?.drainQueue()

        // Re-register push token if user has it enabled
        #if os(iOS)
        pushManager?.onAuthenticated()
        #endif
        voiceInputController.prepare()
    }

    func onAuthFailed(error: String) {
        self.lastError = error
        self.connectionStatus = .awaitingLogin
    }

    /// Send an encrypted message over the Pulse reliable-transport layer.
    /// E2E-encrypts the inner message to `{blob, keys}`, then hands the pair to
    /// the pulse endpoint, which frames it and sends the OUTER relay envelope
    /// `{type:"unicast"|"broadcast", pulse:b64, blob:"", keys:{}}` — the
    /// ciphertext rides inside the pulse frame, transparent to the relay.
    @discardableResult
    func sendEncryptedMessage(
        _ message: [String: Any],
        routingTarget: String? = nil,
        connectionScoped: Bool = false
    ) -> Bool {
        #if DEBUG
        if let testOutboundMessageHandler {
            return testOutboundMessageHandler(message, routingTarget, connectionScoped)
        }
        #endif
        guard deviceId != nil else {
            KLog.d("⚠️ sendEncrypted: no deviceId")
            return false
        }

        guard let innerData = try? JSONSerialization.data(withJSONObject: message),
              let innerString = String(data: innerData, encoding: .utf8) else {
            KLog.d("⚠️ sendEncrypted: failed to serialize message")
            return false
        }

        // Determine target tentacle device. Prefer an explicit
        // `targetDeviceId` in the envelope (e.g. import or
        // request_local_sessions, both of which target a specific
        // tentacle without a sessionId). Fall back to the session's
        // owning device when a sessionId is present, else broadcast.
        let sessionId = message["sessionId"] as? String
        let explicitTarget = message["targetDeviceId"] as? String
        // Commands such as create_session and request_local_sessions carry
        // their target inside the protocol payload, but relay routing happens
        // before decryption and therefore needs the same target separately.
        // Resolve both shapes so a targeted command is encrypted to, and
        // delivered by the relay to, the intended Tentacle.
        let payloadTarget = (message["payload"] as? [String: Any])?["targetDeviceId"] as? String
        let targetDeviceId: String?
        if let routingTarget {
            targetDeviceId = routingTarget
        } else if let explicitTarget {
            targetDeviceId = explicitTarget
        } else if let payloadTarget {
            targetDeviceId = payloadTarget
        } else if let sessionId, let session = sessionStore.sessions[sessionId] {
            targetDeviceId = session.deviceId
        } else {
            targetDeviceId = nil
        }

        // Collect recipient encryption keys
        var recipients: [RecipientKey] = []
        let crypto = CryptoManager()

        if let targetDeviceId {
            guard let device = deviceStore.devices[targetDeviceId],
                  let encKeyB64 = device.encryptionKey ?? device.publicKey else {
                KLog.d("⚠️ sendEncrypted: target unavailable \(targetDeviceId.prefix(12))")
                return false
            }
            do {
                let pubKey = try crypto.importPublicKeyFromSPKI(encKeyB64)
                recipients.append(RecipientKey(deviceId: targetDeviceId, publicKey: pubKey))
            } catch {
                KLog.d("❌ sendEncrypted: can't import key for \(targetDeviceId.prefix(12)): \(error)")
                return false
            }
        } else {
            // Broadcast to all tentacle devices
            for device in deviceStore.devices.values where device.role == .tentacle {
                guard let encKeyB64 = device.encryptionKey ?? device.publicKey else { continue }
                do {
                    let pubKey = try crypto.importPublicKeyFromSPKI(encKeyB64)
                    recipients.append(RecipientKey(deviceId: device.id, publicKey: pubKey))
                } catch {
                    KLog.d("⚠️ sendEncrypted: can't import key for \(device.id.prefix(12))")
                }
            }
        }

        guard !recipients.isEmpty else {
            KLog.d("⚠️ sendEncrypted: no recipients found")
            return false
        }

        do {
            let blob = try crypto.encryptToBlob(innerString, recipients: recipients)
            KLog.d("📤🔒 pulse → \(targetDeviceId?.prefix(12) ?? "broadcast")...")
            guard let pulseManager else { return false }
            pulseManager.sendEncrypted(
                blob: blob.blob,
                keys: blob.keys,
                target: targetDeviceId,
                connectionScoped: connectionScoped
            )
            return true
        } catch {
            KLog.d("❌ sendEncrypted: encryption failed: \(error)")
            return false
        }
    }
}

// MARK: - Session subscription

extension AppState: SessionSubscriptionHost {
    var subscriptionConnected: Bool { connectionStatus == .connected }

    func resolveTentacle(for sessionId: String) -> String? {
        sessionStore.sessions[sessionId]?.deviceId
    }

    func sendSessionSubscription(to tentacleId: String, sessionId: String?) -> Bool {
        var payload: [String: Any] = [:]
        payload["sessionId"] = sessionId ?? NSNull()
        return sendEncryptedMessage([
            "type": "set_session_subscription",
            "deviceId": deviceId ?? "",
            "seq": 0,
            "timestamp": ISO8601.now(),
            "payload": payload,
        ], routingTarget: tentacleId)
    }

    func applySessionSubscriptionSnapshot(_ ack: SessionSubscriptionAck) {
        guard let sessionId = ack.sessionId,
              let snapshot = ack.snapshot,
              let digestJSON = snapshot["digest"] as? [String: Any],
              let digest = SessionDigest(json: digestJSON) else { return }

        let device = deviceStore.device(for: ack.tentacleId)
        sessionStore.upsertSession(
            digest,
            deviceId: ack.tentacleId,
            deviceName: device?.name ?? ack.tentacleId
        )
        sessionStore.setMode(sessionId, digest.mode)
        if let usage = digest.usage { sessionStore.setUsage(sessionId, usage) }
        if let preview = digest.preview {
            sessionStore.setPreview(
                sessionId,
                text: preview.text,
                type: preview.type,
                timestamp: preview.timestamp
            )
        }

        if digest.runtimeStatus?.status == "compacting" {
            let reason = digest.runtimeStatus?.reason.flatMap(CompactionReason.init(rawValue:))
            messageStore.setCompacting(sessionId, reason: reason)
        } else {
            switch digest.state {
            case .compacting:
                messageStore.setCompacting(sessionId, reason: nil)
            case .idle, .active:
                messageStore.clearRuntimeStatus(sessionId)
            }
        }

        let cardJSON = snapshot["card"] as? [String: Any] ?? [:]
        let draft = cardJSON["draft"] as? String ?? ""
        let actionPayload = cardJSON["action"].map { ["action": $0] }
        let action = MessageRouter.decodeCardAction(actionPayload)
        messageStore.replaceCardFromSubscription(
            sessionId,
            draft: draft,
            action: action,
            state: digest.state
        )

        let spineHeadSeq = snapshot["spineHeadSeq"] as? Int ?? digest.lastSeq
        messageProvider?.setTentacleInfo(
            sessionId: sessionId,
            lastSeq: spineHeadSeq,
            deviceId: ack.tentacleId
        )
        messageProvider?.ensureLoaded(
            sessionId: sessionId,
            reason: "subscriptionSnapshot"
        )
    }

    func reportSessionSubscriptionError(_ message: String) {
        lastError = message
    }
}

// MARK: - Voice input host

extension AppState: KrakiVoiceInputHost {
    static let headPulseTarget = "@head"

    var voiceUserID: String? { user?.id }
    var voiceDeviceID: String? { deviceId }
    var voiceTransportReady: Bool { connectionStatus == .connected }

    @discardableResult
    func requestVoiceLease(resource: String) -> Bool {
        guard connectionStatus == .connected, let deviceId, let wsClient,
              JSONSerialization.isValidJSONObject([
                "type": "request_voice_lease",
                "deviceId": deviceId,
                "resource": resource,
              ]),
              let data = try? JSONSerialization.data(withJSONObject: [
                "type": "request_voice_lease",
                "deviceId": deviceId,
                "resource": resource,
              ]),
              let string = String(data: data, encoding: .utf8) else {
            KLog.d("🎙️ Voice lease request blocked: transport unavailable")
            return false
        }
        // Voice authorization is connection-scoped. The controller requests a
        // lease during foreground warm-up and reuses it across sequential
        // recordings until expiry or reconnect replacement.
        wsClient.sendRaw(string)
        KLog.d("🎙️ Voice lease request sent resource=\(resource)")
        return true
    }
}

// MARK: - PulseHost

extension AppState: PulseHost {
    func sendPulseFrame(_ b64: String, target: String?) {
        // Outer relay envelope carrying the pulse frame; blob/keys are empty
        // (the ciphertext lives inside the pulse frame's payload).
        var envelope: [String: Any] = ["pulse": b64, "blob": "", "keys": [String: String]()]
        if let target {
            envelope["type"] = "unicast"
            envelope["to"] = target
            if target == Self.headPulseTarget {
                KLog.d("🎙️ Voice control Pulse frame → @head bytes=\(b64.utf8.count)")
            }
        } else {
            envelope["type"] = "broadcast"
        }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              let str = String(data: data, encoding: .utf8) else { return }
        wsClient?.sendRaw(str)
    }

    func onDelivered(json: String) {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        // Head-originated control (presence, preferences, voice lease) is
        // intentionally plaintext inside ordered Pulse. Route its inner message
        // through the same control dispatcher as a raw WebSocket frame.
        if object["from"] as? String == Self.headPulseTarget,
           let message = object["msg"] as? [String: Any],
           let messageData = try? JSONSerialization.data(withJSONObject: message) {
            KLog.d("🎙️ Head control delivered type=\(message["type"] as? String ?? "unknown")")
            messageRouter?.handleRawMessage(messageData)
            return
        }

        // All other delivered payloads are `{blob, keys}` E2E ciphertext from a
        // tentacle. Submit to the ordered background decrypt pipeline so RSA
        // work never competes with AppKit scrolling on the main thread.
        messageRouter?.encryptionHandler.submitForDecryption(data)
    }

    func onAcked(seqUpTo: UInt64) {
        commandSender?.resolvePulseAcked(seqUpTo: seqUpTo)
    }

    func onResetInbound(fromSeq: UInt64, epoch: String) {
        KLog.d("⚠️ pulse reset-inbound from=\(fromSeq) epoch=\(epoch)")
    }

    func requestConnect() { wsClient?.connect() }
    func requestDisconnect() { wsClient?.disconnect() }
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
