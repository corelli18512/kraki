/// BuiltInTentacle — the tentacle daemon that ships inside Kraki for Mac.
///
/// Layout (produced by scripts/mac/embed-tentacle-helper.sh):
///
///   Kraki.app/Contents/Library/Helpers/Kraki Tentacle.app   the tentacle SEA
///   Kraki.app/Contents/Library/LaunchAgents/<id>.tentacle.plist
///
/// The daemon is registered with `SMAppService.agent(plistName:)`. launchd
/// then runs the helper's executable directly (BundleProgram) with KeepAlive,
/// independently of this app: quitting Kraki leaves the daemon running, and it
/// starts again at login. Verified on a clean macOS VM with a notarized build:
///
///   - TCC attributes the daemon (and every agent it spawns) to this app's
///     bundle id, so Full Disk Access is granted once, to "Kraki", and
///     survives app updates;
///   - Login Items shows "Kraki" with its icon rather than "open — unidentified
///     developer" as the CLI's launchd job does;
///   - the registration survives reboots and in-place app replacement.
///
/// It must NOT be registered while the app runs translocated (quarantined app
/// opened from Downloads without being moved) or from a mounted disk image:
/// launchd would record a path that disappears at the next reboot.
///
/// Ownership is shared with the standalone CLI through
/// `~/.kraki/managed-by.json` (see packages/tentacle/src/managed.ts): while it
/// exists the CLI refuses to start/stop/update a daemon of its own.

#if os(macOS)
import AppKit
import Foundation
import ServiceManagement

enum AppInstallLocation: Equatable {
    /// A stable path launchd can rely on (normally /Applications).
    case stable
    /// Gatekeeper App Translocation: a randomized read-only mount that is gone
    /// after reboot. Only a Finder move of the app ends it.
    case translocated
    /// Running straight from a mounted .dmg.
    case diskImage

    static func classify(bundlePath: String) -> AppInstallLocation {
        if bundlePath.contains("/AppTranslocation/") { return .translocated }
        if bundlePath.hasPrefix("/Volumes/") { return .diskImage }
        return .stable
    }

    static var current: AppInstallLocation { classify(bundlePath: Bundle.main.bundlePath) }
}

/// Which tentacle this app drives.
enum TentacleMode: String, Equatable {
    /// The built-in helper supervised through SMAppService.
    case builtIn
    /// A separately installed `kraki` CLI that manages its own daemon.
    case external

    /// Decide the mode without surprising anyone.
    ///
    /// - An explicit user choice always wins (when still possible).
    /// - A Mac-app ownership marker means the built-in daemon is in charge.
    /// - An existing CLI-installed daemon (its launchd plist) keeps working as
    ///   before: the user opts in to the built-in daemon from Settings.
    /// - Everyone else — the new user who only downloaded the app — gets the
    ///   built-in tentacle, with no CLI involved.
    static func resolve(
        preference: String,
        builtInAvailable: Bool,
        ownershipMarkerExists: Bool,
        cliDaemonInstalled: Bool,
        externalCLIFound: Bool
    ) -> TentacleMode {
        guard builtInAvailable else { return .external }
        switch TentacleMode(rawValue: preference) {
        case .builtIn: return .builtIn
        case .external: return externalCLIFound ? .external : .builtIn
        case nil: break
        }
        if ownershipMarkerExists { return .builtIn }
        if cliDaemonInstalled && externalCLIFound { return .external }
        return .builtIn
    }

    /// A command-line install already runs Kraki on this Mac and the user has
    /// not said which one should: ask once instead of silently picking. The
    /// answer is stored as the explicit preference, so this never repeats.
    static func needsOwnerChoice(
        preference: String,
        builtInAvailable: Bool,
        ownershipMarkerExists: Bool,
        cliDaemonInstalled: Bool,
        externalCLIFound: Bool
    ) -> Bool {
        builtInAvailable
            && TentacleMode(rawValue: preference) == nil
            && !ownershipMarkerExists
            && cliDaemonInstalled
            && externalCLIFound
    }
}

struct BuiltInTentacle {
    static let helperRelativePath = "Contents/Library/Helpers/Kraki Tentacle.app"
    static let ownerId = "kraki-mac"

    let appBundle: Bundle
    let krakiHome: URL

    init(appBundle: Bundle = .main, krakiHome: URL = BuiltInTentacle.defaultKrakiHome) {
        self.appBundle = appBundle
        self.krakiHome = krakiHome
    }

    static var defaultKrakiHome: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".kraki", isDirectory: true)
    }

    // MARK: Bundle contents

    var helperURL: URL { appBundle.bundleURL.appendingPathComponent(Self.helperRelativePath, isDirectory: true) }
    var binaryPath: String { helperURL.appendingPathComponent("Contents/MacOS/kraki").path }

    /// The helper, its launch agent plist, and (in Debug) an explicit opt-in.
    ///
    /// Debug builds share `~/.kraki` with the developer's real daemon, so they
    /// only use an embedded helper when KRAKI_MAC_ALLOW_BUILTIN_TENTACLE=1 —
    /// never by accident on a production machine.
    var isAvailable: Bool {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["KRAKI_MAC_ALLOW_BUILTIN_TENTACLE"] == "1" else { return false }
        #endif
        let plist = appBundle.bundleURL
            .appendingPathComponent("Contents/Library/LaunchAgents/\(label).plist").path
        return FileManager.default.isExecutableFile(atPath: binaryPath)
            && FileManager.default.fileExists(atPath: plist)
    }

    /// Version of the tentacle shipped in this app (Info.plist, set at build).
    var version: String? { appBundle.object(forInfoDictionaryKey: "KrakiTentacleVersion") as? String }

    var label: String { (appBundle.bundleIdentifier ?? "chat.kraki.mac") + ".tentacle" }

    var service: SMAppService { SMAppService.agent(plistName: "\(label).plist") }

    // MARK: Lifecycle

    /// Record ownership, then register (or keep) the launchd job. Returns the
    /// resulting status; `.requiresApproval` means the user turned Kraki off
    /// in Login Items and must re-enable it there.
    func enable() throws -> SMAppService.Status {
        try writeOwnershipMarker()
        let service = service
        if service.status != .enabled {
            try service.register()
        }
        return service.status
    }

    /// Unregister the job (launchd stops the daemon) and release ownership.
    func disable() async throws {
        if service.status != .notRegistered && service.status != .notFound {
            try await service.unregister()
        }
        clearOwnershipMarker()
    }

    /// Restart the daemon in place under the same launchd supervision.
    @discardableResult
    func kickstart() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    // MARK: Ownership marker (shared contract with the CLI)

    var ownershipMarkerURL: URL { krakiHome.appendingPathComponent("managed-by.json") }

    var ownershipMarkerExists: Bool {
        guard let data = try? Data(contentsOf: ownershipMarkerURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return json["by"] as? String == Self.ownerId
    }

    static func ownershipMarkerData(label: String, appPath: String, appVersion: String?, now: Date = Date()) throws -> Data {
        var json: [String: Any] = [
            "by": ownerId,
            "label": label,
            "appPath": appPath,
            "updatedAt": ISO8601DateFormatter().string(from: now),
        ]
        if let appVersion { json["appVersion"] = appVersion }
        return try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
    }

    func writeOwnershipMarker() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: krakiHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try Self.ownershipMarkerData(
            label: label,
            appPath: appBundle.bundlePath,
            appVersion: appBundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        )
        try data.write(to: ownershipMarkerURL, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: ownershipMarkerURL.path)
    }

    func clearOwnershipMarker() {
        try? FileManager.default.removeItem(at: ownershipMarkerURL)
    }

    // MARK: Standalone CLI artifacts

    /// The standalone CLI's own launchd job for ~/.kraki.
    static var cliLaunchAgentPlist: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/LaunchAgents/cloud.corelli.kraki.plist")
    }

    static var cliDaemonInstalled: Bool {
        FileManager.default.fileExists(atPath: cliLaunchAgentPlist.path)
    }

    // MARK: This Mac's role

    /// What the user chose in setup's "Set up this Mac" step.
    enum ThisMacRole: String {
        /// Not asked yet (or an existing install from before the step existed).
        case undecided = ""
        /// Run the coding agents installed on this Mac (the built-in daemon).
        case runsAgents = "agents"
        /// Only control agents on other computers; no daemon on this Mac.
        case remoteOnly = "remoteOnly"
    }

    static let thisMacRoleKey = "tentacle.thisMac"

    static var thisMacRole: ThisMacRole {
        ThisMacRole(rawValue: UserDefaults.standard.string(forKey: thisMacRoleKey) ?? "") ?? .undecided
    }

    // MARK: Full Disk Access (probed in-app)

    /// Whether Kraki has Full Disk Access, without prompting. TCC attributes
    /// the built-in daemon to this app, so the app's own access is the answer,
    /// and it is available before the daemon ever runs. Same probe as the
    /// tentacle's (checks.ts FDA_PROBE_TARGETS): read something only FDA opens.
    static func hasFullDiskAccess(home: String = NSHomeDirectory()) -> Bool {
        let fm = FileManager.default
        for dir in ["Library/Safari", "Library/Mail"] {
            let path = (home as NSString).appendingPathComponent(dir)
            guard fm.fileExists(atPath: path) else { continue }
            return (try? fm.contentsOfDirectory(atPath: path)) != nil
        }
        let tcc = (home as NSString).appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
        return FileHandle(forReadingAtPath: tcc) != nil
    }

    // MARK: System Settings

    static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    static func openFullDiskAccessSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
    }

    static func revealAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
}

#endif
