import Foundation

/// A pairing code from a Kraki QR link: `https://app.kraki.chat/?relay=…&token=…`.
///
/// The same link is opened by the in-app scanner, by the iPhone Camera
/// (universal link) and by pasting it manually. All of them go through
/// `AppState.openPairingLink(_:)` so the safety checks are identical.
struct PairingLink: Equatable {
    let token: String
    /// Relay that issued the token. Pairing tokens live on one regional relay
    /// (e.g. `cn.relay.kraki.chat`), so it must be honoured when present.
    let relay: String?
    /// Fingerprint of the computer's encryption key (`fp`), when present.
    var keyFingerprint: String?
    /// Device trust (DeviceTrust.swift): the computer's ID, identity and
    /// X25519 keys, and the one-time pairing secret. Read optically from the
    /// QR, so the relay never sees them.
    var trust: (tentacleId: String, identityKey: String, encryptionKey: String, secret: String)?

    static func == (lhs: PairingLink, rhs: PairingLink) -> Bool {
        lhs.token == rhs.token && lhs.relay == rhs.relay && lhs.keyFingerprint == rhs.keyFingerprint
            && lhs.trust?.tentacleId == rhs.trust?.tentacleId && lhs.trust?.secret == rhs.trust?.secret
    }

    init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else { return nil }
        let relay = components.queryItems?.first(where: { $0.name == "relay" })?.value
        self.token = token
        self.relay = (relay?.isEmpty ?? true) ? nil : relay
        let fp = components.queryItems?.first(where: { $0.name == "fp" })?.value
        self.keyFingerprint = (fp?.isEmpty ?? true) ? nil : fp
        let item = { (name: String) in components.queryItems?.first(where: { $0.name == name })?.value }
        if let tid = item("tid"), !tid.isEmpty,
           let ik = item("ik"), DeviceTrustWire.isRawKey(ik),
           let xk = item("xk"), DeviceTrustWire.isRawKey(xk),
           let ps = item("ps"), DeviceTrustWire.fromB64url(ps)?.count == 16 {
            self.trust = (tid, ik, xk, ps)
        }
    }

    init?(string: String) {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url: url)
    }

    /// Kraki-operated relays and this machine's own relay need no confirmation;
    /// anything else could be a crafted QR code pointing at a stranger's server.
    static func isTrustedRelay(_ relay: String) -> Bool {
        guard let url = URL(string: relay),
              let scheme = url.scheme?.lowercased(), scheme == "wss" || scheme == "ws",
              let host = url.host?.lowercased() else { return false }
        if ["localhost", "127.0.0.1", "::1"].contains(host) { return true }
        // Kraki's relays only over TLS: a `ws://` link to a kraki.chat host
        // would pair and authenticate in cleartext.
        return scheme == "wss" && (host == "kraki.chat" || host.hasSuffix(".kraki.chat"))
    }

    var needsRelayConfirmation: Bool {
        guard let relay else { return false }
        return !Self.isTrustedRelay(relay)
    }

    var relayHost: String {
        guard let relay else { return "" }
        guard let url = URL(string: relay), let host = url.host else { return relay }
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}

/// A pairing link waiting for the user's decision.
enum PairingLinkPrompt: Identifiable, Equatable {
    /// The link names a relay that is not Kraki's.
    case confirmRelay(PairingLink)
    /// This phone is already connected; pairing again would only matter for a
    /// different account, which requires logging out first.
    case alreadyConnected(PairingLink, login: String?)
    /// The code names a computer this app is paired with, under another key.
    case replaceComputerKey(PairingLink, name: String)

    var id: String {
        switch self {
        case .confirmRelay(let link): return "relay:\(link.token)"
        case .alreadyConnected(let link, _): return "connected:\(link.token)"
        case .replaceComputerKey(let link, _): return "rekey:\(link.token)"
        }
    }

    var link: PairingLink {
        switch self {
        case .confirmRelay(let link), .alreadyConnected(let link, _), .replaceComputerKey(let link, _): return link
        }
    }
}

extension AppState {
    /// Entry point for every pairing link (scanner, Camera universal link,
    /// manual paste). Asks first when the relay is untrusted or the phone is
    /// already connected; otherwise pairs immediately.
    func openPairingLink(_ link: PairingLink, relayConfirmed: Bool = false, keyChangeConfirmed: Bool = false) {
        if link.needsRelayConfirmation && !relayConfirmed {
            pendingPairingPrompt = .confirmRelay(link)
            return
        }
        // Other keys for a computer this app already pinned: ask first, on
        // every path (also a cold launch before the first connection).
        if !keyChangeConfirmed, let trust = link.trust, pairingLinkChangesKey(link) {
            pendingPairingPrompt = .replaceComputerKey(link, name: deviceStore.devices[trust.tentacleId]?.name ?? "this computer")
            return
        }
        // Already signed in to this account: a QR that carries device trust
        // pairs this app with that computer (the usual "re-scan to pair").
        // The computer must be one of this account's devices; a code from
        // another account falls through to the account-switch prompt.
        if hasStoredCredentials && hasCompletedInitialConnect, let trust = link.trust,
           deviceStore.devices[trust.tentacleId] != nil {
            pairWithComputer(link)
            return
        }
        if hasStoredCredentials && hasCompletedInitialConnect {
            pendingPairingPrompt = .alreadyConnected(link, login: user?.login)
            return
        }
        startPairing(link)
    }

    /// The user chose to switch accounts: drop this identity, then pair.
    func logoutAndPair(_ link: PairingLink) {
        logout()
        startPairing(link)
    }

    private func startPairing(_ link: PairingLink) {
        lastError = nil
        pendingPairingPrompt = nil
        deviceStore.keyPins.pendingQRFingerprint = link.keyFingerprint
        pinFromPairingLink(link)
        if let relay = link.relay, relay != relayURL {
            // Stash the token so the reconnect → bootstrapAuth path sends
            // `method: "pairing"` against the right regional relay.
            KLog.d("🔀 pair: relay mismatch — stashing token + redirecting \(relayURL) → \(relay)")
            authManager?.pairingToken = link.token
            connectionStatus = .authenticating
            redirectToRelay(relay)
        } else if wsClient?.state == .connected {
            authManager?.authenticateWithPairingToken(link.token)
        } else {
            authManager?.pairingToken = link.token
            connectionStatus = .authenticating
            requestConnect()
        }
    }
}
