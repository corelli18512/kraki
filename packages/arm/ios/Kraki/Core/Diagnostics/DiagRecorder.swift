#if KRAKI_DIAG
import Foundation
import MachO
import zlib

/// These types deliberately have no arbitrary log message / text / error field.
/// Keep in sync with the receiver allowlist in head/src/diag-api.ts.
enum DiagEventName: String, Codable {
    case launch = "app.launch", phase = "app.phase", connection = "ws.state"
    case uiAnswer = "ui.answer", uiMouse = "ui.mouse", answer = "cmd.answer", input = "cmd.input", result = "cmd.result", handoff = "cmd.handoff"
    case outbox = "outbox.state", echo = "echo.input", health = "diag.health", upload = "diag.upload", slowWork = "work.slow"
    case busy = "ui.busy", marker = "user.marker", voice = "voice.action", list = "list.snapshot", navigation = "session.view"
}
enum DiagField: String {
    case clientId, questionId, answerTo, ix, origin, phase, state, source, stack
    case textLength, attachments, pending, messageSeq, matched, accepted, duplicate
    case restored, count, dropped, durationMs, clickCount, eventNumber, attempt, status, bytes, events, firstSeq, lastSeq
}
enum DiagValue: Encodable {
    case id(String), tag(String), number(Double), bool(Bool)
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .id(let value), .tag(let value): try c.encode(String(value.prefix(512)))
        case .number(let value): try c.encode(value.isFinite ? max(0, value) : 0)
        case .bool(let value): try c.encode(value)
        }
    }
    static func int(_ value: Int) -> Self { .number(Double(value)) }
}
struct DiagEvent: Encodable {
    let t: Double
    let m: Double
    let seq: UInt64
    let ev: DiagEventName
    let sid: String?
    let d: [String: DiagValue]
}
struct DiagBatch: Encodable {
    let schema = 1
    let batchId: String
    let processId: String
    let platform: String
    let version: String
    let build: String
    let events: [DiagEvent]
    let image = DiagImage.current
}

/// Main binary identity/load address for offline atos symbolication. No paths.
struct DiagImage: Encodable {
    let uuid: String
    let base: String
    let os: String
    let arch: String
    static let current: DiagImage = {
        var uuid = "00000000-0000-0000-0000-000000000000"
        var base = "0x0"
        if let header = _dyld_get_image_header(0), header.pointee.magic == MH_MAGIC_64 {
            let raw = UnsafeRawPointer(header)
            let info = raw.load(as: mach_header_64.self)
            base = "0x" + String(UInt(bitPattern: raw), radix: 16)
            var offset = MemoryLayout<mach_header_64>.size
            let end = offset + Int(info.sizeofcmds)
            for _ in 0..<info.ncmds {
                guard offset + MemoryLayout<load_command>.size <= end else { break }
                let command = raw.advanced(by: offset).load(as: load_command.self)
                guard command.cmdsize >= MemoryLayout<load_command>.size, offset + Int(command.cmdsize) <= end else { break }
                if command.cmd == LC_UUID, command.cmdsize >= MemoryLayout<uuid_command>.size {
                    uuid = UUID(uuid: raw.advanced(by: offset).load(as: uuid_command.self).uuid).uuidString
                    break
                }
                offset += Int(command.cmdsize)
            }
        }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        return DiagImage(uuid: uuid, base: base, os: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)", arch: arch)
    }()
}

/// A bounded, nonblocking producer queue. No Task/Dispatch async per event (which
/// would hide an unbounded backlog). Contention drops a record, never waits on UI.
/// Only the consumer encodes, compresses or performs IO. No lock-free algorithm.
final class DiagRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [DiagEvent] = []
    private var enabled = true
    private var sequence: UInt64 = 0
    private var dropped: UInt64 = 0
    private var second = 0
    private var admitted = 0
    let capacity: Int
    let perSecond: Int
    let processId = UUID().uuidString

    init(capacity: Int = 1024, perSecond: Int = 200) {
        self.capacity = capacity; self.perSecond = perSecond
        pending.reserveCapacity(capacity)
    }
    @discardableResult
    func record(_ name: DiagEventName, session: String? = nil, _ fields: [DiagField: DiagValue] = [:]) -> Bool {
        guard lock.try() else { return false } // contention intentionally not counted: no second lock
        defer { lock.unlock() }
        guard enabled else { return false }
        sequence &+= 1 // gaps identify admitted-queue/rate drops within this process
        let mono = ProcessInfo.processInfo.systemUptime
        if Int(mono) != second { second = Int(mono); admitted = 0 }
        guard pending.count < capacity, admitted < perSecond else { dropped &+= 1; return false }
        admitted += 1
        pending.append(DiagEvent(t: Date().timeIntervalSince1970 * 1000, m: mono * 1000,
            seq: sequence, ev: name, sid: session.map { String($0.prefix(128)) },
            d: Dictionary(uniqueKeysWithValues: fields.map { ($0.key.rawValue, $0.value) })))
        return true
    }
    var isEnabled: Bool {
        guard lock.try() else { return false }
        defer { lock.unlock() }
        return enabled
    }
    func setEnabled(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        enabled = value
        if !value { pending.removeAll(keepingCapacity: true); dropped = 0 }
    }
    func drain() -> (events: [DiagEvent], dropped: UInt64) {
        lock.lock(); defer { lock.unlock() }
        let result = (pending, dropped)
        pending = []; pending.reserveCapacity(capacity); dropped = 0
        return result
    }
}

/// Private bounded spool. Called exclusively from the diagnostics utility queue.
/// Files are compressed *complete* batches, so an ACK loss retries identical bytes.
final class DiagSpool {
    struct Segment {
        let url: URL
        let bytes: Int
    }
    let directory: URL
    let maxBytes: Int
    let maxFiles: Int
    private(set) var segments: [Segment] = []
    private(set) var evicted = 0
    var bytes: Int { segments.reduce(0) { $0 + $1.bytes } }

    init(directory: URL, maxBytes: Int = 50 * 1024 * 1024, maxFiles: Int = 2048) throws {
        self.directory = directory; self.maxBytes = maxBytes; self.maxFiles = maxFiles
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var dir = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where Self.isSegment(file) {
            let info = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard info.isRegularFile == true else { continue }
            segments.append(Segment(url: file, bytes: info.fileSize ?? 0))
        }
        trim()
    }
    private static func isSegment(_ url: URL) -> Bool {
        let parts = url.deletingPathExtension().lastPathComponent.split(separator: "_", maxSplits: 1)
        return url.pathExtension == "gz" && parts.count == 2 && Int64(parts[0]) != nil && UUID(uuidString: String(parts[1])) != nil
    }
    @discardableResult
    func append(_ data: Data, batchId: String) throws -> URL {
        guard UUID(uuidString: batchId) != nil, data.count <= 16 * 1024 else { throw DiagError.size }
        let file = directory.appendingPathComponent("\(Int64(Date().timeIntervalSince1970 * 1000))_\(batchId).gz")
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        segments.append(Segment(url: file, bytes: data.count)); trim()
        return file
    }
    func remove(_ url: URL) {
        guard segments.contains(where: { $0.url == url }) else { return }
        do { try FileManager.default.removeItem(at: url) }
        catch { if FileManager.default.fileExists(atPath: url.path) { return } }
        segments.removeAll { $0.url == url }
    }
    func clear() { for segment in segments { remove(segment.url) } }
    private func trim() {
        while bytes > maxBytes || segments.count > maxFiles {
            guard let first = segments.first else { break }
            let count = segments.count
            remove(first.url)
            if segments.count == count { break }
            evicted += 1
        }
    }
}
enum DiagError: Error { case size, compression, unavailable }

func diagGzip(_ input: Data) throws -> Data {
    var stream = z_stream()
    guard deflateInit2_(&stream, Z_BEST_SPEED, Z_DEFLATED, MAX_WBITS + 16, MAX_MEM_LEVEL,
                        Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw DiagError.compression }
    defer { deflateEnd(&stream) }
    var output = Data(count: Int(deflateBound(&stream, uLong(input.count))))
    let result: Int32 = input.withUnsafeBytes { rawInput in
        output.withUnsafeMutableBytes { rawOutput in
            stream.next_in = UnsafeMutablePointer(mutating: rawInput.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(rawInput.count)
            stream.next_out = rawOutput.bindMemory(to: Bytef.self).baseAddress
            stream.avail_out = uInt(rawOutput.count)
            return deflate(&stream, Z_FINISH)
        }
    }
    guard result == Z_STREAM_END else { throw DiagError.compression }
    output.count = Int(stream.total_out)
    return output
}
#endif
