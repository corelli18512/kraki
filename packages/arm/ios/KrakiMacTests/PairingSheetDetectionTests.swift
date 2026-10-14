import XCTest
@testable import Kraki_Dev

/// #513: a late first trusted list must not swallow an existing account phone.
@MainActor
final class PairingSheetDetectionTests: XCTestCase {
    private func entry(_ id: String, _ pairedAt: String = "2026-10-14T10:00:00.000Z") -> TrustedDeviceEntry {
        TrustedDeviceEntry(id: id, name: id, via: "qr", pairedAt: pairedAt)
    }

    func testTimeoutDoesNotCreateCodeAndRetryUsesBaselineBeforeCreatingIt() async throws {
        var list: [TrustedDeviceEntry]?
        var created = 0
        var pauses = 0
        do {
            _ = try await PairingSheet.withTrustedBaseline(read: { list }, pause: { pauses += 1 }) { _ in
                created += 1
                return "must not expose a code"
            }
            XCTFail("Missing signed baseline must time out")
        } catch PairingSheet.BaselineError.unavailable {}
        XCTAssertEqual(pauses, 30)
        XCTAssertEqual(created, 0)

        // The list arrives after the timeout. Retry establishes the real
        // signed baseline before generating any QR/link, regardless of presence.
        let oldPhone = entry("old-phone")
        list = [oldPhone]
        var baseline: [TrustedDeviceEntry] = []
        let code = try await PairingSheet.withTrustedBaseline(read: { list }, pause: {}) { entries in
            baseline = entries
            created += 1
            return "pairing-link"
        }
        XCTAssertEqual(code, "pairing-link")
        XCTAssertEqual(created, 1)
        XCTAssertEqual(baseline, [oldPhone])
        XCTAssertNil(PairingSheet.newlyPaired([oldPhone], baseline: baseline))
        let existingAccountPhone = entry("existing-account-phone")
        XCTAssertEqual(PairingSheet.newlyPaired([oldPhone, existingAccountPhone], baseline: baseline), existingAccountPhone.id)
    }

    func testListArrivingDuringWaitUnblocksCode() async throws {
        var list: [TrustedDeviceEntry]?
        var pauses = 0
        let count = try await PairingSheet.withTrustedBaseline(read: { list }, pause: {
            pauses += 1
            if pauses == 4 { list = [] }
        }) { $0.count }
        XCTAssertEqual(pauses, 4)
        XCTAssertEqual(count, 0) // a signed empty list is a valid baseline
    }

    func testCancellationNeverCreatesCode() async {
        var created = false
        do {
            _ = try await PairingSheet.withTrustedBaseline(read: { nil }, pause: { throw CancellationError() }) { _ in
                created = true
            }
            XCTFail("Cancelled wait must not continue")
        } catch is CancellationError {
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertFalse(created)
    }

    func testAlreadyTrustedPhoneRepairChangesPairingTimeNotIdentity() {
        let phone = entry("phone")
        let repaired = entry("phone", "2026-10-14T11:00:00.000Z")
        XCTAssertNil(PairingSheet.newlyPaired([phone], baseline: [phone]))
        XCTAssertEqual(PairingSheet.newlyPaired([repaired], baseline: [phone]), "phone")
    }
}
