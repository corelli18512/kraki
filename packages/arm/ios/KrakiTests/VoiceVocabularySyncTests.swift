import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

final class VoiceVocabularySyncTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    override func setUp() {
        super.setUp()
        suite = "VoiceVocabularySyncTests.\(UUID())"
        defaults = UserDefaults(suiteName: suite)!
    }
    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        super.tearDown()
    }
    private func entry(_ term: VoiceTerm, revision: Int = 1, deleted: Bool = false, changeId: String = UUID().uuidString.lowercased()) -> VoiceVocabularySnapshot.Entry {
        .init(id: term.id.uuidString.lowercased(), revision: revision, term: deleted ? "" : term.term,
              heardAs: deleted ? "" : term.heardAs, deleted: deleted, changeId: changeId)
    }
    private func activate(_ store: VoiceVocabularyStore, user: String = "alice") {
        store.activate(userID: user, relay: "wss://relay.example")
        store.syncSupported = true
    }

    func testLegacyMigrationIsDurableStableAndOnlyClaimedByFirstAccount() {
        defaults.set("Kraki = cracky\nPostgreSQL", forKey: VoiceVocabulary.storageKey)
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        XCTAssertEqual(store.syncState.pending.count, 2)
        XCTAssertTrue(store.syncState.pending.allSatisfy { $0.action == "import" })
        XCTAssertEqual(store.terms.first?.id, VoiceVocabularySyncState.legacyID("KRAKI"))
        let reloaded = VoiceVocabularyStore(defaults: defaults)
        XCTAssertEqual(reloaded.syncState.pending, store.syncState.pending)
        store.deactivate()
        XCTAssertTrue(VoiceVocabulary.load(defaults).isEmpty)
        XCTAssertFalse(store.canEdit)
        store.upsert(VoiceTerm(term: "Stale editor"))
        XCTAssertTrue(store.terms.isEmpty)
        activate(store, user: "bob")
        XCTAssertTrue(store.terms.isEmpty)
        XCTAssertTrue(store.syncState.pending.isEmpty)
        activate(store)
        XCTAssertEqual(store.syncState.pending.count, 2)
        XCTAssertEqual(defaults.string(forKey: "voice.vocabulary.legacyBackup"), "Kraki = cracky\nPostgreSQL")
    }

    func testAccountAndRelayIsolationIncludesUnacknowledgedChanges() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        store.upsert(VoiceTerm(term: "Alice Only"))
        store.activate(userID: "alice", relay: "wss://another.example")
        XCTAssertTrue(store.terms.isEmpty)
        activate(store, user: "bob")
        XCTAssertTrue(store.terms.isEmpty)
        activate(store)
        XCTAssertEqual(store.terms.map(\.term), ["Alice Only"])
        XCTAssertEqual(store.syncState.pending.count, 1)
    }

    func testLiveSnapshotUpdatesOpenStoreAndNextVoiceRequestCacheWithoutEcho() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var changes = 0
        store.onChange = { changes += 1 }
        let term = VoiceTerm(term: "Kraki", heardAs: "cracky")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        XCTAssertEqual(store.terms, [term])
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["Kraki = cracky"])
        XCTAssertTrue(store.syncState.pending.isEmpty)
        XCTAssertEqual(changes, 0)
        store.receive(.init(revision: 2, entries: [entry(term, revision: 2, deleted: true)]))
        XCTAssertTrue(store.terms.isEmpty)
        XCTAssertTrue(VoiceVocabulary.load(defaults).isEmpty)
    }

    func testTypingWhileRequestInFlightIsNotClearedByAcknowledgement() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Krak")
        store.upsert(term)
        let sent = store.syncState.pending
        let acknowledged = entry(term, changeId: sent[0].changeId)
        term.term = "Kraki"
        store.upsert(term)
        store.receive(.init(revision: 1, entries: [acknowledged]), sent: sent,
                      results: [["changeId": sent[0].changeId, "status": "applied"]])
        XCTAssertEqual(store.terms[0].term, "Kraki")
        XCTAssertEqual(store.syncState.pending.count, 1)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1)
        XCTAssertNotEqual(store.syncState.pending[0].changeId, sent[0].changeId)
        XCTAssertEqual(VoiceVocabularyStore(defaults: defaults).syncState.pending, store.syncState.pending)
    }

    func testContinuedTypingDoesNotRebaseOverRemoteEdit() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Original")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        term.term = "Local"
        store.upsert(term)
        let remote = VoiceTerm(id: term.id, term: "Remote")
        store.receive(.init(revision: 2, entries: [entry(remote, revision: 2)]))
        term.term = "Local continued"
        store.upsert(term)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1)
        XCTAssertEqual(store.terms[0].term, "Local continued")
    }

    func testAcknowledgementPreservesAliasSeparatorAndDraftBaseline() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Kraki", heardAs: "one")
        store.upsert(term)
        let sent = store.syncState.pending
        let ack = entry(term, changeId: sent[0].changeId)
        term.heardAs = "one, "
        store.upsert(term)
        store.receive(.init(revision: 1, entries: [ack]), sent: sent,
                      results: [["changeId": sent[0].changeId, "status": "applied"]])
        XCTAssertEqual(store.terms[0].heardAs, "one, ")
        XCTAssertTrue(store.syncState.pending.isEmpty)
        let remote = VoiceTerm(id: term.id, term: "Kraki", heardAs: "remote")
        store.receive(.init(revision: 2, entries: [entry(remote, revision: 2)]))
        term.heardAs = "one, two"
        store.upsert(term)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1)
    }

    func testEditorSaveUsesRevisionCapturedWhenSheetOpened() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Original")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        let baseline = store.revision(for: term.id)
        store.receive(.init(revision: 2, entries: [entry(VoiceTerm(id: term.id, term: "Remote"), revision: 2)]))
        term.term = "My unsubmitted draft"
        store.upsert(term, baseRevision: baseline)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1)
    }

    func testEditorDeleteUsesRevisionCapturedWhenSheetOpened() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        let term = VoiceTerm(term: "Original")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        let baseline = store.revision(for: term.id)
        store.receive(.init(revision: 2, entries: [entry(VoiceTerm(id: term.id, term: "Remote"), revision: 2)]))
        store.remove(term.id, baseRevision: baseline)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1)
        XCTAssertEqual(store.syncState.pending[0].action, "delete")
    }

    func testOldAckCannotRollBackNewerBroadcast() {
        var state = VoiceVocabularySyncState()
        var term = VoiceTerm(term: "First")
        state.stage(term)
        let sent = state.pending
        let old = VoiceVocabularySnapshot(revision: 1, entries: [entry(term)])
        term.term = "Newer remote edit"
        state.receive(.init(revision: 2, entries: [entry(term, revision: 2)]))
        state.receive(old, sent: sent, results: [["changeId": sent[0].changeId, "status": "applied"]])
        XCTAssertEqual(state.snapshot.revision, 2)
        XCTAssertEqual(state.terms[0].term, "Newer remote edit")
        XCTAssertTrue(state.pending.isEmpty)
    }

    func testDeletionConflictKeepsOfflineEditUntilExplicitResolution() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Old")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        term.term = "Offline Edit"
        store.upsert(term)
        let sent = store.syncState.pending
        store.receive(.init(revision: 2, entries: [entry(term, revision: 2, deleted: true)]), sent: sent,
                      results: [["changeId": sent[0].changeId, "status": "conflict"]])
        XCTAssertTrue(store.hasSyncProblems)
        XCTAssertEqual(store.terms[0].term, "Offline Edit")
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 1, "must not automatically rebase over deletion")
        let reloaded = VoiceVocabularyStore(defaults: defaults)
        XCTAssertTrue(reloaded.hasSyncProblems)
        reloaded.useSyncedWords()
        XCTAssertTrue(reloaded.terms.isEmpty)
        XCTAssertTrue(reloaded.syncState.pending.isEmpty)
        store.retrySync()
        XCTAssertFalse(store.hasSyncProblems)
        XCTAssertEqual(store.syncState.pending[0].baseRevision, 2, "explicit retry can restore the user's word")
    }

    func testInvalidOrEmptyMacDraftDoesNotDeletePreviouslySavedWord() {
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        var term = VoiceTerm(term: "Kraki")
        store.receive(.init(revision: 1, entries: [entry(term)]))
        term.term = ""
        store.upsert(term)
        XCTAssertTrue(store.syncState.pending.isEmpty)
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["Kraki"])
        let remote = VoiceTerm(term: "PostgreSQL")
        store.receive(.init(revision: 2, entries: [entry(VoiceTerm(id: term.id, term: "Kraki")), entry(remote, revision: 2)]))
        XCTAssertEqual(store.terms.first { $0.id == term.id }?.term, "", "preserve uncommitted row")
        store.remove(term.id)
        XCTAssertEqual(store.syncState.pending.first?.action, "delete")
    }

    func testOverflowKeepsLocalWordsInsteadOfTruncatingMigration() {
        defaults.set("Local", forKey: VoiceVocabulary.storageKey)
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        let sent = store.syncState.pending
        let remote = (0..<100).map { entry(VoiceTerm(term: "Word \($0)"), revision: $0 + 1) }
        store.receive(.init(revision: 100, entries: remote), sent: sent,
                      results: [["changeId": sent[0].changeId, "status": "full"]])
        XCTAssertEqual(store.terms.count, 101)
        XCTAssertTrue(store.hasSyncProblems)
        XCTAssertEqual(VoiceVocabularyStore(defaults: defaults).terms.count, 101)
    }

    func testImportMatchingAnExistingWordDoesNotLeaveADuplicateDraftAfterAck() {
        defaults.set("Kraki = cracky", forKey: VoiceVocabulary.storageKey)
        let store = VoiceVocabularyStore(defaults: defaults)
        activate(store)
        let sent = store.syncState.pending
        let canonical = VoiceTerm(term: "Kraki", heardAs: "cracky")
        store.receive(.init(revision: 1, entries: [entry(canonical)]))
        XCTAssertEqual(store.terms.count, 2, "local import is still unacknowledged")
        store.receive(.init(revision: 1, entries: [entry(canonical)]), sent: sent,
                      results: [["changeId": sent[0].changeId, "status": "applied"]])
        XCTAssertEqual(store.terms, [canonical])
        XCTAssertTrue(store.syncState.pending.isEmpty)
    }

    func testDecoderRejectsUnknownVersionAndMalformedIDs() {
        XCTAssertNil(VoiceVocabularySnapshot.decode(["version": 2, "revision": 0, "entries": []]))
        XCTAssertNil(VoiceVocabularySnapshot.decode(["version": 1, "revision": -1, "entries": []]))
        XCTAssertNotNil(VoiceVocabularySnapshot.decode(["version": 1, "revision": 0, "entries": []]))
        XCTAssertEqual(VoiceVocabularySyncState.legacyID("É"), VoiceVocabularySyncState.legacyID("e\u{301}"))
    }
}
