import Foundation

/// A tool's arguments or result as a Steps row shows it. A whole multi-MB
/// result in one `Text` blocked the main thread for seconds per expand and
/// drew an empty box (K-050): show its first `limit` bytes and say so.
struct ToolResultPreview: Equatable {
    static let limit = 32 * 1024
    /// Largest arguments payload parsed into `key: value` lines. The preview
    /// is built in the view body, so a bigger one (a multi-MB write) shows
    /// its raw head instead of parsing megabytes of JSON on every render.
    static let argumentsParseLimit = 256 * 1024

    let text: String
    /// Bytes not shown (0 when the whole result is shown).
    let omittedBytes: Int
    let totalBytes: Int

    /// Nil when the bytes are not UTF-8 text.
    init?(_ data: Data, limit: Int = Self.limit) {
        totalBytes = data.count
        guard data.count > limit else {
            guard let whole = String(data: data, encoding: .utf8) else { return nil }
            text = whole
            omittedBytes = 0
            return
        }
        // Cut on a UTF-8 character boundary (never after a lead byte or
        // inside a continuation run).
        var end = data.startIndex + limit
        while end > data.startIndex, data[end] & 0xC0 == 0x80 { end -= 1 }
        guard let head = String(data: data[data.startIndex..<end], encoding: .utf8) else { return nil }
        text = head
        omittedBytes = data.count - (end - data.startIndex)
    }

    /// A tool's arguments (a JSON object) as sorted `key: value` lines, strings
    /// verbatim, like the web Steps. The raw JSON showed an edit's text as one
    /// escaped blob with literal `\n` (K-051). Not an object, or larger than
    /// `argumentsParseLimit`: shown as is.
    static func arguments(_ data: Data, limit: Int = Self.limit) -> ToolResultPreview? {
        guard data.count <= argumentsParseLimit,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ToolResultPreview(data, limit: limit)
        }
        let lines = object.keys.sorted().map { key -> String in
            let value = object[key]
            if let string = value as? String { return "\(key): \(string)" }
            guard let value, !(value is NSNull) else { return "\(key): null" }
            let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]
            let json = (try? JSONSerialization.data(withJSONObject: value, options: options))
                .flatMap { String(data: $0, encoding: .utf8) } ?? String(describing: value)
            return "\(key): \(json)"
        }
        return ToolResultPreview(Data(lines.joined(separator: "\n").utf8), limit: limit)
    }

    /// "Showing the first 32 KB of 5 MB." when cut.
    var truncationNotice: String? {
        guard omittedBytes > 0 else { return nil }
        let shown = ByteCountFormatter.string(fromByteCount: Int64(totalBytes - omittedBytes), countStyle: .file)
        let total = ByteCountFormatter.string(fromByteCount: Int64(totalBytes), countStyle: .file)
        return String(localized: "Showing the first \(shown) of \(total).")
    }
}
