#if os(iOS)
import Foundation

enum MessageBodySegment {
    case inline(String)
    case blockquote(String)
    case codeBlock(language: String?, code: String)
    /// GitHub-Flavored Markdown table. `rows[0]` is the header row;
    /// alignments are per-column (length matches `rows[0].count`).
    /// Stored already-parsed because the table spans multiple lines
    /// and the splitter has the cleanest view of the syntax — no
    /// reason to re-tokenise it downstream.
    case table(rows: [[String]], alignments: [TableAlignment])
}

enum TableAlignment {
    case leading, center, trailing
}

/// Splits a message body into inline text, blockquote, fenced
/// code-block, and GFM table segments. Blockquote lines start with
/// `> `. Code blocks are fenced with triple backticks. Tables follow
/// the GFM shape: a header row (`| a | b |`), a separator row
/// (`| --- | :-: |`) with optional `:` alignment markers, and one or
/// more body rows. Anything that doesn't match falls through to
/// inline markdown.
func splitMessageBody(_ text: String) -> [MessageBodySegment] {
    var segments: [MessageBodySegment] = []
    var inlineBuffer: [String] = []
    var quoteBuffer: [String] = []
    var codeBuffer: [String] = []
    var codeLanguage: String?
    var inCodeBlock = false

    func flushInline() {
        if !inlineBuffer.isEmpty {
            segments.append(.inline(inlineBuffer.joined(separator: "\n")))
            inlineBuffer.removeAll()
        }
    }
    func flushQuote() {
        if !quoteBuffer.isEmpty {
            segments.append(.blockquote(quoteBuffer.joined(separator: "\n")))
            quoteBuffer.removeAll()
        }
    }

    let lines = text.components(separatedBy: "\n")
    var i = 0
    while i < lines.count {
        let line = lines[i]

        if inCodeBlock {
            if line.hasPrefix("```") {
                segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
                codeBuffer.removeAll()
                codeLanguage = nil
                inCodeBlock = false
            } else {
                codeBuffer.append(line)
            }
            i += 1
            continue
        }

        if line.hasPrefix("```") {
            flushInline()
            flushQuote()
            let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            codeLanguage = lang.isEmpty ? nil : lang
            inCodeBlock = true
            i += 1
            continue
        }

        // Table probe: current line looks like a table row AND the
        // next line is a valid separator. Both checks are cheap;
        // most messages won't have any pipes at all and short-circuit
        // immediately.
        if looksLikeTableRow(line),
           i + 1 < lines.count,
           let alignments = parseTableSeparator(lines[i + 1]) {
            let header = parseTableRow(line)
            // Header column count must match the separator column count.
            if header.count == alignments.count {
                flushInline()
                flushQuote()
                var rows: [[String]] = [header]
                var j = i + 2
                while j < lines.count {
                    let r = lines[j]
                    if !looksLikeTableRow(r) { break }
                    let row = parseTableRow(r)
                    // Pad/truncate so every row has the same column
                    // count — GFM-compatible.
                    var padded = row
                    if padded.count < alignments.count {
                        padded += Array(repeating: "", count: alignments.count - padded.count)
                    } else if padded.count > alignments.count {
                        padded = Array(padded.prefix(alignments.count))
                    }
                    rows.append(padded)
                    j += 1
                }
                segments.append(.table(rows: rows, alignments: alignments))
                i = j
                continue
            }
        }

        // Blockquote: line starts with "> " or is exactly ">".
        if line.hasPrefix("> ") || line == ">" {
            flushInline()
            let content = line == ">" ? "" : String(line.dropFirst(2))
            quoteBuffer.append(content)
            i += 1
            continue
        }

        // Empty line between quote lines ends the quote group.
        if line.isEmpty, !quoteBuffer.isEmpty {
            flushQuote()
            inlineBuffer.append(line)
            i += 1
            continue
        }

        flushQuote()
        inlineBuffer.append(line)
        i += 1
    }

    if inCodeBlock {
        segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
    }
    flushQuote()
    flushInline()

    return segments
}

// MARK: - GFM table helpers

/// Cheap "could this be a table row?" check. Triggers on any line
/// that contains at least one pipe AND isn't an obvious non-table
/// (fenced code, blockquote). Real validation happens via
/// `parseTableSeparator` on the next line; this is just a fast gate
/// so non-table messages skip the more expensive checks.
func looksLikeTableRow(_ line: String) -> Bool {
    guard line.contains("|") else { return false }
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("```") || trimmed.hasPrefix("> ") || trimmed == ">" {
        return false
    }
    return true
}

/// Parses a separator row like `| :--- | :-: | ---: |` into per-
/// column alignments. Returns nil if the line isn't a valid GFM
/// separator (any cell that doesn't match `:?-+:?`).
func parseTableSeparator(_ line: String) -> [TableAlignment]? {
    let cells = parseTableRow(line)
    guard !cells.isEmpty else { return nil }
    var alignments: [TableAlignment] = []
    for cell in cells {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let hasLeftColon = trimmed.hasPrefix(":")
        let hasRightColon = trimmed.hasSuffix(":")
        // Strip leading/trailing colons before verifying the dashes.
        var dashes = trimmed
        if hasLeftColon { dashes.removeFirst() }
        if hasRightColon { dashes.removeLast() }
        guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
        switch (hasLeftColon, hasRightColon) {
        case (true, true):  alignments.append(.center)
        case (false, true): alignments.append(.trailing)
        default:            alignments.append(.leading)
        }
    }
    return alignments
}

/// Splits one table row into trimmed cells. Strips the optional
/// leading/trailing pipe wrappers GFM allows.
func parseTableRow(_ line: String) -> [String] {
    var s = Substring(line)
    if s.first == "|" { s = s.dropFirst() }
    if s.last == "|" { s = s.dropLast() }
    return s.split(separator: "|", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
}
#endif
