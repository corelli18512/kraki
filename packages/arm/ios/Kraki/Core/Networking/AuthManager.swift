/// AuthManager — Authentication handshake flow.
///
/// Mirrors `auth.ts`:
/// - Determines auth method: pairing token → pairing, stored device → challenge, otherwise → open
/// - Signs challenge nonces with the Keychain signing key
/// - Processes `auth_ok` to populate AppState and persist device credentials
/// - Processes `auth_error` to clear stale credentials and surface errors
///
/// Device ID is persisted in UserDefaults; RSA key pairs live in the Keychain
/// via `KeychainManager`.

import Foundation

// DeviceSummary is defined in Core/Protocol/ProtocolTypes.swift

// MARK: - DeviceSummary JSON helper

extension DeviceSummary {
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String else { return nil }
        self.init(
            id: id,
            name: json["name"] as? String ?? id,
            role: DeviceRole(rawValue: json["role"] as? String ?? "") ?? .app,
            kind: DeviceKind(rawValue: json["kind"] as? String ?? ""),
            publicKey: json["publicKey"] as? String,
            encryptionKey: json["encryptionKey"] as? String,
            online: json["online"] as? Bool ?? false,
            lastSeen: json["lastSeen"] as? String,
            createdAt: json["createdAt"] as? String
        )
    }
}

// MARK: - AuthManager

final class AuthManager {

    // MARK: Dependencies

    private let keychain: KeychainManager
    private let crypto: CryptoManager
    private weak var appState: AppState?

    // MARK: Persistent storage key

    private static let deviceIdKey = "kraki.deviceId"

    // MARK: State

    /// The device ID saved from a prior successful auth, loaded from UserDefaults.
    private(set) var storedDeviceId: String?

    /// A one-time pairing token (e.g. from a QR code scan or deep link).
    var pairingToken: String?

    // MARK: Init

    init(keychain: KeychainManager, crypto: CryptoManager, appState: AppState) {
        self.keychain = keychain
        self.crypto = crypto
        self.appState = appState
        self.storedDeviceId = UserDefaults.standard.string(forKey: Self.deviceIdKey)
    }

    // MARK: - Auth Flow

    /// Build and send the initial `auth` message.
    ///
    /// Priority order:
    /// 1. Pairing token (explicit user action — scan QR)
    /// 2. Stored device ID (returning user — challenge-response)
    /// 3. Open auth (new user, no credentials)
    func authenticate() {
        var signingPublicKey: String?
        var encryptionPublicKey: String?

        do {
            let signing = try keychain.getOrCreateSigningKey()
            signingPublicKey = try crypto.exportPublicKeySPKI(signing.publicKey)
            let encryption = try keychain.getOrCreateEncryptionKey()
            encryptionPublicKey = try crypto.exportPublicKeySPKI(encryption.publicKey)
            KLog.d("🔑 Keys ready — signing: \(signingPublicKey?.prefix(20) ?? "nil")... encryption: \(encryptionPublicKey?.prefix(20) ?? "nil")...")
        } catch {
            KLog.d("⚠️ Key generation failed: \(error)")
            signingPublicKey = nil
            encryptionPublicKey = nil
        }

        let device: [String: Any?] = [
            "name": "Kraki iOS",
            "role": "app",
            "kind": "ios",
            "deviceId": storedDeviceId,
            "publicKey": signingPublicKey,
            "encryptionKey": encryptionPublicKey,
        ]
        let cleanDevice = device.compactMapValues { $0 }

        var message: [String: Any]

        if let token = pairingToken {
            KLog.d("🎫 Auth method: pairing")
            message = [
                "type": "auth",
                "auth": ["method": "pairing", "token": token],
                "device": cleanDevice,
            ]
            pairingToken = nil
        } else if let deviceId = storedDeviceId {
            KLog.d("🔐 Auth method: challenge (deviceId: \(deviceId.prefix(12))...)")
            message = [
                "type": "auth",
                "auth": ["method": "challenge", "deviceId": deviceId],
                "device": cleanDevice,
            ]
        } else {
            KLog.d("🔓 Auth method: open")
            message = [
                "type": "auth",
                "auth": ["method": "open"],
                "device": cleanDevice,
            ]
        }

        sendRaw(message)
    }

    /// Sign a challenge nonce and send back `auth_response`.
    func handleAuthChallenge(nonce: String) {
        do {
            let signingKey = try keychain.getOrCreateSigningKey()
            let signature = try crypto.signChallenge(nonce, privateKey: signingKey.privateKey)

            let response: [String: Any] = [
                "type": "auth_response",
                "deviceId": storedDeviceId ?? "",
                "signature": signature,
            ]
            sendRaw(response)
        } catch {
            appState?.onAuthFailed(
                error: "Challenge signing failed: \(error.localizedDescription)"
            )
        }
    }

    /// Process a successful `auth_ok` from the relay.
    func handleAuthOk(message: [String: Any]) {
        guard let appState else { return }

        let deviceId = message["deviceId"] as? String ?? ""
        KLog.d("✅ auth_ok — deviceId: \(deviceId.prefix(12))...")

        // Parse user info
        var user: UserInfo?
        if let userDict = message["user"] as? [String: Any],
           let userId = userDict["id"] as? String,
           let login = userDict["login"] as? String {
            user = UserInfo(
                id: userId,
                login: login,
                provider: userDict["provider"] as? String
            )
            KLog.d("👤 User: \(login)")
        }

        // Parse device list
        var devices: [DeviceSummary] = []
        if let deviceArray = message["devices"] as? [[String: Any]] {
            devices = deviceArray.compactMap { DeviceSummary(json: $0) }
        }
        KLog.d("📱 Devices: \(devices.count) (\(devices.map { "\($0.name)[\($0.role.rawValue)]" }.joined(separator: ", ")))")

        let githubClientId = message["githubClientId"] as? String
        let relayVersion = message["relayVersion"] as? String

        // Persist device credentials
        storedDeviceId = deviceId
        UserDefaults.standard.set(deviceId, forKey: Self.deviceIdKey)

        // Mark transport as authenticated
        appState.wsClient?.setAuthenticated(true)

        // Notify AppState (populates stores, triggers queue drain, etc.)
        appState.onAuthenticated(
            deviceId: deviceId,
            user: user,
            devices: devices,
            githubClientId: githubClientId,
            relayVersion: relayVersion
        )
    }

    /// Process an `auth_error` from the relay.
    func handleAuthError(message: [String: Any]) {
        guard let appState else { return }

        let reason = message["message"] as? String
            ?? message["reason"] as? String

        if storedDeviceId != nil {
            // Stored credentials were rejected — clear and surface error
            clearStoredCredentials()
            appState.onAuthFailed(
                error: reason ?? "Authentication failed. Please scan a new pairing QR code."
            )
        } else {
            appState.onAuthFailed(
                error: reason ?? "Authentication failed. Scan a pairing QR code to get started."
            )
        }
    }

    // MARK: - Credential Management

    func clearStoredCredentials() {
        storedDeviceId = nil
        UserDefaults.standard.removeObject(forKey: Self.deviceIdKey)
        try? keychain.deleteAllKeys()
    }

    /// Authenticate with a GitHub OAuth code.
    func authenticateWithGitHubCode(_ code: String) {
        pairingToken = nil
        // Build and send auth message with github_oauth method
        let device: [String: Any?] = [
            "name": "Kraki iOS",
            "role": "app",
            "kind": "ios",
            "deviceId": storedDeviceId,
        ]
        let cleanDevice = device.compactMapValues { $0 }
        let message: [String: Any] = [
            "type": "auth",
            "auth": ["method": "github_oauth", "code": code],
            "device": cleanDevice,
        ]
        sendRaw(message)
    }

    /// Authenticate with a pairing token (from QR scan or deep link).
    func authenticateWithPairingToken(_ token: String) {
        pairingToken = token
        authenticate()
    }

    // MARK: - Helpers

    private func sendRaw(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        appState?.wsClient?.sendRaw(string)
    }
}
