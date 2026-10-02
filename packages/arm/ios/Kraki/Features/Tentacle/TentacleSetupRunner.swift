/// TentacleSetupRunner — drives `kraki setup --json` from the built-in
/// tentacle so a new user signs in and configures this Mac without Terminal.
///
/// The tentacle streams NDJSON events (see packages/tentacle/src/setup-json.ts):
/// start → oauth_url | device_code → authenticated → relay → done | error.
/// Cancelling terminates the process; the tentacle writes config only at the
/// very end, so a cancelled run leaves nothing behind.
///
/// Sign-in is one click: the tentacle hands us a GitHub authorize URL (PKCE,
/// verifier kept in the tentacle), we open it in the system web-auth window
/// (the user's Safari session, so a signed-in user just approves), and pass
/// the kraki:// callback back on stdin. If the server predates browser sign-in
/// (`oauth_unavailable`) we rerun with the device code, as before.

#if os(macOS)
import AppKit
import AuthenticationServices
import Foundation
import Observation

@MainActor
@Observable
final class TentacleSetupRunner {
    enum Phase: Equatable {
        case idle
        case starting
        /// The system sign-in window is open on GitHub.
        case waitingForBrowser
        case waitingForGitHub(userCode: String, verificationURL: URL)
        case configuring(username: String)
        case done(username: String)
        case failed(message: String)
    }

    private(set) var phase: Phase = .idle

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var stdin: FileHandle?
    @ObservationIgnored private var buffer = Data()
    @ObservationIgnored private var webAuth: ASWebAuthenticationSession?
    @ObservationIgnored private let webAuthAnchor = WebAuthAnchor()
    @ObservationIgnored private var lastStart: (binaryPath: String, deviceName: String?, forceLogin: Bool)?

    var isRunning: Bool {
        switch phase {
        case .starting, .waitingForBrowser, .waitingForGitHub, .configuring: return true
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
        case "oauth_url":
            return .waitingForBrowser
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
            if json["code"] as? String == "cancelled" { return .idle }
            return .failed(message: json["message"] as? String ?? "Setup failed.")
        default:
            return nil
        }
    }

    /// - Parameter useBrowser: one-click sign-in in the system web-auth
    ///   window; false shows a GitHub device code instead.
    func start(binaryPath: String, deviceName: String? = nil, forceLogin: Bool = false, useBrowser: Bool = true) {
        cancel()
        phase = .starting
        buffer = Data()
        lastStart = (binaryPath, deviceName, forceLogin)

        var args = ["setup", "--json"]
        if useBrowser { args.append("--oauth") }
        if let deviceName, !deviceName.isEmpty { args += ["--device-name", deviceName] }
        if forceLogin { args.append("--force-login") }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.arguments = args
        let out = Pipe()
        let input = Pipe()
        process.standardOutput = out
        process.standardInput = input
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
            // Writing after the tentacle exited must not SIGPIPE the app.
            _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
            self.stdin = input.fileHandleForWriting
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            phase = .failed(message: "Could not start Kraki on this Mac: \(error.localizedDescription)")
        }
    }

    /// Rerun sign-in with a GitHub device code (fallback, or user's choice).
    func startWithCode() {
        guard let last = lastStart else { return }
        start(binaryPath: last.binaryPath, deviceName: last.deviceName, forceLogin: last.forceLogin, useBrowser: false)
    }

    func cancel() {
        webAuth?.cancel()
        webAuth = nil
        try? stdin?.close()
        stdin = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
        if isRunning { phase = .idle }
    }

    /// Bring the sign-in window back if the user lost it behind other windows.
    func reopenBrowser() {
        guard case .waitingForBrowser = phase, let pending = pendingAuthURL else { return }
        webAuth?.cancel()
        openWebAuth(url: pending.url, scheme: pending.scheme)
    }

    @ObservationIgnored private var pendingAuthURL: (url: URL, scheme: String)?

    private func openWebAuth(url: URL, scheme: String) {
        pendingAuthURL = (url, scheme)
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
            Task { @MainActor [weak self] in self?.webAuthFinished(callback: callback, error: error) }
        }
        session.presentationContextProvider = webAuthAnchor
        // Use the browser's existing session: a user already signed in to
        // GitHub only has to approve (or nothing, if Kraki was approved before).
        session.prefersEphemeralWebBrowserSession = false
        webAuth = session
        if !session.start() {
            webAuth = nil
            // No web-auth window available: fall back to the device code.
            startWithCode()
        }
    }

    private func webAuthFinished(callback: URL?, error: Error?) {
        webAuth = nil
        guard case .waitingForBrowser = phase else { return }
        if let callback, let data = (callback.absoluteString + "\n").data(using: .utf8) {
            try? stdin?.write(contentsOf: data)
            return
        }
        // Closed or cancelled: EOF makes the tentacle exit with "cancelled".
        _ = error
        try? stdin?.close()
        stdin = nil
    }

    /// `oauth_url` event → the authorize URL and callback scheme. Pure for testing.
    static func oauthRequest(line: String) -> (URL, String)? {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["event"] as? String == "oauth_url",
              let raw = json["url"] as? String, let url = URL(string: raw),
              url.scheme == "https", url.host == "github.com" else { return nil }
        return (url, json["callbackScheme"] as? String ?? "kraki")
    }

    /// True when the server cannot do browser sign-in yet. Pure for testing.
    static func oauthFallback(line: String) -> Bool? {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["event"] as? String == "error" else { return nil }
        return json["code"] as? String == "oauth_unavailable"
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
            if let fallback = Self.oauthFallback(line: line), fallback {
                // Server predates browser sign-in: show a device code instead.
                startWithCode()
                return
            }
            if let (url, scheme) = Self.oauthRequest(line: line) {
                phase = .waitingForBrowser
                openWebAuth(url: url, scheme: scheme)
                continue
            }
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
        try? stdin?.close()
        stdin = nil
        webAuth?.cancel()
        webAuth = nil
        if isRunning {
            phase = status == 0 ? phase : .failed(message: "Setup stopped unexpectedly (exit \(status)).")
        }
    }
}

/// Presents the web-auth window over Kraki's key window.
private final class WebAuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first ?? NSWindow()
    }
}

private extension TentacleSetupRunner.Phase {
    var isWaitingForGitHub: Bool {
        if case .waitingForGitHub = self { return true }
        return false
    }
}

#endif
