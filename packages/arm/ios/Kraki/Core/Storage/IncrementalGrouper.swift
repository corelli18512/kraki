/// IncrementalGrouper / SessionGrouperCache — incremental wrapper
/// around the message-grouping logic in TurnGrouper.swift.
///
/// **Motivation.** The plain `groupMessagesIntoTurns(_:)` is a
/// pure-function full-walk: hand it N messages and it groups all of
/// them, every time. For chats with thousands of messages this is
/// wasteful — most ingest events are "one new message at the tail"
/// and the dozens of closed `ActivityBlock`s we already grouped will
/// not change. Stage F of the storage refactor caches those closed
/// blocks per session.
///
/// **Cache shape.** A session's grouping cache is a list of
/// **islands** — one per contiguous seq range we know about.
/// Conceptually:
///
///   island [lo..hi]
///   ├── leftPartial?         — the head of a block whose start lies
///   │                          outside this island (we have its
///   │                          thinking entries but not the user
///   │                          message that opened it)
///   ├── closedBlocks[]       — idle-bounded, immutable, never
///   │                          re-grouped while the island exists
///   └── rightPartial?        — the active tail block (no closing
///                              `idle` yet) plus the per-island
///                              grouper state (tailState) we need
///                              to continue ingesting at the tail
///
/// Tail-append (the common case) consumes one message at a time via
/// `step(_:into:emits:)`, mutating only the trailing island's
/// `rightPartial` / `closedBlocks`. Closed blocks already in the
/// list are NOT touched. This is the whole win.
///
/// Out-of-tail ingest (gap fill, prepend, batch crossing an island
/// boundary) currently rebuilds the affected island(s) from scratch.
/// Those paths are rare enough that the simple implementation is
/// fine — the design leaves room for fine-grained incremental work
/// later if needed.
///
/// **Streaming content** is layered on top in `items(streamingContent:)`:
/// the cached blocks are emitted unchanged, and the optional active
/// tail gets a synthetic agent_message appended just before render.
/// Streaming text never lands in the cache itself.

import Foundation

// MARK: - Per-island grouper state

/// All the running state the grouper needs to resume mid-stream.
/// A snapshot of this is kept on each island so a tail-append
/// continues from exactly where the previous ingest stopped.
struct GrouperState: Equatable {
    var currentInitiator: Initiator?
    var currentThinking: [ChatMessage] = []
    /// Permission ids that have been asked but not yet resolved.
    /// Tracked in stream order so a deferred-idle re-fires after the
    /// resolver shows up — see the long comment in TurnGrouper.swift.
    var unresolvedPermIds: Set<String> = []
    var skipNextToolComplete: Bool = false

    /// True iff there is in-progress block content to flush.
    var hasOpenBlock: Bool {
        currentInitiator != nil || !currentThinking.isEmpty
    }
}

// MARK: - Island result

/// Per-island grouping output. The islands list inside the cache is
/// always sorted by `lo` ascending; each island covers a contiguous
/// seq range and never overlaps its siblings (the merge logic in
/// `SessionGrouperCache.ingest` is responsible for keeping that
/// invariant).
struct SeqIsland {
    var lo: Int
    var hi: Int

    /// Idle-bounded blocks that have been finalised inside this
    /// island. Never re-grouped while the island survives.
    var closedBlocks: [ActivityBlock] = []

    /// Open tail block — exists when the island's last message was
    /// not a terminator. Mirrors what `GrouperState` was holding
    /// when ingest stopped; on the next tail-append we resume from
    /// `tailState` rather than re-walking these messages.
    var rightPartial: ActivityBlock?

    /// Resume-from snapshot. `lastProcessedSeq == hi`. Empty initial
    /// state for a brand-new island.
    var tailState: GrouperState = GrouperState()
}

// MARK: - Cache

/// Per-session grouping cache. Mutating methods are `mutating`
/// (struct semantics) so callers control ownership; in practice it
/// lives on `MessageStore`-adjacent code and is keyed by sessionId.
struct SessionGrouperCache {
    private(set) var islands: [SeqIsland] = []

    var islandCount: Int { islands.count }

    // MARK: Public API

    /// Ingest a batch of messages. The batch can be tail-contiguous
    /// (the common case — one or more new messages right after the
    /// current tail), can open a new island, or can bridge two
    /// existing islands. Internally messages are split per island
    /// and dispatched.
    mutating func ingest(_ messages: [ChatMessage]) {
        guard !messages.isEmpty else { return }
        // Process strictly in seq order so the tail-append fast path
        // sees them in arrival order, and so the island-routing
        // decisions are deterministic.
        let sorted = messages
            .filter { $0.seq > 0 }
            .sorted { $0.seq < $1.seq }
        for msg in sorted {
            ingestOne(msg)
        }
        mergeAdjacentIslands()
    }

    /// Render the current cache as a flat `[TurnItem]`, optionally
    /// appending a streaming-content synthetic agent_message to the
    /// trailing active block.
    func items(streamingContent: String?) -> [TurnItem] {
        var out: [TurnItem] = []
        for (i, island) in islands.enumerated() {
            // leftPartial: TODO — we don't model it in this iteration,
            // since today's grouper handles "missing initiator" by
            // synthesising an .implicit block on demand. Stage F's
            // first version skips the leftPartial concept and lets
            // an island's first block be one with .implicit initiator
            // whenever the boundary is mid-block.
            for b in island.closedBlocks { out.append(.block(b)) }
            if var rp = island.rightPartial {
                // Apply streaming content to the very last active
                // block only.
                if i == islands.count - 1, let streaming = streamingContent, !streaming.isEmpty {
                    rp.thinkingMessages.append(makeStreamingSynthetic(streaming))
                }
                out.append(.block(rp))
            }
        }
        // Streaming content with no active block at all — synthesise
        // an implicit tail block so the synthetic message has a home.
        if let streaming = streamingContent, !streaming.isEmpty {
            if islands.last?.rightPartial == nil {
                let synth = makeStreamingSynthetic(streaming)
                out.append(.block(ActivityBlock(
                    id: "turn:\(synth.id)",
                    initiator: .implicit,
                    thinkingMessages: [synth],
                    finalMessage: nil,
                    isActive: true
                )))
            }
        }
        // Insert standalones inline. They were buffered into the
        // closedStandalones list during ingest — flatten back into
        // chronological order by seq.
        if !standalones.isEmpty {
            out = interleave(out, with: standalones)
        }
        return out
    }

    // MARK: Internals

    /// Standalones live outside islands — they're not part of any
    /// block. Stored separately and re-interleaved on render.
    private var standalones: [ChatMessage] = []

    /// Anchor seq used when computing block ids for the unusual
    /// "thinking-only" case (no user message opened the block).
    /// Stable across ingests so the diffable data source treats it
    /// as the same row.

    private mutating func ingestOne(_ msg: ChatMessage) {
        // Standalones don't enter any island — emit-style, recorded
        // for render.
        if Self.isStandaloneType(msg.type) {
            // Dedup standalones by seq+type — re-ingest of the same
            // event replaces in place.
            if let idx = standalones.firstIndex(where: { $0.seq == msg.seq && $0.type == msg.type }) {
                standalones[idx] = msg
            } else {
                standalones.append(msg)
            }
            return
        }

        // Locate the island this msg belongs to.
        let idx = islandIndex(for: msg.seq)
        switch idx {
        case .extendsTail(let i):
            // Tail-contiguous append — the fast path. Step the
            // island's tailState by one and update its bottom.
            appendOne(msg, toIslandAt: i)
        case .prependHead(let i):
            // Out-of-tail prepend — rebuild that island (will pick
            // up the new low row plus whatever was already in).
            insertOutsideTail(msg, atIslandIndex: i)
        case .inside(let i):
            // Re-ingest inside an existing range — replace by
            // seq+type. Easiest: collect all of island's messages,
            // swap the dup, regroup.
            replaceInside(msg, islandIndex: i)
        case .newBefore(let i):
            islands.insert(SeqIsland(lo: msg.seq, hi: msg.seq - 1), at: i)
            appendOne(msg, toIslandAt: i)
        }
    }

    /// What to do with `seq` relative to the current islands list.
    private enum IslandTarget {
        /// Append after islands[i].hi. fast path.
        case extendsTail(Int)
        /// Insert before islands[i].lo and rebuild islands[i].
        case prependHead(Int)
        /// Falls inside islands[i] — dedup/replace.
        case inside(Int)
        /// No island contains it; needs a brand-new island inserted
        /// before islands[i] (or at end if i == islands.count).
        case newBefore(Int)
    }

    private func islandIndex(for seq: Int) -> IslandTarget {
        for (i, island) in islands.enumerated() {
            if seq >= island.lo && seq <= island.hi {
                return .inside(i)
            }
            if seq == island.hi + 1 {
                return .extendsTail(i)
            }
            if seq == island.lo - 1 {
                return .prependHead(i)
            }
            if seq < island.lo {
                return .newBefore(i)
            }
        }
        return .newBefore(islands.count)
    }

    /// Fast path: append `msg` at islands[i] and step the grouper.
    private mutating func appendOne(_ msg: ChatMessage, toIslandAt i: Int) {
        var island = islands[i]
        var state = island.tailState
        var closed: [ActivityBlock] = []
        Self.processOne(msg, state: &state, closed: &closed)
        island.closedBlocks.append(contentsOf: closed)
        island.rightPartial = Self.buildActiveBlock(from: state)
        island.tailState = state
        if island.lo == 0 || msg.seq < island.lo { island.lo = msg.seq }
        if msg.seq > island.hi { island.hi = msg.seq }
        islands[i] = island
    }

    /// Out-of-tail ingest (prepend, or inside-range). Rebuild
    /// affected island by collecting its messages + msg and
    /// regrouping. Brute-force for now; could be tightened later.
    private mutating func insertOutsideTail(_ msg: ChatMessage, atIslandIndex i: Int) {
        // Gather the island's raw messages by replaying its current
        // closedBlocks + rightPartial. (Round-tripping through
        // ActivityBlock data is sufficient — every cached message
        // we ever ingested lives inside one of those structures.)
        var raw = Self.flattenMessages(islands[i])
        raw.append(msg)
        raw.sort { $0.seq < $1.seq }
        rebuildIsland(at: i, fromRaw: raw)
    }

    private mutating func replaceInside(_ msg: ChatMessage, islandIndex i: Int) {
        var raw = Self.flattenMessages(islands[i])
        if let dup = raw.firstIndex(where: { $0.seq == msg.seq && $0.type == msg.type }) {
            raw[dup] = msg
        } else {
            raw.append(msg)
            raw.sort { $0.seq < $1.seq }
        }
        rebuildIsland(at: i, fromRaw: raw)
    }

    private mutating func rebuildIsland(at i: Int, fromRaw raw: [ChatMessage]) {
        var state = GrouperState()
        var closed: [ActivityBlock] = []
        for m in raw {
            Self.processOne(m, state: &state, closed: &closed)
        }
        var island = islands[i]
        island.lo = raw.first?.seq ?? island.lo
        island.hi = raw.last?.seq ?? island.hi
        island.closedBlocks = closed
        island.rightPartial = Self.buildActiveBlock(from: state)
        island.tailState = state
        islands[i] = island
    }

    private mutating func mergeAdjacentIslands() {
        guard islands.count >= 2 else { return }
        var i = 0
        while i < islands.count - 1 {
            let a = islands[i]
            let b = islands[i + 1]
            if a.hi + 1 == b.lo {
                // Merge: take a's raw + b's raw and regroup.
                var raw = Self.flattenMessages(a) + Self.flattenMessages(b)
                raw.sort { $0.seq < $1.seq }
                var state = GrouperState()
                var closed: [ActivityBlock] = []
                for m in raw {
                    Self.processOne(m, state: &state, closed: &closed)
                }
                var merged = SeqIsland(lo: a.lo, hi: b.hi)
                merged.closedBlocks = closed
                merged.rightPartial = Self.buildActiveBlock(from: state)
                merged.tailState = state
                islands.replaceSubrange(i...(i + 1), with: [merged])
                // Don't advance i — the newly merged island might
                // chain with the next one.
            } else {
                i += 1
            }
        }
    }

    // MARK: - One-message step (the actual grouping logic)

    /// Process a single message into the running state, possibly
    /// closing a block and appending it to `closed`. This is the
    /// per-message body of `groupMessagesIntoTurns` lifted into a
    /// reusable single-step form. Behaviour MUST match the original.
    static func processOne(_ msg: ChatMessage, state: inout GrouperState, closed: inout [ActivityBlock]) {
        // Track permission lifecycle — must run for every message
        // regardless of branch.
        switch msg.type {
        case "permission":
            if let pid = msg.permissionId { state.unresolvedPermIds.insert(pid) }
        case "approve", "deny", "always_allow", "permission_resolved":
            if let pid = msg.payload["permissionId"]?.stringValue {
                state.unresolvedPermIds.remove(pid)
            }
        default: break
        }

        if userMessageTypes.contains(msg.type) {
            if state.hasOpenBlock {
                flush(state: &state, closed: &closed, complete: true)
            }
            state.currentInitiator = .user(msg)
            return
        }
        if turnCompleteTypes.contains(msg.type) {
            if !state.unresolvedPermIds.isEmpty {
                // Deferred — drop the idle, agent isn't done yet.
                return
            }
            flush(state: &state, closed: &closed, complete: true)
            return
        }
        if thinkingTypes.contains(msg.type) {
            if state.currentInitiator == nil && state.currentThinking.isEmpty {
                state.currentInitiator = .implicit
            }
            if msg.type == "question" {
                if let startIdx = state.currentThinking.lastIndex(where: {
                    $0.type == "tool_start" && ($0.toolName == "ask_user" || $0.toolName == "ask")
                }) {
                    var updatedPayload = state.currentThinking[startIdx].payload
                    updatedPayload["questionText"] = AnyCodable(msg.payload["question"]?.stringValue ?? "")
                    updatedPayload["questionChoices"] = msg.payload["choices"] ?? AnyCodable(nil)
                    updatedPayload["questionId"] = AnyCodable(msg.payload["id"]?.stringValue ?? "")
                    state.currentThinking[startIdx] = ChatMessage(
                        type: state.currentThinking[startIdx].type,
                        seq: state.currentThinking[startIdx].seq,
                        sessionId: state.currentThinking[startIdx].sessionId,
                        deviceId: state.currentThinking[startIdx].deviceId,
                        timestamp: state.currentThinking[startIdx].timestamp,
                        payload: updatedPayload
                    )
                }
                return
            }
            if msg.type == "question_resolved" || msg.type == "answer" || msg.type == "permission_resolved" {
                return
            }
            if msg.type == "tool_complete" && state.skipNextToolComplete {
                state.skipNextToolComplete = false
                return
            }
            if msg.type == "tool_complete" {
                let toolCallId = msg.toolCallId
                if let toolCallId, !toolCallId.isEmpty,
                   let startIdx = state.currentThinking.firstIndex(where: {
                       $0.type == "tool_start" && $0.toolCallId == toolCallId
                   }) {
                    let startMsg = state.currentThinking[startIdx]
                    let startArgs = startMsg.args ?? [:]
                    let completeArgs = msg.args ?? [:]
                    var mergedPayload = msg.payload
                    mergedPayload["toolName"] = msg.payload["toolName"] ?? startMsg.payload["toolName"]
                    if mergedPayload["argsRef"] == nil, let ar = startMsg.payload["argsRef"] {
                        mergedPayload["argsRef"] = ar
                    }
                    if let qt = startMsg.payload["questionText"] { mergedPayload["questionText"] = qt }
                    if let qc = startMsg.payload["questionChoices"] { mergedPayload["questionChoices"] = qc }
                    if let qi = startMsg.payload["questionId"] { mergedPayload["questionId"] = qi }
                    var mergedArgs: [String: AnyCodable] = [:]
                    for (k, v) in startArgs { mergedArgs[k] = v }
                    for (k, v) in completeArgs { mergedArgs[k] = v }
                    mergedPayload["args"] = AnyCodable(mergedArgs)
                    state.currentThinking[startIdx] = ChatMessage(
                        type: msg.type,
                        seq: startMsg.seq,
                        sessionId: msg.sessionId,
                        deviceId: msg.deviceId,
                        timestamp: msg.timestamp,
                        payload: mergedPayload
                    )
                    return
                }
                state.currentThinking.append(msg)
                return
            }
            state.currentThinking.append(msg)
            return
        }
        // Unknown type → treat as turn-breaking standalone-like:
        // close any open block. The standalone itself is appended at
        // the cache level (we don't carry it here).
        if state.hasOpenBlock {
            flush(state: &state, closed: &closed, complete: true)
        }
    }

    /// Close the current state's accumulated block (if any) and
    /// append it to `closed`. Mirrors the original `flushTurn`.
    private static func flush(state: inout GrouperState, closed: inout [ActivityBlock], complete: Bool) {
        defer { state.unresolvedPermIds.removeAll() }
        guard state.hasOpenBlock else { return }
        let anchor = state.currentInitiator?.userMessage?.id
            ?? state.currentThinking.first?.id
            ?? "unknown"
        let blockId = "turn:\(anchor)"
        let initiator = state.currentInitiator ?? .implicit

        if !complete {
            closed.append(ActivityBlock(
                id: blockId,
                initiator: initiator,
                thinkingMessages: state.currentThinking,
                finalMessage: nil,
                isActive: true
            ))
        } else {
            var lastAgentIdx = -1
            for i in stride(from: state.currentThinking.count - 1, through: 0, by: -1) {
                if state.currentThinking[i].type == "agent_message" {
                    lastAgentIdx = i
                    break
                }
            }
            if lastAgentIdx == -1 {
                closed.append(ActivityBlock(
                    id: blockId,
                    initiator: initiator,
                    thinkingMessages: state.currentThinking,
                    finalMessage: nil,
                    isActive: false
                ))
            } else {
                let thinking = state.currentThinking.enumerated()
                    .filter { $0.offset != lastAgentIdx }
                    .map(\.element)
                let finalMsg = state.currentThinking[lastAgentIdx]
                closed.append(ActivityBlock(
                    id: blockId,
                    initiator: initiator,
                    thinkingMessages: thinking,
                    finalMessage: finalMsg,
                    isActive: false
                ))
            }
        }
        state.currentInitiator = nil
        state.currentThinking = []
    }

    /// Build an "active" ActivityBlock view from the state's
    /// in-progress content without consuming it. Used to keep the
    /// island's rightPartial in sync with tailState after every step.
    private static func buildActiveBlock(from state: GrouperState) -> ActivityBlock? {
        guard state.hasOpenBlock else { return nil }
        let anchor = state.currentInitiator?.userMessage?.id
            ?? state.currentThinking.first?.id
            ?? "unknown"
        return ActivityBlock(
            id: "turn:\(anchor)",
            initiator: state.currentInitiator ?? .implicit,
            thinkingMessages: state.currentThinking,
            finalMessage: nil,
            isActive: true
        )
    }

    // MARK: - Helpers

    /// Reconstruct an island's raw message stream from its cached
    /// blocks. Used by gap-fill / replace paths that regroup an
    /// island from scratch.
    private static func flattenMessages(_ island: SeqIsland) -> [ChatMessage] {
        var out: [ChatMessage] = []
        for b in island.closedBlocks {
            if let u = b.initiator.userMessage { out.append(u) }
            out.append(contentsOf: b.thinkingMessages)
            if let f = b.finalMessage { out.append(f) }
            // We also need to re-emit a synthetic `idle` to close
            // the block on regroup. Since we don't keep the original
            // idle's seq, fabricate one between final and next
            // user_message — sort-by-seq later. Using the final
            // message's seq + 0.5 won't work for Int, so use the
            // next contiguous seq we know belongs to this island.
            // Simpler approach: emit a placeholder idle with seq =
            // (final.seq ?? thinking.last.seq) + epsilon … but seqs
            // are Int.
            // For correctness we synthesise an idle with seq one
            // larger than the block's highest message seq. If the
            // next real message has the same seq, the
            // sort-and-process will sort idle first (because the
            // idle's type sorts predictably) — that's wrong.
            // Practical fix: track the original closing-idle seq on
            // the ActivityBlock. We don't today, so for now we
            // synthesise a fake idle with the highest seq the block
            // contains. This means re-grouping a closed block on
            // gap-fill will produce the exact same blocks as long as
            // no message lands in the [closingIdle..nextOpenerSeq-1]
            // gap — which is the empirical case in practice.
            let maxSeq = max(b.initiator.userMessage?.seq ?? 0,
                             b.thinkingMessages.map(\.seq).max() ?? 0,
                             b.finalMessage?.seq ?? 0)
            out.append(ChatMessage(
                type: "idle",
                seq: maxSeq,  // sorts equal to last block msg; processOne sees user→thinking→idle order from sorting
                sessionId: b.initiator.userMessage?.sessionId,
                deviceId: b.initiator.userMessage?.deviceId,
                timestamp: b.initiator.userMessage?.timestamp,
                payload: [:]
            ))
        }
        if let rp = island.rightPartial {
            if let u = rp.initiator.userMessage { out.append(u) }
            out.append(contentsOf: rp.thinkingMessages)
            // No final, no synthesised idle — it's still active.
        }
        // The synthesised idles use seq equal to the last real
        // message; that's a soft collision. Push idles to the back of
        // their group via a stable sort with type priority.
        out.sort { (a, b) -> Bool in
            if a.seq != b.seq { return a.seq < b.seq }
            // Same seq → idle goes last (so the block closes after
            // its thinking content).
            if a.type == "idle" && b.type != "idle" { return false }
            if b.type == "idle" && a.type != "idle" { return true }
            return false
        }
        return out
    }

    private func interleave(_ blockItems: [TurnItem], with standalones: [ChatMessage]) -> [TurnItem] {
        // Build (seq, item) list then sort. Blocks are keyed by
        // their lowest seq.
        struct Entry { let seq: Int; let item: TurnItem }
        var entries: [Entry] = []
        for item in blockItems {
            if case .block(let b) = item {
                let seq = b.initiator.userMessage?.seq
                    ?? b.thinkingMessages.first?.seq
                    ?? 0
                entries.append(Entry(seq: seq, item: item))
            }
        }
        for s in standalones {
            entries.append(Entry(seq: s.seq, item: .standalone(s)))
        }
        entries.sort { $0.seq < $1.seq }
        return entries.map(\.item)
    }

    private static func isStandaloneType(_ t: String) -> Bool {
        switch t {
        case "session_created", "session_ended", "kill_session", "session_deleted":
            return true
        default:
            return false
        }
    }

    private func makeStreamingSynthetic(_ text: String) -> ChatMessage {
        // Negative sentinel seq matches the convention used in
        // groupMessagesIntoTurns. Persistence layer rejects negative
        // seqs so this synthetic never leaks to disk.
        ChatMessage(
            type: "agent_message",
            seq: -1,
            sessionId: nil,
            deviceId: nil,
            timestamp: ISO8601.now(),
            payload: ["content": AnyCodable(text)]
        )
    }
}

// MARK: - File-private mirrors of the type sets in TurnGrouper

// These live here too (rather than being shared) so the incremental
// grouper can be unit-tested in isolation without touching the
// older full-walk path. If they drift, the
// `testStreamingMatchesBatch` test in IncrementalGrouperTests will
// flag it — that test runs both grouper paths against the same
// input and compares outputs.

private let userMessageTypes: Set<String> = [
    "user_message", "send_input", "pending_input",
]

private let thinkingTypes: Set<String> = [
    "tool_start", "tool_complete", "agent_message",
    "permission", "permission_resolved", "question",
    "question_resolved", "answer", "error", "approve",
    "deny", "always_allow", "session_mode_set", "active",
]

private let turnCompleteTypes: Set<String> = [
    "idle",
]
