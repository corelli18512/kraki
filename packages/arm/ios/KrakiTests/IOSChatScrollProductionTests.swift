import XCTest
@testable import Kraki

#if os(iOS)
@MainActor
final class IOSChatScrollProductionTests: XCTestCase {
    private var temporaryRoots: [URL] = []
    private var windows: [UIWindow] = []
    private var appStates: [AppState] = []

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        appStates.removeAll()
        temporaryRoots.forEach { try? FileManager.default.removeItem(at: $0) }
        temporaryRoots.removeAll()
        try await super.tearDown()
    }

    func testLatestMessageJumpControls() throws {
        let fixture = try makeFixture(totalMessages: 80, lastMessageParagraphs: 60)
        let viewController = fixture.viewController
        let collectionView = fixture.collectionView

        drainMainRunLoop(milliseconds: 900)
        collectionView.layoutIfNeeded()
        let initial = snapshot(collectionView)
        XCTAssertLessThanOrEqual(abs(initial.distanceToBottom), 1.5)

        let buttons = findButtons(in: viewController.view)
        let startButton = try XCTUnwrap(
            buttons.first { $0.accessibilityLabel == "Jump to start of latest message" }
        )
        let bottomButton = try XCTUnwrap(
            buttons.first { $0.accessibilityLabel == "Jump to latest" }
        )
        XCTAssertFalse(startButton.isHidden, "long latest message should expose its start control at the tail")
        XCTAssertTrue(bottomButton.isHidden, "latest-tail control is unnecessary while already at the tail")
        XCTAssertNotNil(startButton.image(for: .normal), "latest-message-start helper must render an icon")
        // The tail button is hidden at entry, but its image must already be
        // installed so the first reveal cannot produce a blank control.
        XCTAssertNotNil(bottomButton.image(for: .normal), "jump-to-latest helper must render an icon")

        startButton.sendActions(for: .touchUpInside)
        drainMainRunLoop(milliseconds: 900)
        collectionView.layoutIfNeeded()

        let afterStart = snapshot(collectionView)
        let latest = try XCTUnwrap(afterStart.visibleBubbles.last(where: { $0.id == "ios-scroll-gate:80" }))
        XCTAssertGreaterThanOrEqual(latest.screenY, 100,
                                    "latest message start must remain below the top navigation glass")
        XCTAssertLessThanOrEqual(latest.screenY, 140,
                                 "latest message start should land near the reading position")
        XCTAssertGreaterThan(afterStart.distanceToBottom, 100,
                             "latest-message-start must not pin the viewport to the tail")
    }

    func testProductionScrollGate() throws {
        let fixture = try makeFixture(totalMessages: 240)
        let viewController = fixture.viewController
        let collectionView = fixture.collectionView

        drainMainRunLoop(milliseconds: 700)
        collectionView.layoutIfNeeded()

        let entry = snapshot(collectionView)
        XCTAssertGreaterThan(entry.itemCount, 0)
        XCTAssertGreaterThan(entry.contentHeight, entry.viewportHeight)
        XCTAssertLessThanOrEqual(abs(entry.distanceToBottom), 1.5,
                                 "iOS Session entry must be pinned to the newest tail")
        XCTAssertTrue(entry.visibleCellsMaterialized,
                      "every visible index path must have a production bubble cell")

        let minimumOffset = -collectionView.adjustedContentInset.top
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: minimumOffset),
            animated: false
        )
        collectionView.layoutIfNeeded()
        viewController.automationMarkUserScrolledAway()
        let topBefore = snapshot(collectionView)
        let anchorBefore = topBefore.firstVisibleBubble
        XCTAssertNotNil(anchorBefore, "top viewport must contain a bubble before prepend")

        viewController.scrollViewDidScroll(collectionView)
        viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        drainMainRunLoop(milliseconds: 3_500)
        collectionView.layoutIfNeeded()

        let afterOlder = snapshot(collectionView)
        let rawTopAfterOlder = fixture.appState.messageStore.windowState(fixture.sessionId)?.topSeq ?? 0
        XCTAssertLessThan(rawTopAfterOlder, fixture.entryRawTopSeq,
                          "first upward approach must load older history")
        XCTAssertGreaterThan(afterOlder.itemCount, entry.itemCount,
                             "older prepend must reveal additional cells")
        XCTAssertTrue(afterOlder.visibleCellsMaterialized)
        XCTAssertGreaterThanOrEqual(afterOlder.contentOffsetY, minimumOffset - 1)
        XCTAssertLessThanOrEqual(afterOlder.contentOffsetY, afterOlder.maximumOffsetY + 1)

        if let anchorBefore {
            let anchorAfter = afterOlder.bubble(named: anchorBefore.id)
            XCTAssertNotNil(anchorAfter, "the pre-pagination anchor must remain present")
            if let anchorAfter {
                let drift = abs(anchorAfter.screenY - anchorBefore.screenY)
                print("IOS_SCROLL_GATE anchor id=\(anchorBefore.id) before=\(anchorBefore.screenY) after=\(anchorAfter.screenY) drift=\(drift) offsetBefore=\(topBefore.contentOffsetY) offsetAfter=\(afterOlder.contentOffsetY) contentBefore=\(topBefore.contentHeight) contentAfter=\(afterOlder.contentHeight)")
                XCTAssertLessThanOrEqual(drift, 2.0,
                                         "older prepend moved the visible anchor by \(drift)pt")
            }
        }

        // A continuous upward approach must not expose blank cells while the
        // async DB-first page and the exact-height barrier are settling.
        let duringFlingOffsets = stride(from: afterOlder.maximumOffsetY,
                                         through: minimumOffset,
                                         by: -120).map { CGFloat($0) }
        for offset in duringFlingOffsets {
            collectionView.setContentOffset(
                CGPoint(x: collectionView.contentOffset.x, y: max(minimumOffset, offset)),
                animated: false
            )
            viewController.scrollViewDidScroll(collectionView)
            viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
            drainMainRunLoop(milliseconds: 40)
            XCTAssertTrue(snapshot(collectionView).visibleCellsMaterialized)
        }
        drainMainRunLoop(milliseconds: 900)
        XCTAssertFalse(collectionView.isDecelerating)

        // A later distinct approach may continue paging until the true oldest
        // boundary; it must remain clamped and must not duplicate item ids.
        for _ in 0..<8 {
            let state = snapshot(collectionView)
            guard state.topSeq > 1 else { break }
            collectionView.setContentOffset(
                CGPoint(x: collectionView.contentOffset.x, y: minimumOffset),
                animated: false
            )
            viewController.scrollViewDidScroll(collectionView)
            viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
            drainMainRunLoop(milliseconds: 450)
        }
        let final = snapshot(collectionView)
        XCTAssertGreaterThanOrEqual(final.contentOffsetY, minimumOffset - 1)
        XCTAssertLessThanOrEqual(final.contentOffsetY, final.maximumOffsetY + 1)
        XCTAssertEqual(final.itemIDs.count, Set(final.itemIDs).count,
                       "pagination must not duplicate visible spine identities")
        XCTAssertTrue(final.visibleCellsMaterialized)

        // The px-managed window can trim the far/newer edge while walking to
        // the oldest history. A later downward approach must recover that
        // newer page through the symmetric production path.
        let bottomBeforeNewer = fixture.appState.messageStore.windowState(fixture.sessionId)?.bottomSeq ?? 0
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: final.maximumOffsetY),
            animated: false
        )
        viewController.scrollViewDidScroll(collectionView)
        viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        drainMainRunLoop(milliseconds: 3_500)
        let afterNewer = snapshot(collectionView)
        let bottomAfterNewer = fixture.appState.messageStore.windowState(fixture.sessionId)?.bottomSeq ?? 0
        XCTAssertGreaterThan(bottomAfterNewer, bottomBeforeNewer,
                             "downward approach must recover trimmed newer history")
        XCTAssertGreaterThanOrEqual(afterNewer.contentOffsetY, minimumOffset - 1)
        XCTAssertLessThanOrEqual(afterNewer.contentOffsetY, afterNewer.maximumOffsetY + 1)
        XCTAssertTrue(afterNewer.visibleCellsMaterialized)

        // Reflow/size change while history mode is active must not expose an
        // invalid offset or an unmaterialized visible cell.
        fixture.window.frame = CGRect(x: 0, y: 0, width: 430, height: 700)
        viewController.view.frame = fixture.window.bounds
        viewController.view.setNeedsLayout()
        viewController.view.layoutIfNeeded()
        drainMainRunLoop(milliseconds: 500)
        let afterResize = snapshot(collectionView)
        XCTAssertGreaterThanOrEqual(afterResize.contentOffsetY, minimumOffset - 1)
        XCTAssertLessThanOrEqual(afterResize.contentOffsetY, afterResize.maximumOffsetY + 1)
        XCTAssertTrue(afterResize.visibleCellsMaterialized)
    }

    private struct Fixture { 
        let viewController: ChatPerfListVC
        let collectionView: UICollectionView
        let window: UIWindow
        let appState: AppState
        let sessionId: String
        let entryRawTopSeq: Int
    }

    private struct BubbleFrame {
        let id: String
        let screenY: CGFloat
    }

    private struct ScrollSnapshot {
        let itemCount: Int
        let itemIDs: [String]
        let topSeq: Int
        let contentHeight: CGFloat
        let viewportHeight: CGFloat
        let contentOffsetY: CGFloat
        let maximumOffsetY: CGFloat
        let distanceToBottom: CGFloat
        let visibleCellsMaterialized: Bool
        let visibleBubbles: [BubbleFrame]
        let firstVisibleBubble: BubbleFrame?

        func bubble(named id: String) -> BubbleFrame? {
            visibleBubbles.first { $0.id == id }
        }
    }

    private func makeFixture(totalMessages: Int, lastMessageParagraphs: Int = 4) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-ios-scroll-gate-\(UUID().uuidString)", isDirectory: true)
        temporaryRoots.append(root)
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let sessionId = "ios-scroll-gate"
        let messages = (1...totalMessages).map { seq in
            let paragraph = String(
                repeating: "Message \(seq): a realistic wrapped response keeps pagination anchored while the viewport moves. ",
                count: seq == totalMessages ? lastMessageParagraphs : 4
            )
            return ChatMessage(
                type: seq.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "ios-scroll-device",
                timestamp: "2026-08-22T00:00:00Z",
                payload: ["content": AnyCodable(paragraph)]
            )
        }
        try database.insert(sessionId, messages)

        let appState = AppState(testDatabase: database)
        appStates.append(appState)
        appState.messageProvider?.setTentacleInfo(
            sessionId: sessionId,
            lastSeq: totalMessages,
            deviceId: "ios-scroll-device"
        )
        _ = appState.messageStore.loadInitialWindow(sessionId)

        let viewController = ChatPerfListVC(
            sessionId: sessionId,
            appState: appState,
            agent: "claude",
            bottomContentInset: 54
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = viewController
        window.makeKeyAndVisible()
        windows.append(window)
        viewController.view.frame = window.bounds
        viewController.loadViewIfNeeded()
        viewController.view.setNeedsLayout()
        viewController.view.layoutIfNeeded()
        viewController.viewDidAppear(false)

        guard let collectionView = findCollectionView(in: viewController.view) else {
            throw XCTSkip("ChatPerfListVC did not mount its UICollectionView")
        }
        let entryRawTopSeq = appState.messageStore.windowState(sessionId)?.topSeq ?? 0
        return Fixture(
            viewController: viewController,
            collectionView: collectionView,
            window: window,
            appState: appState,
            sessionId: sessionId,
            entryRawTopSeq: entryRawTopSeq
        )
    }

    private func findCollectionView(in view: UIView) -> UICollectionView? {
        if let collectionView = view as? UICollectionView { return collectionView }
        for child in view.subviews {
            if let collectionView = findCollectionView(in: child) { return collectionView }
        }
        return nil
    }

    private func findButtons(in view: UIView) -> [UIButton] {
        var result: [UIButton] = []
        if let button = view as? UIButton { result.append(button) }
        for child in view.subviews {
            result.append(contentsOf: findButtons(in: child))
        }
        return result
    }

    private func snapshot(_ collectionView: UICollectionView) -> ScrollSnapshot {
        collectionView.layoutIfNeeded()
        let itemCount = collectionView.numberOfItems(inSection: 0)
        let itemIDs = collectionView.indexPathsForVisibleItems.compactMap { indexPath in
            (collectionView.cellForItem(at: indexPath) as? TKBubbleCell)?.contentSnapshot?.message.id
        }
        let visibleCellsMaterialized = collectionView.indexPathsForVisibleItems.allSatisfy {
            collectionView.cellForItem(at: $0) is TKBubbleCell
        }
        let visible = collectionView.indexPathsForVisibleItems
            .sorted()
            .compactMap { indexPath -> BubbleFrame? in
                guard let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell,
                      let message = cell.contentSnapshot?.message else { return nil }
                return BubbleFrame(
                    id: message.id,
                    screenY: cell.frame.minY - collectionView.contentOffset.y
                )
            }
            .first
        let minY = -collectionView.adjustedContentInset.top
        let maxY = max(
            minY,
            collectionView.contentSize.height
                - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom
        )
        let distance = collectionView.contentSize.height
            + collectionView.adjustedContentInset.bottom
            - collectionView.bounds.height
            - collectionView.contentOffset.y
        let topSeq = collectionView.indexPathsForVisibleItems
            .compactMap { (collectionView.cellForItem(at: $0) as? TKBubbleCell)?.contentSnapshot?.message.seq }
            .min() ?? 0
        return ScrollSnapshot(
            itemCount: itemCount,
            itemIDs: itemIDs,
            topSeq: topSeq,
            contentHeight: collectionView.contentSize.height,
            viewportHeight: collectionView.bounds.height,
            contentOffsetY: collectionView.contentOffset.y,
            maximumOffsetY: maxY,
            distanceToBottom: distance,
            visibleCellsMaterialized: visibleCellsMaterialized,
            visibleBubbles: collectionView.indexPathsForVisibleItems
                .sorted()
                .compactMap { indexPath -> BubbleFrame? in
                    guard let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell,
                          let message = cell.contentSnapshot?.message else { return nil }
                    return BubbleFrame(
                        id: message.id,
                        screenY: cell.frame.minY - collectionView.contentOffset.y
                    )
                },
            firstVisibleBubble: visible
        )
    }

    private func drainMainRunLoop(milliseconds: Int) {
        let deadline = Date().addingTimeInterval(Double(milliseconds) / 1_000)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.01)))
        }
    }
}
#endif
