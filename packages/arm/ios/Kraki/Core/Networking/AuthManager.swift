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
#if os(iOS)
import AuthenticationServices
import UIKit
#endif

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

    /// UserDefaults shared between the app and KrakiNotification extension in
    /// production. macOS Debug is deliberately isolated from the stable GUI.
    private static var sharedDefaults: UserDefaults {
        #if os(macOS)
        #if DEBUG
        return UserDefaults(suiteName: "chat.kraki.mac.dev") ?? .standard
        #else
        return UserDefaults(suiteName: "chat.kraki.mac") ?? .standard
        #endif
        #else
        return UserDefaults(suiteName: appGroupSuite) ?? .standard
        #endif
    }

    // MARK: State

    /// The device ID saved from a prior successful auth, loaded from UserDefaults.
    private(set) var storedDeviceId: String?

    /// Device ID we received from a `wrong_region` redirect — held in
    /// memory only until the redirected relay confirms it with
    /// `auth_ok`. We deliberately do NOT persist this to UserDefaults
    /// or the app-group store yet, because if the redirected relay is
    /// unreachable or rejects auth we want the user's previous
    /// identity (`storedDeviceId`) to remain intact for retry.
    private var pendingRegionDeviceId: String?

    /// Device id we should use when speaking to the relay right now.
    /// Dev open-auth deliberately has no persisted relay identity: the local
    /// relay mints an ephemeral device without replacing production credentials.
    private var activeDeviceId: String? {
        guard !usesEphemeralOpenAuth else { return nil }
        return pendingRegionDeviceId ?? storedDeviceId
    }

    /// A one-time pairing token (e.g. from a QR code scan or deep link).
    var pairingToken: String?

    /// Set by `AppState.devConnect()` for the lifetime of a local-dev process.
    /// Every reconnect uses open auth with an ephemeral relay identity. This
    /// never deletes or overwrites production device credentials or RSA keys.
    var usesEphemeralOpenAuth: Bool = false

    /// Platform-aware device name/kind advertised during auth.
    #if os(macOS)
    private static let platformDeviceName = "Kraki Mac"
    private static let platformDeviceKind = "desktop"
    #else
    private static let platformDeviceName = "Kraki iOS"
    private static let platformDeviceKind = "ios"
    #endif

    #if os(macOS)
    /// Use process-local RSA keys for token authentication when the old
    /// Keychain ACL is unavailable. The token authenticates the user; the
    /// fresh public keys let the relay continue delivering encrypted data.
    func useEphemeralKeysForCurrentProcess() {
        keychain.activateEphemeralKeys()
    }

    /// Reuse the locally installed CLI credential for every authentication
    /// attempt in this process. A WebSocket can drop after the auth frame but
    /// before `auth_ok`; making this one-shot caused the next automatic retry
    /// to fall back to stale Keychain challenge auth. The token remains
    /// process-local, is never logged/persisted by Kraki, and is cleared on
    /// explicit logout through `clearStoredCredentials()`.
    var cliGitHubToken: String?

    /// Reuse the locally-installed `kraki` CLI's login so the Mac app can
    /// sign in without a separate pairing/OAuth dance. Returns the relay
    /// URL + GitHub token when the CLI is installed and logged in.
    /// Mirrors the kraki daemon's own token resolution order: `gh auth token`
    /// (gh CLI) first, then the saved device-flow token at ~/.kraki/github-token.
    /// The Mac app is not sandboxed, so `~/.kraki` is readable and `gh` spawnable.
    static func loadCLICredentials() async -> (relay: String, token: String)? {
        let krakiHome = NSHomeDirectory() + "/.kraki"
        guard let configData = try? Data(contentsOf: URL(fileURLWithPath: krakiHome + "/config.json")),
              let config = try? JSONSerialization.jsonObject(with: configData) as? [String: Any],
              let relay = config["relay"] as? String,
              relay.hasPrefix("ws") else { return nil }

        // 1. gh CLI token — the daemon's primary path (used whenever `gh` is
        //    authenticated, which is the common case on a dev machine).
        if let ghToken = await runGhAuthToken(), !ghToken.isEmpty {
            return (relay, ghToken)
        }
        // 2. Saved device-flow token (~/.kraki/github-token).
        if let raw = try? String(contentsOfFile: krakiHome + "/github-token", encoding: .utf8) {
            let saved = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !saved.isEmpty { return (relay, saved) }
        }
        return nil
    }

    /// Run `gh auth token` via a login shell and return its trimmed output,
    /// or nil if gh is unavailable / not authenticated. Login shell so a
    /// GUI-launched app still resolves gh from the user's normal PATH.
    private static func runGhAuthToken() async -> String? {
        await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-lc", "gh auth token"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { return nil }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                return String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                return nil
            }
        }.value
    }
    #endif

    #if os(iOS)
    /// Live ASWebAuthenticationSession + its presentation provider. Held
    /// strongly while the OAuth sheet is up — the system retains them
    /// weakly, so without a strong reference they'd dealloc and the
    /// sheet would fail with `presentationContextNotProvided`.
    private var oauthSession: ASWebAuthenticationSession?
    private var oauthContextProvider: OAuthPresentationContextProvider?
    #endif

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
        // `activeDeviceId` includes `pendingRegionDeviceId` — the id the
        // previous relay just minted for us as part of a wrong_region
        // redirect. Without this branch we'd reconnect to the new relay
        // (cn / us / etc.), see no storedDeviceId, and fall through to
        // `requestAuthInfo()` — silently dropping the in-flight OAuth /
        // pairing handoff. User experience: tap GitHub → auth sheet
        // completes → app sits on login screen forever.
        let hasActiveDeviceId = activeDeviceId != nil
        #if os(macOS)
        let hasCLIToken = cliGitHubToken != nil
        #else
        let hasCLIToken = false
        #endif
        if pairingToken != nil || hasActiveDeviceId || usesEphemeralOpenAuth || hasCLIToken {
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

        let cleanDevice = buildDeviceDict(
            deviceId: activeDeviceId,
            signingPublicKey: signingPublicKey,
            encryptionPublicKey: encryptionPublicKey
        )

        if usesEphemeralOpenAuth {
            KLog.d("🔓 Auth method: open (ephemeral local-dev identity)")
            sendRaw([
                "type": "auth",
                "auth": ["method": "open"],
                "device": cleanDevice,
            ])
            return
        }

        #if os(macOS)
        if let token = cliGitHubToken {
            KLog.d("🔑 Auth method: github_token (local kraki CLI)")
            sendRaw([
                "type": "auth",
                "auth": ["method": "github_token", "token": token],
                "device": cleanDevice,
            ])
            return
        }
        #endif

        var message: [String: Any]

        if let token = pairingToken {
            KLog.d("🎫 Auth method: pairing")
            message = [
                "type": "auth",
                "auth": ["method": "pairing", "token": token],
                "device": cleanDevice,
            ]
            pairingToken = nil
        } else if let deviceId = activeDeviceId {
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
                "deviceId": activeDeviceId ?? "",
                "signature": signature,
            ]
            sendRaw(response)
        } catch {
            KLog.d("⚠️ Challenge signing failed: \(error)")
            #if os(macOS)
            // A denied Keychain ACL must be recoverable. Re-authenticate with
            // the existing CLI token and process-local keys instead of leaving
            // the socket authenticated-but-stuck on the login screen.
            Task { @MainActor [weak self] in
                guard let self, let appState = self.appState else { return }
                appState.lastError = "Keychain access was denied. Retrying with CLI credentials…"
                if !(await appState.attemptCLILogin()) {
                    appState.onAuthFailed(
                        error: "Keychain access was denied. Allow Kraki in Keychain Access or sign in again with the CLI."
                    )
                }
            }
            #else
            appState?.onAuthFailed(
                error: "Challenge signing failed: \(error.localizedDescription)"
            )
            #endif
        }
    }

    /// Process a successful `auth_ok` from the relay.
    func handleAuthOk(message: [String: Any]) {
        guard let appState else { return }

        // The deviceId is required — without it we can't address any
        // subsequent commands. A malformed/missing field here would
        // otherwise poison our stored credentials and soft-lock the
        // user out, so we treat it as an auth failure instead.
        guard let deviceId = message["deviceId"] as? String, !deviceId.isEmpty else {
            KLog.d("❌ auth_ok with missing/empty deviceId — failing auth")
            clearStoredCredentials()
            appState.onAuthFailed(error: "Server response missing device identifier.")
            return
        }
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
        let voiceCapability = (message["voice"] as? [String: Any]).flatMap(VoiceCapability.init(json:))

        if usesEphemeralOpenAuth {
            // Keep routing this process with the local relay id, but leave the
            // production challenge identity in persistent storage untouched.
            pendingRegionDeviceId = deviceId
        } else {
            storedDeviceId = deviceId
            pendingRegionDeviceId = nil
            Self.sharedDefaults.set(deviceId, forKey: Self.deviceIdKey)
            UserDefaults.standard.set(deviceId, forKey: Self.deviceIdKey)
            appState.hasStoredCredentials = true
        }

        // Mark transport as authenticated
        appState.wsClient?.setAuthenticated(true)

        // Hydrate server-side preferences (theme, etc.) before
        // notifying AppState — that way any view watching the
        // `colorScheme` AppStorage key sees the right value on its
        // first render after login. Web does the same in `auth_ok`'s
        // `applyPreferences` path.
        if let userDict = message["user"] as? [String: Any],
           let prefs = userDict["preferences"] as? [String: Any] {
            #if os(iOS)
            Task { @MainActor in
                appState.preferencesManager?.applyRemote(prefs)
            }
            #endif
        }

        appState.voiceCapability = voiceCapability
        KLog.d("🎙️ Voice capability: \(voiceCapability == nil ? "unavailable" : "available")")

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
        #if os(macOS)
        let hasCLITokenForLog = cliGitHubToken != nil
        #else
        let hasCLITokenForLog = false
        #endif
        KLog.d("❌ auth_error code=\(code ?? "nil") reason=\(reason ?? "nil") cli=\(hasCLITokenForLog ? 1 : 0) stored=\(storedDeviceId == nil ? 0 : 1)")

        // wrong_region: relay tells us our user is pinned to a different
        // region. The server includes the deviceId it just registered for
        // us so we can use challenge-response auth at the redirected relay.
        // We hold the new id transiently — only persisting once the
        // redirected relay confirms it with `auth_ok`. That way a failed
        // redirect doesn't clobber the user's previous identity.
        if code == "wrong_region", let redirect = message["redirect"] as? String {
            KLog.d("🌏 wrong_region → \(redirect)")
            if let newDeviceId = message["deviceId"] as? String, !newDeviceId.isEmpty {
                pendingRegionDeviceId = newDeviceId
            }
            appState.redirectToRelay(redirect)
            return
        }

        #if os(macOS)
        let recoverableCLIOutage = cliGitHubToken != nil
            && (code == "service_unavailable" || code == "auth_unavailable")
        #else
        let recoverableCLIOutage = false
        #endif

        if usesEphemeralOpenAuth {
            // A local relay failure says nothing about production credentials.
            // Keep them untouched and let the dev socket retry normally.
            appState.lastError = reason ?? "Local development relay authentication failed. Reconnecting…"
            appState.wsClient?.resetBackoffAndReconnect()
        } else if recoverableCLIOutage {
            // The GitHub token has already been loaded and remains process-local.
            // Account-service outages are recoverable: retain local Sessions and
            // retry on a replacement socket instead of falling back to LoginView
            // or stale Keychain challenge auth.
            KLog.d("⏳ CLI auth backend unavailable — keeping token, reconnecting")
            appState.lastError = reason ?? "Authentication service temporarily unavailable. Reconnecting…"
            appState.wsClient?.resetBackoffAndReconnect()
        } else if storedDeviceId != nil {
            // Only destroy the persisted pairing on a DETERMINISTIC failure —
            // a code that proves this device's credentials are actually
            // invalid. A transient outage (account backend unreachable →
            // `auth_unavailable` / `service_unavailable`, or a generic
            // `auth_rejected` that may itself stem from a backend hiccup) must
            // NOT clear the paired device: doing so turned a short
            // account-service timeout into a permanent logout that required a
            // fresh pairing. Mirrors arm-web's `processAuthError` fatal set.
            let fatal = code == "invalid_signature"
                || code == "device_not_found"
                || code == "unknown_device"
                || code == "user_not_found"
            if fatal {
                KLog.d("🚪 Fatal auth error (code=\(code ?? "nil")) — clearing credentials")
                clearStoredCredentials()
                appState.onAuthFailed(
                    error: reason ?? "Authentication failed. Please scan a new pairing QR code."
                )
                if appState.connectionStatus == .awaitingLogin {
                    requestAuthInfo()
                }
            } else {
                // Transient: keep the paired identity and reconnect — the next
                // challenge attempt succeeds once the backend recovers.
                KLog.d("⏳ Transient auth error (code=\(code ?? "nil")) — keeping credentials, reconnecting")
                appState.lastError = reason ?? "Authentication temporarily unavailable. Reconnecting…"
                appState.wsClient?.resetBackoffAndReconnect()
            }
        } else {
            appState.onAuthFailed(
                error: reason ?? "Authentication failed. Scan a pairing QR code to get started."
            )
            if appState.connectionStatus == .awaitingLogin {
                requestAuthInfo()
            }
        }
    }

    // MARK: - Credential Management

    func clearStoredCredentials() {
        storedDeviceId = nil
        pendingRegionDeviceId = nil
        #if os(macOS)
        cliGitHubToken = nil
        #endif
        Self.sharedDefaults.removeObject(forKey: Self.deviceIdKey)
        UserDefaults.standard.removeObject(forKey: Self.deviceIdKey)
        try? keychain.deleteAllKeys()
        appState?.hasStoredCredentials = false
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

        // Mint / load our key pair NOW so the relay can register the
        // device with our public keys on first auth. Without this the
        // relay creates a device row with null publicKey, and any
        // subsequent challenge-response auth (e.g. after a wrong_region
        // redirect) has nothing to verify the signed nonce against —
        // the user appears to "sign in" but lands back on the login
        // screen because the redirected challenge auth silently fails.
        var signingPublicKey: String?
        var encryptionPublicKey: String?
        do {
            let signing = try keychain.getOrCreateSigningKey()
            signingPublicKey = try crypto.exportPublicKeySPKI(signing.publicKey)
            let encryption = try keychain.getOrCreateEncryptionKey()
            encryptionPublicKey = try crypto.exportPublicKeySPKI(encryption.publicKey)
        } catch {
            KLog.d("⚠️ Key generation failed for GitHub OAuth: \(error)")
        }

        let cleanDevice = buildDeviceDict(
            deviceId: storedDeviceId,
            signingPublicKey: signingPublicKey,
            encryptionPublicKey: encryptionPublicKey
        )
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

    #if os(iOS)
    // MARK: - GitHub OAuth

    /// Start the GitHub OAuth flow directly — no intermediate sheet.
    ///
    /// Called from the LoginView's GitHub button. Builds the authorize
    /// URL with PKCE + a fresh CSRF state, opens
    /// `ASWebAuthenticationSession` against the prod web's
    /// `/auth/callback` (intercepted via the Associated Domains
    /// entitlement claiming `webcredentials:app.kraki.chat`), and on
    /// success forwards the code + verifier + redirect_uri to the
    /// relay via `authenticateWithGitHubCode`.
    func startGitHubOAuth(clientId: String) {
        // Defeat double-tap — if a session is already in flight, bail.
        guard oauthSession == nil else {
            return
        }
        // Flip the spinner state FIRST and yield to the runloop so
        // SwiftUI gets a render pass before we kick off the heavy
        // ASWebAuthenticationSession setup. The LoginView swaps its
        // actionArea (which hosts the GitHub button) for a status
        // panel as soon as `isOAuthInFlight` flips — if we then call
        // `session.start()` synchronously in the same tick, the
        // system tries to present `SFAuthenticationViewController`
        // from a view-hierarchy that SwiftUI is in the middle of
        // rebuilding, and silently cancels the session with
        // `canceledLogin` (the VC literally deallocates mid-load).
        // The async hop defers presentation to the next runloop tick,
        // by which time SwiftUI has committed the re-render and the
        // anchor is stable.
        appState?.isOAuthInFlight = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let anchor = self.resolvePresentationAnchor()
            if anchor == nil {
                self.appState?.isOAuthInFlight = false
                return
            }
            self.startGitHubOAuthImpl(clientId: clientId, anchor: anchor)
        }
    }

    /// Pick the foreground-active UIWindowScene rather than grabbing
    /// the first connected scene blindly — on iPad multi-window setups
    /// `connectedScenes.first` may resolve to a backgrounded scene
    /// whose `windows.first` is no longer visible, and
    /// ASWebAuthenticationSession would then fail with
    /// `presentationContextNotProvided`. We also prefer the scene's
    /// `keyWindow` over the deprecated `windows.first`.
    private func resolvePresentationAnchor() -> UIWindow? {
        let activeScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        guard let scene = activeScene else { return nil }
        return scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    }

    private func startGitHubOAuthImpl(clientId: String, anchor: UIWindow?) {
        let csrfState = UUID().uuidString
        let verifier = PKCE.generateCodeVerifier()
        let challenge = PKCE.deriveChallenge(verifier: verifier)
        let redirectURL = "https://\(Self.oauthCallbackHost)\(Self.oauthCallbackPath)"

        var components = URLComponents(string: "https://github.com/login/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "scope", value: "read:user"),
            URLQueryItem(name: "state", value: csrfState),
            URLQueryItem(name: "redirect_uri", value: redirectURL),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let authURL = components.url else {
            appState?.isOAuthInFlight = false
            return
        }

        let callback: ASWebAuthenticationSession.Callback = .https(
            host: Self.oauthCallbackHost,
            path: Self.oauthCallbackPath
        )

        let session = ASWebAuthenticationSession(
            url: authURL,
            callback: callback
        ) { [weak self] callbackURL, error in
            guard let self else { return }
            // Drop the strong refs the moment the system sheet resolves.
            self.oauthSession = nil
            self.oauthContextProvider = nil
            // OAuth window closed (success/cancel/error). The spinner
            // is now owned by `.authenticating` for the success path,
            // or we drop back to `.awaitingLogin` UI for cancel/error.
            self.appState?.isOAuthInFlight = false

            if let asError = error as? ASWebAuthenticationSessionError {
                if asError.code == .canceledLogin {
                    return
                }
                self.appState?.onAuthFailed(error: asError.localizedDescription)
                return
            }
            if let error {
                self.appState?.onAuthFailed(error: error.localizedDescription)
                return
            }

            guard let callbackURL,
                  let cb = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let code = cb.queryItems?.first(where: { $0.name == "code" })?.value,
                  let returned = cb.queryItems?.first(where: { $0.name == "state" })?.value,
                  returned == csrfState else {
                self.appState?.onAuthFailed(error: "Invalid callback from GitHub")
                return
            }

            self.authenticateWithGitHubCode(code, codeVerifier: verifier, redirectUri: redirectURL)
        }

        if let anchor {
            let provider = OAuthPresentationContextProvider(anchor: anchor)
            self.oauthContextProvider = provider
            session.presentationContextProvider = provider
        }
        session.prefersEphemeralWebBrowserSession = false
        self.oauthSession = session
        let started = session.start()
        if !started {
            // System refused to present the sheet. Roll back state so
            // the user can re-tap rather than be stuck on the spinner.
            self.oauthSession = nil
            self.oauthContextProvider = nil
            self.appState?.isOAuthInFlight = false
            self.appState?.onAuthFailed(error: "Couldn't open the GitHub sign-in window. Please try again.")
        }
    }

    /// Callback URL pieces — kept in lockstep with the AASA file at
    /// `https://app.kraki.chat/.well-known/apple-app-site-association`.
    private static let oauthCallbackHost = "app.kraki.chat"
    private static let oauthCallbackPath = "/auth/callback"
    #endif

    // MARK: - Helpers

    /// Build the platform-aware device descriptor sent during auth.
    private func buildDeviceDict(
        deviceId: String?,
        signingPublicKey: String?,
        encryptionPublicKey: String?
    ) -> [String: Any] {
        let dict: [String: Any?] = [
            "name": Self.platformDeviceName,
            "role": "app",
            "kind": Self.platformDeviceKind,
            "deviceId": deviceId,
            "publicKey": signingPublicKey,
            "encryptionKey": encryptionPublicKey,
        ]
        return dict.compactMapValues { $0 }
    }

    private func sendRaw(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        appState?.wsClient?.sendRaw(string)
    }
}

#if os(iOS)
/// Trivial bridge — ASWebAuthenticationSession needs an
/// `ASPresentationAnchor` provider it can call back into to learn
/// which window to mount the system browser sheet on. It holds the
/// provider weakly, so AuthManager keeps a strong reference for the
/// duration of the session.
private final class OAuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    init(anchor: ASPresentationAnchor) { self.anchor = anchor }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}
#endif
