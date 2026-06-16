import XCTest
@testable import Kraki

/// Tests for `PendingTailBuffer` — the pure drain/tombstone logic
/// powering MessageProvider's push-gap recovery. No I/O, no
/// timeouts; just the state machine.
final class PendingTailBufferTests: XCTestCase {

    private func msg(_ seq: Int) -> ChatMessage {
        ChatMessage(
            type: "user_message",
            seq: seq,
            sessionId: "s",
            deviceId: "d",
            timestamp: "t",
            payload: [:]
        )
    }

    // MARK: - Sorted-insert / dedupe / cap

    func testInsertKeepsSortedOrder() {
        var b = PendingTailBuffer()
        b.insert(msg(5))
        b.insert(msg(2))
        b.insert(msg(8))
        b.insert(msg(3))
        XCTAssertEqual(b.messages.map(\.seq), [2, 3, 5, 8])
    }

    func testInsertDedupesOnSeq() {
        var b = PendingTailBuffer()
        b.insert(msg(5))
        b.insert(msg(5))
        b.insert(msg(5))
        XCTAssertEqual(b.messages.count, 1)
    }

    func testInsertAllInOneCall() {
        var b = PendingTailBuffer()
        b.insertAll([msg(3), msg(1), msg(2), msg(2)])
        XCTAssertEqual(b.messages.map(\.seq), [1, 2, 3])
    }

    func testOverflowDropsOldest() {
        var b = PendingTailBuffer()
        // Fill up to cap with contiguous seqs.
        for s in 1...PendingTailBuffer.cap { b.insert(msg(s)) }
        XCTAssertEqual(b.messages.count, PendingTailBuffer.cap)
        XCTAssertEqual(b.messages.first?.seq, 1)
        // One more → oldest dropped, overflow flag true.
        let didOverflow = b.insert(msg(PendingTailBuffer.cap + 1))
        XCTAssertTrue(didOverflow)
        XCTAssertEqual(b.messages.count, PendingTailBuffer.cap)
        XCTAssertEqual(b.messages.first?.seq, 2)
        XCTAssertEqual(b.messages.last?.seq, PendingTailBuffer.cap + 1)
    }

    // MARK: - Drain — basic

    func testDrainEmptyBufferIsNoop() {
        var b = PendingTailBuffer()
        let action = b.drain(dbLast: 100, hasInflight: false)
        XCTAssertTrue(action.toCommit.isEmpty)
        XCTAssertNil(action.nextFetch)
    }

    func testDrainContiguousAtDbLastPlusOneCommitsAll() {
        var b = PendingTailBuffer()
        b.insertAll([msg(11), msg(12), msg(13)])
        let action = b.drain(dbLast: 10, hasInflight: false)
        XCTAssertEqual(action.toCommit.map(\.seq), [11, 12, 13])
        XCTAssertNil(action.nextFetch)
        XCTAssertTrue(b.messages.isEmpty)
    }

    func testDrainWithGapSchedulesFetchForGapOnly() {
        var b = PendingTailBuffer()
        // dbLast=200, push lands at 205 → gap [201..204].
        b.insertAll([msg(205)])
        let action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertTrue(action.toCommit.isEmpty)
        XCTAssertEqual(action.nextFetch, 201...204)
        // Buffered message NOT committed.
        XCTAssertEqual(b.messages.map(\.seq), [205])
    }

    func testDrainNoFetchWhileInflight() {
        var b = PendingTailBuffer()
        b.insertAll([msg(205)])
        let action = b.drain(dbLast: 200, hasInflight: true)
        XCTAssertNil(action.nextFetch)
    }

    func testDrainDropsStaleEntriesAtOrBelowDbLast() {
        // Common race: turn-aligned `request_session_messages`
        // batch advances dbLast past some buffered pushes while
        // a range fetch was still in flight.
        var b = PendingTailBuffer()
        b.insertAll([msg(195), msg(198), msg(205)])
        let action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertTrue(action.toCommit.isEmpty)         // 205 not contiguous w/ 201
        XCTAssertEqual(action.nextFetch, 201...204)
        XCTAssertEqual(b.messages.map(\.seq), [205])   // 195, 198 dropped
    }

    // MARK: - Tombstones

    func testDrainStepsPastTombstones() {
        // Server confirmed seqs 202 and 204 are non-persistent.
        var b = PendingTailBuffer()
        b.insertAll([msg(201), msg(203), msg(205)])
        b.ingestRangeResponse(
            messages: [msg(201), msg(203)],
            requestedFrom: 201, requestedTo: 204,
            responseFirstSeq: 201, responseLastSeq: 204,
            truncated: false
        )
        let action = b.drain(dbLast: 200, hasInflight: false)
        // Should commit 201, step past 202 tombstone, commit 203,
        // step past 204 tombstone, commit 205.
        XCTAssertEqual(action.toCommit.map(\.seq), [201, 203, 205])
        XCTAssertNil(action.nextFetch)
        XCTAssertTrue(b.isEmpty)
    }

    func testTombstonesGarbageCollectedBelowCursor() {
        var b = PendingTailBuffer()
        b.ingestRangeResponse(
            messages: [],
            requestedFrom: 201, requestedTo: 210,
            responseFirstSeq: 0, responseLastSeq: 0,
            truncated: false
        )
        XCTAssertEqual(b.tombstones.count, 10)
        // After drain to head, all tombstones should be GC'd.
        b.insert(msg(211))
        _ = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertTrue(b.tombstones.isEmpty)
    }

    // MARK: - Range response ingestion

    func testRangeResponseTombstonesInsideGaps() {
        var b = PendingTailBuffer()
        // Asked [101..110]; server returned only [101, 103, 107].
        b.ingestRangeResponse(
            messages: [msg(101), msg(103), msg(107)],
            requestedFrom: 101, requestedTo: 110,
            responseFirstSeq: 101, responseLastSeq: 110,
            truncated: false
        )
        XCTAssertEqual(b.messages.map(\.seq), [101, 103, 107])
        // Tombstones for 102, 104, 105, 106, 108, 109, 110.
        XCTAssertEqual(b.tombstones, [102, 104, 105, 106, 108, 109, 110])
    }

    func testRangeResponseTruncatedDoesNotTombstoneLowEdge() {
        // Asked [201..1000]; server hit cap, returned only the
        // newest 500 messages [501..1000]. Low edge MUST stay
        // unmarked so the next drain triggers a follow-up fetch.
        var b = PendingTailBuffer()
        let returned = (501...1000).map(msg)
        b.ingestRangeResponse(
            messages: returned,
            requestedFrom: 201, requestedTo: 1000,
            responseFirstSeq: 501, responseLastSeq: 1000,
            truncated: true
        )
        // No tombstones at all — every returned seq was present and
        // the low end is pending more fetches.
        XCTAssertTrue(b.tombstones.isEmpty)
        XCTAssertEqual(b.messages.count, 500)
        XCTAssertEqual(b.messages.first?.seq, 501)
    }

    func testRangeResponseShortHighEdgeIsTombstonedEvenIfTruncated() {
        // Edge case: server's actual head was 800 but we asked
        // [201..1000]. Response covers [501..800] (truncated low,
        // 300 messages). High edge [801..1000] confirmed empty.
        var b = PendingTailBuffer()
        let returned = (501...800).map(msg)
        b.ingestRangeResponse(
            messages: returned,
            requestedFrom: 201, requestedTo: 1000,
            responseFirstSeq: 501, responseLastSeq: 800,
            truncated: true
        )
        // Low edge [201..500] NOT tombstoned (truncated).
        for s in 201...500 { XCTAssertFalse(b.tombstones.contains(s)) }
        // High edge [801..1000] tombstoned.
        for s in 801...1000 { XCTAssertTrue(b.tombstones.contains(s)) }
    }

    func testRangeResponseEmptyAndNotTruncatedTombstonesWholeRange() {
        var b = PendingTailBuffer()
        b.ingestRangeResponse(
            messages: [],
            requestedFrom: 201, requestedTo: 204,
            responseFirstSeq: 0, responseLastSeq: 0,
            truncated: false
        )
        XCTAssertEqual(b.tombstones, [201, 202, 203, 204])
    }

    func testRangeResponseEmptyTruncatedIsIgnored() {
        // Per spec this shouldn't happen; assert defensive no-op.
        var b = PendingTailBuffer()
        b.ingestRangeResponse(
            messages: [],
            requestedFrom: 201, requestedTo: 204,
            responseFirstSeq: 0, responseLastSeq: 0,
            truncated: true
        )
        XCTAssertTrue(b.tombstones.isEmpty)
        XCTAssertTrue(b.messages.isEmpty)
    }

    // MARK: - Multi-hole convergence

    func testMultiHoleConvergesAcrossMultipleDrainCycles() {
        // Scenario:
        //   dbLast=200, push 205 → gap [201..204]
        //   push 210 before range fetch returns → gap [206..209] too
        //   range fetch returns [201..204]
        // Expected: drain commits [201..205], schedules fetch for [206..209].
        // After that response: drain commits [206..210], no more fetch.
        var b = PendingTailBuffer()
        b.insert(msg(205))
        // First drain: gap, no commits.
        var action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertEqual(action.nextFetch, 201...204)
        XCTAssertTrue(action.toCommit.isEmpty)

        // Another push arrives BEFORE the range response. Buffer now [205, 210].
        b.insert(msg(210))
        // Drain again (hasInflight=true since we already triggered fetch).
        action = b.drain(dbLast: 200, hasInflight: true)
        XCTAssertNil(action.nextFetch)
        XCTAssertTrue(action.toCommit.isEmpty)

        // Range response arrives for [201..204] — full, not truncated.
        b.ingestRangeResponse(
            messages: [msg(201), msg(202), msg(203), msg(204)],
            requestedFrom: 201, requestedTo: 204,
            responseFirstSeq: 201, responseLastSeq: 204,
            truncated: false
        )
        // Inflight cleared by wrapper; drain again.
        action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertEqual(action.toCommit.map(\.seq), [201, 202, 203, 204, 205])
        XCTAssertEqual(action.nextFetch, 206...209)
        // Caller commits → dbLast advances to 205. Buffer holds [210].

        // Range response arrives for [206..209].
        b.ingestRangeResponse(
            messages: [msg(206), msg(207), msg(208), msg(209)],
            requestedFrom: 206, requestedTo: 209,
            responseFirstSeq: 206, responseLastSeq: 209,
            truncated: false
        )
        action = b.drain(dbLast: 205, hasInflight: false)
        XCTAssertEqual(action.toCommit.map(\.seq), [206, 207, 208, 209, 210])
        XCTAssertNil(action.nextFetch)
        XCTAssertTrue(b.isEmpty)
    }

    func testLargeRangeFetchedInTruncatedChunks() {
        // Asked [201..2000]; server cap forces three iterations:
        //   1: returns [1501..2000] truncated
        //   2: returns [1001..1500] truncated
        //   3: returns [201..1000] not truncated
        // Until the final response lands, the contiguous prefix is
        // empty (everything is above the gap), so no commits happen.
        var b = PendingTailBuffer()
        b.insert(msg(2001))   // the original push that triggered everything

        // Pretend wrapper fired fetch for [201..2000].
        var action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertEqual(action.nextFetch, 201...2000)

        // Response 1: newest 500.
        b.ingestRangeResponse(
            messages: (1501...2000).map(msg),
            requestedFrom: 201, requestedTo: 2000,
            responseFirstSeq: 1501, responseLastSeq: 2000,
            truncated: true
        )
        action = b.drain(dbLast: 200, hasInflight: false)
        // 1501..2001 is contiguous internally, but dbLast=200 so
        // commit prefix is empty. Fetch the next lower chunk
        // [201..1500].
        XCTAssertTrue(action.toCommit.isEmpty)
        XCTAssertEqual(action.nextFetch, 201...1500)

        // Response 2: next 500.
        b.ingestRangeResponse(
            messages: (1001...1500).map(msg),
            requestedFrom: 201, requestedTo: 1500,
            responseFirstSeq: 1001, responseLastSeq: 1500,
            truncated: true
        )
        action = b.drain(dbLast: 200, hasInflight: false)
        XCTAssertTrue(action.toCommit.isEmpty)
        XCTAssertEqual(action.nextFetch, 201...1000)

        // Response 3: final 800.
        b.ingestRangeResponse(
            messages: (201...1000).map(msg),
            requestedFrom: 201, requestedTo: 1000,
            responseFirstSeq: 201, responseLastSeq: 1000,
            truncated: false
        )
        action = b.drain(dbLast: 200, hasInflight: false)
        // Now the entire prefix collapses in one commit.
        XCTAssertEqual(action.toCommit.count, 1801)
        XCTAssertEqual(action.toCommit.first?.seq, 201)
        XCTAssertEqual(action.toCommit.last?.seq, 2001)
        XCTAssertNil(action.nextFetch)
        XCTAssertTrue(b.isEmpty)
    }

    // MARK: - Reset

    func testResetClearsEverything() {
        var b = PendingTailBuffer()
        b.insert(msg(5))
        b.ingestRangeResponse(
            messages: [],
            requestedFrom: 1, requestedTo: 3,
            responseFirstSeq: 0, responseLastSeq: 0,
            truncated: false
        )
        b.reset()
        XCTAssertTrue(b.isEmpty)
        XCTAssertEqual(b.messages.count, 0)
        XCTAssertEqual(b.tombstones.count, 0)
    }
}
