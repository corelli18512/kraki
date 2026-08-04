/// TentacleCLIManager — Detects the locally-installed `kraki` CLI,
/// queries its daemon state, and provides start/stop/connect actions.
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
        case error(String)
    }

    private(set) var installState: InstallState = .unknown
    private(set) var daemonState: DaemonState = .unknown
    private(set) var configInfo: ConfigInfo?
    private(set) var lastError: String?

    struct ConfigInfo: Equatable {
        let exists: Bool
        let relay: String?
        let authMethod: String?
        let deviceName: String?
        let deviceId: String?
        let region: String?
        let logVerbosity: String?
    }

    // MARK: - Persistence

    @ObservationIgnored
    @AppStorage("tentacle.binaryPathOverride") private var binaryPathOverride: String = ""

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
        // User-set override always wins, if it points at an executable.
        let override = binaryPathOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        if !override.isEmpty, FileManager.default.isExecutableFile(atPath: override) {
            let version = await runCapturing(binary: override, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            installState = .available(path: override, version: version)
            return
        }

        // Login-shell which.
        if let result = await runCapturing(binary: "/bin/sh", args: ["-lc", "command -v kraki"]),
           result.exitCode == 0 {
            let path = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
                let version = await runCapturing(binary: path, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                installState = .available(path: path, version: version)
                return
            }
        }

        // Fallback common locations.
        for path in fallbackPaths {
            if FileManager.default.isExecutableFile(atPath: path) {
                let version = await runCapturing(binary: path, args: ["--version"])?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                installState = .available(path: path, version: version)
                return
            }
        }

        installState = .notFound
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
            daemonState = .stopped
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
                logVerbosity: cfg["logVerbosity"] as? String
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
        _ = await runCapturing(binary: path, args: ["stop"])
        try? await Task.sleep(nanoseconds: 300_000_000)
        await refreshDaemonState()
    }

    func restartDaemon() async {
        await stopDaemon()
        await startDaemon()
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

                process.waitUntilExit()
                let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
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
