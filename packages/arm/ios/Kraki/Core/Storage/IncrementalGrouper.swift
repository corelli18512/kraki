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
    /// Question ids that have been asked but not yet answered.
    /// Idle is deferred while non-empty, mirroring permissions —
    /// `ask_user` is a blocking tool so the agent shouldn't idle
    /// before the answer arrives, but tracking explicitly keeps the
    /// answer's seq inside the same open block for backpatch.
    var unresolvedQuestionIds: Set<String> = []
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
                    startSeq: synth.seq,  // -1 sentinel; renderer doesn't
                    endSeq: synth.seq,    // care about ordering for this case
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
        // regardless of branch. The `unresolvedPermIds` set is
        // additionally used by the idle branch to defer block-close
        // until the resolver shows up. When a resolver arrives we also
        // backpatch the matching permission row in `currentThinking`
        // so its rendered bubble carries the resolution badge — this
        // replaces the old `MessageStore.resolvePermissionMessage`
        // in-memory stamp and works the same way on cold start
        // (grouper sees both rows in the stream and folds).
        switch msg.type {
        case "permission":
            if let pid = msg.permissionId { state.unresolvedPermIds.insert(pid) }
        case "approve", "deny", "always_allow", "permission_resolved":
            let pid = msg.payload["permissionId"]?.stringValue
            let resolution = Self.derivedPermissionResolution(msg)
            if let pid {
                state.unresolvedPermIds.remove(pid)
                if let resolution {
                    Self.backpatchPermission(in: &state.currentThinking,
                                             permissionId: pid,
                                             resolution: resolution)
                }
            }
        case "question":
            // Only track lifecycle when there's a matching
            // `ask_user` tool_start to merge into — orphan questions
            // get dropped, so they can't be backpatched and shouldn't
            // gate idle.
            if let qid = msg.payload["id"]?.stringValue,
               state.currentThinking.contains(where: {
                   $0.type == "tool_start" && ($0.toolName == "ask_user" || $0.toolName == "ask")
               }) {
                state.unresolvedQuestionIds.insert(qid)
            }
        case "answer", "question_resolved":
            if let qid = msg.payload["questionId"]?.stringValue {
                state.unresolvedQuestionIds.remove(qid)
                if let answer = msg.payload["answer"]?.stringValue {
                    Self.backpatchQuestion(in: &state.currentThinking,
                                           questionId: qid,
                                           answer: answer)
                }
            }
        default: break
        }

        if userMessageTypes.contains(msg.type) {
            if state.hasOpenBlock {
                // Force-close: no idle, block stays active.
                flush(state: &state, closed: &closed, closingSeq: nil)
            }
            state.currentInitiator = .user(msg)
            return
        }
        if turnCompleteTypes.contains(msg.type) {
            if !state.unresolvedPermIds.isEmpty || !state.unresolvedQuestionIds.isEmpty {
                // Deferred — drop the idle, agent isn't done yet.
                return
            }
            // Real idle — closingSeq is this message's seq, which
            // becomes the block's endSeq.
            flush(state: &state, closed: &closed, closingSeq: msg.seq)
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
            // Resolution echoes are structural — the originating
            // permission/question row carries the visible result after
            // the backpatch above. Don't emit them as separate bubbles.
            if msg.type == "question_resolved" || msg.type == "answer"
                || msg.type == "permission_resolved"
                || msg.type == "approve" || msg.type == "deny" || msg.type == "always_allow" {
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
            flush(state: &state, closed: &closed, closingSeq: nil)
        }
    }

    /// Close the current state's accumulated block (if any) and
    /// append it to `closed`. Mirrors the original `flushTurn`.
    ///
    /// `closingSeq`:
    ///   - Real idle seq when closing via the idle branch — becomes
    ///     the block's `endSeq` and marks it `isActive = false`.
    ///   - nil for force-close (back-to-back user message, unknown
    ///     type, end-of-stream) — block stays active, endSeq is
    ///     the last internal-message seq.
    private static func flush(state: inout GrouperState, closed: inout [ActivityBlock], closingSeq: Int?) {
        defer {
            state.unresolvedPermIds.removeAll()
            state.unresolvedQuestionIds.removeAll()
        }
        guard state.hasOpenBlock else { return }
        let anchor = state.currentInitiator?.userMessage?.id
            ?? state.currentThinking.first?.id
            ?? "unknown"
        let blockId = "turn:\(anchor)"
        let initiator = state.currentInitiator ?? .implicit

        let startSeq = state.currentInitiator?.userMessage?.seq
            ?? state.currentThinking.first?.seq
            ?? 0
        let lastInternalSeq = max(
            state.currentInitiator?.userMessage?.seq ?? 0,
            state.currentThinking.map(\.seq).max() ?? 0
        )
        let endSeq = closingSeq ?? lastInternalSeq
        let isActive = (closingSeq == nil)

        if isActive {
            closed.append(ActivityBlock(
                id: blockId,
                initiator: initiator,
                thinkingMessages: state.currentThinking,
                finalMessage: nil,
                startSeq: startSeq,
                endSeq: endSeq,
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
                    startSeq: startSeq,
                    endSeq: endSeq,
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
                    startSeq: startSeq,
                    endSeq: endSeq,
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
        let startSeq = state.currentInitiator?.userMessage?.seq
            ?? state.currentThinking.first?.seq
            ?? 0
        let endSeq = max(
            state.currentInitiator?.userMessage?.seq ?? 0,
            state.currentThinking.map(\.seq).max() ?? 0
        )
        return ActivityBlock(
            id: "turn:\(anchor)",
            initiator: state.currentInitiator ?? .implicit,
            thinkingMessages: state.currentThinking,
            finalMessage: nil,
            startSeq: startSeq,
            endSeq: endSeq,
            isActive: true
        )
    }

    // MARK: - Helpers

    /// Reconstruct an island's raw message stream from its cached
    /// blocks. Used by gap-fill / replace paths that regroup an
    /// island from scratch.
    ///
    /// Closed blocks emit `[user_message?, ...thinking, final?, idle]`
    /// where the trailing idle uses the block's recorded `endSeq` —
    /// the actual seq of the closing idle observed during the
    /// original ingest. Earlier versions had to synthesise this seq
    /// because ActivityBlock didn't carry it; the resulting
    /// soft-collision required a fragile sort tiebreaker. With
    /// `endSeq` stored explicitly the regroup produces byte-identical
    /// blocks against the original ingest sequence.
    private static func flattenMessages(_ island: SeqIsland) -> [ChatMessage] {
        var out: [ChatMessage] = []
        for b in island.closedBlocks {
            if let u = b.initiator.userMessage { out.append(u) }
            out.append(contentsOf: b.thinkingMessages)
            if let f = b.finalMessage { out.append(f) }
            out.append(ChatMessage(
                type: "idle",
                seq: b.endSeq,
                sessionId: b.initiator.userMessage?.sessionId,
                deviceId: b.initiator.userMessage?.deviceId,
                timestamp: b.initiator.userMessage?.timestamp,
                payload: [:]
            ))
        }
        if let rp = island.rightPartial {
            if let u = rp.initiator.userMessage { out.append(u) }
            out.append(contentsOf: rp.thinkingMessages)
            // No final, no idle — block is still active.
        }
        out.sort { $0.seq < $1.seq }
        return out
    }

    private func interleave(_ blockItems: [TurnItem], with standalones: [ChatMessage]) -> [TurnItem] {
        // Build (seq, item) list then sort. Blocks are keyed by
        // their startSeq.
        struct Entry { let seq: Int; let item: TurnItem }
        var entries: [Entry] = []
        for item in blockItems {
            if case .block(let b) = item {
                entries.append(Entry(seq: b.startSeq, item: item))
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

    // MARK: - Resolution backpatch

    /// Map a resolver message type/payload onto the canonical
    /// resolution string carried by the originating permission row.
    /// `permission_resolved` ships the resolution explicitly in its
    /// payload; the legacy `approve`/`deny`/`always_allow` types
    /// derive it from the type itself. Returns nil when the message
    /// doesn't carry enough info (defensive — shouldn't happen).
    fileprivate static func derivedPermissionResolution(_ msg: ChatMessage) -> String? {
        switch msg.type {
        case "approve": return "approved"
        case "deny": return "denied"
        case "always_allow": return "always_allowed"
        case "permission_resolved": return msg.payload["resolution"]?.stringValue
        default: return nil
        }
    }

    /// Stamp `resolution` onto the most recent matching `permission`
    /// row in `thinking`. The block is kept open until all permission
    /// resolutions land (see `unresolvedPermIds` gating in the idle
    /// branch), so the originating row is always still in
    /// `currentThinking` when its resolver arrives — no need to scan
    /// closed blocks.
    fileprivate static func backpatchPermission(in thinking: inout [ChatMessage],
                                                permissionId: String,
                                                resolution: String) {
        guard let idx = thinking.lastIndex(where: {
            $0.type == "permission" && $0.permissionId == permissionId
        }) else { return }
        var patched = thinking[idx]
        patched.payload["resolution"] = AnyCodable(resolution)
        thinking[idx] = patched
    }

    /// Stamp `answer` onto the entry carrying `questionId`. After the
    /// `question` merges into the preceding `ask_user` tool_start
    /// (and possibly further into a subsequent tool_complete), the
    /// questionId lives in that merged entry's payload. Idle is
    /// gated by `unresolvedQuestionIds` so the entry is still in
    /// `currentThinking` when the answer arrives.
    fileprivate static func backpatchQuestion(in thinking: inout [ChatMessage],
                                              questionId: String,
                                              answer: String) {
        guard let idx = thinking.lastIndex(where: {
            $0.payload["questionId"]?.stringValue == questionId
        }) else { return }
        var patched = thinking[idx]
        patched.payload["answer"] = AnyCodable(answer)
        thinking[idx] = patched
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
