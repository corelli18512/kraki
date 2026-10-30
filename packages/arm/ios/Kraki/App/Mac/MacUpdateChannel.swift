/// MacUpdateChannel — which Sparkle feed this Mac follows.
///
/// Settings › General › Updates switches it (internal accounts only, see
/// `isSwitchVisible`). Stored per machine in the app's own defaults domain;
/// Stable is the default. Stable reads the production appcast on
/// `mac-updates`. Dogfood reads the feed of the rolling `dogfood-mac`
/// release, which also lists the newest formal release, so a dogfood Mac
/// moves on to a formal release that is newer than its build
/// (docs/dogfood.md).

#if os(macOS)
import Foundation

enum MacUpdateChannel: String, CaseIterable, Identifiable {
    case stable
    case dogfood

    static let defaultsKey = "mac.updateChannel"
    static let stableFeedURL = "https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml"
    static let dogfoodFeedURL = "https://github.com/corelli18512/kraki/releases/download/dogfood-mac/appcast-dogfood.xml"

    var id: String { rawValue }

    var feedURL: String {
        switch self {
        case .stable: Self.stableFeedURL
        case .dogfood: Self.dogfoodFeedURL
        }
    }

    static func stored(in defaults: UserDefaults = .standard) -> MacUpdateChannel {
        defaults.string(forKey: defaultsKey).flatMap(MacUpdateChannel.init(rawValue:)) ?? .stable
    }

    static func store(_ channel: MacUpdateChannel, in defaults: UserDefaults = .standard) {
        defaults.set(channel.rawValue, forKey: defaultsKey)
    }

    /// Internal accounts see the switch. A Mac already on Dogfood keeps
    /// seeing it without the account flag (signed out, or the flag was
    /// removed), so it can always switch back.
    static func isSwitchVisible(accountIsInternal: Bool, current: MacUpdateChannel) -> Bool {
        accountIsInternal || current == .dogfood
    }

    /// A dogfood build's CFBundleVersion is `<formal build>.<N>`; a formal
    /// build's is a plain integer (docs/dogfood.md).
    static func isDogfoodBuild(_ bundleVersion: String) -> Bool {
        bundleVersion.contains(".")
    }

    /// What the line under the switch says.
    enum Note: Equatable {
        /// Dogfood: every new dogfood build, and a newer formal release.
        case followsDogfood
        /// Stable on a dogfood build: Sparkle never downgrades, so this
        /// build stays until the next formal release (a higher build).
        case staysUntilNextFormalRelease(build: String)
        /// Stable on a formal build.
        case formalReleasesOnly
    }

    static func note(for channel: MacUpdateChannel, bundleVersion: String) -> Note {
        switch channel {
        case .dogfood: .followsDogfood
        case .stable where isDogfoodBuild(bundleVersion): .staysUntilNextFormalRelease(build: bundleVersion)
        case .stable: .formalReleasesOnly
        }
    }
}
#endif
