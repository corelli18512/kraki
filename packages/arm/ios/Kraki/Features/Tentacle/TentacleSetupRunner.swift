/// TentacleSetupRunner — drives `kraki setup --json` from the built-in
/// tentacle so a new user signs in and configures this Mac without Terminal.
///
/// The tentacle streams NDJSON events (see packages/tentacle/src/setup-json.ts):
/// start → device_code → authenticated → relay → done | error. Cancelling
/// terminates the process; the tentacle writes config only at the very end, so
/// a cancelled run leaves nothing behind.

#if os(macOS)
import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class TentacleSetupRunner {
    enum Phase: Equatable {
        case idle
        case starting
        case waitingForGitHub(userCode: String, verificationURL: URL)
        case configuring(username: String)
        case done(username: String)
        case failed(message: String)
    }

    private(set) var phase: Phase = .idle

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var buffer = Data()

    var isRunning: Bool {
        switch phase {
        case .starting, .waitingForGitHub, .configuring: return true
        default: return false
        }
    }

    /// Parse one NDJSON line into a phase transition. Pure for testing.
    static func phase(after current: Phase, line: String) -> Phase? {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = json["event"] as? String else { return nil }
        switch event {
        case "start":
            return .starting
        case "device_code":
            guard let code = json["userCode"] as? String,
                  let raw = json["verificationUri"] as? String,
                  let url = URL(string: raw) else { return nil }
            return .waitingForGitHub(userCode: code, verificationURL: url)
        case "authenticated":
            return .configuring(username: json["username"] as? String ?? "")
        case "relay":
            if case .configuring = current { return current }
            return nil
        case "done":
            return .done(username: json["username"] as? String ?? "")
        case "error":
            return .failed(message: json["message"] as? String ?? "Setup failed.")
        default:
            return nil
        }
    }

    func start(binaryPath: String, deviceName: String? = nil, forceLogin: Bool = false) {
        cancel()
        phase = .starting
        buffer = Data()

        var args = ["setup", "--json"]
        if let deviceName, !deviceName.isEmpty { args += ["--device-name", deviceName] }
        if forceLogin { args.append("--force-login") }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice

        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            Task { @MainActor [weak self] in self?.consume(chunk) }
        }
        process.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor [weak self] in self?.finished(process: proc, status: status) }
        }

        do {
            try process.run()
            self.process = process
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            phase = .failed(message: "Could not start Kraki's built-in tentacle: \(error.localizedDescription)")
        }
    }

    func cancel() {
        if let process, process.isRunning { process.terminate() }
        process = nil
        if isRunning { phase = .idle }
    }

    func copyCodeAndOpenGitHub() {
        guard case let .waitingForGitHub(code, url) = phase else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        NSWorkspace.shared.open(url)
    }

    private func consume(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            // Terminal phases are final even if a late pipe chunk arrives.
            if case .done = phase { continue }
            if case .failed = phase { continue }
            if let next = Self.phase(after: phase, line: line) {
                let firstCode: Bool = {
                    if case .waitingForGitHub = next, !(phase.isWaitingForGitHub) { return true }
                    return false
                }()
                phase = next
                // Same convenience as the CLI: copy the code and open GitHub
                // once, so the user only has to paste it.
                if firstCode { copyCodeAndOpenGitHub() }
            }
        }
    }

    private func finished(process finished: Process, status: Int32) {
        guard finished === process else { return }
        if let pipe = finished.standardOutput as? Pipe {
            pipe.fileHandleForReading.readabilityHandler = nil
            // Drain what the handler has not delivered yet (e.g. the final
            // `done` or `error` line) before judging the outcome.
            consume(pipe.fileHandleForReading.readDataToEndOfFile())
        }
        process = nil
        if isRunning {
            phase = status == 0 ? phase : .failed(message: "Setup stopped unexpectedly (exit \(status)).")
        }
    }
}

private extension TentacleSetupRunner.Phase {
    var isWaitingForGitHub: Bool {
        if case .waitingForGitHub = self { return true }
        return false
    }
}

#endif
