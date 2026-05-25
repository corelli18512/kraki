import SwiftUI
import Observation

/// Central app state that coordinates all stores and the network layer.
@Observable
final class AppState {
    // MARK: - Stores
    let sessionStore = SessionStore()
    let deviceStore = DeviceStore()
    let messageStore = MessageStore()
    /// Disk-backed cache + chunk reassembly for ContentRef attachments
    /// (tool args/result, agent images). Created with a request-pull
    /// closure that uses our encrypted-send pipeline.
    private(set) var attachmentStore: AttachmentStore!

    // MARK: - Networking
    private(set) var wsClient: WebSocketClient?
    private(set) var authManager: AuthManager?
    private(set) var messageRouter: MessageRouter?
    private(set) var commandSender: CommandSender?
    private(set) var messageProvider: MessageProvider?
    private(set) var pushManager: PushManager?
    private(set) var preferencesManager: PreferencesManager?

    // MARK: - Connection
    var connectionStatus: ConnectionStatus = .awaitingLogin
    var deviceId: String?
    var user: UserInfo?

    /// App group UserDefaults suite, shared with the NSE.
    private static let sharedDefaults: UserDefaults = UserDefaults(suiteName: "group.chat.kraki.ios") ?? .standard
    /// Key for the persisted relay URL. Set after a successful auth or a
    /// `wrong_region` redirect so we can skip the redirect dance on cold launch.
    private static let relayURLKey = "kraki.relayURL"

    #if DEBUG
    private static let defaultRelayURL = "ws://localhost:4400"
    #else
    private static let defaultRelayURL = "wss://relay.kraki.chat"
    #endif

    /// The relay URL the app will connect to.
    ///
    /// Priority order:
    ///   1. Persisted URL in shared defaults (set after a successful
    ///      auth or `wrong_region` redirect).
    ///   2. `KRAKI_RELAY_URL` env var (debug-build convenience for
    ///      pointing a development build at prod — set in the Xcode
    ///      scheme's Run > Environment Variables when capturing
    ///      device logs against a real-data session).
    ///   3. `defaultRelayURL` for the current build configuration.
    private static func resolveDefaultRelayURL() -> String {
        if let persisted = AppState.sharedDefaults.string(forKey: AppState.relayURLKey) {
            return persisted
        }
        if let env = ProcessInfo.processInfo.environment["KRAKI_RELAY_URL"], !env.isEmpty {
            return env
        }
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

    init() {
        // attachmentStore is set up first so the request-pull closure
        // can capture self by weak reference and the rest of setup
        // (router, ws) can read it.
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
        let push = PushManager(appState: self)
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
        self.pushManager = push
        self.preferencesManager = prefs

        // Mirror the persisted credential state from disk so cold launch
        // with stored creds skips LoginView and lands directly on the
        // session list, per RootView's gating contract. AuthManager has
        // already loaded `storedDeviceId` from UserDefaults in its init.
        self.hasStoredCredentials = (auth.storedDeviceId != nil)
    }

    func connect() {
        connectionStatus = .connecting
        wsClient?.connect()
    }

    /// Connect to local relay with open auth — DEBUG only.
    /// Bypasses pairing and OAuth for fast dev iteration.
    func devConnect() {
        #if DEBUG
        // Clear any stored credentials so we get a fresh open auth
        authManager?.pairingToken = nil
        connectionStatus = .connecting
        wsClient?.connect()
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
        lastError = nil
        reconnectAttempt = 0
        hasCompletedInitialConnect = false
        connectionStatus = .awaitingLogin
        sessionStore.reset()
        deviceStore.reset()
        messageStore.reset()
    }

    /// Called when the app returns to foreground. Reset backoff and
    /// kick a fresh connect immediately so the user doesn't have to
    /// wait out a long backoff timer that started in the background.
    func handleForegroundRehydrate() {
        guard hasCompletedInitialConnect else { return }
        guard connectionStatus != .connected else { return }
        wsClient?.resetBackoffAndReconnect()
    }

    /// Called when the app moves to background. Close the WS so the
    /// relay marks this device offline immediately and starts routing
    /// to APNs. Otherwise the relay would skip APNs for ~30s while it
    /// waits for a pong from the dead socket.
    ///
    /// Also drains the persistent message-cache writer so messages
    /// that arrived in the burst right before backgrounding aren't
    /// lost if iOS suspends the process before the I/O queue empties.
    func handleBackground() {
        messageStore.flushCache()
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
            if connectionStatus == .connected {
                connectionStatus = .disconnected
            }
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

        deviceStore.setDevices(devices)

        // Drain any queued encrypted messages
        messageRouter?.drainQueue()

        // Re-register push token if user has it enabled
        pushManager?.onAuthenticated()
    }

    func onAuthFailed(error: String) {
        self.lastError = error
        self.connectionStatus = .awaitingLogin
    }

    /// Send an encrypted message through the WebSocket.
    /// Encrypts as a unicast to the target tentacle (looked up by sessionId),
    /// or broadcasts to all tentacles if no sessionId.
    func sendEncryptedMessage(_ message: [String: Any]) {
        guard let deviceId else {
            KLog.d("⚠️ sendEncrypted: no deviceId")
            return
        }

        // Serialize the inner message to JSON string
        guard let innerData = try? JSONSerialization.data(withJSONObject: message),
              let innerString = String(data: innerData, encoding: .utf8) else {
            KLog.d("⚠️ sendEncrypted: failed to serialize message")
            return
        }

        // Determine target tentacle device. Prefer an explicit
        // `targetDeviceId` in the envelope (e.g. import or
        // request_local_sessions, both of which target a specific
        // tentacle without a sessionId). Fall back to the session's
        // owning device when a sessionId is present, else broadcast.
        let sessionId = message["sessionId"] as? String
        let explicitTarget = message["targetDeviceId"] as? String
        let targetDeviceId: String?
        if let explicitTarget {
            targetDeviceId = explicitTarget
        } else if let sessionId, let session = sessionStore.sessions[sessionId] {
            targetDeviceId = session.deviceId
        } else {
            targetDeviceId = nil
        }

        // Collect recipient encryption keys
        var recipients: [RecipientKey] = []
        let crypto = CryptoManager()

        if let targetDeviceId, let device = deviceStore.devices[targetDeviceId],
           let encKeyB64 = device.encryptionKey ?? device.publicKey {
            do {
                let pubKey = try crypto.importPublicKeyFromSPKI(encKeyB64)
                recipients.append(RecipientKey(deviceId: targetDeviceId, publicKey: pubKey))
            } catch {
                KLog.d("❌ sendEncrypted: can't import key for \(targetDeviceId.prefix(12)): \(error)")
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
            return
        }

        do {
            let blob = try crypto.encryptToBlob(innerString, recipients: recipients)

            if let targetDeviceId {
                // Unicast
                let envelope: [String: Any] = [
                    "type": "unicast",
                    "to": targetDeviceId,
                    "blob": blob.blob,
                    "keys": blob.keys,
                ]
                guard let envData = try? JSONSerialization.data(withJSONObject: envelope),
                      let envString = String(data: envData, encoding: .utf8) else { return }
                KLog.d("📤🔒 unicast → \(targetDeviceId.prefix(12))...")
                wsClient?.sendRaw(envString)
            } else {
                // Broadcast
                let envelope: [String: Any] = [
                    "type": "broadcast",
                    "blob": blob.blob,
                    "keys": blob.keys,
                ]
                guard let envData = try? JSONSerialization.data(withJSONObject: envelope),
                      let envString = String(data: envData, encoding: .utf8) else { return }
                KLog.d("📤🔒 broadcast to \(recipients.count) devices")
                wsClient?.sendRaw(envString)
            }
        } catch {
            KLog.d("❌ sendEncrypted: encryption failed: \(error)")
        }
    }
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
