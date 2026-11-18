import XCTest
@testable import Kraki

/// Composer draft target and chat-entry loading rules (moved out of
/// TextKitPureSpineTests.swift).
extension TextKitPureSpineTests {
    /// K-021: a draft stays bound to the permission / question it was typed for.
    func testComposerDraftTargetHoldsASendWhoseTargetChanged() {
        let p1 = ComposerDraftTarget(permissionID: "p1", questionID: "q1")
        XCTAssertEqual(p1, .permission("p1"))
        XCTAssertEqual(ComposerDraftTarget(permissionID: nil, questionID: "q1"), .question("q1"))
        XCTAssertEqual(ComposerDraftTarget(permissionID: nil, questionID: nil), .conversation)
        XCTAssertFalse(ComposerDraftTarget.changed(boundTo: nil, live: p1))
        XCTAssertFalse(ComposerDraftTarget.changed(boundTo: p1, live: .permission("p1")))
        XCTAssertTrue(ComposerDraftTarget.changed(boundTo: p1, live: .permission("p2")))
        XCTAssertTrue(ComposerDraftTarget.changed(boundTo: .question("q1"), live: .conversation))
        XCTAssertTrue(ComposerDraftTarget.changed(boundTo: .conversation, live: .permission("p1")))
    }

    /// K-040: an uncached session whose computer is offline neither shows an
    /// endless "Syncing…" nor poses as a brand-new session.
    func testOfflineComputerHistoryIsNotSyncingNorANewSession() {
        XCTAssertTrue(ChatEntryLoading.isCatchingUp(connected: true, deviceOnline: true,
                                                    expectedLastSeq: 40, persistedHead: 0))
        XCTAssertFalse(ChatEntryLoading.isCatchingUp(connected: true, deviceOnline: false,
                                                     expectedLastSeq: 40, persistedHead: 0),
                       "nothing can arrive from an offline computer")
        XCTAssertFalse(ChatEntryLoading.isCatchingUp(connected: false, deviceOnline: true,
                                                     expectedLastSeq: 40, persistedHead: 0))
        XCTAssertFalse(ChatEntryLoading.isCatchingUp(connected: true, deviceOnline: true,
                                                     expectedLastSeq: 40, persistedHead: 40))
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 0, persistedHead: 0, deviceOnline: true), .newSession)
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 0, persistedHead: 0, deviceOnline: false), .newSession)
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 40, persistedHead: 0, deviceOnline: false), .historyOnOfflineComputer)
        XCTAssertNil(ChatEntryLoading.emptyChatNote(knownLastSeq: 40, persistedHead: 0, deviceOnline: true),
                     "history on an online computer is loading, not a new session")
    }

    /// B2: a brand-new session already has one history row, its
    /// `session_created` (seq 1), which draws nothing. Holding it, this device
    /// has the whole conversation: the intro shows, online or offline.
    func testNewSessionWithOnlyItsCreatedRowShowsTheIntro() {
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 1, persistedHead: 1, deviceOnline: true), .newSession)
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 1, persistedHead: 1, deviceOnline: false), .newSession)
        XCTAssertEqual(ChatEntryLoading.emptyChatNote(knownLastSeq: 40, persistedHead: 1, deviceOnline: false), .historyOnOfflineComputer)
    }
}
