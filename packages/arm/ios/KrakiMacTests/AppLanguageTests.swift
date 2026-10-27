import XCTest
@testable import Kraki_Dev

/// Mac language picker storage (`AppLanguage.override` / `setOverride`).
/// Uses a throwaway defaults suite so the test host's own language is untouched.
final class AppLanguageTests: XCTestCase {
    private let domain = "chat.kraki.tests.applanguage"
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

    private func store(_ list: [String]) {
        defaults.set(list, forKey: "AppleLanguages")
    }

    private var stored: [String]? {
        defaults.persistentDomain(forName: domain)?["AppleLanguages"] as? [String]
    }

    func testNoStoredListFollowsSystem() {
        XCTAssertNil(AppLanguage.override(in: defaults, domain: domain))
        XCTAssertFalse(AppLanguage.setOverride(nil, in: defaults, domain: domain))
    }

    func testPickerValuesRoundTrip() {
        XCTAssertTrue(AppLanguage.setOverride(.simplifiedChinese, in: defaults, domain: domain))
        XCTAssertEqual(stored, ["zh-Hans"])
        XCTAssertEqual(AppLanguage.override(in: defaults, domain: domain), .simplifiedChinese)
        XCTAssertFalse(AppLanguage.setOverride(.simplifiedChinese, in: defaults, domain: domain))
        XCTAssertTrue(AppLanguage.setOverride(nil, in: defaults, domain: domain))
        XCTAssertNil(stored)
    }

    /// `defaults write` or System Settings can store region-qualified tags;
    /// the picker must show the language the app actually runs in.
    func testRegionQualifiedValuesResolveLikeTheBundle() {
        store(["zh-Hans-CN"])
        XCTAssertEqual(AppLanguage.override(in: defaults, domain: domain), .simplifiedChinese)
        store(["en-GB", "zh-Hans"])
        XCTAssertEqual(AppLanguage.override(in: defaults, domain: domain), .english)
    }

    /// System Default must clear any stored list, not only ones the picker wrote.
    func testSystemDefaultClearsAForeignValue() {
        store(["zh-Hans-CN"])
        XCTAssertTrue(AppLanguage.setOverride(nil, in: defaults, domain: domain))
        XCTAssertNil(stored)
        XCTAssertNil(AppLanguage.override(in: defaults, domain: domain))
    }

    /// Choosing a language replaces a foreign list even if it resolves the same.
    func testPickingALanguageNormalizesAForeignValue() {
        store(["zh-Hans-CN", "en"])
        XCTAssertTrue(AppLanguage.setOverride(.simplifiedChinese, in: defaults, domain: domain))
        XCTAssertEqual(stored, ["zh-Hans"])
    }
}
