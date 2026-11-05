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
    static let krakiVoiceEditRequested = Notification.Name("chat.kraki.voiceEditRequested")
}

/// The Sessions tab stack after opening a Session (`navigateToSession`).
enum SessionNavigationRoute {
    struct Result: Equatable {
        let path: [SessionNavID]
        /// Swap without a pop/push transition (a placeholder became its Session).
        let inPlace: Bool
    }

    /// - `pushesOnTop`: a fork opened from its source chat is pushed over it.
    /// - `replacingPlaceholder`: the pending route the target replaces. It is
    ///   swapped where it sits, so a slow fork ("Copying session…" over its
    ///   source) keeps the source below it and Back returns there.
    /// - Otherwise the stack is reset to the target.
    static func open(_ target: String, in path: [SessionNavID], replacingPlaceholder placeholder: String?,
                     pushesOnTop: Bool, sessionsTabSelected: Bool) -> Result {
        if pushesOnTop, sessionsTabSelected, !path.isEmpty {
            return Result(path: path + [SessionNavID(id: target)], inPlace: false)
        }
        if let placeholder, let index = path.lastIndex(of: SessionNavID(id: placeholder)) {
            return Result(path: Array(path[..<index]) + [SessionNavID(id: target)], inPlace: true)
        }
        return Result(path: [SessionNavID(id: target)], inPlace: false)
    }
}
