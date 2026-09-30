import XCTest
@testable import Kraki

/// Opening (`ready.summary`) and outage (`outage.summary`) records, driven by a
/// fake clock through the same calls AppState makes.
final class StabilityTrackerTests: XCTestCase {
    private var clock: TimeInterval = 1_000
    private var scheduled: [(at: TimeInterval, work: () -> Void)] = []
    private var tracker: StabilityTracker!

    override func setUp() {
        super.setUp()
        clock = 1_000
        scheduled = []
        tracker = StabilityTracker()
        tracker.now = { [unowned self] in clock }
        tracker.schedule = { [unowned self] delay, work in scheduled.append((clock + delay, work)) }
        tracker.pathChanged(to: "wifi")
    }

    private func advance(_ seconds: TimeInterval) {
        clock += seconds
        let due = scheduled.filter { $0.at <= clock }
        scheduled.removeAll { $0.at <= clock }
        due.forEach { $0.work() }
    }

    /// First connection of the process, as the Mac and iOS both do.
    private func coldOpenAndAuthenticate(viewing: Bool = true) {
        tracker.appVisible(hasCachedContent: true, viewing: viewing)
        tracker.connecting()
        advance(0.2); tracker.socketOpen()
        advance(0.3); tracker.authenticated()
    }

    // MARK: - Openings

    func testColdOpeningWaitsUntilTheViewedConversationIsCurrent() throws {
        tracker.appVisible(hasCachedContent: false, viewing: true)
        tracker.connecting()
        advance(0.4); tracker.conversationRendered(sessionId: "s1", localSeq: 10, lastSeq: 10, hasContent: true)
        advance(0.1); tracker.socketOpen()
        advance(0.3); tracker.authenticated()
        advance(0.2); tracker.sessionListApplied(viewed: (sessionId: "s1", lastSeq: 14, localSeq: 10))
        XCTAssertTrue(tracker.readies.isEmpty, "4 newer messages are still missing on screen")
        advance(0.5); tracker.conversationRendered(sessionId: "s1", localSeq: 12, lastSeq: 14, hasContent: true)
        XCTAssertTrue(tracker.readies.isEmpty)
        advance(0.5); tracker.conversationRendered(sessionId: "s1", localSeq: 14, lastSeq: 14, hasContent: true)

        let ready = try XCTUnwrap(tracker.readies.first)
        XCTAssertEqual(ready.kind, .cold)
        XCTAssertEqual(ready.outcome, .ready)
        XCTAssertNil(ready.backgroundMs)
        XCTAssertEqual(try XCTUnwrap(ready.firstContentMs), 400, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(ready.wsOpenMs), 500, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(ready.authedMs), 800, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(ready.listFreshMs), 1000, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(ready.viewCurrentMs), 2000, accuracy: 1)
        XCTAssertEqual(ready.gap, 4)
        XCTAssertEqual(ready.attempts, 0)
        XCTAssertEqual(ready.path, "wifi")
    }

    func testWarmOpeningOnTheSessionListIsCurrentWhenTheListArrives() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        tracker.appHidden()
        advance(125)
        tracker.appVisible(hasCachedContent: true, viewing: false)
        tracker.connecting()
        advance(0.1); tracker.connecting() // one failed attempt
        advance(0.6); tracker.socketOpen()
        advance(0.2); tracker.authenticated()
        advance(0.1); tracker.sessionListApplied(viewed: nil)

        XCTAssertEqual(tracker.readies.count, 2)
        let warm = tracker.readies[1]
        XCTAssertEqual(warm.kind, .warm)
        XCTAssertEqual(try XCTUnwrap(warm.backgroundMs), 125_000, accuracy: 1)
        XCTAssertEqual(warm.firstContentMs, 0, "content stays in memory while backgrounded")
        XCTAssertEqual(warm.attempts, 1)
        XCTAssertEqual(try XCTUnwrap(warm.viewCurrentMs), 1000, accuracy: 1)
        XCTAssertFalse(warm.viewing)
    }

    func testLeavingBeforeReadyIsAbandonedAndSlowOpeningTimesOut() throws {
        tracker.appVisible(hasCachedContent: true, viewing: true)
        advance(1); tracker.appHidden()
        XCTAssertEqual(tracker.readies.last?.outcome, .abandoned)

        advance(10)
        tracker.appVisible(hasCachedContent: true, viewing: true)
        tracker.connecting()
        advance(31)
        let timedOut = try XCTUnwrap(tracker.readies.last)
        XCTAssertEqual(timedOut.outcome, .timeout)
        XCTAssertNil(timedOut.authedMs)
        XCTAssertEqual(tracker.readies.count, 2)
    }

    func testOpeningAnotherConversationMeanwhileRetargets() throws {
        coldOpenAndAuthenticate()
        tracker.sessionListApplied(viewed: (sessionId: "s1", lastSeq: 9, localSeq: 3))
        advance(0.4); tracker.conversationRendered(sessionId: "s2", localSeq: 20, lastSeq: 22, hasContent: true)
        XCTAssertTrue(tracker.readies.isEmpty, "s2 is still behind")
        advance(0.4); tracker.conversationRendered(sessionId: "s2", localSeq: 22, lastSeq: 22, hasContent: true)
        XCTAssertEqual(tracker.readies.first?.outcome, .ready)
    }

    func testMacWakeIsItsOwnOpeningAndItsDropIsNotAnOutage() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        advance(5)
        tracker.systemWillSleep()
        advance(3600)
        tracker.appVisible(hasCachedContent: true, viewing: false) // didWake → rehydrate
        tracker.transportLost(reason: "transport_error", code: -1005, quietFor: 3_610)
        tracker.connecting()
        advance(0.9); tracker.socketOpen()
        advance(0.3); tracker.authenticated()
        advance(0.2); tracker.sessionListApplied(viewed: nil)

        let wake = try XCTUnwrap(tracker.readies.last)
        XCTAssertEqual(wake.kind, .wake)
        XCTAssertEqual(try XCTUnwrap(wake.backgroundMs), 3_600_000, accuracy: 1)
        XCTAssertEqual(wake.outcome, .ready)
        XCTAssertTrue(tracker.outages.isEmpty, "the wake reconnect is part of the opening")
    }

    // MARK: - Outages

    func testOutageSplitsDetectionReconnectAndCatchUp() throws {
        coldOpenAndAuthenticate()
        tracker.sessionListApplied(viewed: (sessionId: "s1", lastSeq: 5, localSeq: 5))
        advance(600)

        // Half-open: nothing arrived for 22 s before the client gave up.
        tracker.transportLost(reason: "transport_silent", code: nil, quietFor: 22)
        tracker.connecting()
        advance(2); tracker.reconnectingShown(true)
        advance(1); tracker.connecting()
        advance(1.5); tracker.socketOpen()
        advance(0.5); tracker.authenticated()
        tracker.reconnectingShown(false)
        advance(0.3); tracker.sessionListApplied(viewed: (sessionId: "s1", lastSeq: 8, localSeq: 5))
        XCTAssertTrue(tracker.outages.isEmpty, "3 messages still missing")
        advance(0.7); tracker.conversationRendered(sessionId: "s1", localSeq: 8, lastSeq: 8, hasContent: true)

        let outage = try XCTUnwrap(tracker.outages.first)
        XCTAssertEqual(outage.reason, "transport_silent")
        XCTAssertEqual(outage.outcome, .recovered)
        XCTAssertEqual(outage.detectMs, 22_000, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(outage.reconnectMs), 5_000, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(outage.catchupMs), 1_000, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(outage.impactMs), 28_000, accuracy: 1)
        XCTAssertEqual(outage.visibleMs, 3_000, accuracy: 1)
        XCTAssertEqual(outage.attempts, 2)
        XCTAssertFalse(outage.pathChanged)
        XCTAssertEqual(tracker.readies.count, 1, "an outage is not an opening")
    }

    func testPathChangeAndServerCloseAreRecorded() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        advance(300)
        tracker.pathChanged(to: "cellular")
        advance(3)
        tracker.transportLost(reason: "peer_closed", code: 1001, quietFor: 0.5)
        tracker.connecting()
        advance(0.8); tracker.authenticated()
        tracker.sessionListApplied(viewed: nil)

        let outage = try XCTUnwrap(tracker.outages.first)
        XCTAssertEqual(outage.code, 1001)
        XCTAssertEqual(outage.path, "cellular")
        XCTAssertTrue(outage.pathChanged)
        XCTAssertEqual(outage.visibleMs, 0, "a sub-2 s blip never shows Reconnecting")
    }

    func testRepeatedDropsBeforeCatchingUpAreOneOutage() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        advance(60)
        tracker.transportLost(reason: "ping_timeout", code: nil, quietFor: 8)
        advance(1); tracker.authenticated()
        advance(1); tracker.transportLost(reason: "transport_error", code: -1005, quietFor: 1) // before the list
        advance(2); tracker.authenticated()
        advance(0.5); tracker.sessionListApplied(viewed: nil)

        XCTAssertEqual(tracker.outages.count, 1)
        let outage = try XCTUnwrap(tracker.outages.first)
        XCTAssertEqual(outage.reason, "ping_timeout", "the first cause is the cause")
        XCTAssertEqual(try XCTUnwrap(outage.impactMs), 12_500, accuracy: 1)
    }

    func testNoOutageWhileHiddenOrBeforeFirstSignIn() throws {
        tracker.transportLost(reason: "transport_error", code: -1004, quietFor: nil)
        XCTAssertTrue(tracker.outages.isEmpty, "never connected yet")

        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        tracker.appHidden()
        tracker.transportLost(reason: "transport_error", code: -1005, quietFor: 1)
        XCTAssertTrue(tracker.outages.isEmpty, "background closes are intentional")
    }

    func testOutageEndsWhenTheAppLeavesOrGivesUp() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        advance(10)
        tracker.transportLost(reason: "transport_error", code: -1009, quietFor: 0)
        advance(40); tracker.appHidden()
        XCTAssertEqual(tracker.outages.last?.outcome, .backgrounded)
        XCTAssertNil(tracker.outages.last?.impactMs)

        tracker.appVisible(hasCachedContent: true, viewing: false)
        tracker.authenticated(); tracker.sessionListApplied(viewed: nil)
        advance(10)
        tracker.transportLost(reason: "transport_error", code: -1009, quietFor: 0)
        advance(601)
        XCTAssertEqual(tracker.outages.last?.outcome, .abandoned)
        XCTAssertEqual(tracker.outages.count, 2)
    }

    // MARK: - Opening a conversation

    func testOpeningAConversationWaitsForItsLatestMessages() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        advance(30)
        tracker.conversationOpened(sessionId: "s2", lastSeq: 50, localSeq: 44, online: true)
        XCTAssertTrue(tracker.wantsConversationUpdates)
        advance(0.05); tracker.conversationRendered(sessionId: "s2", localSeq: 44, lastSeq: 50, hasContent: true)
        advance(0.5); tracker.conversationRendered(sessionId: "s2", localSeq: 50, lastSeq: 50, hasContent: true)
        let open = try XCTUnwrap(tracker.opens.first)
        XCTAssertEqual(open.outcome, .current)
        XCTAssertEqual(open.gap, 6)
        XCTAssertEqual(try XCTUnwrap(open.firstContentMs), 50, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(open.currentMs), 550, accuracy: 1)
        XCTAssertFalse(tracker.wantsConversationUpdates, "no lookups once done")
    }

    func testOpeningIsNotRecordedOfflineAndEndsWhenLeft() throws {
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        tracker.conversationOpened(sessionId: "s1", lastSeq: 9, localSeq: 9, online: false)
        XCTAssertTrue(tracker.opens.isEmpty)
        tracker.conversationOpened(sessionId: "s1", lastSeq: 9, localSeq: 3, online: true)
        advance(1); tracker.conversationOpened(sessionId: "s2", lastSeq: 4, localSeq: 4, online: true)
        advance(0.1); tracker.conversationRendered(sessionId: "s2", localSeq: 4, lastSeq: 4, hasContent: true)
        XCTAssertEqual(tracker.opens.map(\.outcome), [.left, .current])
    }

    func testColdRecordCarriesThePreviousExit() throws {
        tracker.previousExit = { "unclean" }
        coldOpenAndAuthenticate(viewing: false)
        tracker.sessionListApplied(viewed: nil)
        tracker.appHidden(); advance(5)
        tracker.appVisible(hasCachedContent: true, viewing: false)
        tracker.authenticated(); tracker.sessionListApplied(viewed: nil)
        XCTAssertEqual(tracker.readies.map(\.previousExit), ["unclean", nil])
    }
}
