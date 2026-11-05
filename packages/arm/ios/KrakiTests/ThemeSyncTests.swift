import XCTest
@testable import Kraki

/// The theme is an account preference synced through the relay.
@MainActor
final class ThemeSyncTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        suite = "ThemeSyncTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
    }

    /// K-080: account B does not inherit account A's theme.
    func testSignOutResetsTheThemeToSystem() {
        let app = AppState.makeUnitTestHost()
        let prefs = app.usePreferencesManagerForTesting(defaults: defaults)
        prefs.applyRemote(["theme": "dark"])
        XCTAssertEqual(defaults.string(forKey: "colorScheme"), "dark")
        app.resetIdentity(clearRelayURL: false)
        XCTAssertNil(defaults.string(forKey: "colorScheme"), "System until the next account says otherwise")
        XCTAssertTrue(prefs.isApplyingRemote, "the reset is not sent as a theme change")
    }

    /// K-081: a theme picked offline is sent on reconnect and is not reverted
    /// by the account's stored one.
    func testOfflineThemeChangeSurvivesReconnect() {
        let app = AppState.makeUnitTestHost()
        let prefs = app.usePreferencesManagerForTesting(defaults: defaults)
        app.connectionStatus = .disconnected
        defaults.set("dark", forKey: "colorScheme") // the picker's @AppStorage
        prefs.sendTheme(.dark)
        XCTAssertEqual(prefs.pendingTheme, .dark)

        app.connectionStatus = .connected
        prefs.applyAuthPreferences(["theme": "system"])
        XCTAssertEqual(defaults.string(forKey: "colorScheme"), "dark", "the offline choice stays")
        XCTAssertNil(prefs.pendingTheme, "sent")
    }

    func testWithoutOfflineChangeTheAccountThemeApplies() {
        let app = AppState.makeUnitTestHost()
        let prefs = app.usePreferencesManagerForTesting(defaults: defaults)
        defaults.set("dark", forKey: "colorScheme")
        prefs.applyAuthPreferences(["theme": "light"])
        XCTAssertEqual(defaults.string(forKey: "colorScheme"), "light")
    }

    /// An unsent change of the signed-out account is not sent as the next one's.
    func testSignOutDropsAnUnsentThemeChange() {
        let app = AppState.makeUnitTestHost()
        let prefs = app.usePreferencesManagerForTesting(defaults: defaults)
        app.connectionStatus = .disconnected
        prefs.sendTheme(.light)
        app.resetIdentity(clearRelayURL: false)
        XCTAssertNil(prefs.pendingTheme)
    }
}
