import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Spoken VoiceOver announcements for state changes that happen away from the
/// VoiceOver cursor (connection lost / back, a send that failed, a pairing
/// result). Without them those changes are silent for VoiceOver users.
enum AccessibilityAnnouncer {
    /// Delivery seam; tests replace it to observe announcements.
    nonisolated(unsafe) static var post: @MainActor (String) -> Void = { message in
        #if os(iOS)
        UIAccessibility.post(notification: .announcement, argument: message)
        #else
        guard let element = NSApp.mainWindow ?? NSApp.keyWindow else { return }
        NSAccessibility.post(element: element, notification: .announcementRequested,
                             userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        #endif
    }

    static func announce(_ message: String) {
        guard !message.isEmpty else { return }
        if Thread.isMainThread {
            MainActor.assumeIsolated { post(message) }
        } else {
            DispatchQueue.main.async { post(message) }
        }
    }
}
