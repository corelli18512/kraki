import XCTest
@testable import Kraki

/// Tests for the incremental grouping cache (Stage F).
///
/// The cache lives per-session and answers "give me the current
/// list of TurnItems" without re-walking all messages on each
/// arrival. Closed blocks (idle-bounded, finalised) are immutable
/// and survive across `ingest` calls; only the active tail block
/// and the seams between newly-merged islands ever get rebuilt.
final class IncrementalGrouperTests: XCTestCase {

    // MARK: - Helpers

    private func userMsg(seq: Int, text: String = "hi") -> ChatMessage {
        ChatMessage(
            type: "user_message", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: ["content": AnyCodable(text)]
        )
    }

    private func agentMsg(seq: Int, text: String = "ok") -> ChatMessage {
        ChatMessage(
            type: "agent_message", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: ["content": AnyCodable(text)]
        )
    }

    private func toolStart(seq: Int, name: String = "shell", callId: String) -> ChatMessage {
        ChatMessage(
            type: "tool_start", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: [
                "toolName": AnyCodable(name),
                "toolCallId": AnyCodable(callId),
            ]
        )
    }

    private func toolComplete(seq: Int, callId: String) -> ChatMessage {
        ChatMessage(
            type: "tool_complete", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: ["toolCallId": AnyCodable(callId)]
        )
    }

    private func idle(seq: Int) -> ChatMessage {
        ChatMessage(
            type: "idle", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: [:]
        )
    }

    private func permission(seq: Int, pid: String) -> ChatMessage {
        ChatMessage(
            type: "permission", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: ["id": AnyCodable(pid), "toolName": AnyCodable("shell")]
        )
    }

    private func approve(seq: Int, pid: String) -> ChatMessage {
        ChatMessage(
            type: "approve", seq: seq,
            sessionId: "s", deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
            payload: ["permissionId": AnyCodable(pid)]
        )
    }

    /// Convenience: extract blocks from a TurnItem array, skipping
    /// standalones.
    private func blocks(_ items: [TurnItem]) -> [ActivityBlock] {
        items.compactMap { if case .block(let b) = $0 { return b } else { return nil } }
    }

    // MARK: - Single-island, append-only

    /// New cache + a complete turn arriving as one batch produces
    /// the same output as the non-incremental grouper.
    func testCompleteTurnInOneBatch() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1, text: "hello"),
            agentMsg(seq: 2, text: "hi"),
            idle(seq: 3),
        ])
        let items = cache.items(streamingContent: nil)
        XCTAssertEqual(items.count, 1)
        if case .block(let b) = items[0] {
            XCTAssertEqual(b.initiator.userMessage?.content, "hello")
            XCTAssertEqual(b.finalMessage?.content, "hi")
            XCTAssertFalse(b.isActive)
        } else {
            XCTFail("expected a block")
        }
    }

    /// Streaming agent message — block stays active (no idle yet).
    func testActiveBlockWhenNoIdle() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1, text: "hi"),
            agentMsg(seq: 2, text: "working"),
        ])
        let items = cache.items(streamingContent: nil)
        XCTAssertEqual(items.count, 1)
        if case .block(let b) = items[0] {
            XCTAssertTrue(b.isActive)
            XCTAssertNil(b.finalMessage)
        } else {
            XCTFail()
        }
    }

    /// Adding the closing idle to an existing active block closes
    /// it WITHOUT recomputing prior closed blocks.
    func testIncrementalIdleClosesActiveBlock() {
        var cache = SessionGrouperCache()
        // First closed block.
        cache.ingest([
            userMsg(seq: 1, text: "first"),
            agentMsg(seq: 2, text: "done1"),
            idle(seq: 3),
        ])
        // Second turn opens.
        cache.ingest([
            userMsg(seq: 4, text: "second"),
            agentMsg(seq: 5, text: "working"),
        ])
        var items = cache.items(streamingContent: nil)
        XCTAssertEqual(items.count, 2)
        let blocksBefore = blocks(items)
        XCTAssertEqual(blocksBefore[0].finalMessage?.content, "done1")
        XCTAssertTrue(blocksBefore[1].isActive)
        // Close the second block.
        cache.ingest([idle(seq: 6)])
        items = cache.items(streamingContent: nil)
        let blocksAfter = blocks(items)
        XCTAssertEqual(blocksAfter.count, 2)
        // The first block must be IDENTITY-equal — incremental
        // cache should not recreate it.
        XCTAssertEqual(blocksAfter[0].id, blocksBefore[0].id)
        XCTAssertEqual(blocksAfter[0].finalMessage?.content, "done1")
        // Second block now closed with its final message.
        XCTAssertFalse(blocksAfter[1].isActive)
        XCTAssertEqual(blocksAfter[1].finalMessage?.content, "working")
    }

    /// One-message-at-a-time ingest matches batch-ingest output.
    func testStreamingMatchesBatch() {
        let msgs: [ChatMessage] = [
            userMsg(seq: 1),
            toolStart(seq: 2, callId: "t1"),
            toolComplete(seq: 3, callId: "t1"),
            agentMsg(seq: 4, text: "final"),
            idle(seq: 5),
            userMsg(seq: 6, text: "next"),
            agentMsg(seq: 7, text: "ok"),
            idle(seq: 8),
        ]
        // Batch ingest.
        var batch = SessionGrouperCache()
        batch.ingest(msgs)
        let batchItems = batch.items(streamingContent: nil)

        // Streaming ingest.
        var stream = SessionGrouperCache()
        for m in msgs { stream.ingest([m]) }
        let streamItems = stream.items(streamingContent: nil)

        XCTAssertEqual(batchItems.count, streamItems.count)
        for (a, b) in zip(batchItems, streamItems) {
            XCTAssertEqual(a.id, b.id, "item id mismatch")
        }
    }

    // MARK: - Standalone messages

    func testStandaloneEmittedAndDoesNotCloseActiveBlock() {
        // session_created is a standalone; should not affect a
        // block that follows.
        var cache = SessionGrouperCache()
        cache.ingest([
            ChatMessage(
                type: "session_created", seq: 1, sessionId: "s",
                deviceId: "d", timestamp: "2024-01-01T00:00:00Z",
                payload: [:]
            ),
            userMsg(seq: 2),
            agentMsg(seq: 3),
            idle(seq: 4),
        ])
        let items = cache.items(streamingContent: nil)
        XCTAssertEqual(items.count, 2)
        if case .standalone = items[0] {} else { XCTFail("expected standalone") }
        if case .block(let b) = items[1] {
            XCTAssertFalse(b.isActive)
        } else { XCTFail() }
    }

    // MARK: - Multiple islands

    /// Two disjoint batches (e.g. user opened head, then jumped to
    /// an older slice) → two islands in the cache, both
    /// independently grouped.
    func testDisjointBatchesProduceTwoIslands() {
        var cache = SessionGrouperCache()
        // Older island [10..12].
        cache.ingest([
            userMsg(seq: 10, text: "old"),
            agentMsg(seq: 11, text: "old-reply"),
            idle(seq: 12),
        ])
        // Newer island [50..52], non-adjacent to [10..12].
        cache.ingest([
            userMsg(seq: 50, text: "new"),
            agentMsg(seq: 51, text: "new-reply"),
            idle(seq: 52),
        ])
        let items = cache.items(streamingContent: nil)
        let bs = blocks(items)
        XCTAssertEqual(bs.count, 2)
        XCTAssertEqual(bs[0].initiator.userMessage?.content, "old")
        XCTAssertEqual(bs[1].initiator.userMessage?.content, "new")
        XCTAssertEqual(cache.islandCount, 2)
    }

    /// Filling the gap between two islands merges them. The
    /// originally-closed blocks survive; only the seam blocks are
    /// rebuilt.
    func testGapFillMergesIslands() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1, text: "first"),
            agentMsg(seq: 2, text: "r1"),
            idle(seq: 3),
        ])
        cache.ingest([
            userMsg(seq: 10, text: "third"),
            agentMsg(seq: 11, text: "r3"),
            idle(seq: 12),
        ])
        XCTAssertEqual(cache.islandCount, 2)
        // Fill the middle.
        cache.ingest([
            userMsg(seq: 4, text: "second"),
            agentMsg(seq: 5, text: "r2"),
            idle(seq: 6),
            // Seqs 7-9 truly missing — leave a residual gap.
        ])
        let bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 3)
        XCTAssertEqual(bs[0].initiator.userMessage?.content, "first")
        XCTAssertEqual(bs[1].initiator.userMessage?.content, "second")
        XCTAssertEqual(bs[2].initiator.userMessage?.content, "third")
        // Still 2 islands because 7-9 are missing.
        XCTAssertEqual(cache.islandCount, 2)
    }

    /// Filling the gap exactly contiguously merges into one
    /// island.
    func testGapFillFullyContiguousMergesToOneIsland() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1),
            agentMsg(seq: 2),
            idle(seq: 3),
        ])
        cache.ingest([
            userMsg(seq: 7),
            agentMsg(seq: 8),
            idle(seq: 9),
        ])
        // Bridge seqs 4..6.
        cache.ingest([
            userMsg(seq: 4),
            agentMsg(seq: 5),
            idle(seq: 6),
        ])
        XCTAssertEqual(cache.islandCount, 1)
        let bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 3)
    }

    // MARK: - Permission defer

    /// idle arriving while a permission is unresolved is deferred —
    /// the block stays active. A later approve + idle closes it.
    func testIdleDeferredByUnresolvedPermission() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1),
            toolStart(seq: 2, name: "shell", callId: "t1"),
            permission(seq: 3, pid: "p1"),
            idle(seq: 4),  // SHOULD be deferred — perm unresolved
        ])
        var bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 1)
        XCTAssertTrue(bs[0].isActive, "block should still be active because perm p1 unresolved")

        // User approves, agent finishes, real idle arrives.
        cache.ingest([
            approve(seq: 5, pid: "p1"),
            toolComplete(seq: 6, callId: "t1"),
            agentMsg(seq: 7, text: "done"),
            idle(seq: 8),
        ])
        bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 1)
        XCTAssertFalse(bs[0].isActive)
        XCTAssertEqual(bs[0].finalMessage?.content, "done")
    }

    /// Same scenario but ingested one-at-a-time across multiple
    /// calls. The deferred-idle state must persist in the cache's
    /// per-island tailState between ingests.
    func testIdleDeferredAcrossSeparateIngests() {
        var cache = SessionGrouperCache()
        cache.ingest([userMsg(seq: 1)])
        cache.ingest([permission(seq: 2, pid: "p1")])
        cache.ingest([idle(seq: 3)])  // deferred
        var bs = blocks(cache.items(streamingContent: nil))
        XCTAssertTrue(bs[0].isActive, "permission unresolved across ingests")
        cache.ingest([approve(seq: 4, pid: "p1")])
        cache.ingest([agentMsg(seq: 5, text: "ok")])
        cache.ingest([idle(seq: 6)])
        bs = blocks(cache.items(streamingContent: nil))
        XCTAssertFalse(bs[0].isActive)
    }

    // MARK: - Streaming content

    /// streamingContent is appended as a synthetic agent_message to
    /// the in-progress block but does NOT touch closed blocks.
    func testStreamingContentAppendsToActiveOnly() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1),
            agentMsg(seq: 2, text: "old-done"),
            idle(seq: 3),
            userMsg(seq: 4),
        ])
        let items = cache.items(streamingContent: "partial...")
        let bs = blocks(items)
        XCTAssertEqual(bs.count, 2)
        XCTAssertEqual(bs[0].finalMessage?.content, "old-done")
        XCTAssertFalse(bs[0].isActive)
        XCTAssertTrue(bs[1].isActive)
        // Active block's thinking should now contain the synthetic.
        XCTAssertTrue(bs[1].thinkingMessages.contains { $0.seq == -1 })
        XCTAssertEqual(bs[1].thinkingMessages.last?.content, "partial...")
    }

    /// Streaming with no active block at all (rare) opens an
    /// implicit block to carry the synthetic message.
    func testStreamingWithNoActiveBlockOpensImplicit() {
        var cache = SessionGrouperCache()
        // Only closed content.
        cache.ingest([
            userMsg(seq: 1),
            agentMsg(seq: 2, text: "done"),
            idle(seq: 3),
        ])
        let items = cache.items(streamingContent: "live...")
        let bs = blocks(items)
        XCTAssertEqual(bs.count, 2)
        XCTAssertEqual(bs[0].finalMessage?.content, "done")
        // Second block has implicit initiator + streaming content.
        if case .implicit = bs[1].initiator {} else {
            XCTFail("expected implicit initiator for streaming-only tail block, got \(bs[1].initiator)")
        }
        XCTAssertEqual(bs[1].thinkingMessages.last?.content, "live...")
    }

    // MARK: - Closed-block stability

    /// The same ActivityBlock value (id + finalMessage) is returned
    /// across successive ingests — confirms incremental nature.
    func testClosedBlocksAreStableObjectsAcrossIngests() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1, text: "stable"),
            agentMsg(seq: 2, text: "reply"),
            idle(seq: 3),
        ])
        let snap1 = blocks(cache.items(streamingContent: nil))
        // 5 more ingests of unrelated tail messages.
        for s in 4...8 {
            cache.ingest([userMsg(seq: s), agentMsg(seq: s + 100), idle(seq: s + 200)])
        }
        let snap2Closed = blocks(cache.items(streamingContent: nil))[0]
        XCTAssertEqual(snap1[0].id, snap2Closed.id)
        XCTAssertEqual(snap1[0].finalMessage?.id, snap2Closed.finalMessage?.id)
        XCTAssertEqual(snap1[0].thinkingMessages.count, snap2Closed.thinkingMessages.count)
    }

    // MARK: - Dedup / replace

    /// Re-ingesting the same seq with the same type updates the
    /// payload but doesn't duplicate the block.
    func testReingestSameSeqReplacesContent() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1, text: "v1"),
            agentMsg(seq: 2, text: "v1-reply"),
            idle(seq: 3),
        ])
        var bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs[0].finalMessage?.content, "v1-reply")
        // Re-ingest the agent msg with updated content.
        cache.ingest([agentMsg(seq: 2, text: "v2-reply")])
        bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 1)
        XCTAssertEqual(bs[0].finalMessage?.content, "v2-reply",
                       "re-ingest should update final message content")
    }

    // MARK: - startSeq / endSeq

    /// Closed block: startSeq == user msg seq; endSeq == closing idle seq.
    func testClosedBlockSeqRange() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 10),
            agentMsg(seq: 11),
            idle(seq: 12),
        ])
        let b = blocks(cache.items(streamingContent: nil))[0]
        XCTAssertEqual(b.startSeq, 10)
        XCTAssertEqual(b.endSeq, 12, "endSeq should be the closing idle's seq, not the final message's seq")
        XCTAssertFalse(b.isActive)
    }

    /// Active block: endSeq is the latest message seq we've seen,
    /// will climb as the block grows.
    func testActiveBlockSeqRangeUpdatesWithEachIngest() {
        var cache = SessionGrouperCache()
        cache.ingest([userMsg(seq: 5)])
        XCTAssertEqual(blocks(cache.items(streamingContent: nil))[0].endSeq, 5)
        cache.ingest([agentMsg(seq: 6)])
        XCTAssertEqual(blocks(cache.items(streamingContent: nil))[0].endSeq, 6)
        cache.ingest([agentMsg(seq: 7)])
        XCTAssertEqual(blocks(cache.items(streamingContent: nil))[0].endSeq, 7)
    }

    /// Two adjacent blocks have non-overlapping seq ranges, and the
    /// next block's startSeq is exactly the previous block's
    /// endSeq + 1 (assuming no gap between idle and next user msg).
    func testAdjacentBlocksHaveContiguousSeqRanges() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1),
            agentMsg(seq: 2),
            idle(seq: 3),
            userMsg(seq: 4),
            agentMsg(seq: 5),
            idle(seq: 6),
        ])
        let bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs[0].startSeq, 1)
        XCTAssertEqual(bs[0].endSeq, 3)
        XCTAssertEqual(bs[1].startSeq, 4)
        XCTAssertEqual(bs[1].endSeq, 6)
    }

    /// gap-fill (island merge) preserves the seq ranges of the
    /// blocks that were already closed — confirms flattenMessages
    /// using endSeq round-trips correctly through the regroup.
    func testGapFillPreservesClosedBlockSeqRanges() {
        var cache = SessionGrouperCache()
        cache.ingest([
            userMsg(seq: 1), agentMsg(seq: 2), idle(seq: 3),
        ])
        cache.ingest([
            userMsg(seq: 7), agentMsg(seq: 8), idle(seq: 9),
        ])
        // Bridge: [4..6] fully fills the [4..6] gap and makes the
        // two islands contiguous.
        cache.ingest([
            userMsg(seq: 4), agentMsg(seq: 5), idle(seq: 6),
        ])
        XCTAssertEqual(cache.islandCount, 1, "should merge to one island after bridging")
        let bs = blocks(cache.items(streamingContent: nil))
        XCTAssertEqual(bs.count, 3)
        XCTAssertEqual(bs[0].startSeq, 1); XCTAssertEqual(bs[0].endSeq, 3)
        XCTAssertEqual(bs[1].startSeq, 4); XCTAssertEqual(bs[1].endSeq, 6)
        XCTAssertEqual(bs[2].startSeq, 7); XCTAssertEqual(bs[2].endSeq, 9)
    }
}
