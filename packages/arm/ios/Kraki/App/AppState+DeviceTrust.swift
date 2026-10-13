/// Pairing with computers (device trust — see Core/Crypto/DeviceTrust.swift
/// and docs/e2e-trust.md).

import Foundation

/// Transient pairing state (throttling) shared by the AppState extension.
final class DeviceTrustCoordinator {
    static let shared = DeviceTrustCoordinator()
    var lastPairRequest: [String: Date] = [:]
    static let retryInterval: TimeInterval = 10
}

extension AppState {
    /// Pin the computer a pairing QR names. A new QR for an already pinned
    /// computer replaces the pin (re-scanning is how a user re-pairs).
    func pinFromPairingLink(_ link: PairingLink) {
        guard let trust = link.trust else { return }
        TentacleTrustStore.shared.update(trust.tentacleId) { pin in
            pin = TentaclePin(identityKey: trust.identityKey, encryptionKey: trust.encryptionKey,
                              paired: false, secret: trust.secret, via: "qr", pinnedAt: Date())
        }
        DeviceTrustCoordinator.shared.lastPairRequest[trust.tentacleId] = nil
        KLog.d("🔏 device trust: pinned \(trust.tentacleId.prefix(12)) from QR")
    }

    /// Pair this (signed-in) app with the computer whose QR was scanned.
    func pairWithComputer(_ link: PairingLink) {
        pinFromPairingLink(link)
        deviceTrustDevicesChanged()
    }

    /// The device list changed: pin this Mac's own computer, and ask every
    /// pinned-but-unpaired computer that is online to pair.
    func deviceTrustDevicesChanged() {
        guard deviceId != nil else { return }
        #if os(macOS)
        pinLocalTentacleIfNeeded()
        #endif
        for (tentacleId, pin) in TentacleTrustStore.shared.all where !pin.paired {
            guard let device = deviceStore.devices[tentacleId], device.online != false else { continue }
            if let last = DeviceTrustCoordinator.shared.lastPairRequest[tentacleId],
               Date().timeIntervalSince(last) < DeviceTrustCoordinator.retryInterval { continue }
            sendPairRequest(tentacleId: tentacleId, pin: pin)
        }
    }

    private func sendPairRequest(tentacleId: String, pin: TentaclePin) {
        guard let selfId = deviceId,
              let identityKey = DeviceIdentityKeys.shared.identityPublicKey,
              let encryptionKey = DeviceIdentityKeys.shared.encryptionPublicKey else { return }
        let ts = Int64(Date().timeIntervalSince1970 * 1000)
        // iOS also enrolls its RSA key: the Notification Service Extension
        // still decrypts RSA push previews. macOS gets previews over the link.
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
        DeviceTrustCoordinator.shared.lastPairRequest[tentacleId] = Date()
        // Never over the local link: the link only serves paired apps.
        pulseManager?.sendEncryptedPayload(sealed, target: tentacleId, connectionScoped: true)
        KLog.d("🔏 device trust: pair_request → \(tentacleId.prefix(12)) via \(pin.via)")
    }

    /// The computer answered our pair_request (signed by its pinned key —
    /// EncryptionHandler already checked that).
    func handlePairResult(_ dict: [String: Any]) {
        guard let tentacleId = dict["deviceId"] as? String,
              let payload = dict["payload"] as? [String: Any] else { return }
        let ok = payload["ok"] as? Bool == true
        TentacleTrustStore.shared.update(tentacleId) { pin in
            guard pin != nil else { return }
            pin!.paired = ok
            pin!.enforced = payload["enforced"] as? Bool
            pin!.lastError = ok ? nil : (payload["reason"] as? String ?? "rejected")
            if ok { pin!.secret = nil }
        }
        KLog.d(ok ? "✅ device trust: paired with \(tentacleId.prefix(12))"
                  : "⛔️ device trust: \(tentacleId.prefix(12)) refused pairing (\(payload["reason"] as? String ?? "?"))")
        if ok {
            // Re-introduce ourselves on the trusted channel.
            commandSender?.resendPendingInputs(deviceId: tentacleId, reason: "device_trust_paired")
        }
    }

    /// The computer does not (or no longer) trust this app.
    func handleTrustRequired(_ dict: [String: Any]) {
        guard let tentacleId = dict["deviceId"] as? String else { return }
        TentacleTrustStore.shared.update(tentacleId) { pin in
            guard pin != nil else { return }
            pin!.paired = false
            pin!.lastError = "trust_required"
        }
        KLog.d("🔏 device trust: \(tentacleId.prefix(12)) requires pairing")
        DeviceTrustCoordinator.shared.lastPairRequest[tentacleId] = nil
        deviceTrustDevicesChanged()
    }

    #if os(macOS)
    /// Where the computer on this Mac keeps its identity (`~/.kraki`).
    static var localKrakiHome: URL {
        #if DEBUG
        if let override = DeviceTrustTesting.localKrakiHome { return override }
        #endif
        return BuiltInTentacle.defaultKrakiHome
    }

    /// Pin the computer on this Mac from its own files and enroll this app
    /// with it by writing a private file only this user can write. Neither
    /// step involves the relay.
    func pinLocalTentacleIfNeeded() {
        let home = Self.localKrakiHome
        guard let selfId = deviceId,
              let tentacleId = (try? String(contentsOf: home.appendingPathComponent("device-id"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines), !tentacleId.isEmpty,
              deviceStore.devices[tentacleId] != nil,
              let data = try? Data(contentsOf: home.appendingPathComponent("keys/public-identity.json")),
              let identity = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ik = identity["identityKey"] as? String, DeviceTrustWire.isRawKey(ik),
              let xk = identity["encryptionKey"] as? String, DeviceTrustWire.isRawKey(xk),
              let myIk = DeviceIdentityKeys.shared.identityPublicKey,
              let myXk = DeviceIdentityKeys.shared.encryptionPublicKey else { return }
        let existing = TentacleTrustStore.shared.pin(tentacleId)
        if let existing, existing.paired, existing.identityKey == ik, existing.encryptionKey == xk { return }
        if existing == nil || existing?.identityKey != ik || existing?.encryptionKey != xk {
            TentacleTrustStore.shared.update(tentacleId) { pin in
                pin = TentaclePin(identityKey: ik, encryptionKey: xk, paired: false, secret: nil, via: "local", pinnedAt: Date())
            }
        }
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
            KLog.d("🔏 device trust: enrolled with this Mac's computer \(tentacleId.prefix(12))")
        } catch {
            KLog.d("⚠️ device trust: local enrollment failed: \(error)")
        }
    }
    #endif
}

#if DEBUG
enum DeviceTrustTesting {
    /// Tests: the `KRAKI_HOME` of the computer on this Mac.
    static var localKrakiHome: URL?
}
#endif
