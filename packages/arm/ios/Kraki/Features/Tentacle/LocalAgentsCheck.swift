/// LocalAgentsCheck — runs `kraki agents --json` from the built-in tentacle to
/// show which coding agents on this Mac can run a session: installed, signed
/// in, and able to list models. Read-only: Kraki reports problems with a hint,
/// it never changes an agent's own setup.

#if os(macOS)
import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class LocalAgentsCheck {
    enum Status: String, Equatable {
        case checking
        case ready
        case needsLogin = "needs_login"
        case notInstalled = "not_installed"
        case error
    }

    struct Agent: Identifiable, Equatable {
        let id: String
        var name: String
        var status: Status
        var version: String?
        var models = 0
        var sampleModels: [String] = []
        var hint: String?
        var installURL: URL?
    }

    /// The four agents Kraki supports, in display order, before any result.
    static let placeholders: [Agent] = [
        Agent(id: "claude", name: "Claude Code", status: .checking),
        Agent(id: "codex", name: "Codex", status: .checking),
        Agent(id: "copilot", name: "GitHub Copilot CLI", status: .checking),
        Agent(id: "pi", name: "Pi", status: .checking),
    ]

    private(set) var agents: [Agent] = LocalAgentsCheck.placeholders
    private(set) var isRunning = false
    private(set) var failure: String?

    var readyCount: Int { displayedAgents.filter { $0.status == .ready }.count }

    /// Agents this Mac's running Kraki already serves, with their model count.
    /// The daemon is the ground truth: a one-off check can miss an agent that
    /// is working (e.g. its sign-in lives in a Keychain item that a second,
    /// short-lived process could not read right after login).
    var running: [String: Int] = [:]

    /// `agents` with anything the running daemon serves shown as ready.
    var displayedAgents: [Agent] { Self.merging(agents, running: running) }

    static func merging(_ agents: [Agent], running: [String: Int]) -> [Agent] {
        agents.map { agent in
            guard let models = running[agent.id], models > 0,
                  agent.status == .needsLogin || agent.status == .error else { return agent }
            var a = agent
            a.status = .ready
            a.models = models
            a.hint = nil
            return a
        }
    }

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var buffer = Data()

    /// Apply one NDJSON line. Pure for testing.
    static func apply(line: String, to agents: [Agent]) -> [Agent] {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["event"] as? String == "agent",
              let id = json["id"] as? String else { return agents }
        var result = Agent(
            id: id,
            name: json["name"] as? String ?? id,
            status: Status(rawValue: json["status"] as? String ?? "") ?? .error,
            version: json["version"] as? String,
            models: json["models"] as? Int ?? 0,
            sampleModels: json["sampleModels"] as? [String] ?? [],
            hint: json["hint"] as? String,
            installURL: (json["installUrl"] as? String).flatMap(URL.init(string:))
        )
        var next = agents
        if let i = next.firstIndex(where: { $0.id == id }) {
            if result.name.isEmpty { result.name = next[i].name }
            next[i] = result
        } else {
            next.append(result)
        }
        return next
    }

    #if DEBUG
    /// Fixed results for previews and snapshot tests.
    static func preview(_ agents: [Agent]) -> LocalAgentsCheck {
        let check = LocalAgentsCheck()
        check.agents = agents
        check.previewOnly = true
        return check
    }
    #endif
    @ObservationIgnored private(set) var previewOnly = false

    func run(binaryPath: String) {
        guard !previewOnly else { return }
        cancel()
        agents = Self.placeholders
        failure = nil
        isRunning = true
        buffer = Data()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.arguments = ["agents", "--json"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            Task { @MainActor [weak self] in self?.consume(chunk) }
        }
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in self?.finished(proc) }
        }
        do {
            try process.run()
            self.process = process
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            isRunning = false
            failure = "Couldn't check the agents on this Mac: \(error.localizedDescription)"
        }
    }

    func cancel() {
        if let process, process.isRunning { process.terminate() }
        process = nil
        isRunning = false
    }

    private func consume(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if let line = String(data: lineData, encoding: .utf8) {
                agents = Self.apply(line: line, to: agents)
            }
        }
    }

    private func finished(_ finished: Process) {
        guard finished === process else { return }
        if let pipe = finished.standardOutput as? Pipe {
            pipe.fileHandleForReading.readabilityHandler = nil
            consume(pipe.fileHandleForReading.readDataToEndOfFile())
        }
        process = nil
        isRunning = false
        // Anything still "checking" never reported back.
        agents = agents.map { agent in
            guard agent.status == .checking else { return agent }
            var a = agent
            a.status = .error
            a.hint = "Couldn't check \(agent.name)."
            return a
        }
    }
}

#endif
