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

#elseif os(macOS)
import SwiftUI

@main
struct KrakiApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Kraki is an iOS app. This macOS target is for compilation verification only.")
                .padding()
        }
    }
}
#endif
