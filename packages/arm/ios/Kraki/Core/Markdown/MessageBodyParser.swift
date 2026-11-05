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
        /// Ranges of complete code spans: emphasis never closes inside one.
        let codeSpans: [Range<String.Index>] = {
            var spans: [Range<String.Index>] = []
            var cursor = fragment.startIndex
            while let open = fragment[cursor...].firstIndex(of: "`") {
                let afterOpen = fragment.index(after: open)
                guard let close = fragment[afterOpen...].firstIndex(of: "`") else { break }
                spans.append(open..<fragment.index(after: close))
                cursor = fragment.index(after: close)
            }
            return spans
        }()
        func closer(for marker: String, from start: String.Index) -> String.Index? {
            var search = start
            while search < fragment.endIndex,
                  let found = fragment.range(of: marker, range: search..<fragment.endIndex) {
                let close = found.lowerBound
                if let span = codeSpans.first(where: { $0.contains(close) }) {
                    search = span.upperBound
                    continue
                }
                let afterClose = found.upperBound
                let precededBySpace = close > start && fragment[fragment.index(before: close)].isWhitespace
                let followedByWord = marker.hasPrefix("_") && afterClose < fragment.endIndex && isWordChar(fragment[afterClose])
                if close > start, !precededBySpace, !followedByWord { return close }
                search = fragment.index(after: close)
            }
            return nil
        }
        /// Length of the run of `fragment[i]` starting at `i`.
        func delimiterRun(at i: String.Index) -> Int {
            var end = i
            while end < fragment.endIndex, fragment[end] == fragment[i] { end = fragment.index(after: end) }
            return fragment.distance(from: i, to: end)
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
               let url = autolinkURL(String(fragment[next..<close])) ?? mailAutolinkURL(String(fragment[next..<close])) {
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

            if fragment[index] == "*" || fragment[index] == "_" {
                let run = delimiterRun(at: index)
                let afterRun = fragment.index(index, offsetBy: run)
                // A delimiter run followed by a space or the end opens
                // nothing ("a *** b"): it is text, kept whole.
                if afterRun == fragment.endIndex || fragment[afterRun].isWhitespace {
                    index = afterRun
                    continue
                }
                // ***strong emphasis***
                if run == 3, canOpen(at: index, length: 3),
                   let close = closer(for: String(repeating: String(fragment[index]), count: 3), from: afterRun) {
                    flushPlain(until: index)
                    appendNested(String(fragment[afterRun..<close]), bold: true, italic: true)
                    index = fragment.index(close, offsetBy: 3)
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

            // ![alt](url): chat bubbles do not inline remote images; the alt
            // text links to the image instead of leaking a "!".
            let isImage = fragment[index] == "!" && next < fragment.endIndex && fragment[next] == "["
            let labelOpen = isImage ? next : index
            let labelStart = fragment.index(after: labelOpen)
            if fragment[labelOpen] == "[", labelStart <= fragment.endIndex,
               let labelEnd = fragment[labelStart...].firstIndex(of: "]"),
               fragment.index(after: labelEnd) < fragment.endIndex,
               fragment[fragment.index(after: labelEnd)] == "(" {
                let destinationStart = fragment.index(labelEnd, offsetBy: 2)
                if let destinationEnd = linkDestinationEnd(in: fragment, from: destinationStart),
                   let destination = URL(string: String(fragment[destinationStart..<destinationEnd])
                        .trimmingCharacters(in: .whitespaces)) {
                    flushPlain(until: index)
                    // Agent text is untrusted: only web and mail links become
                    // tappable. Any other scheme (file:, app handlers, …) keeps
                    // its label as plain text.
                    var label = String(fragment[labelStart..<labelEnd])
                    if isImage, label.isEmpty { label = destination.absoluteString }
                    appendNested(label, link: isSafeLinkURL(destination) ? destination : nil)
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

/// Schemes a chat link may open. Everything else in agent-written text could
/// launch local files or other apps (`file:`, `vscode:`, `x-apple…:`).
func isSafeLinkURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    if scheme == "mailto" { return true }
    return (scheme == "http" || scheme == "https") && url.host?.isEmpty == false
}

/// The `)` closing a link destination that starts at `start`: nested
/// balanced parentheses belong to the URL (`…/Foo_(bar))`).
func linkDestinationEnd(in text: String, from start: String.Index) -> String.Index? {
    var depth = 0
    var index = start
    while index < text.endIndex {
        let character = text[index]
        if character == "\\", text.index(after: index) < text.endIndex {
            index = text.index(index, offsetBy: 2)
            continue
        }
        if character == "(" { depth += 1 }
        if character == ")" {
            if depth == 0 { return index }
            depth -= 1
        }
        index = text.index(after: index)
    }
    return nil
}

/// `<mailto:a@b.c>` or `<a@b.c>` (CommonMark email autolink).
func mailAutolinkURL(_ text: String) -> URL? {
    guard !text.contains(where: \.isWhitespace) else { return nil }
    let address = text.lowercased().hasPrefix("mailto:") ? String(text.dropFirst(7)) : text
    let parts = address.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."),
          !parts[1].hasPrefix("."), !parts[1].hasSuffix(".") else { return nil }
    return URL(string: "mailto:" + address)
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

/// Explicit bidirectional embeddings, overrides and isolates (U+202A–U+202E,
/// U+2066–U+2069) let message text reorder what it displays — `txt.exe`
/// shown as `exe.txt` inside a bubble (K-164). The bidi algorithm lays out
/// real right-to-left text without them, so they are removed before
/// rendering. The plain marks (LRM/RLM/ALM) can't reverse text and stay.
func neutralizingBidiControls(_ text: String) -> String {
    func isControl(_ scalar: Unicode.Scalar) -> Bool {
        (0x202A...0x202E).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value)
    }
    guard text.unicodeScalars.contains(where: isControl) else { return text }
    var kept = String.UnicodeScalarView()
    kept.append(contentsOf: text.unicodeScalars.filter { !isControl($0) })
    return String(kept)
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
    /// The opening fence (``` or ~~~, possibly longer). Only a fence of the
    /// same character and at least this length closes the block.
    var codeFence = ""
    /// The block was opened inside a blockquote ("> ```"): its lines carry
    /// the quote marker, and the block ends with the quote.
    var codeInQuote = false

    /// A fence line: up to 8 spaces, then 3+ backticks or tildes.
    func fence(in line: String) -> (indent: Int, marker: String, info: String)? {
        let indent = line.prefix(while: { $0 == " " }).count
        guard indent <= 8 else { return nil }
        let rest = line.dropFirst(indent)
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let marker = rest.prefix(while: { $0 == first })
        guard marker.count >= 3 else { return nil }
        let info = String(rest.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string cannot contain a backtick (CommonMark).
        if first == "`", info.contains("`") { return nil }
        return (indent, String(marker), info)
    }
    /// Quote content without its markers: "> a", ">a", "> > a" and ">> a"
    /// all give "a" (nested quotes render as one quote level).
    func quoteContent(_ line: String) -> String? {
        guard line.hasPrefix(">") else { return nil }
        var rest = Substring(line)
        while rest.hasPrefix(">") {
            rest = rest.dropFirst()
            if rest.hasPrefix(" ") { rest = rest.dropFirst() }
        }
        return String(rest)
    }

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

    func closeCodeBlock() {
        segments.append(.codeBlock(language: codeLanguage, code: codeBuffer.joined(separator: "\n")))
        codeBuffer.removeAll()
        codeLanguage = nil
        inCodeBlock = false
        codeIndent = 0
        codeFence = ""
        codeInQuote = false
    }

    let lines = neutralizingBidiControls(text).components(separatedBy: "\n")
    var i = 0
    while i < lines.count {
        var line = lines[i]

        if inCodeBlock, codeInQuote {
            // The quote ended (a line without ">"): so does its code block.
            guard let content = quoteContent(line) else {
                closeCodeBlock()
                continue
            }
            line = content
        }

        let lineFence = fence(in: line)

        if inCodeBlock {
            if let lineFence, lineFence.info.isEmpty, lineFence.marker.first == codeFence.first,
               lineFence.marker.count >= codeFence.count {
                closeCodeBlock()
            } else {
                let strip = min(codeIndent, line.prefix(while: { $0 == " " }).count)
                codeBuffer.append(String(line.dropFirst(strip)))
            }
            i += 1
            continue
        }

        if let lineFence {
            flushInline()
            flushQuote()
            codeLanguage = lineFence.info.isEmpty ? nil : lineFence.info
            inCodeBlock = true
            codeIndent = lineFence.indent
            codeFence = lineFence.marker
            i += 1
            continue
        }

        // A fence inside a quote ("> ```"): the code renders as a code block
        // instead of leaking its fence lines into the quote text.
        if let content = quoteContent(line), let quotedFence = fence(in: content) {
            flushInline()
            flushQuote()
            codeLanguage = quotedFence.info.isEmpty ? nil : quotedFence.info
            inCodeBlock = true
            codeIndent = quotedFence.indent
            codeFence = quotedFence.marker
            codeInQuote = true
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

        // Blockquote: line starts with ">" (nested markers are dropped).
        if let content = quoteContent(line) {
            flushInline()
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
        closeCodeBlock()
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
    if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") || trimmed.hasPrefix(">") {
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
        // A lone ":" is both prefix and suffix: removing twice would trap.
        if hasRightColon, !dashes.isEmpty { dashes.removeLast() }
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
