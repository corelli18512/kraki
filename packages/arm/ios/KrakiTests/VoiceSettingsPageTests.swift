#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin
@testable import Kraki

/// Settings → Voice Input and Custom Words on iPhone, mounted with an isolated
/// AppState. K-194: the page says when this relay has no voice input (as the
/// Mac pane does). K-195: the first Add Word opens the Add sheet, not Edit.
@MainActor final class VoiceSettingsPageTests: XCTestCase {
    private var window: UIWindow?
    private var app: AppState?

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        try Self.setApplicationAccessibility(true)
    }

    override func tearDown() {
        app?.voiceVocabularyStore.deactivate()
        try? Self.setApplicationAccessibility(false)
        window?.rootViewController?.dismiss(animated: false)
        window?.isHidden = true; window?.rootViewController = nil
        window = nil; app = nil
        super.tearDown()
    }

    private func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    @discardableResult
    private func drain(until condition: () -> Bool, timeout: Double = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { drain(0.02) }
        return condition()
    }

    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }

    /// Accessibility elements whose label contains `text`, in the window and
    /// any sheet presented from it.
    private func accessible(containing text: String) -> [NSObject] {
        var out: [NSObject] = []
        func walk(_ object: NSObject) {
            // Reusable list cells stay in the hierarchy, hidden.
            if let view = object as? UIView, view.isHidden { return }
            if object.accessibilityLabel?.contains(text) == true { out.append(object) }
            var kids: [NSObject] = (object as? UIView)?.subviews ?? []
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 { kids += (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        var controller = window?.rootViewController
        while let current = controller {
            if let view = current.viewIfLoaded { walk(view) }
            controller = current.presentedViewController
        }
        return out
    }

    private func show<Page: View>(_ page: Page) throws -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("voice-settings-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        self.app = app
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window?.rootViewController = UIHostingController(rootView: NavigationStack { page }.environment(app))
        window?.makeKeyAndVisible()
        drain(0.3)
        return app
    }

    // MARK: K-194

    func testVoiceInputPageSaysVoiceIsUnavailableWithThisRelay() throws {
        let app = try show(VoiceInputSettingsPage())
        app.connectionStatus = .connected
        app.voiceCapability = nil
        XCTAssertTrue(drain(until: { !self.accessible(containing: "isn't available with this relay").isEmpty }),
                      "a connected relay without voice says so")

        app.voiceCapability = VoiceCapability(brokerUrl: "wss://voice.invalid", resource: "voice/doubao")
        XCTAssertTrue(drain(until: { self.accessible(containing: "isn't available with this relay").isEmpty }),
                      "no note when voice input is available")
    }

    // MARK: K-195

    func testFirstAddWordOpensTheAddSheet() throws {
        let app = try show(VoiceVocabularyPage())
        app.voiceVocabularyStore.activate(userID: "voice-settings-\(UUID().uuidString)")
        drain(0.3)
        let add = try XCTUnwrap(accessible(containing: "Add Word").first, "Add Word button")
        XCTAssertTrue(add.accessibilityActivate())
        XCTAssertTrue(drain(until: { self.window?.rootViewController?.presentedViewController != nil }), "a sheet opens")
        drain(0.5)
        XCTAssertTrue(accessible(containing: "Edit Word").isEmpty, "the first Add Word is not the Edit sheet")
        XCTAssertTrue(accessible(containing: "Delete Word").isEmpty, "a new word has nothing to delete")
    }
}
#endif
