/// MacUpdateController — Sparkle 2 lifecycle for the signed production GUI.
///
/// Debug/Dev builds intentionally do not start an updater. The bundle identity
/// check also prevents a copied Dev build from ever consuming the production
/// appcast or replacing the production app.

#if os(macOS)
import AppKit
import Sparkle

@MainActor
final class MacUpdateController: NSObject, SPUUpdaterDelegate {
    static let productionBundleIdentifier = "chat.kraki.mac"
    static let productionFeedURL = "https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml"

    private(set) lazy var controller: SPUStandardUpdaterController = {
        SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
    }()

    static func makeIfProduction() -> MacUpdateController? {
        guard Bundle.main.bundleIdentifier == productionBundleIdentifier else {
            return nil
        }
        return MacUpdateController()
    }

    override init() {
        super.init()

        // Sparkle keeps these values in UserDefaults. Set the initial policy
        // through Info.plist and only use this object for lifecycle/actions.
    }

    func start() {
        controller.startUpdater()
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    func feedURLString(for updater: SPUUpdater) -> String? {
        Self.productionFeedURL
    }

    func updaterShouldPromptForPermissionToCheck(forUpdates updater: SPUUpdater) -> Bool {
        false
    }

    func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        []
    }
}
#endif
