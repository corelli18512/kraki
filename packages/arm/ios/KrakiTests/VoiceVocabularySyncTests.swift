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

    private func signedIn(_ user: String = "alice") -> VoiceVocabularyStore {
        let store = VoiceVocabularyStore(defaults: defaults)
        store.activate(userID: user)
        store.syncSupported = true
        return store
    }

    private func w(_ term: String, _ heardAs: String = "") -> VoiceWord { VoiceWord(term: term, heardAs: heardAs) }
    private func lines(_ store: VoiceVocabularyStore) -> [String] { store.terms.compactMap(\.line) }

    // MARK: Intents

    func testEditsBecomeOneIntentPerWordAtFlush() {
        let store = signedIn()
        // Mac types letter by letter into a new row.
        var row = VoiceTerm()
        store.upsert(row)
        for prefix in ["K", "Kr", "Kraki"] { row.term = prefix; store.upsert(row) }
        row.heardAs = "cracky, "
        store.upsert(row)
        store.flush()
        XCTAssertEqual(store.outbox, [VoiceWordOp(op: .add, term: "Kraki", heardAs: "cracky")])

        row.term = "Kraki App"
        store.upsert(row)
        store.remove(row.id)
        store.flush()
        XCTAssertEqual(store.outbox.dropFirst().map(\.op), [.remove])
        XCTAssertEqual(store.outbox.last?.term, "Kraki")
    }

    func testRenameAndReAddSameNameStayDistinct() {
        let store = signedIn()
        store.receive([w("A")])
        var renamed = store.terms[0]
        renamed.term = "B"
        store.upsert(renamed)
        store.upsert(VoiceTerm(term: "A"))
        store.flush()
        XCTAssertEqual(store.outbox.map(\.op), [.edit, .add])
        XCTAssertEqual(VoiceWordList.apply(store.outbox, to: [w("A")]), [w("B"), w("A")])
    }

    // MARK: Receiving

    func testRemoteListAppliesQueuedIntentsAndAckDropsThem() {
        let store = signedIn()
        store.upsert(VoiceTerm(term: "Mine"))
        store.flush()
        // Another device's change arrives before ours is acknowledged.
        store.receive([w("Theirs")])
        XCTAssertEqual(Set(lines(store)), ["Theirs", "Mine"], "optimistic: our queued add still shows")
        XCTAssertEqual(store.outbox.count, 1)
        store.receive([w("Theirs"), w("Mine")], acknowledged: 1)
        XCTAssertTrue(store.outbox.isEmpty)
        XCTAssertEqual(lines(store), ["Theirs", "Mine"])
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["Theirs", "Mine"], "next dictation request uses them")
    }

    func testRemoteChangesUpdateRowsWithoutLosingDraftsOrRowIdentity() {
        let store = signedIn()
        store.receive([w("Kraki", "cracky"), w("Old")])
        let krakiID = store.terms[0].id
        var kraki = store.terms[0]
        kraki.heardAs = "cracky, "          // Mac: comma typed, next alias not yet
        store.upsert(kraki)
        store.upsert(VoiceTerm())           // empty row being added
        store.flush()
        XCTAssertTrue(store.outbox.isEmpty, "raw spacing alone is not a change")

        store.receive([w("Kraki", "cracky"), w("New")])
        XCTAssertEqual(store.terms[0].id, krakiID)
        XCTAssertEqual(store.terms[0].heardAs, "cracky, ", "raw text kept")
        XCTAssertFalse(store.terms.contains { $0.term == "Old" }, "removed on another device")
        XCTAssertTrue(store.terms.contains { $0.term == "New" })
        XCTAssertTrue(store.terms.contains { $0.term.isEmpty }, "draft row kept")
    }

    func testUnflushedEditIsQueuedBeforeAdoptingRemoteList() {
        let store = signedIn()
        store.receive([w("Kraki")])
        var row = store.terms[0]
        row.heardAs = "cracky"
        store.upsert(row)
        store.receive([w("Kraki"), w("Other")])
        XCTAssertEqual(store.outbox.first?.op, .edit)
        XCTAssertEqual(store.terms.first?.heardAs, "cracky")
    }

    // MARK: Accounts and migration

    func testLegacyWordsGoToFirstAccountOnceAndSurviveRelaunch() {
        defaults.set("Kraki = cracky\nPostgreSQL", forKey: VoiceVocabulary.storageKey)
        let store = signedIn()
        store.flush()
        XCTAssertEqual(store.outbox.map(\.op), [.add, .add])
        XCTAssertEqual(VoiceVocabularyStore(defaults: defaults).outbox, store.outbox, "persisted")

        store.deactivate()
        XCTAssertTrue(VoiceVocabulary.load(defaults).isEmpty, "signed out: no words")
        XCTAssertFalse(store.canEdit)
        store.upsert(VoiceTerm(term: "Nobody's"))
        XCTAssertTrue(store.terms.isEmpty)

        store.activate(userID: "bob")
        store.flush()
        XCTAssertTrue(store.terms.isEmpty && store.outbox.isEmpty, "not imported twice")
        store.activate(userID: "alice")
        XCTAssertEqual(store.outbox.count, 2, "alice's queued words are still there")
        XCTAssertEqual(defaults.string(forKey: "voice.vocabulary.legacyBackup"), "Kraki = cracky\nPostgreSQL")
    }

    func testBeforeFirstSignInListStaysLocalAndEditable() {
        let store = VoiceVocabularyStore(defaults: defaults)
        XCTAssertTrue(store.canEdit)
        store.upsert(VoiceTerm(term: "Local"))
        XCTAssertEqual(VoiceVocabulary.load(defaults), ["Local"])
        store.activate(userID: "alice")
        store.flush()
        XCTAssertEqual(store.outbox, [VoiceWordOp(op: .add, term: "Local", heardAs: "")])
    }

    // MARK: Mirror of Head

    /// Same cases as packages/head/src/__tests__/voice-vocabulary.test.ts.
    func testApplyMatchesHead() {
        typealias Op = VoiceWordOp
        XCTAssertEqual(VoiceWordList.apply([Op(op: .add, term: "KRAKI", heardAs: "克拉奇, cracky")], to: [w("Kraki", "cracky")]),
                       [w("Kraki", "cracky, 克拉奇")])
        XCTAssertEqual(VoiceWordList.apply([Op(op: .edit, term: "Kraki App", heardAs: "x", from: "Kraki")], to: [w("A"), w("Kraki", "cracky"), w("B")]),
                       [w("A"), w("Kraki App", "x"), w("B")])
        XCTAssertEqual(VoiceWordList.apply([Op(op: .edit, term: "Kraki", heardAs: "cracky", from: "Kraki")], to: []),
                       [w("Kraki", "cracky")])
        XCTAssertEqual(VoiceWordList.apply([Op(op: .edit, term: "b", heardAs: "a", from: "A")], to: [w("A", "a"), w("B", "b")]),
                       [w("B", "b, a")])
        XCTAssertEqual(VoiceWordList.apply([Op(op: .remove, term: "kraki")], to: [w("Kraki")]), [])
        let full = (0..<VoiceVocabulary.maxEntries).map { w("W\($0)") }
        XCTAssertEqual(VoiceWordList.apply([Op(op: .add, term: "extra")], to: full).count, VoiceVocabulary.maxEntries)
    }
}
