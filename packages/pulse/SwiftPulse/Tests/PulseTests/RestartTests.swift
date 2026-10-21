import XCTest

@testable import Pulse

/// Relay restart from a stale durable-only snapshot (kraki 2026-10-21). Same
/// scenarios as `kraki-restart.test.ts` in the TypeScript suite.
///
/// The relay restores its endpoint toward a computer with sendSeq=4,
/// outboxBase=3 and nothing retained, under a NEW epoch; the computer had in
/// fact received 1..17 from the old relay process and still holds cursor 17.
final class RestartTests: XCTestCase {
    private final class Link {
        let relay: Endpoint
        let computer: Endpoint
        var delivered: [String] = []

        init() {
            relay = Endpoint(
                epoch: "relay:new",
                // Swift's load() restores the snapshot's epoch (TS keeps the
                // fresh one), so model the restarted relay's state directly.
                restore: Snapshot(
                    epoch: "relay:new", sendSeq: 4, outboxBase: 3, outbox: [],
                    recvCursor: 0, peerEpoch: "computer:1", disconnectedAtMs: nil),
                durable: DurableConfig(supported: true))
            computer = Endpoint(
                epoch: "computer:1",
                restore: Snapshot(
                    epoch: "computer:1", sendSeq: 0, outboxBase: 0, outbox: [],
                    recvCursor: 17, peerEpoch: "relay:old", disconnectedAtMs: nil))
        }

        func toComputer(_ effects: [Effect]) {
            for case .transmit(let bytes) in effects {
                for result in computer.onBytes(bytes, 1) {
                    switch result {
                    case .deliver(_, let payload, _, _): delivered.append(String(decoding: payload, as: UTF8.self))
                    case .transmit: toRelay([result])
                    default: break
                    }
                }
            }
        }

        func toRelay(_ effects: [Effect]) {
            for case .transmit(let bytes) in effects { toComputer(relay.onBytes(bytes, 1)) }
        }

        func send(_ text: String) { toComputer(relay.send(Array(text.utf8)).effects) }
    }

    func testFramesAfterARelayRestartReachTheComputerWhenTheHelloArrivesFirst() {
        let link = Link()
        let relayHello = link.relay.onConnected(1)
        let computerHello = link.computer.onConnected(1)
        let computerData = link.computer.send(Array("up".utf8)).effects  // piggybacks ack=17
        link.toComputer(relayHello)
        link.toRelay(computerHello)
        link.toRelay(computerData)
        for i in 0..<4 { link.send("m\(i)") }
        for t in 2..<6 {
            link.toComputer(link.relay.onTick(t * 20_000))
            link.toRelay(link.computer.onTick(t * 20_000))
        }
        XCTAssertEqual(link.delivered, ["m0", "m1", "m2", "m3"])
    }

    func testAResetWithANewEpochReplacesTheCursorWhenItArrivesBeforeTheHello() {
        let link = Link()
        let relayHello = link.relay.onConnected(1)
        link.toRelay(link.computer.onConnected(1))
        link.toComputer(relayHello)
        for i in 0..<3 { link.send("m\(i)") }
        XCTAssertEqual(link.delivered, ["m0", "m1", "m2"])
    }
}
