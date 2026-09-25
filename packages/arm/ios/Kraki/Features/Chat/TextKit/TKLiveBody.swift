#if os(iOS)
import UIKit

/// Memoized rendering of inline markdown lines for one streaming body.
final class TKInlineLineCache {
    private(set) var pieces: [String: NSAttributedString] = [:]

    func store(_ line: String, _ piece: NSAttributedString) {
        if pieces.count > 2_000 { pieces.removeAll(keepingCapacity: true) }
        pieces[line] = piece
    }
}

/// Incremental rendering + measurement for one Session's streaming draft.
///
/// A streaming answer grows at its tail. Re-parsing, re-measuring and
/// re-assigning the whole body on every chunk makes each update O(text), so a
/// long answer degrades to ~10 fps. This object keeps:
///   • parsed markdown segments, reused positionally while their source is
///     unchanged (only the changed tail segment is rebuilt);
///   • a short history of "changed from" offsets.
/// Rendering/measurement cost is bounded separately by `TKBodyChunks`: only
/// the last chunk of a long body changes while it streams.
final class TKLiveBody {
    nonisolated(unsafe) private static var registry: [String: TKLiveBody] = [:]

    /// One live body per Session. The draft is keep-last, so a replacement
    /// (reset) is simply a diff whose first changed segment is early.
    static func forSession(_ sessionId: String) -> TKLiveBody {
        if let existing = registry[sessionId] { return existing }
        let created = TKLiveBody()
        registry[sessionId] = created
        return created
    }

    static func discard(_ sessionId: String) {
        registry.removeValue(forKey: sessionId)
    }

    private(set) var text = ""
    private(set) var revision = 0

    private var keys: [String] = []
    private var pieces: [NSAttributedString] = []
    private var pieceStarts: [Int] = []
    private let storage = NSMutableAttributedString()
    private var changes: [(revision: Int, from: Int)] = []
    private let lineCache = TKInlineLineCache()
    private var snapshot: NSAttributedString?

    /// Immutable snapshot of the rendered body for this revision.
    var body: NSAttributedString? {
        guard storage.length > 0 else { return nil }
        if let snapshot { return snapshot }
        let copy = NSAttributedString(attributedString: storage)
        snapshot = copy
        return copy
    }

    /// Advance to `newText`. Returns true when the rendered body changed.
    @discardableResult
    func update(_ newText: String) -> Bool {
        guard newText != text else { return false }
        var segments = newText.isEmpty ? [] : splitMessageBody(newText)
        if segments.isEmpty, !newText.isEmpty { segments = [.inline(newText)] }
        let newKeys = segments.map(TKMarkdown.segmentKey)

        var first = 0
        let shared = min(keys.count, newKeys.count)
        while first < shared, keys[first] == newKeys[first] { first += 1 }

        let oldCount = keys.count
        let from = first < oldCount ? pieceStarts[first] : storage.length
        let tail = NSMutableAttributedString()
        var newPieces = Array(pieces.prefix(first))
        var newStarts = Array(pieceStarts.prefix(first))
        var cursor = from
        for index in first..<segments.count {
            if index > 0, index > first || first >= oldCount {
                tail.append(TKMarkdown.segmentSeparator)
                cursor += TKMarkdown.segmentSeparator.length
            }
            let piece = TKMarkdown.segmentPiece(segments[index], allowHighlighting: false, lineCache: lineCache)
            newPieces.append(piece)
            newStarts.append(cursor)
            tail.append(piece)
            cursor += piece.length
        }

        let range = NSRange(location: from, length: storage.length - from)
        storage.replaceCharacters(in: range, with: tail)

        keys = newKeys
        pieces = newPieces
        pieceStarts = newStarts
        text = newText
        revision += 1
        snapshot = nil
        changes.append((revision, from))
        if changes.count > 128 { changes.removeFirst(changes.count - 128) }
        return true
    }

    private var chunkMemo: (width: CGFloat, revision: Int, placed: [TKBodyChunks.Placed])?

    /// Chunk geometry for the current revision. Chunks that end before the
    /// first changed character keep their measured height; only the changed
    /// tail is measured.
    func chunkLayout(width: CGFloat) -> [TKBodyChunks.Placed] {
        guard let body else { return [] }
        if let chunkMemo, chunkMemo.width == width, chunkMemo.revision == revision {
            return chunkMemo.placed
        }
        let previous = chunkMemo?.width == width ? chunkMemo?.placed ?? [] : []
        let unchanged = chunkMemo.flatMap { $0.width == width ? changedFrom(since: $0.revision) : nil } ?? 0
        var y: CGFloat = 0
        var placed: [TKBodyChunks.Placed] = []
        for (index, chunk) in TKBodyChunks.chunks(body).enumerated() {
            y += chunk.gapBefore
            let height: CGFloat
            if index < previous.count, previous[index].range == chunk.range,
               NSMaxRange(chunk.range) <= unchanged {
                height = previous[index].height
            } else {
                let piece = chunk.range.length == body.length ? body : body.attributedSubstring(from: chunk.range)
                height = TKBodyChunks.height(piece, width: width)
            }
            placed.append(TKBodyChunks.Placed(range: chunk.range, y: y, height: height))
            y += height
        }
        chunkMemo = (width, revision, placed)
        return placed
    }

    /// Earliest character changed after `revision`, or nil when the history no
    /// longer covers it (caller must replace the whole text).
    func changedFrom(since previous: Int) -> Int? {
        guard previous <= revision else { return nil }
        if previous == revision { return storage.length }
        guard let oldest = changes.first, oldest.revision <= previous + 1 else { return nil }
        return changes.lazy.filter { $0.revision > previous }.map(\.from).min()
    }

}

/// Deterministic split of a long rendered body into paragraph-aligned chunks,
/// each shown by its own TextKit view.
///
/// One text view holding a whole long answer re-runs viewport layout over
/// every paragraph whenever its text or bounds change (≈45 ms per streaming
/// update at 8k characters). With chunks, a streaming update touches only the
/// last chunk; settled chunks are measured and laid out once. Both the live
/// bubble and the landed message use this same rule, so the handoff is exact.
///
/// A boundary depends only on the text before it, so boundaries never move as
/// an answer grows. Chunks never split a code block, quote or table.
enum TKBodyChunks {
    static let targetLength = 500
    static let singleChunkLimit = 800

    struct Chunk {
        let range: NSRange
        let gapBefore: CGFloat
    }

    struct Placed {
        let range: NSRange
        let y: CGFloat
        let height: CGFloat
    }

    static func chunks(_ body: NSAttributedString) -> [Chunk] {
        let ns = body.string as NSString
        let length = ns.length
        guard length > singleChunkLimit else {
            return [Chunk(range: NSRange(location: 0, length: length), gapBefore: 0)]
        }
        var result: [Chunk] = []
        var start = 0
        var gap: CGFloat = 0
        var search = targetLength
        while search < length {
            let found = ns.range(of: "\n", options: [], range: NSRange(location: search, length: length - search))
            guard found.location != NSNotFound else { break }
            let newline = found.location
            guard newline + 1 < length else { break }
            if isSafeBoundary(body, newline) {
                result.append(Chunk(range: NSRange(location: start, length: newline - start), gapBefore: gap))
                gap = spacing(body, newline: newline)
                start = newline + 1
                search = start + targetLength
            } else {
                search = newline + 1
            }
        }
        result.append(Chunk(range: NSRange(location: start, length: length - start), gapBefore: gap))
        return result
    }

    private static func isSafeBoundary(_ body: NSAttributedString, _ newline: Int) -> Bool {
        guard newline > 0 else { return false }
        if body.attribute(.tkBlockID, at: newline, effectiveRange: nil) != nil { return false }
        let before = body.attribute(.tkBlockID, at: newline - 1, effectiveRange: nil) as? String
        let after = body.attribute(.tkBlockID, at: newline + 1, effectiveRange: nil) as? String
        return before == nil || before != after
    }

    private static func spacing(_ body: NSAttributedString, newline: Int) -> CGFloat {
        let before = body.attribute(.paragraphStyle, at: max(0, newline - 1), effectiveRange: nil) as? NSParagraphStyle
        let after = body.attribute(.paragraphStyle, at: newline + 1, effectiveRange: nil) as? NSParagraphStyle
        return (before?.paragraphSpacing ?? 0) + (after?.paragraphSpacingBefore ?? 0)
    }

    nonisolated(unsafe) private static let heightCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 4_000
        return cache
    }()

    /// Exact height of one chunk (cached by width + content).
    static func height(_ chunk: NSAttributedString, width: CGFloat) -> CGFloat {
        let key = "\(Int(width * 2))\u{1F}\(chunk.length)\u{1F}\(chunk.string)" as NSString
        if let hit = heightCache.object(forKey: key) { return CGFloat(hit.doubleValue) }
        let measured = TKMeasure.height(chunk, width: width)
        heightCache.setObject(NSNumber(value: Double(measured)), forKey: key)
        return measured
    }

    static func layout(_ body: NSAttributedString, width: CGFloat) -> [Placed] {
        var y: CGFloat = 0
        var placed: [Placed] = []
        for chunk in chunks(body) {
            y += chunk.gapBefore
            let piece = chunk.range.length == body.length ? body : body.attributedSubstring(from: chunk.range)
            let h = height(piece, width: width)
            placed.append(Placed(range: chunk.range, y: y, height: h))
            y += h
        }
        return placed
    }
}
#endif
