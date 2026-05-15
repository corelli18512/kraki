import SwiftUI
import Observation

/// Central app state that coordinates all stores and the network layer.
@Observable
final class AppState {
    // MARK: - Stores
    let sessionStore = SessionStore()
    let deviceStore = DeviceStore()
    let messageStore = MessageStore()

    // MARK: - Networking
    private(set) var wsClient: WebSocketClient?
    private(set) var authManager: AuthManager?
    private(set) var messageRouter: MessageRouter?
    private(set) var commandSender: CommandSender?
    private(set) var messageProvider: MessageProvider?
    private(set) var pushManager: PushManager?

    // MARK: - Connection
    var connectionStatus: ConnectionStatus = .awaitingLogin
    var deviceId: String?
    var user: UserInfo?
    #if DEBUG
    var relayURL: String = "ws://localhost:4400"
    #else
    var relayURL: String = "wss://kraki.corelli.cloud"
    #endif
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

    /// Sign the user out: drop the WS, wipe stored credentials, and
    /// reset everything to the pre-login state so RootView routes
    /// back to the login screen.
    func logout() {
        wsClient?.disconnect()
        authManager?.clearStoredCredentials()
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

    /// Called by the WS client whenever it bumps its retry counter.
    func updateReconnectAttempt(_ attempt: Int) {
        reconnectAttempt = attempt
    }

    private func handleConnectionStateChange(_ state: WebSocketState) {
        switch state {
        case .connected:
            connectionStatus = .authenticating
            authManager?.authenticate()
        case .disconnected:
            if connectionStatus == .connected {
                connectionStatus = .disconnected
            }
        case .connecting:
            connectionStatus = .connecting
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

        // Determine target tentacle device
        let sessionId = message["sessionId"] as? String
        let targetDeviceId: String?
        if let sessionId, let session = sessionStore.sessions[sessionId] {
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
