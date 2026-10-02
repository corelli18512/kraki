import Foundation
import CryptoKit

/// Pins each computer's (Tentacle's) encryption key so the relay cannot
/// silently swap it for its own and read the conversation (D4).
///
/// - The pairing QR carries a short fingerprint of the computer's key (`fp`).
///   After that pairing authenticates, the computer whose key matches is
///   pinned — the QR, not the relay, vouches for it.
/// - Computers seen without a QR are pinned on first sight (trust on first use).
/// - If the relay later reports a different key for a pinned computer, the
///   pinned key keeps being used (fail closed: an attacker's key is never
///   encrypted to) and the computer is flagged until it is re-paired.
final class DeviceKeyPins {
    private static let storageKey = "kraki.deviceKeyPins.v1"
    private let defaults: UserDefaults
    private(set) var pins: [String: String]
    /// Computers whose relay-reported key no longer matches their pin.
    private(set) var mismatched: Set<String> = []
    /// Fingerprint from the most recently opened pairing QR, verified once
    /// the next device list arrives.
    var pendingQRFingerprint: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.pins = defaults.dictionary(forKey: Self.storageKey) as? [String: String] ?? [:]
    }

    /// `base64url(sha256(compactKey))`, first 16 bytes — must match Tentacle's
    /// `keyFingerprint` in pair.ts.
    static func fingerprint(_ compactKey: String) -> String {
        let digest = SHA256.hash(data: Data(compactKey.utf8))
        return Data(digest.prefix(16)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Apply the pin to a device reported by the relay. Returns the device to
    /// store (with the pinned key when the reported one is not trusted).
    func apply(_ device: DeviceSummary) -> DeviceSummary {
        guard device.role == .tentacle, let reported = device.encryptionKey ?? device.publicKey else { return device }
        guard let pinned = pins[device.id] else {
            pins[device.id] = reported
            save()
            return device
        }
        if pinned == reported {
            mismatched.remove(device.id)
            return device
        }
        mismatched.insert(device.id)
        var safe = device
        safe.encryptionKey = pinned
        return safe
    }

    /// After a QR pairing: pin the computer the QR named (replacing an older
    /// pin — re-scanning is how a user trusts a computer's new key).
    /// Returns false when no reported computer matches the QR.
    @discardableResult
    func verifyPendingQR(against devices: [DeviceSummary]) -> Bool {
        guard let fp = pendingQRFingerprint else { return true }
        pendingQRFingerprint = nil
        guard let match = devices.first(where: { device in
            guard device.role == .tentacle, let key = device.encryptionKey ?? device.publicKey else { return false }
            return Self.fingerprint(key) == fp
        }), let key = match.encryptionKey ?? match.publicKey else { return false }
        pins[match.id] = key
        mismatched.remove(match.id)
        save()
        return true
    }

    func forget(_ deviceId: String) {
        pins.removeValue(forKey: deviceId)
        mismatched.remove(deviceId)
        save()
    }

    func reset() {
        pins = [:]
        mismatched = []
        pendingQRFingerprint = nil
        save()
    }

    private func save() {
        defaults.set(pins, forKey: Self.storageKey)
    }
}
