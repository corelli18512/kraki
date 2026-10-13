/// AppState as the pulse host: sending pulse frames and handling delivered payloads.

import SwiftUI
import Observation

// MARK: - PulseHost

extension AppState: PulseHost {
    func sendPulseFrame(_ b64: String, target: String?) {
        // Outer relay envelope carrying the pulse frame; blob/keys are empty
        // (the ciphertext lives inside the pulse frame's payload).
        var envelope: [String: Any] = ["pulse": b64, "blob": "", "keys": [String: String]()]
        if let target {
            envelope["type"] = "unicast"
            envelope["to"] = target
            if target == Self.headPulseTarget {
                KLog.d("🎙️ Voice control Pulse frame → @head bytes=\(b64.utf8.count)")
            }
        } else {
            envelope["type"] = "broadcast"
        }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              let str = String(data: data, encoding: .utf8) else { return }
        #if os(macOS)
        localLink?.noteHeadFrame(target: target)
        #endif
        wsClient?.sendRaw(str)
    }

    func onDelivered(json: String) {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        // Head-originated control (presence, preferences, voice lease) is
        // intentionally plaintext inside ordered Pulse. Route its inner message
        // through the same control dispatcher as a raw WebSocket frame.
        if object["from"] as? String == Self.headPulseTarget {
            guard let message = Self.headControlMessage(in: object),
                  let messageData = try? JSONSerialization.data(withJSONObject: message) else {
                KLog.d("⚠️ Dropped non-control message in head pulse wrapper")
                return
            }
            KLog.d("🎙️ Head control delivered type=\(message["type"] as? String ?? "")")
            messageRouter?.handleRawMessage(messageData)
            return
        }

        #if os(macOS)
        // While this Mac is linked to a Tentacle, that Tentacle sends it nothing
        // through the Head. A Head frame from it was sent before the switch and
        // is stale. Its connection-scoped live state (deltas, card, subscription
        // acks) would land after the link's fresh snapshot and duplicate or
        // revert the card, so those are dropped after decryption; everything
        // else (session_list, spine) is idempotent and still applied.
        if let src = object["src"] as? String, let localLink, localLink.isLinked(src) {
            localLink.noteStaleHeadFrameDropped()
            var marked = object
            marked[EncryptionHandler.staleRouteKey] = true
            if let markedData = try? JSONSerialization.data(withJSONObject: marked) {
                messageRouter?.encryptionHandler.submitForDecryption(markedData)
            }
            return
        }
        #endif

        // All other delivered payloads are `{blob, keys}` E2E ciphertext from a
        // tentacle. Submit to the ordered background decrypt pipeline so RSA
        // work never competes with AppKit scrolling on the main thread.
        messageRouter?.encryptionHandler.submitForDecryption(data)
    }

    func onAcked(seqUpTo: UInt64) {
        commandSender?.resolvePulseAcked(seqUpTo: seqUpTo)
    }

    func onResetInbound(fromSeq: UInt64, epoch: String) {
        KLog.d("⚠️ pulse reset-inbound from=\(fromSeq) epoch=\(epoch)")
    }

    func requestConnect() { wsClient?.connect() }
    func requestDisconnect() { wsClient?.disconnect() }
    func requestPulseRecovery() { wsClient?.recover(reason: "pulse_progress_timeout") }
}
