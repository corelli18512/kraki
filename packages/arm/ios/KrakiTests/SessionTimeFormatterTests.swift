import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// K-305: today's card time was always "HH:mm", even in 12-hour locales,
/// while the Info sheet showed the same moment as "11:19 PM".
final class SessionTimeFormatterTests: XCTestCase {
    private func todayAt(hour: Int, minute: Int) throws -> String {
        let date = try XCTUnwrap(Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()))
        return ISO8601.withFractional.string(from: date)
    }

    func testTodayFollowsTheUsersHourCycle() throws {
        let iso = try todayAt(hour: 23, minute: 19)
        let american = SessionTimeFormatter.format(iso, locale: Locale(identifier: "en_US"))
        XCTAssertTrue(american.hasPrefix("11:19"), american)
        XCTAssertTrue(american.hasSuffix("PM"), american)
        XCTAssertEqual(SessionTimeFormatter.format(iso, locale: Locale(identifier: "en_GB")), "23:19")
    }

    func testOlderDatesKeepTheRelativeLabels() throws {
        let yesterday = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: -1, to: Date()))
        XCTAssertEqual(SessionTimeFormatter.format(ISO8601.withFractional.string(from: yesterday)), "yesterday")
        XCTAssertEqual(SessionTimeFormatter.format("not a date"), "")
    }
}
