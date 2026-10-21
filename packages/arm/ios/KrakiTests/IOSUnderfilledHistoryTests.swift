#if os(iOS)
import UIKit
import XCTest
@testable import Kraki

@MainActor
final class IOSUnderfilledHistoryTests: XCTestCase {
    private var roots: [URL] = []
    private var windows: [UIWindow] = []
    private var states: [AppState] = []
    private let sid = "ios-underfilled"

    override func setUpWithError() throws {
        try requireForegroundUITests()
    }

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        states.removeAll()
        await settle()
        roots.forEach { try? FileManager.default.removeItem(at: $0) }
        roots.removeAll()
        try await super.tearDown()
    }

    func testShortStoppedTailFillsWithoutUserPagingAndKeepsTail() async throws {
        let vc = try fixture(total: 180, height: 2_200)
        let initialTop = vc.vm.windowTopSeq
        await settle()
        XCTAssertLessThan(vc.vm.windowTopSeq, initialTop)
        XCTAssertGreaterThanOrEqual(renderedHeight(vc), availableHeight(vc) - 1)
        XCTAssertFalse(vc.allowsEdgePaging, "automatic fill must not synthesize user intent")
        XCTAssertEqual(vc.vm.windowBottomSeq, 180)
        XCTAssertFalse(vc.atOldest, "stop once the viewport fills")
        XCTAssertEqual(vc.collectionView.contentOffset.y, vc.maximumOffsetY(), accuracy: 1)
        let top = vc.vm.windowTopSeq
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
    }

    func testShortHistoryReachesStartAndRemovesOlderSpinner() async throws {
        let vc = try fixture(total: 36, height: 2_200)
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, 1)
        XCTAssertTrue(vc.atOldest)
        XCTAssertFalse(vc.loadingOlder)
        XCTAssertFalse(vc.allowsEdgePaging)
        XCTAssertEqual(vc.collectionView.contentOffset.y, -vc.collectionView.adjustedContentInset.top, accuracy: 1,
                       "short complete history stays top-aligned")
    }

    func testFilledTailDoesNotPageAtRest() async throws {
        let vc = try fixture(total: 180, height: 400)
        let top = vc.vm.windowTopSeq
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
        XCTAssertFalse(vc.allowsEdgePaging)
    }

    func testFillWaitsForNavigationAndUserInteraction() async throws {
        let vc = try fixture(total: 180, height: 2_200)
        let top = vc.vm.windowTopSeq
        vc.scrollPolicy.beginLatestMessageStartNavigation()
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
        vc.scrollPolicy.endNavigation()
        vc.automationMarkUserScrolledAway()
        vc.updateJumpButtonVisibility()
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
        vc.scrollPolicy.endUserInteraction()
        vc.settleEdges()
        await settle()
        XCTAssertLessThan(vc.vm.windowTopSeq, top)
    }

    func testFillStopsAfterEightPagesAndDoesNotConsumeUserAllowance() async throws {
        let vc = try fixture(total: 300, height: 20_000)
        let initialTop = vc.vm.windowTopSeq
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, initialTop - 80, "eight 10-row older pages per entry")
        let top = vc.vm.windowTopSeq
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
        vc.automationMarkUserScrolledAway()
        vc.collectionView.contentOffset.y = -vc.collectionView.adjustedContentInset.top
        vc.driveEdges()
        vc.scrollPolicy.endUserInteraction()
        await settle()
        XCTAssertLessThan(vc.vm.windowTopSeq, top, "normal user paging has a separate budget")
    }

    func testHiddenEntryWaitsUntilVisible() async throws {
        let vc = try fixture(total: 180, height: 2_200)
        let top = vc.vm.windowTopSeq
        vc.view.isHidden = true
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, top)
        vc.view.isHidden = false
        vc.updateJumpButtonVisibility()
        await settle()
        XCTAssertLessThan(vc.vm.windowTopSeq, top)
    }

    func testNoProgressEdgeIsNotRequestedRepeatedly() async throws {
        let vc = try fixture(total: 60, height: 2_200, storedFrom: 31)
        await settle()
        XCTAssertEqual(vc.vm.windowTopSeq, 31)
        XCTAssertEqual(vc.underfilledHistory.pagesRequested, 1)
        for _ in 0..<4 { vc.updateJumpButtonVisibility() }
        await settle()
        XCTAssertEqual(vc.underfilledHistory.pagesRequested, 1)
    }

    func testNonvisualRawWindowCanFillAtRest() async throws {
        let vc = try fixture(total: 60, height: 900, nonvisualTail: true)
        XCTAssertTrue(vc.items.isEmpty)
        await settle()
        XCTAssertLessThan(vc.vm.windowTopSeq, 31)
        XCTAssertFalse(vc.items.isEmpty)
        XCTAssertEqual(vc.items, vc.ids)
        XCTAssertFalse(vc.allowsEdgePaging)
    }

    private func fixture(total: Int, height: CGFloat, nonvisualTail: Bool = false, storedFrom: Int = 1) throws -> ChatPerfListVC {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("underfilled-\(UUID().uuidString)")
        roots.append(root)
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        try db.insert(sid, (storedFrom...total).map { seq in
            let type: String
            let payload: [String: AnyCodable]
            if nonvisualTail && seq > total - 30 {
                type = "idle"; payload = [:]
            } else {
                switch seq % 3 {
                case 1: type = "user_message"; payload = ["content": "Stop"]
                case 2: type = "turn_status"; payload = ["action": AnyCodable(["type": "user_abort", "payload": [:]] as [String: Any])]
                default: type = "idle"; payload = [:]
                }
            }
            return ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: "test-device", timestamp: nil, payload: payload)
        })
        let app = AppState(testDatabase: db)
        states.append(app)
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: total, deviceId: "test-device")
        _ = app.messageStore.loadInitialWindow(sid)
        let vc = ChatPerfListVC(sessionId: sid, appState: app, agent: "claude", bottomContentInset: 60)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: height))
        window.rootViewController = vc
        window.makeKeyAndVisible()
        windows.append(window)
        vc.view.frame = window.bounds
        vc.loadViewIfNeeded()
        vc.beginAppearanceTransition(true, animated: false)
        vc.view.layoutIfNeeded()
        vc.endAppearanceTransition()
        return vc
    }

    private func renderedHeight(_ vc: ChatPerfListVC) -> CGFloat {
        guard !vc.items.isEmpty,
              let first = vc.collectionView.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)),
              let last = vc.collectionView.layoutAttributesForItem(at: IndexPath(item: vc.items.count - 1, section: 0)) else { return 0 }
        return last.frame.maxY - first.frame.minY
    }

    private func availableHeight(_ vc: ChatPerfListVC) -> CGFloat {
        vc.collectionView.bounds.height - vc.collectionView.adjustedContentInset.top - vc.tailAdjustedInsets.bottom
    }

    private func settle() async {
        for _ in 0..<100 { try? await Task.sleep(for: .milliseconds(20)) }
    }
}
#endif
