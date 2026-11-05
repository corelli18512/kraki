#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin
@testable import Kraki

/// Starting and opening Sessions on iPhone: the New Session sheet's computer /
/// agent defaults and Start gate, and the Sessions tab stack across a fork,
/// the Session Info device row and a Session started from the sheet.
@MainActor
final class IOSNewSessionNavigationTests: XCTestCase {
    private var window: UIWindow?
    private var creates: [[String: Any]] = []

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        try Self.setApplicationAccessibility(true)
        creates = []
    }

    override func tearDown() {
        try? Self.setApplicationAccessibility(false)
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        drain(0.3)
        super.tearDown()
    }

    // MARK: Helpers

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    @discardableResult
    private func drain(until condition: () -> Bool, timeout: Double = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { drain(0.02) }
        return condition()
    }

    /// SwiftUI builds its buttons' accessibility elements (used to press them)
    /// only while accessibility is on for the app.
    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }

    private func accessible(_ label: String) -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.accessibilityLabel == label { out.append(object) }
            var kids: [NSObject] = (object as? UIView)?.subviews ?? []
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 { kids += (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        if let window { walk(window) }
        for presented in sequence(first: window?.rootViewController?.presentedViewController, next: { $0?.presentedViewController }) {
            if let view = presented?.view { walk(view) }
        }
        return out
    }

    private func mount<V: View>(_ view: V) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        self.window = window
        drain(0.6)
    }

    private func computer(_ id: String, online: Bool = true) -> DeviceSummary {
        DeviceSummary(id: id, name: "Computer \(id)", role: .tentacle, kind: .desktop,
                      publicKey: nil, encryptionKey: nil, online: online, lastSeen: nil, createdAt: nil)
    }

    private func sheetApp() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.connectionStatus = .connected
        app.hasCompletedInitialConnect = true
        app.testOutboundMessageHandler = { [weak self] message, _, _ in
            if message["type"] as? String == "create_session" {
                self?.creates.append(message["payload"] as? [String: Any] ?? [:])
            }
            return true
        }
        app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "Hello")
        return app
    }

    private var startButton: NSObject? { accessible(String(localized: "Start session")).first }
    private var startEnabled: Bool {
        guard let startButton else { return false }
        return !startButton.accessibilityTraits.contains(.notEnabled)
    }

    // MARK: New Session sheet defaults (K-321) and Start gate (K-337)

    /// The first computer joins while the sheet says "No computers online":
    /// it is chosen with its agent and model, as reopening the sheet did.
    func testSheetChoosesTheFirstComputerThatJoinsWhileOpen() throws {
        let app = sheetApp()
        defer { app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "") }
        try mount(NewSessionSheet().environment(app))

        app.deviceStore.devices["joined"] = computer("joined")
        app.deviceStore.setDeviceAgents("joined", agents: [
            AgentCapabilities(type: "code", id: "pi", models: ["m1"], modelDetails: nil),
        ])
        XCTAssertTrue(drain(until: { self.startEnabled }), "Start stays disabled after the computer joined")

        XCTAssertTrue(try XCTUnwrap(startButton).accessibilityActivate())
        drain(0.2)
        XCTAssertEqual(creates.first?["targetDeviceId"] as? String, "joined")
        XCTAssertEqual(creates.first?["agentId"] as? String, "pi")
        XCTAssertEqual(creates.first?["model"] as? String, "m1")
    }

    /// The chosen computer's agents arrive (device greeting) after it was
    /// picked: its agent and model are applied and Start works.
    func testSheetAppliesTheAgentWhenTheGreetingLandsAfterThePick() throws {
        let app = sheetApp()
        defer { app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "") }
        app.deviceStore.devices["greeting"] = computer("greeting")
        try mount(NewSessionSheet().environment(app))
        XCTAssertFalse(startEnabled, "no agent yet")

        app.deviceStore.setDeviceAgents("greeting", agents: [
            AgentCapabilities(type: "code", id: "codex", models: ["m2"], modelDetails: nil),
        ])
        XCTAssertTrue(drain(until: { self.startEnabled }), "Start stays disabled after the greeting")

        XCTAssertTrue(try XCTUnwrap(startButton).accessibilityActivate())
        drain(0.2)
        XCTAssertEqual(creates.first?["targetDeviceId"] as? String, "greeting")
        XCTAssertEqual(creates.first?["agentId"] as? String, "codex")
        XCTAssertEqual(creates.first?["model"] as? String, "m2")
    }

    /// The chosen computer goes offline with the sheet open: Start is disabled
    /// instead of sending a create that can only time out.
    func testSheetDisablesStartWhileTheChosenComputerIsOffline() throws {
        let app = sheetApp()
        defer { app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "") }
        app.deviceStore.devices["away"] = computer("away")
        app.deviceStore.setDeviceAgents("away", agents: [
            AgentCapabilities(type: "code", id: "pi", models: ["m1"], modelDetails: nil),
        ])
        try mount(NewSessionSheet().environment(app))
        XCTAssertTrue(drain(until: { self.startEnabled }), "online computer: Start works")

        app.deviceStore.devices["away"]?.online = false
        XCTAssertTrue(drain(until: { !self.startEnabled }), "Start stays enabled for an offline computer")
        _ = startButton?.accessibilityActivate()
        drain(0.2)
        XCTAssertTrue(creates.isEmpty, "no create is sent to an offline computer")

        app.deviceStore.devices["away"]?.online = true
        XCTAssertTrue(drain(until: { self.startEnabled }), "back online: Start works again")
    }

    // MARK: Sessions tab stack (K-320, K-306, K-068)

    private func tabs() -> UITabBarController? {
        func find(_ vc: UIViewController?) -> UITabBarController? {
            guard let vc else { return nil }
            if let tabs = vc as? UITabBarController { return tabs }
            return vc.children.lazy.compactMap(find).first
        }
        return find(window?.rootViewController)
    }

    /// Pages on the Sessions tab's stack (the list root counts as one).
    private var sessionsStackDepth: Int {
        func navigations(_ vc: UIViewController) -> [UINavigationController] {
            ((vc as? UINavigationController).map { [$0] } ?? []) + vc.children.flatMap(navigations)
        }
        guard let first = tabs()?.viewControllers?.first else { return 0 }
        return navigations(first).map(\.viewControllers.count).max() ?? 0
    }

    private func mainTabApp() throws -> AppState {
        let app = IOSNewSessionScenario.makeAppState()
        try mount(MainTabView(allowsInitialNavigation: true).environment(app))
        drain(0.8)
        return app
    }

    /// A slow fork pushes "Copying session…" over its source chat; when the
    /// fork arrives it takes the placeholder's place and Back still leads to
    /// the source (it used to reset the stack to the fork alone).
    func testSlowForkKeepsItsSourceChatBelowIt() throws {
        let app = try mainTabApp()
        app.sessionStore.navigateToSession = "existing-0"
        XCTAssertTrue(drain(until: { self.sessionsStackDepth == 2 }), "source chat did not open")
        drain(0.8)

        app.sessionStore.addPendingSession("pending-fork")
        app.sessionStore.navigationPushesOnTop = true
        app.sessionStore.navigateToSession = "pending-fork"
        XCTAssertTrue(drain(until: { self.sessionsStackDepth == 3 }), "placeholder not pushed over the source")
        drain(0.8)

        app.sessionStore.removePendingSession("pending-fork")
        app.sessionStore.navigationReplacesPlaceholder = "pending-fork"
        app.sessionStore.navigateToSession = "existing-1"
        drain(1)
        XCTAssertEqual(sessionsStackDepth, 3, "the fork replaces the placeholder above its source")
    }

    /// Session Info's device row opens the computer on the Devices tab; the
    /// chat stays on the Sessions tab, as with a manual tab switch.
    func testDeviceRowKeepsTheChatOnTheSessionsTab() throws {
        let app = try mainTabApp()
        app.sessionStore.navigateToSession = "existing-0"
        XCTAssertTrue(drain(until: { self.sessionsStackDepth == 2 }), "chat did not open")
        drain(0.8)

        app.deviceStore.navigateToDeviceId = IOSNewSessionScenario.deviceID
        XCTAssertTrue(drain(until: { self.tabs()?.selectedIndex == 1 }), "Devices tab not selected")
        drain(0.8)
        XCTAssertEqual(sessionsStackDepth, 2, "the chat is still on the Sessions tab")
    }

    /// A Session started from the New Session sheet opens once the sheet (and
    /// its keyboard) is gone, not while it is still sliding away over it.
    func testSessionStartedFromTheSheetOpensAfterTheSheetIsGone() throws {
        let app = try mainTabApp()
        defer { app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "") }
        app.sessionStore.setDraft(IOSNewSessionComposer.draftID, "Hello")
        let tabBar = try XCTUnwrap(tabs())
        let plus = try XCTUnwrap(tabBar.viewControllers?.first { $0.tabBarItem.title == String(localized: "New Session") },
                                 "tabs: \(tabBar.viewControllers?.map { $0.tabBarItem.title ?? "-" } ?? [])")
        _ = tabBar.delegate?.tabBarController?(tabBar, shouldSelect: plus)
        XCTAssertTrue(drain(until: { tabBar.presentedViewController != nil && self.startEnabled }), "sheet not shown")

        XCTAssertTrue(try XCTUnwrap(startButton).accessibilityActivate())
        var pushedUnderSheet = false
        let deadline = Date().addingTimeInterval(5)
        while tabBar.presentedViewController != nil, Date() < deadline {
            if sessionsStackDepth > 1 { pushedUnderSheet = true }
            drain(0.01)
        }
        XCTAssertNil(tabBar.presentedViewController, "sheet did not close")
        XCTAssertFalse(pushedUnderSheet, "the new page was pushed while the sheet was still on screen")
        XCTAssertTrue(drain(until: { self.sessionsStackDepth == 2 }), "the new Session did not open after the sheet closed")
    }
}

/// `SessionNavigationRoute`: the Sessions stack after opening a Session.
@MainActor
final class SessionNavigationRouteTests: XCTestCase {
    private func ids(_ path: [SessionNavID]) -> [String] { path.map(\.id) }

    func testPlaceholderAboveItsSourceIsReplacedInPlace() {
        let route = SessionNavigationRoute.open(
            "fork", in: [SessionNavID(id: "src"), SessionNavID(id: "pending-1")],
            replacingPlaceholder: "pending-1", pushesOnTop: false, sessionsTabSelected: true)
        XCTAssertEqual(ids(route.path), ["src", "fork"])
        XCTAssertTrue(route.inPlace)
    }

    func testCreatedSessionReplacesItsPlaceholderAtTheRoot() {
        let route = SessionNavigationRoute.open(
            "created", in: [SessionNavID(id: "pending-1")],
            replacingPlaceholder: "pending-1", pushesOnTop: false, sessionsTabSelected: false)
        XCTAssertEqual(ids(route.path), ["created"])
        XCTAssertTrue(route.inPlace)
    }

    /// The placeholder never made it onto the stack (opened later, e.g. after
    /// the New Session sheet closed): the stack is reset, nothing is replaced.
    func testPlaceholderNotOnTheStackResetsToTheTarget() {
        let route = SessionNavigationRoute.open(
            "created", in: [SessionNavID(id: "other")],
            replacingPlaceholder: "pending-1", pushesOnTop: false, sessionsTabSelected: true)
        XCTAssertEqual(ids(route.path), ["created"])
        XCTAssertFalse(route.inPlace)
    }

    func testForkPushesOnTopOfItsSource() {
        let route = SessionNavigationRoute.open(
            "fork", in: [SessionNavID(id: "src")],
            replacingPlaceholder: nil, pushesOnTop: true, sessionsTabSelected: true)
        XCTAssertEqual(ids(route.path), ["src", "fork"])
        XCTAssertFalse(route.inPlace)
    }

    func testOtherNavigationResetsTheStack() {
        let route = SessionNavigationRoute.open(
            "b", in: [SessionNavID(id: "a"), SessionNavID(id: "c")],
            replacingPlaceholder: nil, pushesOnTop: false, sessionsTabSelected: true)
        XCTAssertEqual(ids(route.path), ["b"])
        XCTAssertFalse(route.inPlace)
    }
}
#endif
