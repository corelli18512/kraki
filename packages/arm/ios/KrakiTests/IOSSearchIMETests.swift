#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

/// Session search with a Chinese (pinyin) input method. While the IME is
/// composing (marked text), the search must not filter by the raw letters,
/// and the field must survive result changes so composition is not cut off.
/// Uses the production SessionListView in a real window; composition is
/// driven through the real UITextInput API (setMarkedText / unmarkText).
@MainActor
final class IOSSearchIMETests: XCTestCase {
    static let device = "ime-tentacle"
    private var root: URL!
    private var app: AppState!
    private var window: UIWindow!
    @Observable final class Nav { var path = NavigationPath() }
    private let nav = Nav()

    struct Harness: View {
        @Bindable var nav: Nav
        let app: AppState
        var body: some View {
            NavigationStack(path: $nav.path) { SessionListView(navigationPath: $nav.path, startsSearching: true) }
                .environment(app)
        }
    }

    private func drain(_ ms: Int = 400) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ime-\(UUID().uuidString)")
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(DeviceSummary(id: Self.device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        let titles = ["中文搜索修复", "部署脚本", "Fix login flow", "中国区重要会话"]
        let sessions: [[String: Any]] = titles.enumerated().map { i, title in
            let ts = "2026-10-1\(i)T10:00:00.000Z"
            return ["id": "ime\(i)", "agent": "pi", "model": "deepseek-flash", "title": title, "state": "idle", "mode": "auto",
                    "lastSeq": 1, "readSeq": 1, "messageCount": 1, "createdAt": ts, "pinned": false, "lastActivityAt": ts,
                    "preview": ["text": "预览 \(title)", "type": "agent_message", "timestamp": ts]]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": Self.device, "seq": 1, "timestamp": ISO8601.withFractional.string(from: Date()),
            "payload": ["sessions": sessions, "archivedCount": 0, "autoArchiveDays": 14],
        ])
        app.messageRouter?.handleDataMessage(data)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView: Harness(nav: nav, app: app))
        window.makeKeyAndVisible()
        drain(800)
    }

    override func tearDown() {
        window?.isHidden = true; window = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    // MARK: Helpers

    private func all<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        (view as? T).map { [$0] } ?? [] + view.subviews.flatMap { all(type, in: $0) }
    }
    private func views<T: UIView>(_ type: T.Type) -> [T] { all(type, in: window) }

    private func openSearch() throws -> UITextField {
        // Mounting the field and UIKit's queued first-responder handoff are
        // separate turns; the fixed appearance delay did not prove focus.
        let deadline = Date().addingTimeInterval(5)
        while views(UITextField.self).first?.isFirstResponder != true, Date() < deadline { drain(20) }
        return try XCTUnwrap(views(UITextField.self).first(where: \.isFirstResponder), "focused search field")
    }

    /// Visible session rows (0 when the empty "no results" state replaced the list).
    private var visibleRows: Int {
        views(UITableView.self).reduce(0) { sum, table in
            sum + (0..<table.numberOfSections).reduce(0) { $0 + table.numberOfRows(inSection: $1) }
        }
    }

    private func compose(_ field: UITextField, _ marked: String) {
        field.setMarkedText(marked, selectedRange: NSRange(location: (marked as NSString).length, length: 0))
        field.sendActions(for: .editingChanged)
        NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: field)
        drain(500)
    }

    private func commit(_ field: UITextField, _ text: String) {
        if let range = field.markedTextRange { field.replace(range, withText: text); field.unmarkText() }
        else { field.insertText(text) }
        field.sendActions(for: .editingChanged)
        NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: field)
        drain(500)
    }

    // MARK: Tests

    /// Typing "zhong" letter by letter: the list must not filter by pinyin
    /// letters (that hides everything and flips to the empty state), the same
    /// field must stay first responder and keep the composition intact.
    func testPinyinCompositionDoesNotFilterOrInterruptTheField() throws {
        let field = try openSearch()
        XCTAssertTrue(field.isFirstResponder, "search field focused")
        XCTAssertEqual(visibleRows, 4)
        for prefix in ["z", "zh", "zho", "zhon", "zhong"] {
            compose(field, prefix)
            let current = views(UITextField.self).first
            XCTAssertTrue(current === field, "field recreated while composing '\(prefix)'")
            XCTAssertTrue(field.isFirstResponder, "focus lost while composing '\(prefix)'")
            XCTAssertNotNil(field.markedTextRange, "composition cancelled at '\(prefix)'")
            XCTAssertEqual(visibleRows, 4, "list filtered by pinyin letters at '\(prefix)'")
        }
        commit(field, "中")
        XCTAssertTrue(views(UITextField.self).first === field)
        XCTAssertTrue(field.isFirstResponder)
        XCTAssertEqual(field.text, "中")
        XCTAssertEqual(visibleRows, 2, "committed text filters: 中文搜索修复, 中国区重要会话")
    }

    func testOpenSearchWaitsForDeferredNativeFocus() throws {
        let field = try openSearch()
        field.resignFirstResponder()
        DispatchQueue.main.async { field.becomeFirstResponder() }
        XCTAssertTrue(try openSearch().isFirstResponder, "wait for UIKit's queued focus handoff")
    }

    /// No match → empty state → a new match. The field (and an in-progress
    /// composition after a committed prefix) must survive both transitions.
    func testFieldSurvivesSwitchingToAndFromNoResults() throws {
        let field = try openSearch()
        commit(field, "不存在")
        XCTAssertEqual(visibleRows, 0, "no results shown")
        XCTAssertTrue(views(UITextField.self).first === field, "field recreated by the empty state")
        XCTAssertTrue(field.isFirstResponder)
        compose(field, "b")
        XCTAssertNotNil(field.markedTextRange)
        XCTAssertTrue(field.isFirstResponder)
        XCTAssertEqual(visibleRows, 0, "still the committed query, not 不存在b")
        commit(field, "")
        XCTAssertEqual(field.text, "不存在")
        for _ in 0..<3 { field.deleteBackward() }
        drain(500)
        XCTAssertEqual(field.text, "")
        XCTAssertEqual(visibleRows, 4)
        XCTAssertTrue(views(UITextField.self).first === field, "field recreated leaving the empty state")
        XCTAssertTrue(field.isFirstResponder)
    }

    @Observable final class Query { var text = "" }

    struct FieldHost: View {
        @Bindable var query: Query
        var body: some View { IMESearchField(placeholder: "Search Sessions", text: $query.text) }
    }

    /// The header's × sets the query to "" while "zh" is still being
    /// composed after a committed "中": the field must empty (composition
    /// dropped), and the next commit must not bring "中" back.
    func testClearWhileComposingEmptiesTheField() throws {
        let query = Query()
        window.rootViewController = UIHostingController(rootView: FieldHost(query: query))
        drain(600)
        let field = try openSearch()
        commit(field, "中")
        XCTAssertEqual(query.text, "中")
        compose(field, "zh")
        XCTAssertNotNil(field.markedTextRange)
        XCTAssertEqual(query.text, "中")

        query.text = ""
        drain(400)
        XCTAssertEqual(field.text ?? "", "", "Clear empties the field")
        XCTAssertNil(field.markedTextRange, "Clear ends the composition")
        XCTAssertEqual(query.text, "")

        commit(field, "国")
        XCTAssertEqual(query.text, "国", "the cleared text does not come back")
    }

    /// Plain (non-IME) typing still filters live, character by character.
    func testLatinTypingFiltersLive() throws {
        let field = try openSearch()
        XCTAssertEqual(visibleRows, 4)
        field.insertText("F"); drain(500)
        XCTAssertEqual(visibleRows, 4, "every model name (deepseek-flash) contains f")
        field.insertText("i"); drain(500)
        XCTAssertEqual(visibleRows, 1, "only Fix login flow")
        field.deleteBackward(); drain(500)
        XCTAssertEqual(visibleRows, 4)
        XCTAssertTrue(field.isFirstResponder)
    }
}
#endif
