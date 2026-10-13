/// Pairing with computers (device trust — see Core/Crypto/DeviceTrust.swift
/// and docs/e2e-trust.md): coordination, UI state and user actions.

import Foundation
import Observation

/// One app a computer trusts (from its signed `trusted_devices` list).
struct TrustedDeviceEntry: Identifiable, Equatable {
    let id: String
    let name: String
    /// "qr" or "local".
    let via: String
    let pairedAt: String
}

/// What a computer reported about its trust settings.
struct ComputerTrustInfo: Equatable {
    /// As last confirmed by the computer (signed).
    var enforced: Bool
    var policyLocked: Bool
    var devices: [TrustedDeviceEntry]
    /// The computer's policy revision; a change request names it.
    var policyRevision: Int = 0
    /// A change this app asked for and the computer has not confirmed yet.
    var pendingEnforce: Bool?
}

/// How this app stands with one computer.
enum ComputerTrustState: Equatable {
    /// Signed and encrypted to keys pinned at pairing.
    case paired
    /// Pinned from a QR code (or this Mac), waiting for the computer.
    case pairing
    /// The computer refused the pairing (e.g. the code was already used).
    case failed(String)
    /// The computer only serves paired apps and this one is not paired.
    case needsPairing
    /// Not paired; the computer still accepts unpaired apps.
    case notPaired
    /// The computer's Kraki predates device trust.
    case unsupported
}

/// UI-facing device-trust state. The authoritative pins live in
/// `TentacleTrustStore` (thread-safe, read by the decrypt queue and the
/// Notification Service Extension); this mirrors changes for SwiftUI.
@Observable
final class DeviceTrustModel {
    static let shared = DeviceTrustModel()

    /// Bumped whenever a pin changes.
    private(set) var revision = 0
    /// Per computer, its latest signed trusted-devices list.
    var info: [String: ComputerTrustInfo] = [:]
    /// Computers (without a pin) that said they only serve paired apps.
    var pairingRequired: Set<String> = []
    /// Short-lived message after a scan/paste ("Paired with …").
    var feedback: PairingFeedback?
    /// Computers the user dismissed the "needs pairing" banner for.
    var dismissedBanners: Set<String> = []

    @ObservationIgnored private var lastPairRequest: [String: Date] = [:]
    @ObservationIgnored var retryScheduled = false
    static let retryInterval: TimeInterval = 10

    init() {
        TentacleTrustStore.shared.onChange = { [weak self] in self?.revision += 1 }
    }

    func reset() {
        info = [:]
        pairingRequired = []
        feedback = nil
        dismissedBanners = []
        lastPairRequest = [:]
        retryScheduled = false
        revision += 1
    }

    func mayRequestPairing(_ tentacleId: String) -> Bool {
        guard let last = lastPairRequest[tentacleId] else { return true }
        return Date().timeIntervalSince(last) >= Self.retryInterval
    }

    func notePairRequest(_ tentacleId: String) { lastPairRequest[tentacleId] = Date() }
    func clearPairRequest(_ tentacleId: String) { lastPairRequest[tentacleId] = nil }
}

enum PairingFeedback: Equatable, Identifiable {
    case pairing(name: String)
    case paired(name: String)
    case failed(name: String, reason: String)

    var id: String {
        switch self {
        case .pairing(let n): return "pairing:\(n)"
        case .paired(let n): return "paired:\(n)"
        case .failed(let n, let r): return "failed:\(n):\(r)"
        }
    }
}

/// Plain-language text for a refused pairing.
enum PairingFailureText {
    static func describe(_ reason: String) -> String {
        switch reason {
        case "bad_proof": return "The code was already used or has expired. Run `kraki connect` on the computer and scan the new code."
        case "wrong_computer": return "The code belongs to a different computer."
        case "no_local_enrollment": return "Kraki on this Mac could not confirm the pairing. Restart Kraki and try again."
        case "stale", "from_future": return "This device's clock is off. Check the date and time, then scan again."
        case "trust_required": return "This computer only accepts paired devices. Scan its code to pair."
        case "policy_unconfirmed": return "The computer didn't confirm the change. Check that it's online, then try again."
        case "local_keys_missing": return "Kraki on this Mac hasn't set up pairing yet. Update or restart Kraki, then try again."
        default: return "Pairing was refused (\(reason)). Run `kraki connect` on the computer and scan the new code."
        }
    }
}

extension AppState {
    var deviceTrust: DeviceTrustModel { DeviceTrustModel.shared }

    // MARK: State for the UI

    func trustState(for tentacleId: String) -> ComputerTrustState {
        _ = deviceTrust.revision
        if let pin = TentacleTrustStore.shared.pin(tentacleId) {
            if pin.paired { return .paired }
            if pin.lastError == "trust_required" { return .needsPairing }
            if let error = pin.lastError { return .failed(error) }
            return .pairing
        }
        if deviceTrust.pairingRequired.contains(tentacleId) { return .needsPairing }
        let features = deviceStore.deviceFeatures[tentacleId]
        if let features, !features.contains(DeviceTrustWire.feature) { return .unsupported }
        return .notPaired
    }

    /// Safety code of the key pinned for a computer (compare with `kraki devices`).
    func safetyCode(for tentacleId: String) -> String? {
        _ = deviceTrust.revision
        return TentacleTrustStore.shared.pin(tentacleId).flatMap { DeviceTrustWire.safetyCode($0.identityKey) }
    }

    /// This app's own safety code (shown in `kraki devices` as … nothing; for
    /// support and symmetric comparison).
    var ownSafetyCode: String? {
        DeviceIdentityKeys.shared.identityPublicKey.flatMap(DeviceTrustWire.safetyCode)
    }

    /// Computers that need the user to scan their code, for the banner.
    var computersNeedingPairing: [DeviceSummary] {
        _ = deviceTrust.revision
        return deviceStore.devices.values
            .filter { $0.role == .tentacle && !deviceTrust.dismissedBanners.contains($0.id) }
            .filter {
                switch trustState(for: $0.id) {
                case .needsPairing, .failed: return true
                default: return false
                }
            }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    // MARK: Pairing

    /// Pin the computer a pairing QR names. A new QR for an already pinned
    /// computer replaces the pin (re-scanning is how a user re-pairs).
    func pinFromPairingLink(_ link: PairingLink) {
        guard let trust = link.trust else { return }
        TentacleTrustStore.shared.update(trust.tentacleId) { pin in
            pin = TentaclePin(identityKey: trust.identityKey, encryptionKey: trust.encryptionKey,
                              paired: false, secret: trust.secret, via: "qr", pinnedAt: Date())
        }
        deviceTrust.clearPairRequest(trust.tentacleId)
        deviceTrust.pairingRequired.remove(trust.tentacleId)
        deviceTrust.dismissedBanners.remove(trust.tentacleId)
        KLog.d("🔏 device trust: pinned \(trust.tentacleId.prefix(12)) from QR")
    }

    /// DEBUG `KRAKI_PAIRING_URL`: pair with this token, pinning like a scanned
    /// QR (device trust, fingerprint check).
    func prepareDebugPairing(url: String, token: String, auth: AuthManager) {
        auth.clearStoredCredentials()
        auth.pairingToken = token
        guard let link = PairingLink(string: url) else { return }
        deviceStore.keyPins.pendingQRFingerprint = link.keyFingerprint
        pinFromPairingLink(link)
    }

    /// Pair this (signed-in) app with the computer whose QR was scanned.
    func pairWithComputer(_ link: PairingLink) {
        pinFromPairingLink(link)
        if let id = link.trust?.tentacleId {
            deviceTrust.feedback = .pairing(name: deviceStore.devices[id]?.name ?? "your computer")
        }
        deviceTrustDevicesChanged()
    }

    /// The device list changed: pin this Mac's own computer, and ask every
    /// pinned-but-unpaired computer that is online to pair.
    func deviceTrustDevicesChanged() {
        guard deviceId != nil else { return }
        #if os(macOS)
        pinLocalTentacleIfNeeded()
        #endif
        for (tentacleId, pin) in TentacleTrustStore.shared.all where !pin.paired && pin.lastError == nil {
            guard let device = deviceStore.devices[tentacleId], device.online else { continue }
            guard deviceTrust.mayRequestPairing(tentacleId) else { continue }
            sendPairRequest(tentacleId: tentacleId, pin: pin)
        }
        scheduleTrustRetry()
    }

    /// While a pairing waits for its computer's answer, ask again after the
    /// throttle interval (a lost pair_result must not leave it stuck).
    func scheduleTrustRetry() {
        guard !deviceTrust.retryScheduled,
              TentacleTrustStore.shared.all.contains(where: { !$0.value.paired && $0.value.lastError == nil }) else { return }
        deviceTrust.retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + DeviceTrustModel.retryInterval + 0.5) { [weak self] in
            guard let self else { return }
            self.deviceTrust.retryScheduled = false
            guard self.deviceId != nil, self.connectionStatus == .connected else { return }
            self.deviceTrustDevicesChanged()
        }
    }

    private func sendPairRequest(tentacleId: String, pin: TentaclePin) {
        guard let selfId = deviceId,
              let identityKey = DeviceIdentityKeys.shared.identityPublicKey,
              let encryptionKey = DeviceIdentityKeys.shared.encryptionPublicKey else { return }
        let ts = Int64(Date().timeIntervalSince1970 * 1000)
        // iOS also enrolls its RSA key for the legacy push path; previews from
        // a paired computer use X25519.
        var rsaKey: String?
        #if os(iOS)
        if let keys = try? KeychainManager().getOrCreateEncryptionKey() {
            rsaKey = try? CryptoManager().exportPublicKeySPKI(keys.publicKey)
        }
        #endif
        var claim: [String: Any] = [
            "tentacleId": tentacleId, "appId": selfId,
            "identityKey": identityKey, "encryptionKey": encryptionKey, "ts": ts,
        ]
        if let rsaKey { claim["rsaKey"] = rsaKey }
        var payload: [String: Any] = ["claim": claim, "name": KrakiDevice.localizedName]
        if pin.via == "local" {
            payload["local"] = true
        } else {
            guard let secret = pin.secret,
                  let proof = DeviceTrustWire.pairingProof(secret: secret, tentacleId: tentacleId, appId: selfId,
                                                           identityKey: identityKey, encryptionKey: encryptionKey,
                                                           rsaKey: rsaKey, ts: ts) else {
                KLog.d("⚠️ device trust: \(tentacleId.prefix(12)) needs a fresh QR scan")
                return
            }
            payload["proof"] = proof
        }
        let message: [String: Any] = [
            "type": "pair_request", "deviceId": selfId, "seq": 0,
            "timestamp": ISO8601.now(), "payload": payload,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: message),
              let sealed = sealSigned(String(decoding: body, as: UTF8.self), to: tentacleId,
                                      recipients: [(tentacleId, pin.encryptionKey)]) else { return }
        deviceTrust.notePairRequest(tentacleId)
        // Never over the local link: the link only serves paired apps.
        pulseManager?.sendEncryptedPayload(sealed, target: tentacleId, connectionScoped: true)
        KLog.d("🔏 device trust: pair_request → \(tentacleId.prefix(12)) via \(pin.via)")
    }

    /// The computer answered our pair_request (signed by its pinned key —
    /// EncryptionHandler already checked that).
    func handlePairResult(_ dict: [String: Any]) {
        guard let tentacleId = dict["deviceId"] as? String,
              let payload = dict["payload"] as? [String: Any],
              TentacleTrustStore.shared.pin(tentacleId) != nil else { return }
        let ok = payload["ok"] as? Bool == true
        let reason = payload["reason"] as? String ?? "rejected"
        TentacleTrustStore.shared.update(tentacleId) { pin in
            guard var updated = pin else { return }
            updated.paired = ok
            updated.enforced = payload["enforced"] as? Bool
            updated.lastError = ok ? nil : reason
            if ok { updated.secret = nil }
            pin = updated
        }
        let name = deviceStore.devices[tentacleId]?.name ?? (payload["name"] as? String) ?? "your computer"
        let fromQR = TentacleTrustStore.shared.pin(tentacleId)?.via == "qr"
        if fromQR || deviceTrust.feedback != nil {
            deviceTrust.feedback = ok ? .paired(name: name) : .failed(name: name, reason: reason)
        }
        KLog.d(ok ? "✅ device trust: paired with \(tentacleId.prefix(12))"
                  : "⛔️ device trust: \(tentacleId.prefix(12)) refused pairing (\(reason))")
        if ok {
            commandSender?.resendPendingInputs(deviceId: tentacleId, reason: "device_trust_paired")
        }
    }

    /// The computer does not (or no longer) trust this app.
    func handleTrustRequired(_ dict: [String: Any], signed: Bool) {
        guard let tentacleId = dict["deviceId"] as? String else { return }
        if TentacleTrustStore.shared.pin(tentacleId) != nil {
            // A pinned computer's notice must carry its pinned signature.
            guard signed else { return }
            TentacleTrustStore.shared.update(tentacleId) { pin in
                guard var updated = pin else { return }
                updated.paired = false
                updated.lastError = "trust_required"
                pin = updated
            }
            deviceTrust.info[tentacleId] = nil
            // A same-Mac computer re-enrolls by itself.
            if TentacleTrustStore.shared.pin(tentacleId)?.via == "local" {
                TentacleTrustStore.shared.update(tentacleId) { $0 = nil }
            }
        } else {
            deviceTrust.pairingRequired.insert(tentacleId)
        }
        KLog.d("🔏 device trust: \(tentacleId.prefix(12)) requires pairing")
        deviceTrust.clearPairRequest(tentacleId)
        deviceTrustDevicesChanged()
    }

    /// The computer's signed list of the apps it trusts.
    func handleTrustedDevices(_ dict: [String: Any]) {
        guard let tentacleId = dict["deviceId"] as? String,
              TentacleTrustStore.shared.pairedPin(tentacleId) != nil,
              let payload = dict["payload"] as? [String: Any] else { return }
        let devices = (payload["devices"] as? [[String: Any]] ?? []).compactMap { d -> TrustedDeviceEntry? in
            guard let id = d["id"] as? String else { return nil }
            return TrustedDeviceEntry(id: id, name: d["name"] as? String ?? id,
                                      via: d["via"] as? String ?? "qr", pairedAt: d["pairedAt"] as? String ?? "")
        }
        let enforced = payload["enforced"] as? Bool == true
        deviceTrust.info[tentacleId] = ComputerTrustInfo(
            enforced: enforced, policyLocked: payload["policyLocked"] as? Bool == true, devices: devices,
            policyRevision: (payload["policyRevision"] as? NSNumber)?.intValue ?? 0)
        TentacleTrustStore.shared.update(tentacleId) { pin in pin?.enforced = enforced }
    }

    // MARK: Actions (signed; the computer only accepts them from paired apps)

    func requestTrustedDevices(_ tentacleId: String) {
        sendTrustAdmin(tentacleId, type: "request_trusted_devices", payload: [:])
    }

    func revokeTrustedDevice(_ deviceId: String, on tentacleId: String) {
        sendTrustAdmin(tentacleId, type: "revoke_device", payload: ["deviceId": deviceId])
    }

    func setOnlyPairedDevices(_ enforce: Bool, on tentacleId: String) {
        guard var info = deviceTrust.info[tentacleId] else { return }
        // Shown as "Applying…" until the computer's signed list confirms it.
        info.pendingEnforce = enforce
        deviceTrust.info[tentacleId] = info
        sendTrustAdmin(tentacleId, type: "set_trust_policy", payload: ["enforce": enforce, "revision": info.policyRevision])
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, var current = self.deviceTrust.info[tentacleId], current.pendingEnforce == enforce else { return }
            current.pendingEnforce = nil
            self.deviceTrust.info[tentacleId] = current
            self.deviceTrust.feedback = .failed(name: self.deviceStore.devices[tentacleId]?.name ?? "your computer", reason: "policy_unconfirmed")
        }
    }

    private func sendTrustAdmin(_ tentacleId: String, type: String, payload: [String: Any]) {
        guard TentacleTrustStore.shared.pairedPin(tentacleId) != nil else { return }
        _ = sendEncryptedMessage([
            "type": type, "deviceId": deviceId ?? "", "seq": 0,
            "timestamp": ISO8601.now(), "payload": payload,
        ], routingTarget: tentacleId)
    }

    /// Logout / account deletion: computers must pair this install again.
    func resetDeviceTrust() {
        TentacleTrustStore.shared.reset()
        DeviceIdentityKeys.shared.reset()
        deviceTrust.reset()
    }

    #if os(macOS)
    /// Where the computer on this Mac keeps its identity (`~/.kraki`).
    static var localKrakiHome: URL {
        #if DEBUG
        if let override = DeviceTrustTesting.localKrakiHome { return override }
        #endif
        return BuiltInTentacle.defaultKrakiHome
    }

    /// The device id of the computer on this Mac, if any.
    static var localTentacleId: String? {
        (try? String(contentsOf: localKrakiHome.appendingPathComponent("device-id"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Pin the computer on this Mac from its own files and enroll this app
    /// with it by writing a private file only this user can write. Neither
    /// step involves the relay.
    func pinLocalTentacleIfNeeded() {
        let home = Self.localKrakiHome
        guard let selfId = deviceId,
              let tentacleId = Self.localTentacleId, !tentacleId.isEmpty,
              deviceStore.devices[tentacleId] != nil,
              let data = try? Data(contentsOf: home.appendingPathComponent("keys/public-identity.json")),
              let identity = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ik = identity["identityKey"] as? String, DeviceTrustWire.isRawKey(ik),
              let xk = identity["encryptionKey"] as? String, DeviceTrustWire.isRawKey(xk),
              let myIk = DeviceIdentityKeys.shared.identityPublicKey,
              let myXk = DeviceIdentityKeys.shared.encryptionPublicKey else { return }
        let existing = TentacleTrustStore.shared.pin(tentacleId)
        // Same keys, and paired or pairing in progress: nothing to do.
        if let existing, existing.identityKey == ik, existing.encryptionKey == xk,
           existing.paired || existing.lastError == nil { return }
        TentacleTrustStore.shared.update(tentacleId) { pin in
            pin = TentaclePin(identityKey: ik, encryptionKey: xk, paired: false, secret: nil, via: "local", pinnedAt: Date())
        }
        deviceTrust.pairingRequired.remove(tentacleId)
        // The enrollment the computer checks: this app's keys, written by
        // this user, private.
        let dir = home.appendingPathComponent("trust/local-enroll", isDirectory: true)
        let enrollment: [String: Any] = [
            "appId": selfId, "identityKey": myIk, "encryptionKey": myXk,
            "name": KrakiDevice.localizedName, "ts": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let url = dir.appendingPathComponent("\(selfId).json")
            let tmp = dir.appendingPathComponent(".\(selfId).\(UUID().uuidString).tmp")
            guard fm.createFile(atPath: tmp.path, contents: try JSONSerialization.data(withJSONObject: enrollment),
                                attributes: [.posixPermissions: 0o600]) else { return }
            _ = try? fm.removeItem(at: url)
            try fm.moveItem(at: tmp, to: url)
            deviceTrust.clearPairRequest(tentacleId)
            KLog.d("🔏 device trust: enrolled with this Mac's computer \(tentacleId.prefix(12))")
        } catch {
            KLog.d("⚠️ device trust: local enrollment failed: \(error)")
        }
    }

    /// "Pair" for a computer: the one on this Mac re-enrolls by itself; any
    /// other needs its pairing link (returns false so the caller shows the
    /// paste sheet).
    func macPairLocallyIfPossible(_ device: DeviceSummary?) -> Bool {
        guard let device, device.id == Self.localTentacleId else { return false }
        TentacleTrustStore.shared.update(device.id) { $0 = nil }
        deviceTrust.clearPairRequest(device.id)
        deviceTrust.pairingRequired.remove(device.id)
        deviceTrustDevicesChanged()
        if TentacleTrustStore.shared.pin(device.id) == nil {
            // This Mac's computer has no device-trust keys yet (older Kraki,
            // or not started since updating).
            deviceTrust.feedback = .failed(name: device.name, reason: "local_keys_missing")
        } else {
            deviceTrust.feedback = .pairing(name: device.name)
        }
        return true
    }
    #endif
}

#if DEBUG
enum DeviceTrustTesting {
    /// Tests: the `KRAKI_HOME` of the computer on this Mac.
    static var localKrakiHome: URL?
}
#endif

extension DeviceTrustInbound {
    /// SessionStore's ownership rule: `owner` keeps a session `claimant` also
    /// lists while it is still on the account — unless device trust ranks the
    /// claimant (pinned) above it (unpinned, e.g. a relay-made device).
    static func ownershipRule(_ deviceStore: DeviceStore) -> (String, String) -> Bool {
        { [weak deviceStore] owner, claimant in
            deviceStore?.devices[owner] != nil && !claimantOutranksOwner(claimant, owner)
        }
    }
}
