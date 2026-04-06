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

    // MARK: - Connection
    var connectionStatus: ConnectionStatus = .awaitingLogin
    var deviceId: String?
    var user: UserInfo?
    var relayURL: String = "wss://kraki.corelli.cloud"
    var githubClientId: String?
    var relayVersion: String?
    var lastError: String?
    var reconnectAttempt: Int = 0
    var maxReconnectAttempts: Int = 5

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

        client.onMessage = { [weak router] data in
            router?.handleRawMessage(data)
        }
        client.onStateChange = { [weak self] state in
            self?.handleConnectionStateChange(state)
        }

        self.wsClient = client
        self.authManager = auth
        self.messageRouter = router
        self.commandSender = sender
        self.messageProvider = provider
    }

    func connect() {
        connectionStatus = .connecting
        wsClient?.connect()
    }

    func disconnect() {
        wsClient?.disconnect()
        connectionStatus = .disconnected
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

        deviceStore.setDevices(devices)

        // Drain any queued encrypted messages
        messageRouter?.drainQueue()
    }

    func onAuthFailed(error: String) {
        self.lastError = error
        self.connectionStatus = .awaitingLogin
    }

    /// Send an encrypted message through the WebSocket.
    /// Called by CommandSender — encryption and routing handled here.
    func sendEncryptedMessage(_ message: [String: Any]) {
        // TODO: Encrypt via CryptoManager and send via wsClient
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else { return }
        wsClient?.sendRaw(string)
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
    let preferences: [String: AnyCodable]?

    enum CodingKeys: String, CodingKey {
        case id, login, provider, preferences
    }

    init(id: String, login: String, provider: String? = nil, preferences: [String: AnyCodable]? = nil) {
        self.id = id
        self.login = login
        self.provider = provider
        self.preferences = preferences
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        login = try container.decode(String.self, forKey: .login)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        preferences = try container.decodeIfPresent([String: AnyCodable].self, forKey: .preferences)
    }
}
