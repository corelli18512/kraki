/// Navigation ID wrappers to avoid String type collisions in NavigationStack.
///
/// Both session IDs and device IDs are String, but they route to different
/// destinations. Wrapping in distinct Hashable types lets SwiftUI's
/// .navigationDestination(for:) distinguish them.

import Foundation

struct SessionNavID: Hashable {
    let id: String
}

struct DeviceNavID: Hashable {
    let id: String
}

extension Notification.Name {
    /// Posted after a Chat composer (iOS or macOS) successfully submits a
    /// prompt, steer, typed answer or deny reason: the conversation returns to
    /// its newest edge. userInfo["sessionId"]: String.
    static let krakiComposerSubmitted = Notification.Name("chat.kraki.composerSubmitted")
}
