/// TentacleCLIManager — Drives this Mac's local tentacle: either the one
/// built into Kraki for Mac (see BuiltInTentacle) or a separately installed
/// `kraki` CLI, and provides start/stop/connect actions.
///
/// Mode
/// ----
/// `.builtIn`: the helper embedded in the app, supervised by SMAppService.
/// All queries (`status --json`, `connect --json`, `setup --json`) run the
/// embedded binary; lifecycle goes through SMAppService/launchctl.
/// `.external`: the original model below — a user-installed CLI that owns its
/// own launchd job. Both share ~/.kraki; `managed-by.json` makes sure only one
/// of them ever supervises a daemon (see TentacleMode.resolve).
///
/// Spawn model
/// -----------
/// All commands are run as a short-lived `Process` against the detected
/// `kraki` binary. We never link against the CLI in-process — it's an
/// independent Node.js executable owned by the user's PATH.
///
/// Daemon independence (verified in tentacle/src/daemon.ts:164-188):
///
///   spawn(node, [daemonWorker], {
///     detached: true,
///     stdio: 'ignore',
///   }).unref();
///
/// → daemon is reparented to launchd at PID 1. The mac app's process
/// tree has no link to it. Quitting the mac app, force-quitting, or
/// uninstalling does NOT affect the running daemon. The only way to
/// stop it is `kraki stop` (sends SIGTERM by pidfile).
///
/// We treat the CLI as a black box: detection via `which kraki` +
/// fallback paths, state via `kraki status --json`, lifecycle via
/// `kraki start` / `kraki stop`, pairing via `kraki connect --json`.

#if os(macOS)
import Foundation
import Observation
import AppKit
import SwiftUI

@MainActor
@Observable
final class TentacleCLIManager {

    // MARK: - State

    enum InstallState: Equatable {
        case unknown
        case notFound
        case available(path: String, version: String?)
    }

    enum DaemonState: Equatable {
        case unknown
        case stopped
        case running(pid: Int)
        case starting
        case stopping
        /// Built-in only: the user turned Kraki off in System Settings → Login
        /// Items; macOS will not run the daemon until it is re-enabled there.
        case needsApproval
        case error(String)
    }

    private(set) var installState: InstallState = .unknown
    private(set) var daemonState: DaemonState = .unknown
    private(set) var configInfo: ConfigInfo?
    private(set) var lastError: String?

    /// Which tentacle this app drives. Resolved by refreshInstallState().
    private(set) var mode: TentacleMode = .external
    /// A standalone CLI found on this Mac, independent of the current mode.
    private(set) var externalCLI: (path: String, version: String?)?
    /// A command-line install already runs Kraki and the user hasn't chosen
    /// which one should (see TentacleMode.needsOwnerChoice).
    private(set) var ownerChoicePending = false
    /// Daemon-reported Full Disk Access ("granted" | "denied" | "missing").
    private(set) var fdaStatus: String?
    /// Relay connection state reported by the daemon.
    private(set) var relayState: String?
    /// Version of the running daemon binary (may lag the app after an update).
    private(set) var runningDaemonVersion: String?

    @ObservationIgnored let builtIn = BuiltInTentacle()
    @ObservationIgnored private var restartedForVersion: String?
    @ObservationIgnored private var notRunningSince: Date?
    @ObservationIgnored private var lastKickstartAt: Date?
    @ObservationIgnored private var onDemandCheckedAt: Date?
    @ObservationIgnored private var launchdDomainStuck = false
    @ObservationIgnored private var reRegisteredThisLaunch = false
    @ObservationIgnored private var checkedLegacyHelperPath = false

    var isBuiltInAvailable: Bool { builtIn.isAvailable }

    /// Binary for `kraki agents --json`: the built-in tentacle when present
    /// (it is independent of who runs the daemon), else a CLI new enough.
    var agentCheckBinaryPath: String? {
        if builtIn.isAvailable { return builtIn.binaryPath }
        if case .available(let path, _) = installState { return path }
        return nil
    }
    var installLocation: AppInstallLocation { AppInstallLocation.current }

    struct ConfigInfo: Equatable {
        let exists: Bool
        let relay: String?
        let authMethod: String?
        let deviceName: String?
        let deviceId: String?
        let region: String?
        let logVerbosity: String?
        /// Apps may update Kraki here (`kraki config remote-update`).
        var remoteUpdate: Bool = true
    }

    /// Turn remote update (from the user's other devices) on or off here.
    func setRemoteUpdate(_ on: Bool) async {
        guard case .available(let path, _) = installState else { return }
        _ = await runCapturing(binary: path, args: ["config", "remote-update", on ? "on" : "off"])
        await refreshDaemonState()
    }

    // MARK: - Persistence

    @ObservationIgnored
    @AppStorage("tentacle.binaryPathOverride") private var binaryPathOverride: String = ""

    /// "builtIn" | "external" | "" (automatic). See TentacleMode.resolve.
    @ObservationIgnored
    @AppStorage("tentacle.mode") private var modePreference: String = ""

    // MARK: - Polling

    private var pollTask: Task<Void, Never>?

    /// Detection sites in PATH order. `which` is the canonical answer
    /// but breaks for double-clicked GUI launches that inherit a tiny
    /// PATH from launchd. We invoke a login shell via `sh -lc 'command -v
    /// kraki'` to inherit the user's normal PATH. If even that fails,
    /// fall back to a list of common install locations.
    private let fallbackPaths = [
        "/opt/homebrew/bin/kraki",
        "/usr/local/bin/kraki",
        "\(NSHomeDirectory())/.local/bin/kraki",
        "\(NSHomeDirectory())/.npm-global/bin/kraki",
        "\(NSHomeDirectory())/.volta/bin/kraki",
        "\(NSHomeDirectory())/.bun/bin/kraki",
    ]

    // MARK: - Install detection

    func refreshInstallState() async {
        let external = await detectExternalCLI()
        externalCLI = external
        mode = TentacleMode.resolve(
            preference: modePreference,
            builtInAvailable: builtIn.isAvailable,
            ownershipMarkerExists: builtIn.ownershipMarkerExists,
            cliDaemonInstalled: BuiltInTentacle.cliDaemonInstalled,
            externalCLIFound: external != nil
        )
        ownerChoicePending = TentacleMode.needsOwnerChoice(
            preference: modePreference,
            builtInAvailable: builtIn.isAvailable,
            ownershipMarkerExists: builtIn.ownershipMarkerExists,
            cliDaemonInstalled: BuiltInTentacle.cliDaemonInstalled,
            externalCLIFound: external != nil
        )
        switch mode {
        case .builtIn:
            installState = .available(path: builtIn.binaryPath, version: builtIn.version)
        case .external:
            if let external {
                installState = .available(path: external.path, version: external.version)
            } else {
                installState = .notFound
            }
        }
    }

    private func detectExternalCLI() async -> (path: String, version: String?)? {
        // User-set override always wins, if it points at an executable.
        let override = binaryPathOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        if !override.isEmpty, FileManager.default.isExecutableFile(atPath: override) {
            let version = await runCapturing(binary: override, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            return (override, version)
        }

        // Login-shell which.
        if let result = await runCapturing(binary: "/bin/sh", args: ["-lc", "command -v kraki"]),
           result.exitCode == 0 {
            let path = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty, FileManager.default.isExecutableFile(atPath: path), !isEmbeddedHelper(path) {
                let version = await runCapturing(binary: path, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                return (path, version)
            }
        }

        // Fallback common locations.
        for path in fallbackPaths where FileManager.default.isExecutableFile(atPath: path) && !isEmbeddedHelper(path) {
            let version = await runCapturing(binary: path, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            return (path, version)
        }
        return nil
    }

    /// A `kraki` on PATH that is really a symlink into some Kraki for Mac is
    /// not an independent CLI.
    private func isEmbeddedHelper(_ path: String) -> Bool {
        let resolved = (path as NSString).resolvingSymlinksInPath
        return resolved.contains(".app/Contents/Library/Helpers/")
    }

    /// Persist the user's choice and apply it. Switching to the built-in
    /// tentacle stops a CLI-owned daemon first; switching away releases the
    /// built-in one. ~/.kraki (login, device id, sessions) is shared, so
    /// neither direction needs a new sign-in.
    func switchMode(to target: TentacleMode) async {
        guard target != mode || modePreference != target.rawValue else { return }
        lastError = nil
        daemonState = .stopping
        switch target {
        case .builtIn:
            if let external = externalCLI, BuiltInTentacle.cliDaemonInstalled || daemonIsRunningNow {
                let result = await runCapturing(binary: external.path, args: ["stop"])
                // Taking over while the CLI's daemon still runs would put two
                // daemons on one device id. Stay put and say why instead.
                if BuiltInTentacle.cliDaemonInstalled && result?.exitCode != 0 {
                    let output = [result?.stderr, result?.stdout].compactMap { $0 }.joined(separator: "\n")
                    let detail = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                        .last { !$0.isEmpty } ?? ""
                    lastError = "Couldn't stop the command-line Kraki." + (detail.isEmpty ? "" : " \(detail)")
                    await refreshDaemonState()
                    return
                }
            }
            modePreference = TentacleMode.builtIn.rawValue
            await refreshInstallState()
            await startDaemon()
        case .external:
            do { try await builtIn.disable() } catch { lastError = error.localizedDescription }
            modePreference = TentacleMode.external.rawValue
            await refreshInstallState()
            await startDaemon()
        }
    }

    /// Settings → This Mac "Run agents on this Mac": turn the built-in daemon
    /// on (and remember it) or off (only control other computers from here).
    func setRunsAgentsOnThisMac(_ on: Bool) async {
        UserDefaults.standard.set(
            (on ? BuiltInTentacle.ThisMacRole.runsAgents : .remoteOnly).rawValue,
            forKey: BuiltInTentacle.thisMacRoleKey
        )
        if on {
            await startDaemon()
        } else {
            daemonState = .stopping
            do { try await builtIn.disable() } catch { lastError = error.localizedDescription }
            try? await Task.sleep(nanoseconds: 300_000_000)
            await refreshDaemonState()
        }
    }

    private var daemonIsRunningNow: Bool {
        if case .running = daemonState { return true }
        return false
    }

    /// Allow the user to set an explicit override (Preferences →
    /// Tentacle → Locate kraki manually…). The override is persisted.
    /// Pass nil/empty to clear.
    func setBinaryPathOverride(_ path: String?) {
        binaryPathOverride = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Daemon state

    func refreshDaemonState() async {
        guard case .available(let path, _) = installState else {
            daemonState = .unknown
            configInfo = nil
            return
        }

        guard let result = await runCapturing(binary: path, args: ["status", "--json"]),
              result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            daemonState = .error("status query failed")
            return
        }

        let daemon = json["daemon"] as? [String: Any]
        let running = daemon?["running"] as? Bool ?? false
        let pid = daemon?["pid"] as? Int
        fdaStatus = daemon?["fda"] as? String
        relayState = daemon?["relayState"] as? String
        runningDaemonVersion = daemon?["daemonVersion"] as? String

        if mode == .builtIn {
            // SMAppService is the source of truth for whether the job may run.
            if builtIn.service.status == .requiresApproval {
                daemonState = .needsApproval
                return
            }
            // An app updated from a version whose helper was "Kraki Tentacle.app"
            // still has a launchd job naming that path. Re-register at once so
            // launchd records "Kraki.app", instead of waiting out the
            // not-running self-heal below. Checked once per launch, and only
            // the known legacy path triggers it (re-registering restarts the
            // daemon, so a parse surprise must never cause it).
            if !checkedLegacyHelperPath, builtIn.ownershipMarkerExists,
               builtIn.service.status == .enabled {
                checkedLegacyHelperPath = true
                if !reRegisteredThisLaunch,
                   let program = await registeredProgramIdentifier(),
                   Self.isLegacyHelperProgram(program) {
                    reRegisteredThisLaunch = true
                    restartedForVersion = builtIn.version
                    KLog.diag("[Tentacle] built-in job points at \(program); re-registering")
                    Task { await self.reRegisterBuiltIn() }
                    daemonState = .starting
                    return
                }
            }
            // After a Sparkle update the old daemon keeps running from memory.
            // Restart it once onto the tentacle this app now ships.
            if running, let shipped = builtIn.version, let live = runningDaemonVersion,
               shipped != live, restartedForVersion != shipped, builtIn.ownershipMarkerExists {
                restartedForVersion = shipped
                KLog.diag("[Tentacle] restarting built-in daemon \(live) → \(shipped)")
                builtIn.kickstart()
            }
        }
        // Self-heal: the job is registered and should run, yet nothing runs.
        // After an app update launchd can refuse the new helper binary against
        // the launch constraint it recorded at registration (seen with a
        // re-signed helper: "Requesting repair LWCR update", exit 78 forever).
        // Re-registering records the current binary. Once per app launch, and
        // only after the job had time to come up on its own.
        var stuck = false
        if mode == .builtIn, !running, builtIn.ownershipMarkerExists,
           BuiltInTentacle.thisMacRole != .remoteOnly,
           builtIn.service.status == .enabled {
            let now = Date()
            if notRunningSince == nil { notRunningSince = now }
            let down = now.timeIntervalSince(notRunningSince ?? now)
            // Ask launchd to start it, and keep asking while the app is open.
            // A registered RunAtLoad/KeepAlive job is never spawned while the
            // user's launchd domain is stuck in on-demand-only mode (after an
            // interrupted restart/logout, until the next reboot); an explicit
            // kickstart still is. Seen on a real Mac after an update: "pending
            // spawn, domain in on-demand-only mode", and the app sat on
            // "Starting Kraki in background" forever.
            if down > 6, lastKickstartAt.map({ now.timeIntervalSince($0) > 15 }) ?? true {
                lastKickstartAt = now
                KLog.diag("[Tentacle] built-in daemon registered but not running for \(Int(down))s; kickstarting")
                builtIn.kickstart()
            }
            // Re-registering records the current binary (launch-constraint
            // repair after an update). Once per app launch.
            if down > 20, !reRegisteredThisLaunch {
                reRegisteredThisLaunch = true
                KLog.diag("[Tentacle] built-in daemon registered but not running for 20s; re-registering")
                Task { await self.reRegisterBuiltIn() }
            }
            // Still down: tell the user why instead of spinning forever.
            if down > 45 {
                if let checked = onDemandCheckedAt, now.timeIntervalSince(checked) < 30 {
                    stuck = launchdDomainStuck
                } else {
                    onDemandCheckedAt = now
                    launchdDomainStuck = await isLaunchdDomainOnDemandOnly()
                    stuck = launchdDomainStuck
                    if stuck { KLog.diag("[Tentacle] launchd domain is in on-demand-only mode; daemon cannot start") }
                }
            }
        } else if running {
            notRunningSince = nil
            lastKickstartAt = nil
            launchdDomainStuck = false
        }

        if running, let pid {
            // Don't clobber a transient .starting state if we caught the
            // daemon mid-fork (kraki start already returned but pidfile
            // hadn't flipped yet). On the NEXT poll if status comes
            // back running we promote.
            if case .starting = daemonState {
                daemonState = .running(pid: pid)
            } else {
                daemonState = .running(pid: pid)
            }
        } else {
            // Avoid flapping .stopping → .stopped → .starting if the
            // user spammed buttons. Trust the JSON here.
            daemonState = stuck ? .error(Self.launchdStuckMessage) : .stopped
        }

        if let cfg = json["config"] as? [String: Any] {
            let exists = (cfg["exists"] as? Bool) ?? false
            let device = cfg["device"] as? [String: Any]
            configInfo = ConfigInfo(
                exists: exists,
                relay: cfg["relay"] as? String,
                authMethod: cfg["authMethod"] as? String,
                deviceName: device?["name"] as? String,
                deviceId: device?["id"] as? String,
                region: cfg["region"] as? String,
                logVerbosity: cfg["logVerbosity"] as? String,
                remoteUpdate: cfg["remoteUpdate"] as? Bool ?? true
            )
        } else {
            configInfo = nil
        }
    }

    /// Start a periodic refresh loop. Cancels itself when the task is
    /// dropped, so a fresh call replaces the previous loop.
    func startPolling(interval: TimeInterval = 3) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                await self?.refreshDaemonState()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Daemon lifecycle

    func startDaemon() async {
        guard case .available(let path, _) = installState else { return }
        if mode == .builtIn {
            // The user chose to only control other computers from this Mac.
            guard BuiltInTentacle.thisMacRole != .remoteOnly else { return }
            await startBuiltIn()
            return
        }

        // Reuse, don't replace. The mac app is a CLIENT of the daemon,
        // never its owner. If the CLI (or a previous app launch) already
        // started a daemon, attach to it instead of spawning a second
        // one. Two daemons sharing the same deviceId fight over the
        // relay connection (last-writer-wins on the relay's
        // Map<deviceId, ws>), which silently drops ~half the user's
        // messages. `kraki start` is itself non-idempotent — it stops
        // the existing daemon and writes a fresh launchd plist pointing
        // at whichever binary invoked it — so we must gate it here.
        await refreshDaemonState()
        if case .running = daemonState { return }

        daemonState = .starting
        let result = await runCapturing(binary: path, args: ["start"])
        if let r = result, r.exitCode == 0 {
            // Give the daemon a beat to write its pidfile before
            // polling, so we don't briefly show "stopped" right after
            // a successful start.
            try? await Task.sleep(nanoseconds: 400_000_000)
            await refreshDaemonState()
        } else {
            daemonState = .error(result?.stderr ?? "kraki start failed")
        }
    }

    func stopDaemon() async {
        guard case .available(let path, _) = installState else { return }
        daemonState = .stopping
        if mode == .builtIn {
            do { try await builtIn.disable() } catch { lastError = error.localizedDescription }
            try? await Task.sleep(nanoseconds: 300_000_000)
            await refreshDaemonState()
            return
        }
        _ = await runCapturing(binary: path, args: ["stop"])
        try? await Task.sleep(nanoseconds: 300_000_000)
        await refreshDaemonState()
    }

    func restartDaemon() async {
        if mode == .builtIn, daemonIsRunningNow {
            daemonState = .starting
            builtIn.kickstart()
            try? await Task.sleep(nanoseconds: 800_000_000)
            await refreshDaemonState()
            return
        }
        await stopDaemon()
        await startDaemon()
    }

    /// Remove the job from launchd and register it again (keeps ownership).
    /// SMAppService.unregister alone leaves launchd's recorded launch
    /// constraint in place (verified in a VM: the job kept failing with
    /// exit 78); `launchctl bootout` drops it, and the next register records
    /// the binary now in the app.
    private func reRegisterBuiltIn() async {
        _ = await runCapturing(binary: "/bin/launchctl", args: ["bootout", "gui/\(getuid())/\(builtIn.label)"])
        do {
            try await builtIn.service.unregister()
        } catch {
            KLog.diag("[Tentacle] unregister before re-register failed: \(error.localizedDescription)")
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        do {
            _ = try builtIn.enable()
            // Registration alone does not spawn the job in on-demand-only mode.
            try? await Task.sleep(nanoseconds: 500_000_000)
            builtIn.kickstart()
        } catch {
            daemonState = .error("Could not restart Kraki in the background: \(error.localizedDescription)")
        }
    }

    static let launchdStuckMessage =
        "macOS hasn't finished a restart, so it isn't starting background apps right now. Restart your Mac to fix this."

    /// True while the user's launchd domain only spawns jobs on explicit
    /// demand (`on-demand count` > 0 in `launchctl print gui/<uid>`): the
    /// state an interrupted restart/logout leaves behind until the next reboot.
    private func isLaunchdDomainOnDemandOnly() async -> Bool {
        guard let result = await runCapturing(binary: "/bin/launchctl", args: ["print", "gui/\(getuid())"]),
              result.exitCode == 0 else { return false }
        return Self.onDemandCount(fromLaunchctlPrint: result.stdout) > 0
    }

    nonisolated static func onDemandCount(fromLaunchctlPrint text: String) -> Int {
        for line in text.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("on-demand count = "), let n = Int(t.dropFirst("on-demand count = ".count)) { return n }
        }
        return 0
    }

    /// The bundle-relative program launchd recorded for the built-in job
    /// (`program identifier = …` in `launchctl print`), or nil if unknown.
    private func registeredProgramIdentifier() async -> String? {
        guard let result = await runCapturing(
            binary: "/bin/launchctl", args: ["print", "gui/\(getuid())/\(builtIn.label)"]
        ), result.exitCode == 0 else { return nil }
        return Self.programIdentifier(fromLaunchctlPrint: result.stdout)
    }

    nonisolated static func programIdentifier(fromLaunchctlPrint output: String) -> String? {
        for line in output.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("program identifier = ") else { continue }
            var value = String(trimmed.dropFirst("program identifier = ".count))
            if let mode = value.range(of: " (mode:") { value = String(value[..<mode.lowerBound]) }
            return value
        }
        return nil
    }

    nonisolated static func isLegacyHelperProgram(_ program: String) -> Bool {
        program.hasPrefix("Contents/Library/Helpers/Kraki Tentacle.app/")
    }

    /// Register the built-in daemon with SMAppService.
    ///
    /// Refuses from a translocated/disk-image location (the registration would
    /// point at a path that vanishes on reboot) and never runs beside a daemon
    /// owned by an external CLI.
    private func startBuiltIn() async {
        switch installLocation {
        case .translocated, .diskImage:
            daemonState = .error("Move Kraki to the Applications folder before starting it.")
            return
        case .stable:
            break
        }
        await refreshDaemonState()
        if case .running = daemonState, builtIn.ownershipMarkerExists,
           builtIn.service.status == .enabled { return }

        daemonState = .starting
        do {
            let status = try builtIn.enable()
            if status == .requiresApproval {
                daemonState = .needsApproval
                BuiltInTentacle.openLoginItemsSettings()
                return
            }
        } catch {
            daemonState = .error("Could not start Kraki in the background: \(error.localizedDescription)")
            return
        }
        // The worker publishes its PID within a second or two; poll briefly so
        // the UI moves straight to "running" instead of flashing "stopped".
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            await refreshDaemonState()
            if case .running = daemonState { return }
            if case .needsApproval = daemonState { return }
        }
        if case .stopped = daemonState { daemonState = .starting }
    }

    // MARK: - Pairing

    struct PairingPayload: Equatable {
        let url: String
        let token: String
        let relay: String
        let expiresAt: Date
    }

    func requestPairingPayload() async throws -> PairingPayload {
        guard case .available(let path, _) = installState else {
            throw TentacleCLIError("Kraki CLI not available")
        }
        guard let result = await runCapturing(binary: path, args: ["connect", "--json"]) else {
            throw TentacleCLIError("Failed to spawn kraki connect")
        }
        guard let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TentacleCLIError("Non-JSON output from kraki connect")
        }
        if let ok = json["ok"] as? Bool, !ok {
            let err = json["error"] as? String ?? "unknown"
            throw TentacleCLIError("kraki connect: \(err)")
        }
        guard let url = json["url"] as? String,
              let token = json["token"] as? String,
              let relay = json["relay"] as? String else {
            throw TentacleCLIError("Malformed payload from kraki connect")
        }
        let expiresAt: Date
        if let iso = json["expiresAt"] as? String,
           let date = ISO8601DateFormatter().date(from: iso) {
            expiresAt = date
        } else if let secs = json["expiresInSeconds"] as? TimeInterval {
            expiresAt = Date().addingTimeInterval(secs)
        } else {
            expiresAt = Date().addingTimeInterval(300)
        }
        return PairingPayload(url: url, token: token, relay: relay, expiresAt: expiresAt)
    }

    // MARK: - Logs

    /// Path to the daemon's log directory. Empty string if we haven't
    /// detected the CLI yet.
    var logsDirectory: String {
        // Kraki's CLI puts logs at ~/.kraki/logs by default (see
        // packages/tentacle/src/config.ts: getKrakiHome).
        return "\(NSHomeDirectory())/.kraki/logs"
    }

    func openLogsInFinder() {
        let url = URL(fileURLWithPath: logsDirectory)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    // MARK: - Menu bar appearance

    /// SF Symbol name to render in the MenuBarExtra label. We use the
    /// solid circle variants so the dot is visually distinct from the
    /// regular menu bar icons.
    var menuBarSymbolName: String {
        switch daemonState {
        case .running:  return "circle.fill"
        case .starting, .stopping: return "circle.dashed"
        case .stopped:  return "circle"
        case .needsApproval: return "exclamationmark.circle"
        case .error:    return "exclamationmark.circle"
        case .unknown:  return "questionmark.circle"
        }
    }

    // MARK: - Internals

    private struct CommandResult {
        let exitCode: Int32
        let stdout: String
        let stderr: String
    }

    /// Spawn a process, capture stdout/stderr, return on exit. Returns
    /// nil if Process throws on launch (binary missing / permissions).
    private func runCapturing(binary: String, args: [String]) async -> CommandResult? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: binary)
                process.arguments = args
                let outPipe = Pipe(), errPipe = Pipe()
                process.standardOutput = outPipe
                process.standardError = errPipe

                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: nil)
                    return
                }

                // Drain both pipes while the process runs: waiting first
                // deadlocks once a command writes more than the pipe buffer
                // (e.g. `launchctl print gui/<uid>` is ~130 KB).
                var errData = Data()
                let errDone = DispatchSemaphore(value: 0)
                DispatchQueue.global(qos: .userInitiated).async {
                    errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                    errDone.signal()
                }
                let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                errDone.wait()
                process.waitUntilExit()
                continuation.resume(returning: CommandResult(
                    exitCode: process.terminationStatus,
                    stdout: String(data: outData, encoding: .utf8) ?? "",
                    stderr: String(data: errData, encoding: .utf8) ?? ""
                ))
            }
        }
    }
}

struct TentacleCLIError: Error, LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

#endif
