/// MessageDatabase — GRDB-backed persistent store for chat messages.
///
/// Single SQLite file at `<ApplicationSupport>/Kraki/messages.sqlite`,
/// shared across all sessions. Replaces the old per-session JSONL
/// files in `MessageCache/`. Schema is intentionally minimal: the
/// full `ChatMessage` is JSON-encoded into a `payload` BLOB so
/// `ChatMessage` field evolution doesn't require schema migration —
/// only stable identity columns sit in the table proper.
///
/// Used as the persistence backend for `MessageStore`. Not accessed
/// directly by any other layer.
///
/// WAL mode is enabled so reads never block writes; writes are
/// serialised by GRDB's `DatabasePool`.

import Foundation
import GRDB

/// Thin wrapper around a `DatabasePool` that exposes the message
/// queries `MessageStore` needs. All methods are synchronous because
/// GRDB's pool already serialises writes and SQLite reads are fast
/// enough at the scale we care about (≤ a few ms for any of these).
final class MessageDatabase {

    // MARK: - Schema constants

    /// Bumped on any breaking schema change. The migrator below is
    /// idempotent — re-running it from a higher version on an empty
    /// DB is fine; downgrading is not supported.
    private static let schemaVersion = "v1"
    /// Pure-spine migration: PR #154 moved tools/narration/permission/question
    /// off the spine, so old rows + their (now-mismatched) seqs are garbage.
    /// No back-compat — drop and recreate the table for a clean slate.
    private static let schemaVersionPureSpine = "v2_pure_spine"

    // MARK: - State

    private let dbPool: DatabasePool

    // MARK: - Init

    /// Opens (or creates) the database at the standard application
    /// path. Throws if the directory can't be created or the pool
    /// can't be opened — the caller (AppState) should treat this as
    /// fatal because the chat surface is unusable without it.
    init() throws {
        let url = try Self.databaseURL()
        var config = Configuration()
        config.prepareDatabase { db in
            // WAL gives readers concurrent access while a single
            // writer is in progress — essential for "ChatView reads
            // window while live messages are appending" not blocking.
            try db.execute(sql: "PRAGMA journal_mode = WAL")
            // NORMAL synchronous is the SQLite-recommended sweet
            // spot for WAL: every write is durable to OS cache; only
            // a power-loss event in the few-second WAL checkpoint
            // window could lose the last transaction. Acceptable for
            // a chat cache backed by server replay.
            try db.execute(sql: "PRAGMA synchronous = NORMAL")
            // foreign_keys would matter once we add session metadata
            // joins; on by default to catch logic bugs early.
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        self.dbPool = try DatabasePool(path: url.path, configuration: config)

        var migrator = DatabaseMigrator()
        Self.registerMigrations(&migrator)
        try migrator.migrate(dbPool)
    }

    // MARK: - Migrations

    private static func registerMigrations(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration(schemaVersion) { db in
            // PRIMARY KEY (session_id, seq, type) preserves the
            // existing dedup invariant from the JSONL era:
            // re-broadcasts and replay overlaps `INSERT OR REPLACE`
            // on the same row instead of duplicating.
            try db.execute(sql: """
                CREATE TABLE messages (
                    session_id TEXT    NOT NULL,
                    seq        INTEGER NOT NULL,
                    type       TEXT    NOT NULL,
                    timestamp  INTEGER,
                    payload    BLOB    NOT NULL,
                    PRIMARY KEY (session_id, seq, type)
                ) WITHOUT ROWID
                """)
            // The hot path index. `(session_id, seq)` covers:
            //   - SELECT WHERE session_id = ? AND seq BETWEEN a AND b
            //   - SELECT WHERE session_id = ? ORDER BY seq DESC LIMIT N
            //   - SELECT 1 WHERE session_id = ? AND seq = ?  (has check)
            //   - MAX(seq) WHERE session_id = ?               (dbLastSeq)
            // The PRIMARY KEY's prefix already gives most of this, but
            // the explicit index ensures range/order queries pick it
            // even when SQLite's planner is being conservative.
            try db.execute(sql: """
                CREATE INDEX idx_messages_session_seq
                ON messages (session_id, seq)
                """)
        }
        migrator.registerMigration(schemaVersionPureSpine) { db in
            // Clean wipe: seqs from the old "every-event" model don't line up
            // with the new dense spine-only seqs. Server replay repopulates.
            try db.execute(sql: "DROP TABLE IF EXISTS messages")
            try db.execute(sql: """
                CREATE TABLE messages (
                    session_id TEXT    NOT NULL,
                    seq        INTEGER NOT NULL,
                    type       TEXT    NOT NULL,
                    timestamp  INTEGER,
                    payload    BLOB    NOT NULL,
                    PRIMARY KEY (session_id, seq, type)
                ) WITHOUT ROWID
                """)
            try db.execute(sql: """
                CREATE INDEX idx_messages_session_seq
                ON messages (session_id, seq)
                """)
        }
    }

    // MARK: - File location

    private static func databaseURL() throws -> URL {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("Kraki", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("messages.sqlite", isDirectory: false)
    }

    // MARK: - Write

    /// Upsert a batch of messages. Uses INSERT OR REPLACE so a
    /// re-broadcast of a row with the same (session, seq, type) wins
    /// the later content — matches the JSONL era's "last write wins"
    /// dedup. Caller is responsible for filtering to persistent types.
    func insert(_ sessionId: String, _ messages: [ChatMessage]) throws {
        guard !messages.isEmpty else { return }
        try dbPool.write { db in
            let encoder = JSONEncoder()
            for msg in messages {
                guard msg.seq > 0 else { continue }
                let payload = try encoder.encode(msg)
                let ts = msg.timestamp.flatMap(Self.parseISOToMillis)
                try db.execute(
                    sql: """
                        INSERT OR REPLACE INTO messages
                        (session_id, seq, type, timestamp, payload)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                    arguments: [sessionId, msg.seq, msg.type, ts, payload]
                )
            }
        }
    }

    /// Delete every message for a session. Called on session
    /// deletion. The accompanying SQLite delete is cheap on the
    /// `(session_id, seq)` index.
    func deleteSession(_ sessionId: String) throws {
        try dbPool.write { db in
            try db.execute(
                sql: "DELETE FROM messages WHERE session_id = ?",
                arguments: [sessionId]
            )
        }
    }

    /// Drop every cached message above `seq` for a session. Used by
    /// tentacle-restart recovery: if the relay reports a `lastSeq`
    /// lower than what we have, our local rows above that seq are
    /// stale from a previous tentacle incarnation and would
    /// otherwise trick `requestLatest`'s short-circuit.
    func dropAboveSeq(_ sessionId: String, seq: Int) throws {
        try dbPool.write { db in
            try db.execute(
                sql: "DELETE FROM messages WHERE session_id = ? AND seq > ?",
                arguments: [sessionId, seq]
            )
        }
    }

    /// Wipe everything. Logout / factory reset only.
    func deleteAll() throws {
        try dbPool.write { db in
            try db.execute(sql: "DELETE FROM messages")
        }
    }

    // MARK: - Read

    /// Messages in the inclusive seq range `[from, to]`, sorted
    /// ascending. Returns the empty array if nothing matches.
    func messages(_ sessionId: String, from: Int, to: Int) -> [ChatMessage] {
        do {
            return try dbPool.read { db in
                let rows = try Row.fetchAll(
                    db,
                    sql: """
                        SELECT payload FROM messages
                        WHERE session_id = ? AND seq BETWEEN ? AND ?
                        ORDER BY seq ASC
                        """,
                    arguments: [sessionId, from, to]
                )
                return Self.decode(rows)
            }
        } catch {
            return []
        }
    }

    /// The last `limit` messages by seq, sorted ascending. Used to
    /// bootstrap a session's initial window and to feed preview
    /// recomputation without loading the whole session.
    func recentMessages(_ sessionId: String, limit: Int) -> [ChatMessage] {
        do {
            return try dbPool.read { db in
                let rows = try Row.fetchAll(
                    db,
                    sql: """
                        SELECT payload FROM messages
                        WHERE session_id = ?
                        ORDER BY seq DESC
                        LIMIT ?
                        """,
                    arguments: [sessionId, limit]
                )
                // Decode then reverse — we asked DESC for the LIMIT
                // to bite the latest rows, but the consumer wants
                // chronological order.
                return Self.decode(rows).reversed()
            }
        } catch {
            return []
        }
    }

    /// Largest seq for a session, or 0 if nothing is cached.
    func lastSeq(_ sessionId: String) -> Int {
        do {
            return try dbPool.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT MAX(seq) FROM messages WHERE session_id = ?",
                    arguments: [sessionId]
                ) ?? 0
            }
        } catch {
            return 0
        }
    }

    /// Whether any row with this exact seq exists for the session.
    /// Used by `MessageProvider` to short-circuit "do I need to ask
    /// tentacle for this?" without loading anything into memory.
    func hasMessage(_ sessionId: String, seq: Int) -> Bool {
        do {
            return try dbPool.read { db in
                try Int.fetchOne(
                    db,
                    sql: """
                        SELECT 1 FROM messages
                        WHERE session_id = ? AND seq = ?
                        LIMIT 1
                        """,
                    arguments: [sessionId, seq]
                ) != nil
            }
        } catch {
            return false
        }
    }

    // MARK: - Internal

    private static func decode(_ rows: [Row]) -> [ChatMessage] {
        let decoder = JSONDecoder()
        var out: [ChatMessage] = []
        out.reserveCapacity(rows.count)
        for row in rows {
            guard let payload: Data = row["payload"] else { continue }
            if let msg = try? decoder.decode(ChatMessage.self, from: payload) {
                out.append(msg)
            }
        }
        return out
    }

    /// ChatMessage.timestamp is an ISO-8601 string in the protocol.
    /// We store it as Unix milliseconds so future indexes / time-
    /// ordered queries can use INTEGER comparison directly. Nil
    /// timestamps are stored as NULL.
    private static func parseISOToMillis(_ iso: String) -> Int64? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return Int64(d.timeIntervalSince1970 * 1000) }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: iso) { return Int64(d.timeIntervalSince1970 * 1000) }
        return nil
    }
}
