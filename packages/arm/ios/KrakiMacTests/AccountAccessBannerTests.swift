#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// K-248: "Update Kraki on <computer>" could not be dismissed. The banner is
/// rendered in a window that is never shown.
@MainActor
final class AccountAccessBannerTests: XCTestCase {
    private func allViews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { allViews($0) } }

    func testUpdateComputerBannerCanBeDismissed() throws {
        let app = AppState.makeUnitTestHost()
        let computer = "account-access-\(UUID().uuidString)"
        app.deviceStore.addDevice(DeviceSummary(id: computer, name: "Old Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil,
                                                createdAt: nil))
        app.deviceTrust.pairingRequired.insert(computer)
        XCTAssertEqual(AccountAccessNotice(state: app.trustState(for: computer)), .updateComputer)
        XCTAssertEqual(app.computersNeedingPairing.map(\.id), [computer])

        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 420, height: 160),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        defer { window.contentView = nil }
        let host = NSHostingView(rootView: AccountAccessUpgradeBanner().frame(width: 420).environment(app))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 160)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        // The banner's only button for this notice is its close button.
        let buttons = allViews(host).compactMap { $0 as? NSButton }
        XCTAssertEqual(buttons.count, 1, "the banner offers Dismiss")
        let dismiss = try XCTUnwrap(buttons.first)
        dismiss.performClick(nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertTrue(app.computersNeedingPairing.isEmpty, "dismissed for this run")
        app.deviceTrust.pairingRequired.remove(computer)
    }
}
#endif
