import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

@MainActor
final class MacPerformanceNoticeTests: XCTestCase {
    private func find(_ identifier: String, in element: AnyObject) -> AnyObject? {
        if element.accessibilityIdentifier?() == identifier { return element }
        for child in element.accessibilityChildren?() ?? [] {
            if let found = find(identifier, in: child as AnyObject) { return found }
        }
        return nil
    }

    func testDesktopNoticeStaysBottomRightAndDoesNotBlockTheWindow() async throws {
        for size in [NSSize(width: 800, height: 600), NSSize(width: 1240, height: 820)] {
            for scheme in [ColorScheme.light, .dark] {
                let notice = PerformanceNotice()
                let suite = "MacPerformanceNoticeTests-\(UUID().uuidString)"
                notice.defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
                defer { notice.defaults.removePersistentDomain(forName: suite) }
                var backgroundPresses = 0
                let host = NSHostingView(rootView:
                    Button("Background action") { backgroundPresses += 1 }
                        .accessibilityIdentifier("notice-test-background")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .modifier(PerformanceNoticePresentation(notice: notice))
                        .environment(\.colorScheme, scheme)
                )
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                      styleMask: [.titled], backing: .buffered, defer: false)
                window.contentView = host
                defer { window.contentView = nil }
                notice.showForTesting()
                var card: AnyObject?
                let deadline = Date().addingTimeInterval(5)
                while card == nil, Date() < deadline {
                    host.layoutSubtreeIfNeeded()
                    card = find("performance-notice", in: host)
                    if card == nil { try await Task.sleep(for: .milliseconds(50)) }
                }
                let element = try XCTUnwrap(card)
                let screenFrame = try XCTUnwrap(element.accessibilityFrame?())
                let frame = window.convertFromScreen(screenFrame)
                XCTAssertEqual(frame.maxX, size.width - 16, accuracy: 1, "right inset")
                XCTAssertEqual(frame.minY, 16, accuracy: 1, "bottom inset")
                XCTAssertLessThanOrEqual(frame.width, 440)
                XCTAssertNil(window.attachedSheet, "Desktop notice is non-modal")
                let background = try XCTUnwrap(find("notice-test-background", in: host))
                XCTAssertTrue(background.isAccessibilityEnabled?() ?? false)
                XCTAssertTrue(background.accessibilityPerformPress?() ?? false)
                XCTAssertEqual(backgroundPresses, 1, "The rest of the window remains usable")
                XCTAssertFalse(notice.hasBeenSeen, "No automatic dismissal")
            }
        }
    }
}
