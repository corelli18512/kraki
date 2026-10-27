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
        XCTAssertEqual(zh.localizedString(forKey: "just now", value: nil, table: nil), "刚刚")
        // relativeTimestamp's compact keys (Helpers.swift).
        XCTAssertEqual(zh.localizedString(forKey: "%lldm ago", value: nil, table: nil), "%lld 分钟前")
        XCTAssertEqual(zh.localizedString(forKey: "NSMicrophoneUsageDescription", value: nil, table: "InfoPlist").contains("语音"), true)
    }

    /// The test schemes pin English (project.yml `language: en`); tests that
    /// assert copy rely on it even on a zh-Hans Mac or simulator.
    func testTestHostRunsInEnglish() {
        XCTAssertEqual(Bundle.main.preferredLocalizations.first, "en")
        XCTAssertEqual(Locale.current.language.languageCode?.identifier, "en")
    }

    func testSupportedLanguagesHaveNativeNames() {
        XCTAssertEqual(AppLanguage.allCases.map(\.rawValue), ["en", "zh-Hans"])
        XCTAssertEqual(AppLanguage.simplifiedChinese.nativeName, "简体中文")
    }
}
