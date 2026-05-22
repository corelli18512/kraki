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

    /// Suite name for the app group UserDefaults shared with the NSE.
    private static let appGroupSuite = "group.chat.kraki.ios"

    /// UserDefaults shared between the app and KrakiNotification extension.
    /// The NSE reads `deviceId` from here when decrypting push payloads.
    private static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: appGroupSuite) ?? .standard
    }

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
        // Prefer app group; migrate from standard defaults on first run.
        if let id = Self.sharedDefaults.string(forKey: Self.deviceIdKey) {
            self.storedDeviceId = id
        } else if let legacy = UserDefaults.standard.string(forKey: Self.deviceIdKey) {
            self.storedDeviceId = legacy
            Self.sharedDefaults.set(legacy, forKey: Self.deviceIdKey)
        } else {
            self.storedDeviceId = nil
        }
    }

    // MARK: - Auth Flow

    /// Decide what to do on a freshly-opened WS connection.
    ///
    /// - If we already have a pairing token (just scanned a QR) or a
    ///   stored deviceId (returning user), proceed straight to `authenticate()`.
    ///   The relay's response will include `githubClientId` etc. in
    ///   `auth_ok`, so no separate fetch is needed.
    /// - Otherwise we don't know yet what auth methods this relay
    ///   supports — particularly whether GitHub OAuth is configured —
    ///   so request `auth_info` first. Release builds land here on
    ///   first launch; the response unlocks the GitHub button on
    ///   LoginView via `appState.githubClientId`.
    func bootstrapAuth() {
        if pairingToken != nil || storedDeviceId != nil {
            authenticate()
        } else {
            requestAuthInfo()
        }
    }

    /// Send a pre-auth `auth_info` request to ask the relay which
    /// authentication methods it supports and what its GitHub OAuth
    /// client id is. Response handled by `handleAuthInfoResponse`.
    func requestAuthInfo() {
        KLog.d("ℹ️ Requesting auth_info from relay")
        sendRaw(["type": "auth_info"])
    }

    /// Process the relay's `auth_info_response`. Stores githubClientId
    /// on AppState (so the LoginView's GitHub button can present an
    /// OAuthView with a real client id), then drops connectionStatus
    /// back to `.awaitingLogin` so the login UI is interactive.
    /// If the user already had a pairingToken or storedDeviceId when
    /// the WS came up, `bootstrapAuth` would have skipped this path,
    /// so we don't need to consider those branches here.
    func handleAuthInfoResponse(message: [String: Any]) {
        guard let appState else { return }
        let clientId = message["githubClientId"] as? String
        let methods = message["methods"] as? [String] ?? []
        KLog.d("ℹ️ auth_info_response: methods=\(methods), githubClientId=\(clientId?.prefix(8) ?? "nil")")
        appState.onAuthInfoReceived(githubClientId: clientId)
    }

    /// Build and send the initial `auth` message.
    ///
    /// Priority order:
    /// 1. Pairing token (explicit user action — scan QR)
    /// 2. Stored device ID (returning user — challenge-response)
    /// 3. Open auth (new user, no credentials) — only works against
    ///    relays configured to permit open auth (local dev). Prod
    ///    rejects this; clients should request `auth_info` first and
    ///    route the user through GitHub OAuth or pairing instead.
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
                provider: userDict["provider"] as? String,
                email: userDict["email"] as? String
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

        // Persist device credentials (write to BOTH so NSE can read via app group)
        storedDeviceId = deviceId
        Self.sharedDefaults.set(deviceId, forKey: Self.deviceIdKey)
        UserDefaults.standard.set(deviceId, forKey: Self.deviceIdKey)

        // Mark transport as authenticated
        appState.wsClient?.setAuthenticated(true)

        // Hydrate server-side preferences (theme, etc.) before
        // notifying AppState — that way any view watching the
        // `colorScheme` AppStorage key sees the right value on its
        // first render after login. Web does the same in `auth_ok`'s
        // `applyPreferences` path.
        if let userDict = message["user"] as? [String: Any],
           let prefs = userDict["preferences"] as? [String: Any] {
            Task { @MainActor in
                appState.preferencesManager?.applyRemote(prefs)
            }
        }

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

        let code = message["code"] as? String
        let reason = message["message"] as? String
            ?? message["reason"] as? String

        // wrong_region: relay tells us our user is pinned to a different
        // region. The server includes the deviceId it just registered for
        // us so we can use challenge-response auth at the redirected relay.
        if code == "wrong_region", let redirect = message["redirect"] as? String {
            KLog.d("🌏 wrong_region → \(redirect)")
            if let newDeviceId = message["deviceId"] as? String {
                storedDeviceId = newDeviceId
                Self.sharedDefaults.set(newDeviceId, forKey: Self.deviceIdKey)
                UserDefaults.standard.set(newDeviceId, forKey: Self.deviceIdKey)
            }
            appState.redirectToRelay(redirect)
            return
        }

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
        Self.sharedDefaults.removeObject(forKey: Self.deviceIdKey)
        UserDefaults.standard.removeObject(forKey: Self.deviceIdKey)
        try? keychain.deleteAllKeys()
    }

    /// Authenticate with a GitHub OAuth code.
    ///
    /// `codeVerifier` + `redirectUri` are the PKCE verifier and the
    /// exact `redirect_uri` value used when starting the OAuth flow.
    /// Both are forwarded to the relay, which passes them on to
    /// GitHub's token-exchange endpoint. GitHub requires the verifier
    /// when the original authorize request was PKCE-protected and
    /// matches the redirect_uri against the URL used at authorize
    /// time, defeating code interception and code substitution.
    func authenticateWithGitHubCode(
        _ code: String,
        codeVerifier: String? = nil,
        redirectUri: String? = nil
    ) {
        pairingToken = nil
        appState?.connectionStatus = .authenticating
        // Build and send auth message with github_oauth method
        let device: [String: Any?] = [
            "name": "Kraki iOS",
            "role": "app",
            "kind": "ios",
            "deviceId": storedDeviceId,
        ]
        let cleanDevice = device.compactMapValues { $0 }
        var oauthAuth: [String: Any] = ["method": "github_oauth", "code": code]
        if let codeVerifier { oauthAuth["codeVerifier"] = codeVerifier }
        if let redirectUri { oauthAuth["redirectUri"] = redirectUri }
        let message: [String: Any] = [
            "type": "auth",
            "auth": oauthAuth,
            "device": cleanDevice,
        ]
        sendRaw(message)
    }

    /// Authenticate with a pairing token (from QR scan or deep link).
    func authenticateWithPairingToken(_ token: String) {
        pairingToken = token
        appState?.connectionStatus = .authenticating
        authenticate()
    }

    // MARK: - Helpers

    private func sendRaw(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        appState?.wsClient?.sendRaw(string)
    }
}
