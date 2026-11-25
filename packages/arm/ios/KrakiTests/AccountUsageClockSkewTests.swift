import XCTest
@testable import Kraki

/// K-325: account usage freshness and retry times are judged against the
/// reporting computer's own clock (its `updatedAt`), not this device's.
@MainActor
final class AccountUsageClockSkewTests: XCTestCase {
    private func stamp(_ date: Date) -> String { ISO8601.withFractional.string(from: date) }

    private func payload(workerOffset: TimeInterval, fetchedAgo: TimeInterval, error: String? = nil,
                         retryIn: TimeInterval? = nil, now: Date) -> DeviceUsagePayload {
        let workerNow = now.addingTimeInterval(workerOffset)
        var account = AccountUsage(
            accountKey: "claude:a", provider: "claude",
            windows: [AccountUsageWindow(id: "five_hour", kind: "five_hour", remainingPercent: 40)],
            fetchedAt: stamp(workerNow.addingTimeInterval(-fetchedAgo)), error: error)
        account.retryAt = retryIn.map { stamp(workerNow.addingTimeInterval($0)) }
        return DeviceUsagePayload(accounts: [account], updatedAt: stamp(workerNow))
    }

    private func received(_ payload: DeviceUsagePayload, now: Date) throws -> AccountUsage {
        let store = DeviceStore(persistenceEnabled: false)
        store.setDevices([DeviceSummary(id: "pc", name: "PC", role: .tentacle, kind: .desktop, publicKey: nil,
                                        encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)])
        store.receiveDeviceUsage("pc", payload: payload)
        return try XCTUnwrap(store.deviceUsage["pc"]?.accounts.first)
    }

    func testFreshReadingFromAComputerBehindIsNotStale() throws {
        let now = Date()
        let usage = try received(payload(workerOffset: -3600, fetchedAgo: 10, now: now), now: now)
        XCTAssertFalse(usage.isStale(now: now))
        XCTAssertEqual(usage.lastUpdatedText(now: now), String(localized: "Updated just now"))
    }

    func testOldReadingFromAComputerAheadIsStale() throws {
        let now = Date()
        let usage = try received(payload(workerOffset: 3600, fetchedAgo: 3000, now: now), now: now)
        XCTAssertTrue(usage.isStale(now: now), "50 min old by the computer's own clock")
    }

    func testRetryTimeFollowsTheComputersClock() throws {
        let now = Date()
        for offset in [-3600.0, 3600] {
            let usage = try received(payload(workerOffset: offset, fetchedAgo: 10, error: "rate_limited", retryIn: 290, now: now), now: now)
            XCTAssertEqual(usage.readStatus(now: now), String(localized: "Rate limited · retry in \(5)m"), "worker offset \(offset)")
        }
    }

    func testWithoutUpdatedAtTheReadingIsKeptAsIs() throws {
        let now = Date()
        var plain = payload(workerOffset: 0, fetchedAgo: 10, now: now)
        plain.updatedAt = nil
        let usage = try received(plain, now: now)
        XCTAssertEqual(usage.fetchedAt, plain.accounts[0].fetchedAt)
    }
}
