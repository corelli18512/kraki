import Foundation
import XCTest
@testable import Kraki_Dev

/// A linked Mac receives each notification twice: over the local link and
/// from the Head. It must post it exactly once, whichever arrives first.
@MainActor
final class MacNotificationDedupTests: XCTestCase {
    private var posts: [(String, String)] = []
    private var app: AppState!
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("notif-dedup-\(UUID().uuidString)")
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        posts = []
        MacNotifications.shared.postHandlerForTesting = { [weak self] sessionId, _, body in
            self?.posts.append((sessionId, body))
        }
        UserDefaults.standard.set(true, forKey: MacNotifications.enabledKey)
    }

    override func tearDown() async throws {
        MacNotifications.shared.postHandlerForTesting = nil
        try? FileManager.default.removeItem(at: root)
    }

    private func preview(_ nid: String?, session: String = "S1", type: String = "idle", summary: String = "Done") -> String {
        var object: [String: Any] = ["type": type, "summary": summary, "sessionId": session]
        if let nid { object["nid"] = nid }
        return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    func testSameNotificationFromBothRoutesPostsOnce() {
        let nid = UUID().uuidString
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "link")
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "head")
        XCTAssertEqual(posts.count, 1)
        // Head first, link second.
        let other = UUID().uuidString
        MacNotifications.shared.present(decryptedPreview: preview(other), appState: app, route: "head")
        MacNotifications.shared.present(decryptedPreview: preview(other), appState: app, route: "link")
        XCTAssertEqual(posts.count, 2)
    }

    func testDistinctNotificationsAllPost() {
        for _ in 0..<5 {
            MacNotifications.shared.present(decryptedPreview: preview(UUID().uuidString), appState: app, route: "link")
        }
        XCTAssertEqual(posts.count, 5)
    }

    func testPreviewsWithoutIdFromOlderTentaclesAreNeverDeduplicated() {
        MacNotifications.shared.present(decryptedPreview: preview(nil), appState: app, route: "head")
        MacNotifications.shared.present(decryptedPreview: preview(nil), appState: app, route: "head")
        XCTAssertEqual(posts.count, 2)
    }

    func testCopySkippedWhileViewingAlsoSuppressesTheLateOtherCopy() {
        // The link copy arrives while the Session is on screen (no banner);
        // the Head copy arrives after the user has moved on. It must not post.
        app.isAppForeground = true
        app.isConversationWindowVisible = true
        app.sessionStore.activeSessionId = "S1"
        let nid = UUID().uuidString
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "link")
        XCTAssertEqual(posts.count, 0)
        app.sessionStore.activeSessionId = "S2"
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "head")
        XCTAssertEqual(posts.count, 0)
    }

    func testDisabledNotificationsStillClaimTheId() {
        UserDefaults.standard.set(false, forKey: MacNotifications.enabledKey)
        let nid = UUID().uuidString
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "link")
        UserDefaults.standard.set(true, forKey: MacNotifications.enabledKey)
        MacNotifications.shared.present(decryptedPreview: preview(nid), appState: app, route: "head")
        XCTAssertEqual(posts.count, 0)
    }

    func testDeduperSurvivesRestartAndStaysBounded() {
        let suite = "dedup-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = NotificationDeduper(defaults: defaults)
        XCTAssertTrue(first.claim("a"))
        XCTAssertFalse(first.claim("a"))
        // A new App process (new deduper) still recognises the late Head copy.
        let restarted = NotificationDeduper(defaults: defaults)
        XCTAssertFalse(restarted.claim("a"))
        // Bounded: the oldest ids are forgotten, recent ones kept.
        for i in 0..<(NotificationDeduper.capacity + 10) { _ = restarted.claim("id-\(i)") }
        XCTAssertEqual(defaults.stringArray(forKey: NotificationDeduper.defaultsKey)?.count, NotificationDeduper.capacity)
        XCTAssertFalse(restarted.claim("id-\(NotificationDeduper.capacity + 9)"))
        XCTAssertTrue(restarted.claim("a"), "evicted ids may post again")
    }

    func testMalformedOrOversizedIdsAreIgnored() {
        XCTAssertNil(MacNotifications.notificationId(in: "not json"))
        XCTAssertNil(MacNotifications.notificationId(in: #"{"nid":""}"#))
        XCTAssertNil(MacNotifications.notificationId(in: "{\"nid\":\"\(String(repeating: "x", count: 65))\"}"))
        XCTAssertEqual(MacNotifications.notificationId(in: #"{"nid":"abc"}"#), "abc")
    }

    func testLinkDeliveredLocalNotificationReachesThePresenter() throws {
        app.deviceId = "app-1"
        let router = app.messageRouter!
        let nid = UUID().uuidString
        let message: [String: Any] = [
            "type": "local_notification", "deviceId": "T1", "seq": 1,
            "payload": ["preview": preview(nid, type: "permission", summary: "Write a file")],
        ]
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: message))
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts.first?.1, "Needs approval: Write a file")
        // The Head copy afterwards is dropped.
        MacNotifications.shared.present(decryptedPreview: preview(nid, type: "permission", summary: "Write a file"), appState: app, route: "head")
        XCTAssertEqual(posts.count, 1)
    }
}
