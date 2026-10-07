import Foundation

/// Subagent structure of a turn's TRACE steps (protocol `SubagentInfo`),
/// shared by iOS and Mac and mirroring web `lib/subagent-steps.ts`:
///  - tool_start → tool_complete merge by toolCallId; a later tool_complete
///    for the same id replaces an earlier one (a background subagent completes
///    twice: launch receipt, then its report).
///  - steps carrying `parentToolCallId` belong to that subagent's page.
///  - a step carrying `subagent` (or with steps under it) opens a page.
struct SubagentInfo: Equatable {
    enum Status: String { case running, completed, failed, stopped }
    var name: String
    var task: String?
    var status: Status?
    var tokens: Int?
    var toolCount: Int?
    var durationMs: Int?

    init(name: String, task: String? = nil, status: Status? = nil, tokens: Int? = nil, toolCount: Int? = nil, durationMs: Int? = nil) {
        self.name = name; self.task = task; self.status = status
        self.tokens = tokens; self.toolCount = toolCount; self.durationMs = durationMs
    }

    init?(_ value: AnyCodable?) {
        guard let dict = value?.dictValue, let name = dict["name"]?.stringValue else { return nil }
        self.init(
            name: name,
            task: dict["task"]?.stringValue,
            status: dict["status"]?.stringValue.flatMap(Status.init(rawValue:)),
            tokens: dict["tokens"]?.intValue,
            toolCount: dict["toolCount"]?.intValue,
            durationMs: dict["durationMs"]?.intValue
        )
    }

    /// Later fields win; absent ones keep the earlier value.
    func merged(with later: SubagentInfo) -> SubagentInfo {
        SubagentInfo(
            name: later.name,
            task: later.task ?? task,
            status: later.status ?? status,
            tokens: later.tokens ?? tokens,
            toolCount: later.toolCount ?? toolCount,
            durationMs: later.durationMs ?? durationMs
        )
    }

    var asPayload: AnyCodable {
        var d: [String: Any] = ["name": name]
        if let task { d["task"] = task }
        if let status { d["status"] = status.rawValue }
        if let tokens { d["tokens"] = tokens }
        if let toolCount { d["toolCount"] = toolCount }
        if let durationMs { d["durationMs"] = durationMs }
        return AnyCodable(d)
    }
}

enum SubagentSteps {
    static func parent(of m: ChatMessage) -> String? {
        m.payload["parentToolCallId"]?.stringValue
    }

    static func info(of m: ChatMessage) -> SubagentInfo? {
        SubagentInfo(m.payload["subagent"])
    }

    private static func isTool(_ m: ChatMessage) -> Bool {
        m.type == "tool_start" || m.type == "tool_complete"
    }

    /// Merge tool lifecycles in recorded order. A tool sits where it started;
    /// its latest tool_complete (if any) is what shows, with subagent info
    /// accumulated across the lifecycle.
    static func merge(_ steps: [ChatMessage]) -> [ChatMessage] {
        var output: [ChatMessage] = []
        var index: [String: Int] = [:]
        for message in steps.sorted(by: { $0.seq < $1.seq }) {
            guard isTool(message), let callId = message.toolCallId, !callId.isEmpty else {
                output.append(message)
                continue
            }
            guard let at = index[callId] else {
                index[callId] = output.count
                output.append(message)
                continue
            }
            let previous = output[at]
            // A late tool_start never replaces what already completed.
            if message.type == "tool_start" && previous.type == "tool_complete" { continue }
            var next = message
            switch (info(of: previous), info(of: message)) {
            case let (earlier?, later?): next.payload["subagent"] = earlier.merged(with: later).asPayload
            case let (earlier?, nil): next.payload["subagent"] = earlier.asPayload
            default: break
            }
            output[at] = next
        }
        return output
    }

    /// Steps on one page: the turn's own (`parent == nil`) or one subagent's.
    /// A step whose parent is not in this trace shows at the top level.
    static func steps(_ merged: [ChatMessage], under parent: String?) -> [ChatMessage] {
        let ids = Set(merged.compactMap { $0.toolCallId })
        return merged.filter { m in
            let p = Self.parent(of: m)
            if let parent { return p == parent }
            guard let p else { return true }
            return !ids.contains(p)
        }
    }

    static func isSubagentStep(_ merged: [ChatMessage], _ m: ChatMessage) -> Bool {
        guard isTool(m) else { return false }
        if info(of: m) != nil { return true }
        guard let id = m.toolCallId else { return false }
        return merged.contains { parent(of: $0) == id }
    }

    /// Tool steps the subagent itself took (nested subagents not counted).
    static func stepCount(_ merged: [ChatMessage], _ id: String) -> Int {
        merged.filter { parent(of: $0) == id && isTool($0) && !isSubagentStep(merged, $0) }.count
    }

    /// Subagents started under this one (a group dispatch, or nesting).
    static func childSubagentCount(_ merged: [ChatMessage], _ id: String) -> Int {
        merged.filter { parent(of: $0) == id && isSubagentStep(merged, $0) }.count
    }

    /// "3 steps" / "2 subagents" / "1 subagent · 2 steps".
    static func contentsLabel(_ merged: [ChatMessage], _ id: String) -> String? {
        let steps = stepCount(merged, id)
        let subs = childSubagentCount(merged, id)
        let parts = [
            subs > 0 ? "\(subs) subagent\(subs == 1 ? "" : "s")" : nil,
            steps > 0 ? "\(steps) step\(steps == 1 ? "" : "s")" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func hasSteps(_ merged: [ChatMessage], _ id: String) -> Bool {
        merged.contains { parent(of: $0) == id }
    }

    static func status(of m: ChatMessage) -> SubagentInfo.Status {
        if let s = info(of: m)?.status, s != .running { return s }
        if m.type == "tool_start" { return m.cancelled ? .stopped : .running }
        let termination = m.payload["termination"]?.stringValue
        if termination == "cancelled" { return .stopped }
        if m.payload["success"]?.boolValue == false || termination != nil { return .failed }
        return info(of: m)?.status ?? .completed
    }

    static func formatDuration(_ ms: Int?) -> String? {
        guard let ms else { return nil }
        let s = Int((Double(ms) / 1000).rounded())
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }

    static func formatTokens(_ n: Int?) -> String? {
        guard let n else { return nil }
        if n < 1000 { return "\(n) tokens" }
        let k = Double(n) / 1000
        return n >= 10_000 ? "\(Int(k.rounded()))k tokens" : String(format: "%.1fk tokens", k)
    }

    /// Card meta line: "Running · 3 steps · 12s".
    static func cardMeta(_ merged: [ChatMessage], _ m: ChatMessage) -> String {
        [
            status(of: m) == .running ? "Running" : nil,
            m.toolCallId.flatMap { contentsLabel(merged, $0) },
            formatDuration(info(of: m)?.durationMs),
        ].compactMap { $0 }.joined(separator: " · ")
    }

    /// Subagent page facts: "Done · 3 steps · 12s · 1.2k tokens".
    static func pageFacts(_ merged: [ChatMessage], _ m: ChatMessage) -> String {
        let state: String
        switch status(of: m) {
        case .running: state = "Running"
        case .failed: state = "Failed"
        case .stopped: state = "Stopped"
        case .completed: state = "Done"
        }
        return [
            state,
            m.toolCallId.flatMap { contentsLabel(merged, $0) },
            formatDuration(info(of: m)?.durationMs),
            formatTokens(info(of: m)?.tokens),
        ].compactMap { $0 }.joined(separator: " · ")
    }
}
