import XCTest
@testable import Kraki_Dev

/// Settings › General › Updates (`MacUpdateChannel`): storage, the feed each
/// channel reads, who sees the switch, and the "never downgrades" note.
/// Uses a throwaway defaults suite so the test host's own channel is untouched.
final class MacUpdateChannelTests: XCTestCase {
    private let domain = "chat.kraki.tests.updatechannel"
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: domain)
        defaults.removePersistentDomain(forName: domain)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: domain)
        defaults = nil
        super.tearDown()
    }

    func testDefaultsToStableAndPersistsTheChoice() {
        XCTAssertEqual(MacUpdateChannel.stored(in: defaults), .stable)
        MacUpdateChannel.store(.dogfood, in: defaults)
        XCTAssertEqual(defaults.string(forKey: MacUpdateChannel.defaultsKey), "dogfood")
        XCTAssertEqual(MacUpdateChannel.stored(in: defaults), .dogfood)
        MacUpdateChannel.store(.stable, in: defaults)
        XCTAssertEqual(MacUpdateChannel.stored(in: defaults), .stable)
    }

    func testUnknownStoredValueFallsBackToStable() {
        defaults.set("beta", forKey: MacUpdateChannel.defaultsKey)
        XCTAssertEqual(MacUpdateChannel.stored(in: defaults), .stable)
    }

    /// Stable keeps the production appcast the app always read; Dogfood
    /// reads the feed asset of the rolling dogfood-mac release.
    /// (scripts/release/prerelease.test.mjs checks both against
    /// KrakiMac.Info.plist and the release workflow.)
    func testFeedURLPerChannel() {
        XCTAssertEqual(MacUpdateChannel.stable.feedURL,
                       "https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml")
        XCTAssertEqual(MacUpdateChannel.dogfood.feedURL,
                       "https://github.com/corelli18512/kraki/releases/download/dogfood-mac/appcast-dogfood.xml")
    }

    func testSwitchIsVisibleToInternalAccountsAndOnAnyDogfoodMac() {
        XCTAssertTrue(MacUpdateChannel.isSwitchVisible(accountIsInternal: true, current: .stable))
        XCTAssertTrue(MacUpdateChannel.isSwitchVisible(accountIsInternal: true, current: .dogfood))
        XCTAssertTrue(MacUpdateChannel.isSwitchVisible(accountIsInternal: false, current: .dogfood))
        XCTAssertFalse(MacUpdateChannel.isSwitchVisible(accountIsInternal: false, current: .stable))
    }

    /// auth_ok's `user.preferences.internal` (parsed like AuthManager does).
    func testInternalAccountFlagComesFromAuthOkPreferences() throws {
        func user(_ json: String) throws -> UserInfo? {
            let dict = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            return UserInfo(authOk: dict)
        }
        let internalUser = try XCTUnwrap(user(#"{"id":"u","login":"l","preferences":{"internal":true,"theme":"dark"}}"#))
        XCTAssertTrue(internalUser.isInternalAccount)
        XCTAssertEqual(internalUser.login, "l")
        XCTAssertFalse(try XCTUnwrap(user(#"{"id":"u","login":"l"}"#)).isInternalAccount)
        XCTAssertFalse(try XCTUnwrap(user(#"{"id":"u","login":"l","preferences":{"internal":false}}"#)).isInternalAccount)
        XCTAssertFalse(try XCTUnwrap(user(#"{"id":"u","login":"l","preferences":{"internal":"true"}}"#)).isInternalAccount)
        XCTAssertNil(try user(#"{"login":"l"}"#))
    }

    func testDogfoodBuildsAreTheDottedBundleVersions() {
        XCTAssertTrue(MacUpdateChannel.isDogfoodBuild("93.57"))
        XCTAssertFalse(MacUpdateChannel.isDogfoodBuild("93"))
    }

    /// Switching back to Stable never downgrades: a dogfood build says it
    /// stays until the next formal release; a formal build just follows them.
    func testNoteForEachChannelAndBuild() {
        XCTAssertEqual(MacUpdateChannel.note(for: .dogfood, bundleVersion: "93.57"), .followsDogfood)
        XCTAssertEqual(MacUpdateChannel.note(for: .dogfood, bundleVersion: "93"), .followsDogfood)
        XCTAssertEqual(MacUpdateChannel.note(for: .stable, bundleVersion: "93.57"),
                       .staysUntilNextFormalRelease(build: "93.57"))
        XCTAssertEqual(MacUpdateChannel.note(for: .stable, bundleVersion: "93"), .formalReleasesOnly)
    }
}
