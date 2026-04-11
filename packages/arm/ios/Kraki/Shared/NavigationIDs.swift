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
