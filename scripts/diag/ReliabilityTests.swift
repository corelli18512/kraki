import Foundation
import Pulse

enum KLog { static func d(_ message: @autoclosure () -> String) {} }
// Only SessionPrefs' type dependency; no app state or defaults are exercised.
enum ReasoningEffort: String { case low }
func check(_ ok: @autoclosure () -> Bool, _ label: String) { precondition(ok(), label) }
final class TestPulseHost: PulseHost {
    var manager: PulseManager!
    var frames: [DecodedFrame] = []
    var recovery = 0
    var delivered = 0
    func sendPulseFrame(_ b64: String, target: String?) {
        if let data = Data(base64Encoded: b64), let frame = decodeFrameWithStream(Array(data)) { frames.append(frame) }
    }
    func onDelivered(json: String) { delivered += 1 }
    func onAcked(seqUpTo: UInt64) {}
    func onResetInbound(fromSeq: UInt64, epoch: String) {}
    func requestConnect() { fatalError("Pulse must never own transport retries") }
    func requestDisconnect() { fatalError("Pulse must not intentionally close the transport") }
    func requestPulseRecovery() { recovery += 1; manager.onDisconnected() }
}
@main struct ReliabilityTests {
    static func main() {
        final class Owner { var calls = 0 }
        let owner = Owner()
        for event in [1, 2] {
            let result: Int? = EventMonitorForwarding.forward(event, owner: owner) { owner, _ in owner.calls += 1; return nil }
            check(result == nil, "consumed down/up cannot escape to SwiftUI")
        }
        check(owner.calls == 2, "one intercept per event")
        check(EventMonitorForwarding.forward(3, owner: owner) { _, e in e } == 3, "unrelated event passes")
        check(EventMonitorForwarding.forward(4, owner: nil as Owner?) { _, _ in nil } == 4, "dead owner passes")
        for value in ["2026-09-27T10:47:14.982Z", "2026-09-27T10:47:14Z", "2026-09-27T12:47:14+02:00", "invalid"] {
            let reference = ISO8601.withFractional.date(from: value) ?? ISO8601.withoutFractional.date(from: value)
            check(ISO8601.parse(value) == reference && ISO8601.parse(value) == reference, "memo preserves parser semantics, including nil")
        }
        let stamps = (0..<246).map { ISO8601.withFractional.string(from: Date(timeIntervalSince1970: Double(1_790_000_000 + $0))) }
        for stamp in stamps { _ = ISO8601.parse(stamp) }
        let start = ProcessInfo.processInfo.systemUptime
        for _ in 0..<4 { for stamp in stamps { _ = ISO8601.withFractional.date(from: stamp) } }
        let baseline = ProcessInfo.processInfo.systemUptime - start
        let cachedStart = ProcessInfo.processInfo.systemUptime
        for _ in 0..<4 { for stamp in stamps { _ = ISO8601.parse(stamp) } }
        let cached = ProcessInfo.processInfo.systemUptime - cachedStart
        print(String(format: "Timestamp parse microbenchmark (4x246 only): uncached %.2fms, cached %.2fms; not a whole-UI benchmark", baseline * 1000, cached * 1000))
        let host = TestPulseHost(); let manager = PulseManager(host: host); host.manager = manager
        manager.clockForTesting = 0
        manager.onConnected(); manager.onConnected()
        check(host.frames.count == 2, "duplicate authentication cannot duplicate HELLO")
        manager.clockForTesting = 30_000; manager.tickForTesting()
        check(host.recovery == 0, "30s without COMPLETE frames isn't physical death")
        manager.clockForTesting = 60_000; manager.tickForTesting()
        check(host.recovery == 0, "allow bounded slow frame progress")
        manager.clockForTesting = 120_000; manager.tickForTesting()
        check(host.recovery == 1, "two expired streams cause exactly one recovery")
        check(!manager.tickActiveForTesting, "reentrant disconnect must not resurrect timer")
        for time in [125_000, 130_000, 140_000] { manager.clockForTesting = time; manager.tickForTesting() }
        check(host.recovery == 1, "auth period never opens/replaces transport")
        manager.onDisconnected(); manager.onDisconnected()
        manager.onConnected()
        check(manager.tickActiveForTesting, "authenticated reconnect resumes ticking")
        // Only bulk makes logical progress; live must still eventually recover.
        let bulk = Endpoint(epoch: "server-bulk", streamId: 1)
        manager.clockForTesting = 240_000
        for effect in bulk.onConnected(240_000) {
            if case .transmit(let bytes) = effect { manager.onFrame(Data(bytes).base64EncodedString()) }
        }
        manager.clockForTesting = 260_000; manager.tickForTesting()
        check(host.recovery == 1, "a stream silent while its sibling delivers is starved by a congested FIFO link, not stuck")
        // Sibling keeps delivering; the silent stream is still recovered at the absolute bound.
        for time in [300_000, 360_000, 420_000] {
            manager.clockForTesting = time
            for effect in bulk.onTick(time) {
                if case .transmit(let bytes) = effect { manager.onFrame(Data(bytes).base64EncodedString()) }
            }
            manager.tickForTesting()
        }
        check(host.recovery == 1, "tolerated below the starvation bound")
        manager.clockForTesting = 445_000; manager.tickForTesting()
        check(host.recovery == 2, "one stuck stream cannot be masked by a healthy sibling forever")
        manager.resetForIdentityChange(); manager.tickForTesting()
        check(!manager.tickActiveForTesting, "identity reset disables callbacks")
        manager.sendEncrypted(blob: "scoped-during-auth", keys: [:], target: nil, connectionScoped: true)
        manager.sendEncrypted(blob: "ordinary-during-auth", keys: [:], target: nil)
        manager.onDisconnected()
        check(manager.connectionScopedCountForTesting == 0 && manager.liveOutboxSizeForTesting == 1,
              "failed auth still retires scoped commands, preserves ordinary retry")
        // Payload fragments: split/reassemble, bounds, and paced upload.
        let payload = Data(("{\"blob\":\"" + String(repeating: "Q", count: 200_000) + "\",\"keys\":{\"d\":\"k\"}}").utf8)
        check(PayloadFragments.split(Data("{\"blob\":\"small\"}".utf8)) == nil, "small payload stays whole")
        check(PayloadFragments.split(Data(String(repeating: "é", count: 70_000).utf8)) == nil, "non-ASCII stays whole")
        let parts = PayloadFragments.split(payload, id: "p1")!
        check(parts.count == (payload.count + PayloadFragments.size - 1) / PayloadFragments.size, "part count")
        let asm = PayloadAssembler()
        var whole: String?
        for part in parts.reversed() {
            let r = asm.accept([UInt8](part))
            check(r.isFragment, "a Swift-encoded part is recognised")
            if let w = r.whole { whole = w }
        }
        check(whole.map { Data($0.utf8) == payload } ?? false, "out-of-order parts reassemble exactly")
        check(asm.accept([UInt8]("{\"blob\":\"x\"}".utf8)).isFragment == false, "ordinary payload passes through")
        let tsStyle = #"{"kfrag":1,"id":"t","i":0,"n":2,"d":"ab"}"#
        check(asm.accept([UInt8](tsStyle.utf8)).isFragment && asm.pendingPayloads == 1, "TS-encoded part recognised")
        var clock = Date(timeIntervalSince1970: 0)
        let bounded = PayloadAssembler(maxBytes: 100_000, ttl: 10, now: { clock })
        let a = PayloadFragments.split(payload, id: "a")!, b = PayloadFragments.split(payload, id: "b")!
        _ = bounded.accept([UInt8](a[0])); _ = bounded.accept([UInt8](a[1]))
        _ = bounded.accept([UInt8](b[0])); _ = bounded.accept([UInt8](b[1]))
        check(bounded.pendingPayloads == 1, "oldest partial evicted beyond the byte budget")
        clock = clock.addingTimeInterval(60); _ = bounded.accept([UInt8](a[0]))
        check(bounded.pendingPayloads == 1, "stale partial expired")

        let fhost = TestPulseHost(); let fm = PulseManager(host: fhost); fhost.manager = fm
        fm.clockForTesting = 0; fm.onConnected(); fhost.frames.removeAll()
        let dataFrames = { fhost.frames.filter { if case .data = $0.frame { return true }; return false }.count }
        fm.acksPromptly = true
        fm.sendEncrypted(blob: String(repeating: "Z", count: 300_000), keys: ["t": "k"], target: "tent", fragment: true)
        fm.sendEncrypted(blob: "after", keys: ["t": "k"], target: "tent")
        let firstWindow = dataFrames()
        check(firstWindow == 3 && fm.inflightBytesForTesting <= PulseManager.windowBytes, "one window of parts in flight")
        check(fm.queuedForTesting > 1, "rest (and the later message) wait in order")
        // A relay progress heartbeat acknowledges the window: the next one goes.
        let ackBytes = try! encodeFrame(.heartbeat(ack: UInt64(firstWindow)), streamId: 0)
        fm.onFrame(Data(ackBytes).base64EncodedString())
        check(dataFrames() == firstWindow * 2, "each acknowledgement releases the next window")
        var guardSteps = 0
        while fm.queuedForTesting > 0, guardSteps < 100 {
            let sent = dataFrames()
            fm.onFrame(Data(try! encodeFrame(.heartbeat(ack: UInt64(sent)), streamId: 0)).base64EncodedString())
            guardSteps += 1
        }
        check(fm.queuedForTesting == 0, "queue drains by acknowledgements")
        let lastPayload = fhost.frames.last.flatMap { if case .data(_, _, let p, _, _) = $0.frame { return p }; return nil }
        check(lastPayload.map { String(decoding: $0, as: UTF8.self).contains("after") } ?? false, "later message stays after the parts")

        let legacyHost = TestPulseHost(); let legacy = PulseManager(host: legacyHost); legacyHost.manager = legacy
        legacy.clockForTesting = 0; legacy.onConnected(); legacyHost.frames.removeAll()
        legacy.sendEncrypted(blob: String(repeating: "Z", count: 300_000), keys: ["t": "k"], target: "tent", fragment: true)
        check(legacy.queuedForTesting == 0, "an old relay (no prompt acks) gets all parts at once, as before")

        print("PASS: production event forwarding + real PulseManager lifecycle (slow frame budget, congestion starvation bound, payload fragments + ack-paced upload, single-stream stall, duplicate effects, auth isolation, timer reentrancy, identity reset)")
    }
}
