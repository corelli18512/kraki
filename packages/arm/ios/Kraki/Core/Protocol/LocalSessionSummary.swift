#if os(iOS)
/// Lightweight descriptor of a session that exists on a tentacle's
/// local filesystem (Copilot CLI, VS Code, etc.) but has not yet been
/// imported into Kraki. Sent by the tentacle in `local_sessions_list`
/// responses; consumed by the import picker.
///
/// Mirrors `packages/protocol/src/sessions.ts: LocalSession`.

import Foundation

enum LocalSessionSource: String, Codable, Sendable {
    case copilotCli = "copilot-cli"
    case vscode
    case unknown
}

struct LocalSessionSummary: Identifiable, Equatable, Sendable {
    let sessionId: String
    let cwd: String
    let gitRoot: String?
    let repository: String?
    let branch: String?
    let summary: String?
    let model: String?
    let startTime: String
    let modifiedTime: String
    let isLive: Bool
    let source: LocalSessionSource
    /// If set, this local session has already been imported into Kraki
    /// under the listed Kraki session id.
    let linkedKrakiSessionId: String?

    var id: String { sessionId }

    /// Parse from a raw dictionary as decoded from JSON inside the
    /// `local_sessions_list` payload. Returns nil if required fields
    /// are missing.
    static func from(_ dict: [String: Any]) -> LocalSessionSummary? {
        guard let sessionId = dict["sessionId"] as? String,
              let cwd = dict["cwd"] as? String,
              let startTime = dict["startTime"] as? String,
              let modifiedTime = dict["modifiedTime"] as? String else {
            return nil
        }
        let sourceRaw = dict["source"] as? String ?? "unknown"
        return LocalSessionSummary(
            sessionId: sessionId,
            cwd: cwd,
            gitRoot: dict["gitRoot"] as? String,
            repository: dict["repository"] as? String,
            branch: dict["branch"] as? String,
            summary: dict["summary"] as? String,
            model: dict["model"] as? String,
            startTime: startTime,
            modifiedTime: modifiedTime,
            isLive: dict["isLive"] as? Bool ?? false,
            source: LocalSessionSource(rawValue: sourceRaw) ?? .unknown,
            linkedKrakiSessionId: dict["linkedKrakiSessionId"] as? String
        )
    }
}
#endif
