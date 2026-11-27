import XCTest
@testable import Kraki

/// A write never checkpoints the WAL itself: SQLite's automatic checkpoint ran
/// inside the commit that crossed 1000 pages, and live messages are written on
/// the main thread (production `provider.ingest_messages`: up to 364 ms with
/// 2 ms of CPU). The checkpoint runs afterwards on GRDB's writer queue.
final class MessageDatabaseCheckpointTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("checkpoint-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var databaseURL: URL { root.appendingPathComponent("messages.sqlite") }

    private func fileSize(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
    }

    /// ~6 KB of payload each: 400 of them are well past SQLite's 1000-page
    /// (4 MB) automatic checkpoint threshold.
    private func writeOneByOne(_ db: MessageDatabase, count: Int = 400) throws {
        let body = String(repeating: "这是一段比较典型的回答内容，包含 **加粗**、`inline code`。", count: 60)
        for seq in 1...count {
            try db.insert("s", [ChatMessage(type: "agent_message", seq: seq, sessionId: "s", deviceId: "d",
                                            timestamp: "2026-10-08T10:00:00.000Z",
                                            payload: ["content": AnyCodable("\(body) \(seq)")])])
        }
    }

    func testWritesLeaveTheDatabaseFileToTheBackgroundCheckpoint() throws {
        let db = try MessageDatabase(databaseURL: databaseURL, checkpointDelay: 3_600)
        let before = fileSize(databaseURL)
        try writeOneByOne(db)
        XCTAssertGreaterThan(fileSize(URL(fileURLWithPath: databaseURL.path + "-wal")), 4 * 1024 * 1024,
                             "the writes are in the WAL")
        XCTAssertEqual(fileSize(databaseURL), before,
                       "no write copied WAL pages into the database file (an in-commit checkpoint)")
        XCTAssertEqual(db.recentMessages("s", limit: 1_000).count, 400)
    }

    func testBackgroundCheckpointCopiesTheWALIntoTheDatabaseFile() throws {
        let db = try MessageDatabase(databaseURL: databaseURL, checkpointDelay: 0.05)
        let before = fileSize(databaseURL)
        try writeOneByOne(db)
        let deadline = Date().addingTimeInterval(10)
        // 400 rows of ~5 KB: the checkpointed file holds about 2 MB of them.
        while fileSize(databaseURL) < before + 1_500_000, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertGreaterThanOrEqual(fileSize(databaseURL), before + 1_500_000, "checkpointed after the burst")
        XCTAssertEqual(db.recentMessages("s", limit: 1_000).count, 400)
    }

    /// Rows that so far exist only in the WAL are read by a new connection:
    /// the first one stays open, so closing it cannot checkpoint them first.
    func testWALOnlyWritesAreReadByAnotherConnection() throws {
        let db = try MessageDatabase(databaseURL: databaseURL, checkpointDelay: 3_600)
        let before = fileSize(databaseURL)
        try writeOneByOne(db, count: 50)
        XCTAssertEqual(fileSize(databaseURL), before, "nothing checkpointed yet")
        let other = try MessageDatabase(databaseURL: databaseURL, checkpointDelay: 3_600)
        XCTAssertEqual(other.recentMessages("s", limit: 1_000).count, 50)
        XCTAssertEqual(other.lastSeq("s"), 50)
        withExtendedLifetime(db) {}
    }
}
