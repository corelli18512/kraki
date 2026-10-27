import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

final class LocalizationTests: XCTestCase {
    private func bundle(_ lang: String) throws -> Bundle {
        let path = try XCTUnwrap(Bundle(for: AppState.self).path(forResource: lang, ofType: "lproj")
            ?? Bundle.main.path(forResource: lang, ofType: "lproj"), "\(lang).lproj missing from the app")
        return try XCTUnwrap(Bundle(path: path))
    }

    func testSimplifiedChineseCatalogShips() throws {
        let zh = try bundle("zh-Hans")
        XCTAssertEqual(zh.localizedString(forKey: "Language", value: nil, table: nil), "语言")
        XCTAssertEqual(zh.localizedString(forKey: "time.justNow", value: nil, table: nil), "刚刚")
        XCTAssertEqual(zh.localizedString(forKey: "NSMicrophoneUsageDescription", value: nil, table: "InfoPlist").contains("语音"), true)
    }

    func testSupportedLanguagesHaveNativeNames() {
        XCTAssertEqual(AppLanguage.allCases.map(\.rawValue), ["en", "zh-Hans"])
    /// The test schemes pin English (project.yml `language: en`); tests that
    /// assert copy rely on it even on a zh-Hans Mac or simulator.
    func testTestHostRunsInEnglish() {
        XCTAssertEqual(Bundle.main.preferredLocalizations.first, "en")
        XCTAssertEqual(Locale.current.language.languageCode?.identifier, "en")
    }

        XCTAssertEqual(AppLanguage.simplifiedChinese.nativeName, "简体中文")
    }

    func testRelativeTimeIsLocaleAware() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let en = KrakiFormat.relative(now.addingTimeInterval(-300), now: now, locale: Locale(identifier: "en"))
        let zh = KrakiFormat.relative(now.addingTimeInterval(-300), now: now, locale: Locale(identifier: "zh-Hans"))
        XCTAssertTrue(en.contains("5") && en.contains("ago"), en)
        XCTAssertTrue(zh.contains("5") && zh.contains("前"), zh)
    }
}
