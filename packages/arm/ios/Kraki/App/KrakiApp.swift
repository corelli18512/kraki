#if os(iOS)
import SwiftUI

@main
struct KrakiApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
        }
    }
}
#endif
