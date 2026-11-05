import SQLite3
import XCTest
@testable import Kraki_Dev

/// A full disk makes message cache writes fail. That must be noticed (and
/// logged once, in release builds too) instead of swallowed by a debug-only
/// log, and recover by itself once writes work again (K-353).
@MainActor
final class MessageCacheWriteFailureTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("cache-write-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    /// Runs SQL on the cache file through a second connection.
    private func exec(_ sql: String, on url: URL) throws {
        var handle: OpaquePointer?
        guard sqlite3_open(url.path, &handle) == SQLITE_OK else { throw XCTSkip("cannot open the cache file") }
        defer { sqlite3_close(handle) }
        XCTAssertEqual(sqlite3_exec(handle, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(handle)))
    }

    private func message(_ seq: Int) -> ChatMessage {
        ChatMessage(type: "user_message", seq: seq, sessionId: "S", deviceId: nil, timestamp: nil,
                    payload: ["content": AnyCodable("m\(seq)")])
    }

    func testFailedCacheWritesAreNoticedAndRecover() throws {
        let url = root.appendingPathComponent("m.sqlite")
        let store = MessageStore(db: try MessageDatabase(databaseURL: url))
        store.persist("S", [message(1)])
        XCTAssertFalse(store.cacheWritesFailing)

        // The disk is full: every insert fails.
        try exec("CREATE TRIGGER disk_full BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END;", on: url)
        store.persist("S", [message(2)])
        XCTAssertTrue(store.cacheWritesFailing)
        store.append("S", message(3))
        XCTAssertTrue(store.cacheWritesFailing)
        XCTAssertEqual(store.persistedHead("S"), 1, "the gap stays so the history is fetched again")

        // Space is back.
        try exec("DROP TRIGGER disk_full;", on: url)
        store.persist("S", [message(2), message(3)])
        XCTAssertFalse(store.cacheWritesFailing)
        XCTAssertEqual(store.persistedHead("S"), 3)
    }
}
