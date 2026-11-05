#if os(iOS)
import XCTest
@testable import Kraki

/// K-186: the manual-entry error belongs to the manual-entry sheet.
final class PairingScannerTests: XCTestCase {
    func testManualEntryErrorOnlyForSomethingThatIsNotAPairingLink() {
        XCTAssertEqual(PairingView.manualEntryError(for: "not a link"), String(localized: "Invalid pairing URL"))
        XCTAssertEqual(PairingView.manualEntryError(for: "https://app.kraki.chat/?relay=x"), String(localized: "Invalid pairing URL"))
        XCTAssertNil(PairingView.manualEntryError(for: " https://app.kraki.chat/?token=pt_1 "))
    }
}
#endif
