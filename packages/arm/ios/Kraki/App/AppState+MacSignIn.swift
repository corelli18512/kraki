/// Signing this Mac in with the built-in Kraki's own login, staying signed out after Sign Out, and the sign-in watchdog.

import SwiftUI
import Observation

extension AppState {
    #if os(macOS)

    /// Sign Out on this Mac. The app signs in with the built-in Kraki's own
    /// login, which stays (this Mac keeps serving its agents, like Kraki for
    /// Windows), so until the person signs in again the app must not quietly
    /// reuse it: not at launch, not from the sign-in watchdog.
    static let signedOutByUserKey = "mac.signedOutByUser"
    static let signedOutAtKey = "mac.signedOutAt"
    var signedOutByUser: Bool {
        get { signedOutDefaults.bool(forKey: Self.signedOutByUserKey) }
        set {
            signedOutDefaults.set(newValue, forKey: Self.signedOutByUserKey)
            if newValue { signedOutDefaults.set(Date().timeIntervalSince1970, forKey: Self.signedOutAtKey) }
            else { signedOutDefaults.removeObject(forKey: Self.signedOutAtKey) }
        }
    }

    /// Signed out, and no new sign-in since. A GitHub sign-in saved by the
    /// local Kraki afterwards (`kraki connect` in Terminal, or setup) is the
    /// person signing in again: it ends the Sign Out, so returning from
    /// Terminal still signs in by itself.
    var staysSignedOut: Bool {
        guard signedOutByUser else { return false }
        let at = signedOutDefaults.double(forKey: Self.signedOutAtKey)
        if at > 0, let signIn = AuthManager.cliSignInDate(), signIn.timeIntervalSince1970 > at {
            signedOutByUser = false
            return false
        }
        return true
    }

    /// Reuse the locally-installed `kraki` CLI's login (relay + GitHub token
    /// from `~/.kraki` / `gh auth token`) to authenticate this Mac as an arm
    /// device — no manual pairing required. Returns true when a CLI login was
    /// found and a connection has been started; false when the CLI isn't
    /// installed/logged in (caller falls back to the login screen).
    @discardableResult
    func attemptCLILogin(ghDeadline: TimeInterval = AuthManager.launchGhDeadline) async -> Bool {
        if staysSignedOut {
            KLog.diag("Mac CLI login skipped: signed out on this Mac")
            return false
        }
        // SwiftUI WindowGroup tasks can be recreated while the app is already
        // connecting/authenticating. Loading the CLI token twice used to call
        // connect twice and leave parallel sockets behind.
        if cliLoginInFlight { return true }
        startAuthRecoveryWatchdog()
        if authManager?.cliGitHubToken != nil {
            switch connectionStatus {
            case .connected, .authenticating:
                return true
            default:
                // A token is loaded but the socket is not signed in with it
                // (e.g. still open from a failed attempt): connect() alone is
                // a no-op on an open socket, so replace it.
                reconnectForNewCredentials(reason: "cli_token_retry")
                return true
            }
        }
        cliLoginInFlight = true
        defer { cliLoginInFlight = false }
        guard let creds = await AuthManager.loadCLICredentials(ghDeadline: ghDeadline) else {
            // The quick launch probe can time out on a cold `gh` (first run
            // after an OS update). Keep looking in the background with a
            // realistic deadline instead of giving up for this process.
            if ghDeadline < AuthManager.recoveryGhDeadline {
                Task { @MainActor [weak self] in
                    await self?.recoverCLIAuthentication(reason: "launch_probe_timeout")
                }
            }
            return false
        }
        adoptCLICredentials(creds)
        return true
    }

    /// Use a CLI credential now: token auth with process-local keys, on a
    /// fresh socket unless the current one is already signed in.
    func adoptCLICredentials(_ creds: (relay: String, token: String)) {
        // Token auth is independent of the old device's Keychain ACL. Use
        // process-local keys so a denied Keychain prompt cannot strand the
        // Mac before the relay refreshes this device's public keys.
        authManager?.useEphemeralKeysForCurrentProcess()
        if creds.relay != relayURL { relayURL = creds.relay }
        // Sign Out resets AppState's relay but not the socket's, so compare
        // with the socket: only a real change schedules a new connection.
        let socketRelayChanged = wsClient.map { $0.relayURL != creds.relay } ?? false
        if socketRelayChanged { wsClient?.setRelayURL(creds.relay) }
        authManager?.cliGitHubToken = creds.token
        KLog.diag("Auth: using local CLI login")
        // setRelayURL schedules the replacement connection itself. Calling
        // connect again here would briefly create two authenticated sockets.
        guard !socketRelayChanged, connectionStatus != .connected else { return }
        reconnectForNewCredentials(reason: "cli_token")
    }

    /// `connect()` is ensure-connected: it does nothing while a socket is
    /// already open, so a credential obtained mid-attempt was never sent.
    func reconnectForNewCredentials(reason: String) {
        guard let wsClient else { return }
        if wsClient.state == .disconnected {
            connect()
        } else {
            KLog.diag("Auth: reconnecting to sign in with new credentials (\(reason))")
            connectionStatus = .connecting
            wsClient.resetBackoffAndReconnect()
        }
    }

    /// Find the local CLI login with a realistic `gh` deadline and sign in
    /// with it. Falls back to the relay login flow when there is none.
    func recoverCLIAuthentication(reason: String) async {
        guard !cliRecoveryInFlight, connectionStatus != .connected, !staysSignedOut else { return }
        cliRecoveryInFlight = true
        defer { cliRecoveryInFlight = false }
        KLog.diag("Auth: recovering sign-in (\(reason))")
        if authManager?.cliGitHubToken == nil,
           let creds = await AuthManager.loadCLICredentials(ghDeadline: AuthManager.recoveryGhDeadline) {
            guard connectionStatus != .connected else { return }
            adoptCLICredentials(creds)
            return
        }
        guard connectionStatus != .connected else { return }
        if authManager?.cliGitHubToken != nil || hasStoredCredentials {
            reconnectForNewCredentials(reason: reason)
        } else if connectionStatus == .awaitingLogin, wsClient?.state != .disconnected {
            KLog.diag("Auth: no CLI login found — showing login")
            authManager?.requestAuthInfo()
        }
    }

    func startAuthRecoveryWatchdog() {
        guard authWatchdogTask == nil else { return }
        authWatchdogTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                let interval = self?.authWatchdogInterval ?? 5
                try? await Task.sleep(for: .seconds(interval))
                guard let self else { return }
                await self.authWatchdogTick()
            }
        }
    }

    func authWatchdogTick() async {
        guard !isInBackground, connectionStatus != .connected,
              isSigningInWithCredentials,
              let since = notConnectedSince else { return }
        let transportOpen = wsClient?.state == .connected
        let missingToken = authManager?.cliGitHubToken == nil
        // A plain outage (no transport) with a token is the socket's job.
        guard transportOpen || missingToken else { return }
        let backoff = min(authStuckThreshold * pow(2, Double(authRecoveryAttempts)), 60)
        let reference = max(since, lastAuthRecoveryAt ?? .distantPast)
        guard Date().timeIntervalSince(reference) >= backoff else { return }
        authRecoveryAttempts += 1
        lastAuthRecoveryAt = Date()
        await recoverCLIAuthentication(reason: transportOpen ? "stuck_unauthenticated" : "no_cli_token")
    }
    #endif
}
