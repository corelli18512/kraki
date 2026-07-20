import XCTest
@testable import Kraki

final class SessionSubscriptionControllerTests: XCTestCase {
    private final class Host: SessionSubscriptionHost {
        var subscriptionConnected = true
        var routes: [String: String] = ["A": "T1", "B": "T1", "C": "T1"]
        var sends: [(String, String?)] = []
        var snapshots: [SessionSubscriptionAck] = []
        var errors: [String] = []

        func resolveTentacle(for sessionId: String) -> String? { routes[sessionId] }
        func sendSessionSubscription(to tentacleId: String, sessionId: String?) -> Bool {
            sends.append((tentacleId, sessionId))
            return true
        }
        func applySessionSubscriptionSnapshot(_ ack: SessionSubscriptionAck) {
            snapshots.append(ack)
        }
        func reportSessionSubscriptionError(_ message: String) { errors.append(message) }
    }

    private func ack(_ tentacle: String, _ session: String?, accepted: Bool = true) -> SessionSubscriptionAck {
        SessionSubscriptionAck(
            tentacleId: tentacle,
            sessionId: session,
            accepted: accepted,
            snapshot: session == nil ? nil : ["marker": session!],
            errorMessage: accepted ? nil : "Session not found"
        )
    }

    func testWaitsForPostAuthSessionListBarrier() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.setDesired("A")
        XCTAssertTrue(host.sends.isEmpty)
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, 1)
        XCTAssertEqual(host.sends[0].0, "T1")
        XCTAssertEqual(host.sends[0].1, "A")
    }

    func testMatchingAckEstablishesLiveReadyAndAppliesSnapshot() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        XCTAssertFalse(controller.liveReady)
        controller.onAck(ack("T1", "A"))
        XCTAssertTrue(controller.liveReady)
        XCTAssertTrue(controller.acceptsLive("A"))
        XCTAssertFalse(controller.acceptsLive("B"))
        XCTAssertEqual(host.snapshots.map(\.sessionId), ["A"])
    }

    func testSameTentacleReplaceStopsAcceptingOldFramesBeforeNewAck() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        controller.setDesired("B")
        XCTAssertFalse(controller.acceptsLive("A"))
        XCTAssertFalse(controller.acceptsLive("B"))
        XCTAssertEqual(host.sends.map { $0.1 }, ["A", "B"])
        controller.onAck(ack("T1", "B"))
        XCTAssertTrue(controller.acceptsLive("B"))
    }

    func testRapidNavigationCoalescesAndDiscardsStaleSnapshot() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.setDesired("B")
        controller.setDesired("C")
        controller.onAck(ack("T1", "A"))
        XCTAssertEqual(host.sends.map { $0.1 }, ["A", "C"])
        XCTAssertTrue(host.snapshots.isEmpty)
        XCTAssertFalse(controller.liveReady)
        controller.onAck(ack("T1", "C"))
        XCTAssertEqual(host.snapshots.map(\.sessionId), ["C"])
        XCTAssertTrue(controller.liveReady)
    }

    func testCrossTentacleUnsubscribesOldBeforeSubscribingNew() {
        let host = Host()
        host.routes = ["A": "T1", "B": "T2"]
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.onSessionList(tentacleId: "T2")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        controller.setDesired("B")
        XCTAssertEqual(host.sends.count, 2)
        XCTAssertEqual(host.sends[1].0, "T1")
        XCTAssertNil(host.sends[1].1)
        controller.onAck(ack("T1", nil))
        XCTAssertEqual(host.sends.count, 3)
        XCTAssertEqual(host.sends[2].0, "T2")
        XCTAssertEqual(host.sends[2].1, "B")
    }

    func testLeavingPageConfirmsNullSubscription() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        controller.setDesired(nil)
        XCTAssertEqual(host.sends.map { $0.1 }, ["A", nil])
        controller.onAck(ack("T1", nil))
        XCTAssertNil(controller.confirmedSessionId)
        XCTAssertFalse(controller.liveReady)
    }

    func testDisconnectRetainsDesiredButRequiresFreshBarrierAndAck() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        controller.onDisconnected()
        XCTAssertEqual(controller.desiredSessionId, "A")
        XCTAssertFalse(controller.liveReady)

        host.subscriptionConnected = false
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, 1)
        host.subscriptionConnected = true
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, 2)
        controller.onAck(ack("T1", "A"))
        XCTAssertTrue(controller.liveReady)
    }

    func testRejectsStaleAckAndBlocksFailedDesiredUntilNewBarrier() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.onAck(ack("T1", "B"))
        XCTAssertFalse(controller.liveReady)
        XCTAssertTrue(host.snapshots.isEmpty)

        controller.onAck(ack("T1", "A", accepted: false))
        XCTAssertEqual(host.errors, ["Session not found"])
        XCTAssertEqual(host.sends.count, 1)
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, 2)
    }
}
