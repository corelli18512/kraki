import XCTest
@testable import Kraki

@MainActor
final class AppStateSessionSubscriptionSnapshotTests: XCTestCase {
    func testDeviceDepartureRoutesIntoSubscriptionRecovery() throws {
        for event in ["device_left", "device_removed"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let db = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            let app = AppState(testDatabase: db)
            app.connectionStatus = .connected
            var sends: [String] = []
            app.testOutboundMessageHandler = { message, target, _ in
                if message["type"] as? String == "set_session_subscription" {
                    sends.append(target ?? "")
                }
                return true
            }
            for (session, target) in [("A", "T1"), ("B", "T2")] {
                app.deviceStore.addDevice(DeviceSummary(
                    id: target, name: target, role: .tentacle, kind: .desktop,
                    publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil
                ))
                app.sessionStore.upsertSession(SessionInfo(
                    id: session, deviceId: target, deviceName: target, agent: "pi", model: nil,
                    state: .idle, mode: .safe, lastSeq: 0, readSeq: 0, messageCount: 0,
                    createdAt: Date(), pinned: false
                ))
                app.sessionSubscriptionController.onSessionList(tentacleId: target)
            }
            app.sessionSubscriptionController.setDesired("A")
            app.sessionSubscriptionController.onAck(SessionSubscriptionAck(
                tentacleId: "T1", sessionId: "A", accepted: true, snapshot: nil, errorMessage: nil
            ))
            let departure = try JSONSerialization.data(withJSONObject: ["type": event, "deviceId": "T1"])
            app.messageRouter?.handleRawMessage(departure)
            app.sessionSubscriptionController.setDesired("B")
            XCTAssertEqual(sends, ["T1", "T2"], event)
            XCTAssertFalse(app.sessionSubscriptionController.acceptsLive("A"))
        }
    }

    func testRuntimeStatusFromDigestSurvivesCardSnapshotAndClearsAuthoritatively() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-subscription-snapshot-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let app = AppState(testDatabase: database)

        func ack(runtimeStatus: [String: Any]?) -> SessionSubscriptionAck {
            var digest: [String: Any] = [
                "id": "sess-1",
                "agent": "pi",
                "state": "active",
                "mode": "discuss",
                "lastSeq": 0,
                "readSeq": 0,
                "messageCount": 0,
                "createdAt": "2026-08-06T00:00:00Z",
            ]
            digest["runtimeStatus"] = runtimeStatus
            return SessionSubscriptionAck(
                tentacleId: "dev-1",
                sessionId: "sess-1",
                accepted: true,
                snapshot: [
                    "digest": digest,
                    "card": ["draft": "summarizing"],
                    "spineHeadSeq": 0,
                ],
                errorMessage: nil
            )
        }

        app.applySessionSubscriptionSnapshot(
            ack(runtimeStatus: ["status": "compacting", "reason": "threshold"])
        )
        XCTAssertEqual(app.messageStore.runtimeStatus("sess-1"), .compacting(reason: .threshold))

        app.applySessionSubscriptionSnapshot(
            ack(runtimeStatus: ["status": "idle"])
        )
        XCTAssertEqual(app.messageStore.runtimeStatus("sess-1"), .idle)
    }
}

final class SessionSubscriptionControllerTests: XCTestCase {
    private final class Host: SessionSubscriptionHost {
        var subscriptionConnected = true
        var routes: [String: String] = ["A": "T1", "B": "T1", "C": "T1"]
        var sends: [(String, String?)] = []
        var snapshots: [SessionSubscriptionAck] = []
        var errors: [String] = []
        var offline: Set<String> = []
        func isTentacleOnline(_ tentacleId: String) -> Bool { !offline.contains(tentacleId) }

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

    func testOfflineOldTentacleDoesNotBlockOnlineTargetAndIsReleasedOnReturn() {
        let host = Host()
        host.routes = ["A": "T1", "B": "T2"]
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.onSessionList(tentacleId: "T2")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        controller.setDesired("B")
        XCTAssertEqual(host.sends.last?.0, "T1")
        XCTAssertNil(host.sends.last?.1)
        // T1 disappears before it can acknowledge release; the App stays online.
        host.offline.insert("T1")
        controller.onTentacleUnavailable("T1")
        XCTAssertEqual(host.sends.last?.0, "T2")
        XCTAssertEqual(host.sends.last?.1, "B")
        controller.onAck(ack("T1", nil)) // stale ACK must not settle T2's flight
        controller.onAck(ack("T2", "B"))
        XCTAssertTrue(controller.acceptsLive("B"))
        let sent = host.sends.count
        controller.onSessionList(tentacleId: "T1") // late decrypt while offline
        XCTAssertEqual(host.sends.count, sent)
        host.offline.remove("T1")
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.last?.0, "T1")
        XCTAssertNil(host.sends.last?.1)
        let beforeRejectedCleanup = host.sends.count
        controller.onAck(ack("T1", nil, accepted: false))
        XCTAssertEqual(host.sends.count, beforeRejectedCleanup, "a rejected cleanup must not create a retry storm")
        XCTAssertTrue(controller.acceptsLive("B"))
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, beforeRejectedCleanup + 1)
        controller.onAck(ack("T1", nil))
        XCTAssertTrue(controller.acceptsLive("B"), "old-peer cleanup must preserve the current live card")
    }

    func testOfflineInFlightSubscribeCannotStrandDesiredSessionOnOtherTentacle() {
        let host = Host()
        host.routes = ["A": "T1", "B": "T2"]
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.onSessionList(tentacleId: "T2")
        controller.setDesired("A") // no ACK yet
        host.offline.insert("T1")
        controller.onTentacleUnavailable("T1")
        controller.setDesired("B")
        XCTAssertEqual(host.sends.last?.0, "T2")
        XCTAssertEqual(host.sends.last?.1, "B")
        controller.onAck(ack("T1", "A"))
        XCTAssertTrue(host.snapshots.isEmpty)
        controller.onAck(ack("T2", "B"))
        XCTAssertTrue(controller.liveReady)
    }

    func testCurrentTentacleReturnRequiresFreshBarrierAndSnapshot() {
        let host = Host()
        let controller = SessionSubscriptionController(host: host)
        controller.onSessionList(tentacleId: "T1")
        controller.setDesired("A")
        controller.onAck(ack("T1", "A"))
        host.offline.insert("T1")
        controller.onTentacleUnavailable("T1")
        XCTAssertFalse(controller.liveReady)
        XCTAssertEqual(controller.desiredSessionId, "A")
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.count, 1)
        host.offline.remove("T1")
        controller.onSessionList(tentacleId: "T1")
        XCTAssertEqual(host.sends.map { $0.1 }, ["A", "A"])
        controller.onAck(ack("T1", "A"))
        XCTAssertTrue(controller.liveReady)
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
