/// Sending an encrypted message to devices (unicast/broadcast through the pulse layer).

import SwiftUI
import Observation

extension AppState {
    /// Send an encrypted message over the Pulse reliable-transport layer.
    /// E2E-encrypts the inner message to `{blob, keys}`, then hands the pair to
    /// the pulse endpoint, which frames it and sends the OUTER relay envelope
    /// `{type:"unicast"|"broadcast", pulse:b64, blob:"", keys:{}}` — the
    /// ciphertext rides inside the pulse frame, transparent to the relay.
    @discardableResult
    func sendEncryptedMessage(
        _ message: [String: Any],
        routingTarget: String? = nil,
        connectionScoped: Bool = false
    ) -> Bool {
        #if DEBUG
        if let testOutboundMessageHandler {
            return testOutboundMessageHandler(message, routingTarget, connectionScoped)
        }
        #endif
        guard deviceId != nil else {
            KLog.d("⚠️ sendEncrypted: no deviceId")
            return false
        }

        guard let innerData = try? JSONSerialization.data(withJSONObject: message),
              let innerString = String(data: innerData, encoding: .utf8) else {
            KLog.d("⚠️ sendEncrypted: failed to serialize message")
            return false
        }

        // Determine target tentacle device. Prefer an explicit
        // `targetDeviceId` in the envelope (e.g. import or
        // request_local_sessions, both of which target a specific
        // tentacle without a sessionId). Fall back to the session's
        // owning device when a sessionId is present, else broadcast.
        let sessionId = message["sessionId"] as? String
        let explicitTarget = message["targetDeviceId"] as? String
        // Commands such as create_session and request_local_sessions carry
        // their target inside the protocol payload, but relay routing happens
        // before decryption and therefore needs the same target separately.
        // Resolve both shapes so a targeted command is encrypted to, and
        // delivered by the relay to, the intended Tentacle.
        let payloadTarget = (message["payload"] as? [String: Any])?["targetDeviceId"] as? String
        let targetDeviceId: String?
        if let routingTarget {
            targetDeviceId = routingTarget
        } else if let explicitTarget {
            targetDeviceId = explicitTarget
        } else if let payloadTarget {
            targetDeviceId = payloadTarget
        } else if let sessionId {
            // A session's messages go only to the computer that owns it. An
            // unknown session must not fall back to every computer: that would
            // encrypt this command for machines that have nothing to do with it.
            guard let owner = sessionStore.sessions[sessionId]?.deviceId
                    ?? sessionStore.archivedSessionInfo(sessionId)?.deviceId else {
                KLog.d("⚠️ Not sending \(message["type"] as? String ?? "?"): unknown session")
                return false
            }
            targetDeviceId = owner
        } else {
            targetDeviceId = nil
        }

        let replayable = Self.replayableAcrossRoutes.contains(message["type"] as? String ?? "")
        let fragment = targetDeviceId.map {
            deviceStore.deviceFeatures[$0]?.contains(PayloadFragments.feature) == true
        } ?? false

        // Device trust: a paired computer gets the message signed with this
        // device's identity key and encrypted to the X25519 key pinned at
        // pairing — never to a key the relay reported.
        let trust = TentacleTrustStore.shared
        if let targetDeviceId, let pin = trust.pairedPin(targetDeviceId) {
            guard let payload = sealSigned(innerString, to: targetDeviceId, recipients: [(targetDeviceId, pin.encryptionKey)]) else {
                return false
            }
            return deliverEncrypted(payload, target: targetDeviceId, connectionScoped: connectionScoped,
                                    fragment: fragment, replayable: replayable)
        }
        var pairedInBroadcast: Set<String> = []
        if targetDeviceId == nil {
            let paired = deviceStore.devices.values
                .filter { $0.role == .tentacle }
                .compactMap { d in trust.pairedPin(d.id).map { (deviceId: d.id, publicKey: $0.encryptionKey) } }
            if !paired.isEmpty, let payload = sealSigned(innerString, to: DeviceTrustWire.anyRecipient, recipients: paired) {
                _ = deliverEncrypted(payload, target: nil, connectionScoped: connectionScoped, fragment: false, replayable: false)
                pairedInBroadcast = Set(paired.map(\.deviceId))
            }
        }

        // Collect recipient encryption keys
        var recipients: [RecipientKey] = []
        let crypto = CryptoManager()

        if let targetDeviceId {
            guard let device = deviceStore.devices[targetDeviceId],
                  let encKeyB64 = device.encryptionKey ?? device.publicKey else {
                KLog.d("⚠️ sendEncrypted: target unavailable \(targetDeviceId.prefix(12))")
                return false
            }
            do {
                let pubKey = try crypto.importPublicKeyFromSPKI(encKeyB64)
                recipients.append(RecipientKey(deviceId: targetDeviceId, publicKey: pubKey))
            } catch {
                KLog.d("❌ sendEncrypted: can't import key for \(targetDeviceId.prefix(12)): \(error)")
                return false
            }
        } else {
            // Broadcast to all tentacle devices
            for device in deviceStore.devices.values where device.role == .tentacle && !pairedInBroadcast.contains(device.id) {
                guard let encKeyB64 = device.encryptionKey ?? device.publicKey else { continue }
                do {
                    let pubKey = try crypto.importPublicKeyFromSPKI(encKeyB64)
                    recipients.append(RecipientKey(deviceId: device.id, publicKey: pubKey))
                } catch {
                    KLog.d("⚠️ sendEncrypted: can't import key for \(device.id.prefix(12))")
                }
            }
        }

        guard !recipients.isEmpty else {
            if !pairedInBroadcast.isEmpty { return true }
            KLog.d("⚠️ sendEncrypted: no recipients found")
            return false
        }

        do {
            let blob = try crypto.encryptToBlob(innerString, recipients: recipients)
            #if os(macOS)
            // The Tentacle on this Mac is reached over loopback, not the Head.
            if let targetDeviceId, let localLink,
               localLink.sendEncrypted(
                   blob: blob.blob, keys: blob.keys, to: targetDeviceId,
                   connectionScoped: connectionScoped,
                   replayable: Self.replayableAcrossRoutes.contains(message["type"] as? String ?? "")
               ) {
                KLog.d("📤🔒 local link → \(targetDeviceId.prefix(12))...")
                return true
            }
            #endif
            KLog.d("📤🔒 pulse → \(targetDeviceId?.prefix(12) ?? "broadcast")...")
            guard let pulseManager else { return false }
            pulseManager.sendEncrypted(
                blob: blob.blob,
                keys: blob.keys,
                target: targetDeviceId,
                connectionScoped: connectionScoped,
                fragment: targetDeviceId.map {
                    deviceStore.deviceFeatures[$0]?.contains(PayloadFragments.feature) == true
                } ?? false
            )
            return true
        } catch {
            KLog.d("❌ sendEncrypted: encryption failed: \(error)")
            return false
        }
    }

    /// Sign `body` as this device and encrypt it to `recipients` (X25519).
    func sealSigned(_ body: String, to: String, recipients: [(deviceId: String, publicKey: String)]) -> [String: Any]? {
        guard let selfId = deviceId else { return nil }
        do {
            let signed = try DeviceTrustWire.sign(body: body, from: selfId, to: to, key: DeviceIdentityKeys.shared.signingKey())
            let signedData = try JSONSerialization.data(withJSONObject: signed)
            let blob = try E2EV2.encrypt(String(decoding: signedData, as: UTF8.self), recipients: recipients)
            return ["v": 2, "blob": blob]
        } catch {
            KLog.d("❌ device trust: sealing failed: \(error)")
            return nil
        }
    }

    /// Hand an E2E payload to the local link (same-Mac computer) or Pulse.
    @discardableResult
    func deliverEncrypted(_ payload: [String: Any], target: String?, connectionScoped: Bool, fragment: Bool, replayable: Bool) -> Bool {
        #if os(macOS)
        if let target, let localLink,
           localLink.sendEncryptedPayload(payload, to: target, connectionScoped: connectionScoped, replayable: replayable) {
            return true
        }
        #endif
        guard let pulseManager else { return false }
        pulseManager.sendEncryptedPayload(payload, target: target, connectionScoped: connectionScoped, fragment: fragment)
        return true
    }
}
