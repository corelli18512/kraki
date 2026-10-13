/// Connection lifecycle: dev connect, relay switching, sign out, foreground/background, connection state and auth callbacks.

import SwiftUI
import Observation

extension AppState {
    /// Connect to local relay with open auth — DEBUG only.
    /// Bypasses pairing and OAuth for fast dev iteration.
    ///
    /// The default `relayURL` is `wss://relay.kraki.chat` (prod) for
    /// all build configurations, so this dev path explicitly forces
    /// the URL to the local `pnpm dev` relay (`ws://localhost:4400`,
    /// matching `scripts/dev-local.ts`'s default relay port). On the iOS
    /// Simulator `localhost` resolves to the host Mac, so this just
    /// works when the dev daemon is up.
    func devConnect(port overridePort: Int? = nil) {
        #if DEBUG
        // Local dev is a process-scoped open-auth identity. Keep production
        // pairing/device credentials and RSA keys intact so entering dev mode
        // cannot sign the user's real app out.
        authManager?.pairingToken = nil
        authManager?.usesEphemeralOpenAuth = true
        // `KRAKI_LOCAL_RELAY_PORT` env override matches `scripts/dev-local.ts`.
        let port = overridePort.map(String.init) ?? ProcessInfo.processInfo.environment["KRAKI_LOCAL_RELAY_PORT"] ?? "4400"
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
        #if KRAKI_DIAG
        KrakiDiag.phase("logout")
        #endif
        #if os(iOS)
        // Before the socket closes: stop pushes to this device, clear its
        // notifications (C2 of the 2026-10-01 review).
        pushManager?.handleSignOut()
        #elseif os(macOS)
        Self.onMacNotificationsMain { $0.handleSignOut(appState: self) }
        #endif
        #if os(macOS)
        signedOutByUser = true
        #endif
        wsClient?.disconnect()
        #if os(macOS)
        localLink?.stop()
        #endif
        resetIdentity(clearRelayURL: true)
    }

    /// Drop everything tied to the current device identity: credentials, the
    /// decrypt pipeline (its router caches the old private key), Pulse
    /// streams, and the per-account stores and outbox. Used by sign-out and
    /// when the relay proves the stored credentials invalid (device removed,
    /// key mismatch); without it a re-pair in the same process could not
    /// decrypt anything and a different account would inherit old state.
    func resetIdentity(clearRelayURL: Bool) {
        pulseManager?.resetForIdentityChange()
        // The old decrypt pipeline may already have queued main-actor work.
        // Retire its router as well as the transport before clearing stores.
        messageRouter?.retireIdentity()
        let router = MessageRouter(appState: self)
        messageRouter = router
        wsClient?.onMessage = { [weak router] data in router?.handleRawMessage(data) }
        authManager?.clearStoredCredentials()
        // A new sign-in is a new device: computers pair it again.
        resetDeviceTrust()
        preferencesManager?.resetVocabulary()
        if clearRelayURL { clearStoredRelayURL() }
        deviceId = nil
        user = nil
        githubClientId = nil
        relayVersion = nil
        voiceCapability = nil
        iosVoiceComposer.discard()
        voiceInputController.forgetLease()
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
        messageProvider?.clear()
        sessionSubscriptionController = SessionSubscriptionController(host: self)
    }

    /// Called when the app returns to foreground. Reset backoff and
    /// kick a fresh connect immediately so the user doesn't have to
    /// wait out a long backoff timer that started in the background.
    func handleForegroundRehydrate(forceReconnect: Bool = false) {
        #if os(iOS)
        // Back before a deferred teardown ran: nothing was closed.
        if backgroundVoiceFinisher.isActive { backgroundVoiceFinisher.cancel(); backgroundVoiceClientID = nil }
        #endif
        if isInBackground {
            isInBackground = false
            // The debounce restarts now: a quick foreground reconnect never
            // shows "Reconnecting".
            updateReconnectingIndicator()
        }
        #if KRAKI_DIAG
        KrakiDiag.phase("active")
        #endif
        noteVisible()
        #if KRAKI_DIAG && !KRAKI_DIAG_TEST_BUILD
        // A notice deferred behind an open permission prompt gets another chance.
        if connectionStatus == .connected { Task { @MainActor in PerformanceNotice.shared.authenticated() } }
        #endif
        updateReadVisibility(appForeground: true, conversationVisible: true)
        #if os(iOS)
        Task { await pushManager?.handleForeground() }
        #endif
        voiceInputController.resumeWarmConnection()
        // A first sign-in that was interrupted by going to the background
        // (no auth_ok yet) must resume too; only skip when there is nothing
        // to sign in with (the login/pairing screen owns that connection).
        #if os(macOS)
        let hasCredentials = isSigningInWithCredentials
        #else
        let hasCredentials = hasStoredCredentials
        #endif
        guard hasCompletedInitialConnect || hasCredentials else { return }
        if !forceReconnect, let wsClient, wsClient.state != .disconnected { return }
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
        #if KRAKI_DIAG
        KrakiDiag.phase("inactive")
        #endif
        #if os(iOS)
        if let owner = iosVoiceComposer.sessionID { iosVoiceComposer.depart(sessionID: owner) }
        #endif
        updateReadVisibility(appForeground: false, conversationVisible: false)
    }

    func handleBackground() {
        isInBackground = true
        stability.appHidden()
        messageRouter?.replyMetrics.backgrounded()
        noteOrderlyExit()
        updateReconnectingIndicator()
        #if KRAKI_DIAG
        KrakiDiag.phase("background", pending: commandSender?.outbox.values.reduce(0) { $0 + $1.count } ?? 0)
        #endif
        updateReadVisibility(appForeground: false, conversationVisible: false)
        sessionStore.flushCache()
        deviceStore.flushCache()
        #if os(iOS)
        // A sent voice message still being corrected: keep the voice and relay
        // sockets for a short background task so it goes out as it would in
        // the foreground. Otherwise (or if that runs out) keep everything
        // heard — a draft, or a not-sent bubble with the original transcript.
        if case .staged(let clientID) = iosVoiceComposer.operation?.phase {
            backgroundVoiceClientID = clientID
            if backgroundVoiceFinisher.beginIfNeeded() { return }
        }
        iosVoiceComposer.retireKeepingDraft()
        #endif
        tearDownForBackground()
    }

    /// Close the voice and relay sockets for the background (APNs takes over).
    func tearDownForBackground() {
        voiceInputController.suspendWarmConnection()
        wsClient?.disconnect()
    }

    /// Called by the WS client whenever it bumps its retry counter.
    func updateReconnectAttempt(_ attempt: Int) {
        reconnectAttempt = attempt
    }

    func handleConnectionStateChange(_ state: WebSocketState) {
        #if KRAKI_DIAG
        let diagState: String
        switch state {
        case .connected: diagState = "connected"
        case .disconnected: diagState = "disconnected"
        case .connecting: diagState = "connecting"
        }
        KrakiDiag.record(.connection, [.state: .tag(diagState), .attempt: .int(reconnectAttempt)])
        #endif
        switch state {
        case .connected: stability.socketOpen()
        case .connecting:
            // Every connection path (launch, CLI login, relay switch, dev)
            // passes here: the first attempt of the process opens the cold
            // record.
            startStabilityTracking()
            if !isInBackground { noteVisible() }
            stability.connecting()
        case .disconnected: break
        }
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
        stability.authenticated()

        // The relay rejects Pulse frames before auth and only starts its peer
        // endpoint after sending auth_ok. Start our endpoint at the same
        // boundary; doing this on raw WebSocket connect loses the hello on a
        // challenge reconnect and leaves session_list/history requests stuck.
        pulseManager?.onConnected()

        deviceStore.setDevices(devices)
        // Pair with computers pinned from a QR code or from this Mac.
        deviceTrustDevicesChanged()

        // Drain any queued encrypted messages
        messageRouter?.drainQueue()

        #if os(macOS)
        localLink?.start()
        #endif
        sessionSubscriptionController?.resume()

        // Re-register push token if user has it enabled
        #if os(iOS)
        pushManager?.onAuthenticated()
        #elseif os(macOS)
        Self.onMacNotificationsMain { $0.onAuthenticated(appState: self) }
        #endif
        voiceInputController.prepare()
        #if KRAKI_DIAG && !KRAKI_DIAG_TEST_BUILD
        Task { @MainActor in PerformanceNotice.shared.authenticated() }
        #endif
    }

    func onAuthFailed(error: String) {
        self.lastError = error
        self.connectionStatus = .awaitingLogin
    }
}
