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

// MARK: - Shared inline semantics

struct MarkdownInlineRun: Equatable {
    var text: String
    var bold: Bool = false
    var italic: Bool = false
    var code: Bool = false
    var strikethrough: Bool = false
    var link: URL? = nil
}

struct MarkdownListItem: Equatable {
    let ordered: Bool
    let number: Int
    let depth: Int
    let text: String
}

enum MarkdownInlineLine: Equatable {
    case heading(level: Int, text: String)
    case list(MarkdownListItem)
    case text(String)
}

/// One lightweight inline parser feeds both native attributed-string renderers.
/// It intentionally covers the product surface we render: emphasis, strong,
/// code, strike, links, and escaping. Block syntax is handled separately below.
func parseMarkdownInline(_ text: String) -> [MarkdownInlineRun] {
    func parse(
        _ fragment: String,
        bold: Bool,
        italic: Bool,
        strikethrough: Bool,
        link: URL?
    ) -> [MarkdownInlineRun] {
        var runs: [MarkdownInlineRun] = []
        var index = fragment.startIndex
        var plainStart = index

        func append(_ value: String, code: Bool = false, overrideLink: URL? = nil) {
            guard !value.isEmpty else { return }
            let run = MarkdownInlineRun(
                text: value,
                bold: bold,
                italic: italic,
                code: code,
                strikethrough: strikethrough,
                link: overrideLink ?? link
            )
            if let last = runs.last,
               last.bold == run.bold,
               last.italic == run.italic,
               last.code == run.code,
               last.strikethrough == run.strikethrough,
               last.link == run.link {
                runs[runs.count - 1].text += value
            } else {
                runs.append(run)
            }
        }

        func appendNested(
            _ value: String,
            bold nestedBold: Bool = bold,
            italic nestedItalic: Bool = italic,
            strike nestedStrike: Bool = strikethrough,
            link nestedLink: URL? = nil
        ) {
            runs.append(contentsOf: parse(
                value,
                bold: nestedBold,
                italic: nestedItalic,
                strikethrough: nestedStrike,
                link: nestedLink ?? link
            ))
        }

        // Emphasis delimiters follow CommonMark's flanking rules (simplified):
        // the opener is followed by non-space, the closer preceded by
        // non-space, and `_` never opens or closes inside a word — so
        // SHOULD_NOT_APPEAR or snake_case_names stay literal text.
        func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber }
        func canOpen(at i: String.Index, length: Int) -> Bool {
            let after = fragment.index(i, offsetBy: length)
            guard after < fragment.endIndex, !fragment[after].isWhitespace else { return false }
            if fragment[i] == "_", i > fragment.startIndex, isWordChar(fragment[fragment.index(before: i)]) { return false }
            return true
        }
        func closer(for marker: String, from start: String.Index) -> String.Index? {
            var search = start
            while search < fragment.endIndex,
                  let found = fragment.range(of: marker, range: search..<fragment.endIndex) {
                let close = found.lowerBound
                let afterClose = found.upperBound
                let precededBySpace = close > start && fragment[fragment.index(before: close)].isWhitespace
                let followedByWord = marker.hasPrefix("_") && afterClose < fragment.endIndex && isWordChar(fragment[afterClose])
                if close > start, !precededBySpace, !followedByWord { return close }
                search = fragment.index(after: close)
            }
            return nil
        }

        func flushPlain(until end: String.Index) {
            guard plainStart < end else { return }
            append(String(fragment[plainStart..<end]))
        }

        while index < fragment.endIndex {
            let next = fragment.index(after: index)

            // Backslash escapes only ASCII punctuation (CommonMark). Anything
            // else keeps its backslash, so Windows paths like C:\Users\me
            // are shown as written.
            if fragment[index] == "\\", next < fragment.endIndex,
               fragment[next].isASCII, fragment[next].isPunctuation || fragment[next].isSymbol {
                flushPlain(until: index)
                append(String(fragment[next]))
                index = fragment.index(after: next)
                plainStart = index
                continue
            }

            if fragment[index] == "`",
               let close = fragment[next...].firstIndex(of: "`") {
                flushPlain(until: index)
                append(String(fragment[next..<close]), code: true)
                index = fragment.index(after: close)
                plainStart = index
                continue
            }

            // Autolinks: <https://…> and bare http(s) URLs (GFM). Inside a
            // link label the label already is the link.
            if link == nil, fragment[index] == "<",
               let close = fragment[next...].firstIndex(of: ">"),
               let url = autolinkURL(String(fragment[next..<close])) {
                flushPlain(until: index)
                append(String(fragment[next..<close]), overrideLink: url)
                index = fragment.index(after: close)
                plainStart = index
                continue
            }
            if link == nil, fragment[index] == "h",
               fragment[index...].hasPrefix("https://") || fragment[index...].hasPrefix("http://"),
               index == fragment.startIndex || !(fragment[fragment.index(before: index)].isASCII
                    && isWordChar(fragment[fragment.index(before: index)])) {
                let end = bareURLEnd(in: fragment, from: index)
                if let url = autolinkURL(String(fragment[index..<end])) {
                    flushPlain(until: index)
                    append(String(fragment[index..<end]), overrideLink: url)
                    index = end
                    plainStart = index
                    continue
                }
            }

            if fragment[index...].hasPrefix("**") || fragment[index...].hasPrefix("__") {
                let marker = String(fragment[index...].prefix(2))
                let contentStart = fragment.index(index, offsetBy: 2)
                if canOpen(at: index, length: 2),
                   let close = closer(for: marker, from: contentStart) {
                    flushPlain(until: index)
                    appendNested(String(fragment[contentStart..<close]), bold: true)
                    index = fragment.index(close, offsetBy: 2)
                    plainStart = index
                    continue
                }
            }

            if fragment[index...].hasPrefix("~~") {
                let contentStart = fragment.index(index, offsetBy: 2)
                if let close = fragment.range(of: "~~", range: contentStart..<fragment.endIndex)?.lowerBound {
                    flushPlain(until: index)
                    appendNested(String(fragment[contentStart..<close]), strike: true)
                    index = fragment.index(close, offsetBy: 2)
                    plainStart = index
                    continue
                }
            }

            if fragment[index] == "*" || fragment[index] == "_",
               canOpen(at: index, length: 1),
               let close = closer(for: String(fragment[index]), from: next),
               close > next {
                flushPlain(until: index)
                appendNested(String(fragment[next..<close]), italic: true)
                index = fragment.index(after: close)
                plainStart = index
                continue
            }

            if fragment[index] == "[",
               let labelEnd = fragment[next...].firstIndex(of: "]"),
               fragment.index(after: labelEnd) < fragment.endIndex,
               fragment[fragment.index(after: labelEnd)] == "(" {
                let destinationStart = fragment.index(labelEnd, offsetBy: 2)
                if let destinationEnd = fragment[destinationStart...].firstIndex(of: ")"),
                   let destination = URL(string: String(fragment[destinationStart..<destinationEnd])) {
                    flushPlain(until: index)
                    appendNested(String(fragment[next..<labelEnd]), link: destination)
                    index = fragment.index(after: destinationEnd)
                    plainStart = index
                    continue
                }
            }

            index = next
        }
        flushPlain(until: fragment.endIndex)
        return runs
    }

    return parse(text, bold: false, italic: false, strikethrough: false, link: nil)
}

/// A URL only when it is a complete http(s) address (no spaces).
func autolinkURL(_ text: String) -> URL? {
    guard text.hasPrefix("https://") || text.hasPrefix("http://"),
          !text.contains(where: \.isWhitespace),
          let url = URL(string: text), let host = url.host, !host.isEmpty else { return nil }
    return url
}

/// End of a bare URL: stops at whitespace, `<`, quotes, or CJK text, and drops
/// trailing punctuation and unbalanced closing brackets (GFM extended autolink).
func bareURLEnd(in text: String, from start: String.Index) -> String.Index {
    var end = start
    while end < text.endIndex {
        let character = text[end]
        if character.isWhitespace || "<>\"`".contains(character) { break }
        if let scalar = character.unicodeScalars.first,
           (0x2E80...0x9FFF).contains(scalar.value) || (0x3000...0x303F).contains(scalar.value)
            || (0xFF00...0xFFEF).contains(scalar.value) { break }
        end = text.index(after: end)
    }
    while end > start {
        let last = text[text.index(before: end)]
        if ".,;:!?'*_~".contains(last) {
            end = text.index(before: end)
            continue
        }
        if last == ")" || last == "]" {
            let opener: Character = last == ")" ? "(" : "["
            let candidate = text[start..<end]
            if candidate.filter({ $0 == last }).count > candidate.filter({ $0 == opener }).count {
                end = text.index(before: end)
                continue
            }
        }
        break
    }
    return end
}

func parseMarkdownInlineLine(_ line: String) -> MarkdownInlineLine {
    let characters = Array(line)
    var level = 0
    while level < min(characters.count, 6), characters[level] == "#" { level += 1 }
    if level > 0,
       characters.count > level,
       characters[level] == " " {
        let text = String(characters.dropFirst(level + 1))
        if !text.isEmpty { return .heading(level: level, text: text) }
    }

    let leading = line.prefix { $0 == " " || $0 == "\t" }
    let depth = leading.reduce(0) { $1 == "\t" ? $0 + 2 : $0 + 1 } / 2
    let trimmed = line.dropFirst(leading.count)
    if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
        return .list(MarkdownListItem(
            ordered: false,
            number: 0,
            depth: depth,
            text: String(trimmed.dropFirst(2))
        ))
    }

    var digits = ""
    var cursor = trimmed.startIndex
    while cursor < trimmed.endIndex, trimmed[cursor].isNumber {
        digits.append(trimmed[cursor])
        cursor = trimmed.index(after: cursor)
    }
    if !digits.isEmpty,
       cursor < trimmed.endIndex,
       trimmed[cursor] == "." {
        cursor = trimmed.index(after: cursor)
        if cursor < trimmed.endIndex, trimmed[cursor] == " " {
            return .list(MarkdownListItem(
                ordered: true,
                number: Int(digits) ?? 1,
                depth: depth,
                text: String(trimmed[trimmed.index(after: cursor)...])
            ))
        }
    }

    return .text(line)
}

func normalizeMarkdownQuoteWhitespace(_ content: String) -> String {
    var lines = content.components(separatedBy: "\n")
    while lines.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeFirst() }
    while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeLast() }
    var normalized: [String] = []
    var previousWasEmpty = false
    for line in lines {
        let empty = line.trimmingCharacters(in: .whitespaces).isEmpty
        if empty, previousWasEmpty { continue }
        normalized.append(line)
        previousWasEmpty = empty
    }
    return normalized.joined(separator: "\n")
}

// MARK: - Shared code syntax semantics

enum MarkdownCodeTokenRole: CaseIterable {
    case comment, string, number, keyword, type
}

struct MarkdownCodeTokenRule {
    let pattern: String
    let role: MarkdownCodeTokenRole
    var options: NSRegularExpression.Options = []
}

enum MarkdownCodeSyntax {
    private static let languageAliases: [String: String] = [
        "c++": "cpp", "cxx": "cpp",
        "c#": "csharp", "cs": "csharp",
        "html": "xml", "htm": "xml",
        "js": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python", "rb": "ruby", "rs": "rust", "golang": "go",
        "kt": "kotlin", "kts": "kotlin",
        "sh": "bash", "shell": "bash", "zsh": "bash",
        "shell-session": "shell", "console": "shell", "terminal": "shell",
        "yml": "yaml", "jsonc": "json", "json5": "json",
        "md": "markdown", "mdown": "markdown", "mkdown": "markdown",
        "docker": "dockerfile", "ps": "powershell", "ps1": "powershell", "pwsh": "powershell",
        "gql": "graphql", "postgres": "pgsql", "postgresql": "pgsql",
        "make": "makefile", "patch": "diff", "objc": "objectivec",
        "objective-c": "objectivec", "objc++": "objectivec", "objective-c++": "objectivec", "mm": "objectivec",
    ]
    private static let intentionallyPlainLanguages: Set<String> = [
        "text", "txt", "plaintext", "plain", "none",
    ]
    private static let keywords = [
        "abstract", "async", "await", "break", "case", "catch", "class", "const",
        "continue", "data", "default", "defer", "do", "else", "enum", "export",
        "extends", "false", "final", "finally", "for", "from", "fun", "func", "function",
        "guard", "if", "implements", "import", "in", "interface", "internal", "let", "match",
        "mut", "new", "nil", "null", "override", "package", "private", "protected", "public",
        "record", "return", "sealed", "static", "struct", "switch", "throw", "throws", "trait",
        "true", "try", "type", "typeof", "var", "when", "where", "while", "with", "yield",
        "select", "insert", "update", "delete", "create", "table", "join", "left", "right",
        "inner", "outer", "on", "as", "group", "order", "by", "having", "limit", "offset",
        "flowchart", "graph", "sequenceDiagram", "stateDiagram", "classDiagram", "erDiagram",
        "participant", "activate", "deactivate", "note", "loop", "alt", "opt", "end",
    ]

    static func rawLanguage(_ language: String?) -> String? {
        guard let raw = language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else { return nil }
        return raw
    }

    static func normalizedLanguage(_ language: String?) -> String? {
        guard let raw = rawLanguage(language) else { return nil }
        return languageAliases[raw] ?? raw
    }

    static func isIntentionallyPlain(_ language: String?) -> Bool {
        rawLanguage(language).map(intentionallyPlainLanguages.contains) ?? false
    }

    static let lexicalRules: [MarkdownCodeTokenRule] = [
        MarkdownCodeTokenRule(
            pattern: #"(?s)/\*.*?\*/|(?m)//.*$|(?m)#(?![A-Fa-f0-9]{3,8}\b).*$|(?m)--.*$"#,
            role: .comment
        ),
        MarkdownCodeTokenRule(
            pattern: #"(?s)\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#,
            role: .string
        ),
        MarkdownCodeTokenRule(pattern: #"\b(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\b"#, role: .number),
        MarkdownCodeTokenRule(
            pattern: #"\b(?:"#
                + keywords.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
                + #")\b"#,
            role: .keyword,
            options: [.caseInsensitive]
        ),
        MarkdownCodeTokenRule(pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#, role: .type),
    ]
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
    /// Indentation of the opening fence. Fences nested in a list item are
    /// indented ("  ```"); their content carries the same indent, which is
    /// stripped so the block renders like a top-level one.
    var codeIndent = 0

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

        let fenceIndent = line.prefix(while: { $0 == " " }).count
        let isFence = fenceIndent <= 8 && line.dropFirst(fenceIndent).hasPrefix("```")

        if inCodeBlock {
            if isFence {
                segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
                codeBuffer.removeAll()
                codeLanguage = nil
                inCodeBlock = false
                codeIndent = 0
            } else {
                let strip = min(codeIndent, line.prefix(while: { $0 == " " }).count)
                codeBuffer.append(String(line.dropFirst(strip)))
            }
            i += 1
            continue
        }

        if isFence {
            flushInline()
            flushQuote()
            let lang = String(line.dropFirst(fenceIndent + 3)).trimmingCharacters(in: .whitespaces)
            codeLanguage = lang.isEmpty ? nil : lang
            inCodeBlock = true
            codeIndent = fenceIndent
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
    var s = Substring(line.trimmingCharacters(in: .whitespaces))
    if s.first == "|" { s = s.dropFirst() }
    if s.last == "|", !s.hasSuffix("\\|") { s = s.dropLast() }
    // A pipe separates cells unless escaped (`\|`) or inside a code span.
    var cells: [String] = []
    var current = ""
    var inCode = false
    var index = s.startIndex
    while index < s.endIndex {
        let character = s[index]
        let next = s.index(after: index)
        if character == "\\", next < s.endIndex, s[next] == "|" {
            current += inCode ? "|" : "\\|"
            index = s.index(after: next)
            continue
        }
        if character == "`" { inCode.toggle() }
        if character == "|", !inCode {
            cells.append(current)
            current = ""
        } else {
            current.append(character)
        }
        index = next
    }
    cells.append(current)
    return cells.map { $0.trimmingCharacters(in: .whitespaces) }
}
