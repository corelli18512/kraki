import XCTest
@testable import Kraki_Dev

/// Custom Words account sync through the production client networking
/// (WebSocket, auth, Pulse head controls, PreferencesManager) against the
/// isolated local Head of the chaos stack. Two app links of the same open-auth
/// account; `app` can be cut independently. No Tentacle involvement.
///
/// Skipped unless `scripts/chaos/run-native.sh` started the stack.
@MainActor
final class VoiceVocabularyNetworkTests: XCTestCase {
    private struct StackInfo: Decodable { let controlPort: Int; let appPort: Int; let app2Port: Int }
    private var stack: StackInfo!
    private var apps: [AppState] = []
    private var suites: [String] = []
    /// The stack's account outlives a test: only compare this test's words.
    private let tag = "t\(UUID().uuidString.prefix(6))"

    override func setUp() async throws {
        let url = URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("chaos stack not running") }
        stack = try JSONDecoder().decode(StackInfo.self, from: data)
        try await control("/heal")
    }

    override func tearDown() async throws {
        apps.forEach { $0.disconnect() }
        apps = []
        suites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        suites = []
        if stack != nil { try? await control("/heal") }
    }

    // MARK: - Helpers

    private func defaults() -> (UserDefaults, String) {
        let name = "VoiceVocabularyNetworkTests.\(UUID())"
        suites.append(name)
        return (UserDefaults(suiteName: name)!, name)
    }

    /// A client in its own storage. Passing a suite name reuses that storage,
    /// i.e. a relaunch of the same installation.
    private func launch(port: Int, suite: String? = nil) async throws -> AppState {
        let store = suite.map { UserDefaults(suiteName: $0)! } ?? defaults().0
        let app = AppState.makeNetworkHarness(relayPort: port, vocabularyDefaults: store)
        apps.append(app)
        try await waitUntil(20, "connected and sync supported") {
            app.connectionStatus == .connected && app.voiceVocabularyStore.syncSupported
        }
        return app
    }

    private func words(_ app: AppState) -> Set<String> {
        Set(app.voiceVocabularyStore.terms.compactMap(\.line).filter { $0.hasPrefix(tag) })
    }

    /// Everything edited so far has reached Head. Edits enter the outbox at
    /// the debounced flush, so flush first or this is trivially true.
    private func synced(_ app: AppState) -> Bool {
        app.voiceVocabularyStore.flush()
        return app.voiceVocabularyStore.outbox.isEmpty
    }

    /// Row ids are local to a device; find the row by its word.
    private func row(_ app: AppState, _ term: String) -> VoiceTerm {
        app.voiceVocabularyStore.terms.first { $0.cleanTerm == term }!
    }

    @discardableResult
    private func control(_ path: String, _ body: [String: Any] = [:]) async throws -> Data {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(stack.controlPort)\(path)")!)
        req.httpMethod = "POST"
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await URLSession.shared.data(for: req).0
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out: \(what)"]) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    // MARK: - Scenarios

    /// Add on one client → live on the other, including the cache the next
    /// dictation request reads; delete flows back the other way.
    func testLiveAddEditDeleteBetweenTwoClients() async throws {
        let tag = self.tag
        let (storeB, _) = defaults()
        let a = try await launch(port: stack.appPort)
        let b = AppState.makeNetworkHarness(relayPort: stack.app2Port, vocabularyDefaults: storeB)
        apps.append(b)
        try await waitUntil(20, "B connected") { b.connectionStatus == .connected && b.voiceVocabularyStore.syncSupported }

        var term = VoiceTerm(term: "\(tag) Kraki", heardAs: "cracky")
        a.voiceVocabularyStore.upsert(term)
        try await waitUntil(10, "B receives the new word") { self.words(b) == ["\(tag) Kraki = cracky"] }
        XCTAssertEqual(VoiceVocabulary.load(storeB).filter { $0.hasPrefix(self.tag) }, ["\(tag) Kraki = cracky"], "next voice request on B uses it")
        try await waitUntil(10, "A acknowledged") { self.synced(a) }

        term.heardAs = "cracky, 克拉奇"
        a.voiceVocabularyStore.upsert(term)
        try await waitUntil(10, "B receives the edit") { self.words(b) == ["\(tag) Kraki = cracky, 克拉奇"] }

        try await waitUntil(10, "A acknowledged the edit") { self.synced(a) }
        b.voiceVocabularyStore.remove(row(b, term.term).id)
        try await waitUntil(10, "A receives the deletion") { self.words(a).isEmpty }
        try await waitUntil(10, "both settled") { self.synced(a) && self.synced(b) }
    }

    /// One client edits while cut off and is relaunched before the network
    /// returns; the other client keeps editing. Both converge with no loss.
    func testOfflineEditSurvivesRelaunchAndMergesWithOtherClient() async throws {
        let tag = self.tag
        let (_, suiteA) = defaults()
        let a = try await launch(port: stack.appPort, suite: suiteA)
        let b = try await launch(port: stack.app2Port)

        try await control("/fault", ["link": "app", "refuse": true])
        try await control("/reset", ["link": "app"])
        try await waitUntil(15, "A offline") { a.connectionStatus != .connected }

        a.voiceVocabularyStore.upsert(VoiceTerm(term: "\(tag) Offline Word"))
        b.voiceVocabularyStore.upsert(VoiceTerm(term: "\(tag) Online Word"))
        try await waitUntil(10, "B acknowledged") { self.synced(b) }
        a.voiceVocabularyStore.flush()
        XCTAssertEqual(a.voiceVocabularyStore.outbox.count, 1, "A keeps the edit in its outbox")

        // Relaunch A from the same storage while still offline.
        a.disconnect()
        apps.removeAll { $0 === a }
        try await control("/heal")
        let relaunched = try await launch(port: stack.appPort, suite: suiteA)

        let expected: Set<String> = ["\(tag) Offline Word", "\(tag) Online Word"]
        try await waitUntil(15, "both clients converge") {
            self.words(relaunched) == expected && self.words(b) == expected
        }
        try await waitUntil(10, "outbox drained") { self.synced(relaunched) }
    }

    /// Same word edited on both clients while one is offline: no prompt, the
    /// edit that reaches the server last wins and both clients converge.
    func testConcurrentEditsOfSameWordConvergeSilently() async throws {
        let tag = self.tag
        let a = try await launch(port: stack.appPort)
        let b = try await launch(port: stack.app2Port)
        a.voiceVocabularyStore.upsert(VoiceTerm(term: "\(tag) Word", heardAs: "original"))
        try await waitUntil(10, "B has it") { self.words(b) == ["\(tag) Word = original"] }

        try await control("/fault", ["link": "app", "refuse": true])
        try await control("/reset", ["link": "app"])
        try await waitUntil(15, "A offline") { a.connectionStatus != .connected }
        var onA = a.voiceVocabularyStore.terms.first { $0.term.hasPrefix(tag) }!
        onA.heardAs = "from A"
        a.voiceVocabularyStore.upsert(onA)
        var onB = b.voiceVocabularyStore.terms.first { $0.term.hasPrefix(tag) }!
        onB.heardAs = "from B"
        b.voiceVocabularyStore.upsert(onB)
        try await waitUntil(10, "B acknowledged") { self.synced(b) }

        try await control("/heal")
        let expected: Set<String> = ["\(tag) Word = from A"]
        try await waitUntil(20, "converged on A's later edit") { self.words(a) == expected && self.words(b) == expected }
        try await waitUntil(10, "settled") { self.synced(a) }
    }

    /// Deleted on one client while the other edits it offline: the later edit
    /// brings the word back with that edit, on both clients.
    func testOfflineEditOfWordDeletedElsewhereKeepsTheEdit() async throws {
        let tag = self.tag
        let a = try await launch(port: stack.appPort)
        let b = try await launch(port: stack.app2Port)
        a.voiceVocabularyStore.upsert(VoiceTerm(term: "\(tag) Word"))
        try await waitUntil(10, "B has it") { self.words(b) == ["\(tag) Word"] }

        try await control("/fault", ["link": "app", "refuse": true])
        try await control("/reset", ["link": "app"])
        try await waitUntil(15, "A offline") { a.connectionStatus != .connected }
        var onA = a.voiceVocabularyStore.terms.first { $0.term.hasPrefix(tag) }!
        onA.heardAs = "kept"
        a.voiceVocabularyStore.upsert(onA)
        b.voiceVocabularyStore.remove(b.voiceVocabularyStore.terms.first { $0.term.hasPrefix(tag) }!.id)
        try await waitUntil(10, "B's delete acknowledged") { self.synced(b) && self.words(b).isEmpty }

        try await control("/heal")
        let expected: Set<String> = ["\(tag) Word = kept"]
        try await waitUntil(20, "both show the edited word") { self.words(a) == expected && self.words(b) == expected }
    }
}
