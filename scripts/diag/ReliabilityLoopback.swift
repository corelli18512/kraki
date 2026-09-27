import Foundation
import Pulse

enum KLog { static func d(_ message: @autoclosure () -> String) {} }
final class Host: PulseHost {
    let client: WebSocketClient
    var manager: PulseManager!
    var auths = 0, connects = 0, recoveries = 0, delivered = 0, hellos = 0
    init(port: Int, mode: String) {
        client = WebSocketClient(relayURL: "ws://127.0.0.1:\(port)/\(mode)")
        manager = PulseManager(host: self)
        client.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case .connecting: self.connects += 1
            case .connected: self.client.sendRaw("{\"type\":\"auth\"}")
            case .disconnected: self.manager.onDisconnected()
            }
        }
        client.onMessage = { [weak self] data in
            guard let self, let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            if msg["type"] as? String == "auth_ok" {
                self.auths += 1; self.client.setAuthenticated(true); self.manager.onConnected()
            } else if let pulse = msg["pulse"] as? String { self.manager.onFrame(pulse) }
        }
    }
    func requestConnect() { fatalError("Pulse open must not control the transport") }
    func requestDisconnect() { fatalError("Pulse must not intentionally disconnect") }
    func requestPulseRecovery() { recoveries += 1; client.recover(reason: "pulse_progress_timeout") }
    func sendPulseFrame(_ b64: String, target: String?) {
        if let bytes = Data(base64Encoded: b64), let d = decodeFrameWithStream(Array(bytes)), case .hello = d.frame { hellos += 1 }
        let data = try! JSONSerialization.data(withJSONObject: ["pulse": b64])
        client.sendRaw(String(decoding: data, as: UTF8.self))
    }
    func onDelivered(json: String) { delivered += 1 }
    func onAcked(seqUpTo: UInt64) {}
    func onResetInbound(fromSeq: UInt64, epoch: String) {}
}
@main struct Loopback {
    static func main() {
        let port = Int(CommandLine.arguments[1])!, mode = CommandLine.arguments[2]
        let host = Host(port: port, mode: mode)
        let seconds: Double = ["slow-bulk": 58, "slow-auth": 16, "stall": 133, "half-open": 35, "auth-timeout": 100, "connect-timeout": 38][mode]!
        host.client.connect()
        // Exercise actual production ensureConnected throughout slow auth.
        let calls = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            if mode == "slow-auth" { host.client.connect(); host.client.connect() }
        }
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { _ = RunLoop.current.run(mode: .default, before: min(end, Date().addingTimeInterval(0.05))) }
        calls.invalidate()
        if mode == "slow-bulk" {
            precondition(host.connects == 1 && host.auths == 1 && host.delivered == 1 && host.recoveries == 0, "slow fragmented data must complete without reconnect")
        } else if mode == "slow-auth" {
            precondition(host.connects == 1 && host.auths == 1, "ensure calls must not cancel slow authentication")
        } else {
            precondition(host.connects == 2 && host.client.isAuthenticated, "exactly one recovery then stable auth")
            precondition(host.recoveries == (mode == "stall" ? 1 : 0), "physical vs logical watchdog ownership")
        }
        precondition(host.hellos == host.auths * 2, "both streams resume once per authenticated generation")
        // Intentional disconnect cancels retries, even if old callbacks complete.
        host.client.disconnect(); let count = host.connects
        let finish = Date().addingTimeInterval(2)
        while Date() < finish { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        precondition(host.connects == count && host.client.state == .disconnected)
        host.manager.resetForIdentityChange()
        print("PASS \(mode): connects=\(host.connects) auths=\(host.auths) recoveries=\(host.recoveries) deliveries=\(host.delivered) HELLOs=\(host.hellos)")
    }
}
