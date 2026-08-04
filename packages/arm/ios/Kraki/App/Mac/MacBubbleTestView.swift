/// MacBubbleTestView — Isolated validation of the macOS TextKit bubble render
/// path before it is wired into the production ChatView.
///
/// Reuses the cross-platform `MessageBodyParser` (segment splitting) and
/// mirrors the iOS `TKMarkdown` attributed-string construction with AppKit
/// types (`NSFont` / `NSColor`) so the bubble renders identically on macOS
/// via an `NSTextView` (TextKit2).
///
/// Reach via the Debug menu → "Bubble Test Page".

#if os(macOS)
import AppKit
import SwiftUI
import Highlightr

// MARK: - Markdown → NSAttributedString (macOS mirror of iOS TKMarkdown)

// Adaptive palette: resolves against the text view's effective appearance,
// so the production chat follows the system light/dark setting. The
// headless bubble-test render forces an aqua window, so it still draws
// the light variant there.
enum MacBubblePalette {
    static let text = NSColor.labelColor
    static let secondary = NSColor.secondaryLabelColor
    static let link = NSColor.linkColor
    static let tertiary = NSColor.tertiaryLabelColor
}

enum MacCodePalette {
    static let background = NSColor(
        srgbRed: 0x18 / 255,
        green: 0x18 / 255,
        blue: 0x1B / 255,
        alpha: 1
    )
    static let foreground = NSColor(
        srgbRed: 0xF4 / 255,
        green: 0xF4 / 255,
        blue: 0xF5 / 255,
        alpha: 1
    )

    static func ensuringReadableForeground(in string: NSMutableAttributedString) {
        guard string.length > 0 else { return }
        var unreadableRanges: [NSRange] = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, range, _ in
            guard let color = value as? NSColor,
                  contrastRatio(foreground: color, background: background) >= 4.5 else {
                unreadableRanges.append(range)
                return
            }
        }
        for range in unreadableRanges {
            string.addAttribute(.foregroundColor, value: foreground, range: range)
        }
    }

    static func contrastRatio(foreground: NSColor, background: NSColor) -> CGFloat {
        guard let fg = foreground.usingColorSpace(.sRGB),
              let bg = background.usingColorSpace(.sRGB) else { return 1 }
        let alpha = fg.alphaComponent
        let red = fg.redComponent * alpha + bg.redComponent * (1 - alpha)
        let green = fg.greenComponent * alpha + bg.greenComponent * (1 - alpha)
        let blue = fg.blueComponent * alpha + bg.blueComponent * (1 - alpha)
        let foregroundLuminance = luminance(red: red, green: green, blue: blue)
        let backgroundLuminance = luminance(
            red: bg.redComponent,
            green: bg.greenComponent,
            blue: bg.blueComponent
        )
        return (max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (min(foregroundLuminance, backgroundLuminance) + 0.05)
    }

    private static func luminance(red: CGFloat, green: CGFloat, blue: CGFloat) -> CGFloat {
        func linear(_ value: CGFloat) -> CGFloat {
            value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}

/// Shared stress catalog for the three Mac render paths (SwiftUI page,
/// pure-AppKit page, headless PNG render). Mirrors the iOS
/// `BubbleCatalogTestView` Markdown matrix so coverage stays in lock-step.
enum MacBubbleCatalog {
    struct Sample {
        let title: String
        let body: String
    }

    static let samples: [Sample] = [
        Sample(title: "Plain · short", body: "hi"),
        Sample(title: "Plain · wrapped",
               body: "A longer message that should hug its content until it reaches the maximum bubble width, then wrap naturally without clipping or stretching to full width."),
        Sample(title: "Inline styles",
               body: "**Bold**, *italic*, `inline code`, ~~strikethrough~~, and a [Kraki link](https://kraki.chat)."),
        Sample(title: "ATX headings", body: """
# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
"""),
        Sample(title: "Lists and whitespace", body: """
- First bullet
- Second bullet with **bold**
  - Nested-looking line

1. First numbered item
2. Second numbered item
"""),
        Sample(title: "Blockquote · compact", body: """
> Quoted line with **emphasis**
> Second quoted line

Following paragraph.
"""),
        Sample(title: "Blockquote · long wrapping", body: """
> This is a deliberately long quotation that should wrap across several lines while keeping one continuous background and one leading rule. It should grow only by the actual TextKit line height, without creating a giant empty region above or below the quoted text.
> A second quoted paragraph continues the same compact block.
"""),
        Sample(title: "Blockquote · repeated empty lines", body: """
> Start of quote.
>
>
>
>
>
> End of quote after repeated empty markers.
"""),
        Sample(title: "Blockquote · separate blocks", body: """
> First quote block.
> It has two lines.

Normal paragraph between quotes.

> Second quote block with a long_unbroken_token_abcdefghijklmnopqrstuvwxyz0123456789 that must wrap without exploding the measured height.
"""),
        Sample(title: "Code · Swift highlight", body: """
Before code.

```swift
struct Bubble {
    let state: String
    func render() -> Bool { true }
}
```

After code.
"""),
        Sample(title: "Code · long first line + badge", body: """
```swift
let extremelyLongVariableNameThatMustWrapWithoutTouchingTheLanguageBadge = makeBubble(configuration: .production, enabled: true)
```
"""),
        Sample(title: "Code · TypeScript", body: """
```typescript
interface Session { id: string; active: boolean }
const current: Session = { id: 'abc', active: true }
```
"""),
        Sample(title: "Code · TSX", body: """
```tsx
export function SessionCard({ active }: { active: boolean }) {
    return <article className={active ? "active" : "idle"}>{active ? "Streaming" : "Idle"}</article>
}
```
"""),
        Sample(title: "Code · JavaScript", body: """
```javascript
async function fetchSession(id) {
    const response = await fetch(`/api/sessions/${id}`)
    return response.ok ? response.json() : null
}
```
"""),
        Sample(title: "Code · Python", body: """
```python
@dataclass
class Session:
    id: str
    active: bool = False

async def load_session(session_id: str) -> Session | None:
    return await repository.find(session_id)
```
"""),
        Sample(title: "Code · Rust", body: """
```rust
#[derive(Debug, Clone)]
struct Session<'a> { id: &'a str, active: bool }

impl<'a> Session<'a> {
    fn is_ready(&self) -> bool { self.active && !self.id.is_empty() }
}
```
"""),
        Sample(title: "Code · Go", body: """
```go
type Session struct {
    ID string `json:"id"`
    Active bool `json:"active"`
}

func (s Session) Ready() bool { return s.Active && s.ID != "" }
```
"""),
        Sample(title: "Code · Java", body: """
```java
public record Session(String id, boolean active) {
    public boolean isReady() {
        return active && !id.isBlank();
    }
}
```
"""),
        Sample(title: "Code · Kotlin", body: """
```kotlin
data class Session(val id: String, val active: Boolean) {
    fun isReady(): Boolean = active && id.isNotBlank()
}
```
"""),
        Sample(title: "Code · C++", body: """
```cpp
#include <string>
struct Session {
    std::string id;
    bool active{false};
    [[nodiscard]] bool ready() const { return active && !id.empty(); }
};
```
"""),
        Sample(title: "Code · SQL", body: """
```sql
SELECT s.id, COUNT(m.id) AS message_count
FROM sessions AS s
LEFT JOIN messages AS m ON m.session_id = s.id
WHERE s.active = TRUE
GROUP BY s.id
ORDER BY message_count DESC;
```
"""),
        Sample(title: "Code · JSON", body: """
```json
{ "session": "abc", "count": 42, "ready": true }
```
"""),
        Sample(title: "Code · YAML", body: """
```yaml
session:
  id: abc
  active: true
  models:
    - gpt-5.6-sol
    - claude-sonnet-5
```
"""),
        Sample(title: "Code · HTML", body: """
```html
<section class="session" data-active="true">
  <h2>Streaming session</h2>
  <button type="button" aria-label="Stop">Stop</button>
</section>
```
"""),
        Sample(title: "Code · CSS", body: """
```css
.session[data-active="true"] {
  display: grid;
  color: var(--text-primary);
  background: color-mix(in srgb, #6750a4 12%, transparent);
}
```
"""),
        Sample(title: "Code · shell", body: """
```bash
set -euo pipefail
for file in packages/arm/ios/Kraki/**/*.swift; do
  rg -n "MacMarkdown|Highlightr" "$file" || true
done
```
"""),
        Sample(title: "Code · Mermaid", body: """
```mermaid
flowchart LR
    Input[Streaming delta] --> Parse{Markdown?}
    Parse -->|yes| Artifact[CoreText artifact]
    Parse -->|no| Plain[Plain text]
    Artifact --> View[Bubble cell]
```
"""),
        Sample(title: "Code · unknown language", body: """
```not-a-real-language
widget => value + 42
```
"""),
        Sample(title: "Long code line", body: """
```text
https://example.com/a/very/long/unbroken/path/that/should/wrap/inside/the/textkit/bubble/without/escaping/the/card/bounds?query=abcdefghijklmnopqrstuvwxyz0123456789
```
"""),
        Sample(title: "Table · basic", body: """
| State | Result | Note |
| :--- | :---: | ---: |
| idle | ready | 1 |
| streaming | active | 2 |
"""),
        Sample(title: "Table · wide stress", body: """
| Session | Agent | Model | Status | Started | Duration | Input Tokens | Output Tokens |
| :--- | :--- | :--- | :---: | :--- | ---: | ---: | ---: |
| production-session-with-a-long-name | pi | claude-sonnet-4 | streaming | 2026-07-15 21:42 | 128.4s | 124500 | 18942 |
| simulator-catalog | codex | gpt-5-codex | completed | 2026-07-15 20:01 | 42.8s | 9850 | 3201 |
| device-debug | pi | claude-opus-4 | failed | 2026-07-15 19:18 | 301.2s | 245900 | 12003 |
"""),
        Sample(title: "Table · tall stress", body: """
| Index | Event | Status |
| ---: | :--- | :---: |
| 1 | Connect relay | done |
| 2 | Fetch session head | done |
| 3 | Load local window | done |
| 4 | Merge live tail | done |
| 5 | Project turn spine | done |
| 6 | Measure bubbles | done |
| 7 | Attach collection | done |
| 8 | Restore anchor | done |
| 9 | Render images | done |
| 10 | Hydrate content refs | done |
| 11 | Resolve action cards | done |
| 12 | Update live draft | running |
| 13 | Persist terminal turn | pending |
| 14 | Refresh session list | pending |
| 15 | Flush diagnostics | pending |
"""),
        Sample(title: "Mixed blocks", body: """
## Summary
A paragraph with `code` and a [link](https://example.com).

> Important quoted guidance.

```bash
pnpm test
```

| Check | Status |
| --- | --- |
| Build | Pass |
"""),
        Sample(title: "Unicode and emoji",
               body: "中文排版、かな、한국어, emoji 🦑🚀, combining café, and a verylongtoken_without_breaks_abcdefghijklmnopqrstuvwxyz0123456789."),
    ]
}

private func macContentCacheKey(prefix: String, content: String) -> NSString {
    var hasher = Hasher()
    hasher.combine(content)
    return "\(prefix)\u{1F}\(content.utf8.count)\u{1F}\(hasher.finalize())" as NSString
}

private let macMarkdownCache: NSCache<NSString, NSAttributedString> = {
    let c = NSCache<NSString, NSAttributedString>()
    c.countLimit = 160
    c.totalCostLimit = 24 * 1024 * 1024
    return c
}()

private let macCodeHighlightCache: NSCache<NSString, NSAttributedString> = {
    let cache = NSCache<NSString, NSAttributedString>()
    cache.countLimit = 256
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
}()

extension Notification.Name {
    static let macCodeHighlightReady = Notification.Name("chat.kraki.mac.code-highlight-ready")
}

private final class MacCodeHighlightGeneration: @unchecked Sendable {
    static let shared = MacCodeHighlightGeneration()
    private let lock = NSLock()
    private var value = 0

    func advance() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    func current() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private enum MacCodeHighlighter {
    private static let queue = DispatchQueue(label: "chat.kraki.mac.code-highlight", qos: .utility)
    private static let provisionalThreadKey = "chat.kraki.mac.code-highlight.provisional"
    nonisolated(unsafe) private static var engine: Highlightr?

    #if DEBUG
    struct Diagnostic {
        let title: String
        let language: String
        let supported: Bool
        let rawColorCount: Int
        let readableColorCount: Int
        let sourcePreserved: Bool
        let characterCount: Int
    }
    #endif

    private static let languageAliases: [String: String] = [
        "c++": "cpp", "cxx": "cpp",
        "c#": "csharp", "cs": "csharp",
        "html": "xml", "htm": "xml",
        "js": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python", "rb": "ruby", "rs": "rust",
        "kt": "kotlin", "kts": "kotlin",
        "sh": "bash", "shell": "bash", "zsh": "bash",
        "yml": "yaml", "objc": "objectivec", "objective-c": "objectivec",
    ]
    private static let intentionallyPlainLanguages: Set<String> = [
        "text", "txt", "plaintext", "plain", "none",
    ]

    private static func normalizedLanguage(_ language: String?) -> String? {
        guard let raw = language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else { return nil }
        return languageAliases[raw] ?? raw
    }

    private static func highlighted(
        code: String,
        language: String?,
        engine: Highlightr
    ) -> NSAttributedString {
        let rawLanguage = language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalized = normalizedLanguage(language)
        if let rawLanguage, intentionallyPlainLanguages.contains(rawLanguage) {
            return NSAttributedString(string: code)
        }
        let highlighted = engine.highlight(code, as: normalized, fastRender: true)
            ?? NSAttributedString(string: code)
        guard foregroundColorCount(in: highlighted) <= 1,
              let fallbackLanguage = normalized ?? rawLanguage else { return highlighted }
        return lexicalFallback(code: code, language: fallbackLanguage)
    }

    private static func lexicalFallback(code: String, language: String) -> NSAttributedString {
        let result = NSMutableAttributedString(string: code, attributes: [
            .foregroundColor: MacCodePalette.foreground,
        ])
        let fullRange = NSRange(location: 0, length: result.length)
        var occupied = IndexSet()

        func apply(_ pattern: String, color: NSColor, options: NSRegularExpression.Options = []) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for match in regex.matches(in: code, range: fullRange) {
                let range = match.range
                guard range.length > 0,
                      !occupied.intersects(integersIn: range.location..<(range.location + range.length)) else {
                    continue
                }
                result.addAttribute(.foregroundColor, value: color, range: range)
                occupied.insert(integersIn: range.location..<(range.location + range.length))
            }
        }

        let comment = NSColor(srgbRed: 0x9A/255, green: 0xA4/255, blue: 0xB2/255, alpha: 1)
        let string = NSColor(srgbRed: 0xA5/255, green: 0xD6/255, blue: 0xFF/255, alpha: 1)
        let number = NSColor(srgbRed: 0xD2/255, green: 0xA8/255, blue: 0xFF/255, alpha: 1)
        let keyword = NSColor(srgbRed: 0xFF/255, green: 0x8F/255, blue: 0xC7/255, alpha: 1)
        let type = NSColor(srgbRed: 0xFF/255, green: 0xB8/255, blue: 0x6C/255, alpha: 1)

        apply(#"(?s)/\*.*?\*/|(?m)//.*$|(?m)#(?![A-Fa-f0-9]{3,8}\b).*$|(?m)--.*$"#, color: comment)
        apply(#"(?s)\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#, color: string)
        apply(#"\b(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\b"#, color: number)

        let commonKeywords = [
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
        let keywordPattern = #"\b(?:"#
            + commonKeywords.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
            + #")\b"#
        apply(keywordPattern, color: keyword, options: [.caseInsensitive])
        apply(#"\b[A-Z][A-Za-z0-9_]*\b"#, color: type)
        _ = language
        return result
    }

    static func clearProvisionalFlag() {
        Thread.current.threadDictionary.removeObject(forKey: provisionalThreadKey)
    }

    static func consumeProvisionalFlag() -> Bool {
        let provisional = Thread.current.threadDictionary[provisionalThreadKey] as? Bool ?? false
        Thread.current.threadDictionary.removeObject(forKey: provisionalThreadKey)
        return provisional
    }

    static func prewarm() {
        queue.async { _ = makeEngine() }
    }

    private static func makeEngine() -> Highlightr? {
        if let engine { return engine }
        let created = Highlightr()
        created?.ignoreIllegals = true
        _ = created?.setTheme(to: "github-dark")
        engine = created
        return created
    }

    #if DEBUG
    static func catalogDiagnostics(
        completion: @escaping ([Diagnostic]) -> Void
    ) {
        let cases: [(String, String, String)] = MacBubbleCatalog.samples.flatMap { sample in
            splitMessageBody(sample.body).compactMap { segment in
                guard case let .codeBlock(language, code) = segment,
                      let language, !language.isEmpty else { return nil }
                return (sample.title, language.lowercased(), code)
            }
        }
        queue.async {
            guard let engine = makeEngine() else {
                DispatchQueue.main.async { completion([]) }
                return
            }
            let supported = Set(engine.supportedLanguages().map { $0.lowercased() })
            let results = cases.map { title, language, code in
                let normalized = normalizedLanguage(language)
                let raw = engine.highlight(code, as: normalized, fastRender: true)
                    ?? NSAttributedString(string: code)
                let production = highlighted(code: code, language: language, engine: engine)
                let readable = NSMutableAttributedString(attributedString: production)
                MacCodePalette.ensuringReadableForeground(in: readable)
                return Diagnostic(
                    title: title,
                    language: language,
                    supported: normalized.map(supported.contains) ?? true,
                    rawColorCount: foregroundColorCount(in: raw),
                    readableColorCount: foregroundColorCount(in: readable),
                    sourcePreserved: raw.string == code && readable.string == code,
                    characterCount: code.count
                )
            }
            DispatchQueue.main.async { completion(results) }
        }
    }
    #endif

    private static func foregroundColorCount(in string: NSAttributedString) -> Int {
        var colors: Set<String> = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, _, _ in
            guard let color = value as? NSColor,
                  let rgb = color.usingColorSpace(.sRGB) else {
                colors.insert("none")
                return
            }
            let red = Int((rgb.redComponent * 255).rounded())
            let green = Int((rgb.greenComponent * 255).rounded())
            let blue = Int((rgb.blueComponent * 255).rounded())
            let alpha = Int((rgb.alphaComponent * 255).rounded())
            colors.insert("\(red)-\(green)-\(blue)-\(alpha)")
        }
        return colors.count
    }

    private static func storeHighlighted(_ highlighted: NSAttributedString, forKey key: NSString) {
        macCodeHighlightCache.setObject(
            highlighted,
            forKey: key,
            cost: highlighted.length * 8
        )
        MacCodeHighlightGeneration.shared.advance()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .macCodeHighlightReady, object: nil)
        }
    }

    static func attributed(
        code: String,
        language: String?,
        allowHighlighting: Bool = true
    ) -> NSAttributedString {
        guard allowHighlighting else { return NSAttributedString(string: code) }
        let normalized = normalizedLanguage(language) ?? "auto"
        let key = macContentCacheKey(prefix: normalized, content: code)
        if let cached = macCodeHighlightCache.object(forKey: key) { return cached }

        if Thread.isMainThread {
            Thread.current.threadDictionary[provisionalThreadKey] = true
            // Syntax highlighting is cosmetic and Highlightr can take 300ms+
            // on a cold real-world block. Never synchronously wait for its
            // utility queue from the chat/scroll main thread. Render correct
            // monospaced code immediately and populate the cache for a later
            // revisit without invalidating the current viewport.
            queue.async {
                if macCodeHighlightCache.object(forKey: key) != nil { return }
                // Highlightr's fast parser stays on this queue. `fastRender:
                // false` converts HTML through UIFoundation via safeMainSync,
                // which inserted visible main-thread stalls during scrolling.
                let result = makeEngine().map {
                    highlighted(code: code, language: language, engine: $0)
                } ?? NSAttributedString(string: code)
                storeHighlighted(result, forKey: key)
            }
            let provisional = NSMutableAttributedString(string: code)
            provisional.addAttribute(
                .tkCodeHighlightProvisional,
                value: true,
                range: NSRange(location: 0, length: provisional.length)
            )
            return provisional
        }

        return queue.sync {
            if let cached = macCodeHighlightCache.object(forKey: key) { return cached }
            let result = makeEngine().map {
                highlighted(code: code, language: language, engine: $0)
            } ?? NSAttributedString(string: code)
            storeHighlighted(result, forKey: key)
            return result
        }
    }
}

extension NSAttributedString.Key {
    static let tkBlockKind = NSAttributedString.Key("chat.kraki.tkBlockKind")
    static let tkBlockID = NSAttributedString.Key("chat.kraki.tkBlockID")
    static let tkBlockLabel = NSAttributedString.Key("chat.kraki.tkBlockLabel")
    static let tkDecorativeSpacer = NSAttributedString.Key("chat.kraki.tkDecorativeSpacer")
    static let tkSemanticText = NSAttributedString.Key("chat.kraki.tkSemanticText")
    static let tkCodeHighlightProvisional = NSAttributedString.Key("chat.kraki.tkCodeHighlightProvisional")
}

enum TKBlockKind: String {
    case quote, code
}

private extension NSFont {
    func withTraits(_ traits: NSFontDescriptor.SymbolicTraits) -> NSFont {
        let descriptor = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(traits))
        return NSFont(descriptor: descriptor, size: 0) ?? self
    }
    var tkBold: NSFont { withTraits(.bold) }
    var tkItalic: NSFont { withTraits(.italic) }
}

final class MacTableLayout {
    let rows: [[String]]
    let alignments: [TableAlignment]
    let columnWidths: [CGFloat]
    let rowHeights: [CGFloat]
    let rowOrigins: [CGFloat]
    let contentSize: NSSize
    let bubbleVisibleRowCount: Int
    let bubbleRowsHeight: CGFloat
    let bubbleViewportHeight: CGFloat
    let hiddenRowCount: Int

    static let showMoreHeight: CGFloat = 40
    static let cellPadH: CGFloat = 10
    static let cellPadV: CGFloat = 8
    private static let headerFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
    private static let bodyFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    init(rows: [[String]], alignments: [TableAlignment]) {
        self.rows = rows
        self.alignments = alignments
        let columnCount = rows.first?.count ?? 0
        var widths = Array(repeating: CGFloat(72), count: columnCount)
        for (rowIndex, row) in rows.enumerated() {
            let font = rowIndex == 0 ? Self.headerFont : Self.bodyFont
            for column in 0..<columnCount {
                let value = column < row.count ? row[column] : ""
                let measured = ceil((value as NSString).size(withAttributes: [.font: font]).width)
                widths[column] = max(widths[column], min(220, measured + Self.cellPadH * 2))
            }
        }
        columnWidths = widths

        var heights: [CGFloat] = []
        var origins: [CGFloat] = []
        var y: CGFloat = 0
        for (rowIndex, row) in rows.enumerated() {
            origins.append(y)
            let font = rowIndex == 0 ? Self.headerFont : Self.bodyFont
            var rowHeight: CGFloat = 36
            for column in 0..<columnCount {
                let value = column < row.count ? row[column] : ""
                let available = max(1, widths[column] - Self.cellPadH * 2)
                let rect = (value as NSString).boundingRect(
                    with: NSSize(width: available, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [.font: font]
                )
                rowHeight = max(rowHeight, ceil(rect.height) + Self.cellPadV * 2)
            }
            heights.append(rowHeight)
            y += rowHeight
        }
        rowHeights = heights
        rowOrigins = origins
        contentSize = NSSize(width: max(1, widths.reduce(0, +)), height: max(1, y))

        let previewBudget: CGFloat = 280
        var visibleCount = 0
        var visibleHeight: CGFloat = 0
        for height in heights {
            let needsFooter = visibleCount + 1 < heights.count
            let projected = visibleHeight + height + (needsFooter ? Self.showMoreHeight : 0)
            if visibleCount >= 2, projected > previewBudget { break }
            visibleHeight += height
            visibleCount += 1
        }
        bubbleVisibleRowCount = visibleCount
        bubbleRowsHeight = visibleHeight
        hiddenRowCount = max(0, rows.count - visibleCount)
        bubbleViewportHeight = visibleHeight + (hiddenRowCount > 0 ? Self.showMoreHeight : 0)
    }

    func font(for row: Int) -> NSFont { row == 0 ? Self.headerFont : Self.bodyFont }
    func semanticText() -> String { rows.map { $0.joined(separator: "\t") }.joined(separator: "\n") }
}

private final class MacTableAttachmentCell: NSTextAttachmentCell {
    let tableLayout: MacTableLayout
    var viewportWidth: CGFloat = 1

    init(layout: MacTableLayout) {
        tableLayout = layout
        super.init(textCell: "")
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var cellSize: NSSize {
        NSSize(width: max(1, viewportWidth), height: tableLayout.bubbleViewportHeight)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {}
}

final class MacTableAttachment: NSTextAttachment {
    let tableLayout: MacTableLayout
    private let sizingCell: MacTableAttachmentCell

    init(rows: [[String]], alignments: [TableAlignment]) {
        let layout = MacTableLayout(rows: rows, alignments: alignments)
        tableLayout = layout
        sizingCell = MacTableAttachmentCell(layout: layout)
        super.init(data: nil, ofType: nil)
        attachmentCell = sizingCell
        sizingCell.attachment = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setViewportWidth(_ width: CGFloat) {
        sizingCell.viewportWidth = max(1, width)
    }
}

private final class MacTableCanvasView: NSView {
    override var isFlipped: Bool { true }
    let tableLayout: MacTableLayout
    let fullTable: Bool

    init(layout: MacTableLayout, fullTable: Bool) {
        tableLayout = layout
        self.fullTable = fullTable
        super.init(frame: NSRect(origin: .zero, size: layout.contentSize))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let line = NSColor.labelColor.withAlphaComponent(0.16)
        let headerLine = NSColor.labelColor.withAlphaComponent(0.34)
        let rowLimit = fullTable ? tableLayout.rows.count : tableLayout.bubbleVisibleRowCount
        for row in 0..<rowLimit {
            let y = tableLayout.rowOrigins[row]
            let height = tableLayout.rowHeights[row]
            guard y <= dirtyRect.maxY, y + height >= dirtyRect.minY else { continue }
            var x: CGFloat = 0
            for column in tableLayout.columnWidths.indices {
                let width = tableLayout.columnWidths[column]
                let value = column < tableLayout.rows[row].count ? tableLayout.rows[row][column] : ""
                let paragraph = NSMutableParagraphStyle()
                switch column < tableLayout.alignments.count ? tableLayout.alignments[column] : .leading {
                case .leading: paragraph.alignment = .left
                case .center: paragraph.alignment = .center
                case .trailing: paragraph.alignment = .right
                }
                (value as NSString).draw(
                    with: NSRect(
                        x: x + MacTableLayout.cellPadH,
                        y: y + MacTableLayout.cellPadV,
                        width: width - MacTableLayout.cellPadH * 2,
                        height: height - MacTableLayout.cellPadV * 2
                    ),
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [
                        .font: tableLayout.font(for: row),
                        .foregroundColor: NSColor.labelColor,
                        .paragraphStyle: paragraph,
                    ]
                )
                x += width
                if column < tableLayout.columnWidths.count - 1 {
                    line.setFill()
                    NSRect(x: x - 0.5, y: y, width: 0.5, height: height).fill()
                }
            }
            (row == 0 ? headerLine : line).setFill()
            let ruleHeight: CGFloat = row == 0 ? 1 : 0.5
            NSRect(x: 0, y: y + height - ruleHeight,
                   width: tableLayout.contentSize.width, height: ruleHeight).fill()
        }
    }
}

final class MacTableScrollView: NSScrollView {
    private enum WheelAxis { case horizontal, vertical }

    #if DEBUG
    private(set) var debugLastWheelRoute = "none"
    var debugHasEnclosingChatScrollView: Bool { enclosingChatScrollView != nil }
    #endif

    private let tableLayout: MacTableLayout
    private let fullTable: Bool
    private var wheelAxis: WheelAxis?
    private let container = NSView()
    private let canvas: MacTableCanvasView
    private let showMoreButton = NSButton()
    private let overflowHint = NSImageView()

    init(layout: MacTableLayout, fullTable: Bool = false) {
        tableLayout = layout
        self.fullTable = fullTable
        canvas = MacTableCanvasView(layout: layout, fullTable: fullTable)
        super.init(frame: .zero)
        drawsBackground = false
        borderType = .noBorder
        hasHorizontalScroller = layout.contentSize.width > 1
        hasVerticalScroller = fullTable
        autohidesScrollers = true
        horizontalScrollElasticity = .none
        verticalScrollElasticity = fullTable ? .automatic : .none

        let rowsHeight = fullTable ? layout.contentSize.height : layout.bubbleRowsHeight
        let viewportHeight = fullTable ? layout.contentSize.height : layout.bubbleViewportHeight
        let documentWidth = max(layout.contentSize.width, 1)
        container.frame = NSRect(x: 0, y: 0, width: documentWidth, height: viewportHeight)
        container.addSubview(canvas)
        canvas.frame = NSRect(x: 0, y: 0, width: documentWidth, height: rowsHeight)

        if !fullTable, layout.hiddenRowCount > 0 {
            showMoreButton.title = "Show \(layout.hiddenRowCount) more rows"
            showMoreButton.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)
            showMoreButton.imagePosition = .imageTrailing
            showMoreButton.isBordered = false
            showMoreButton.contentTintColor = .secondaryLabelColor
            showMoreButton.target = self
            showMoreButton.action = #selector(showAllRows)
            showMoreButton.frame = NSRect(x: 0, y: rowsHeight, width: documentWidth,
                                          height: MacTableLayout.showMoreHeight)
            container.addSubview(showMoreButton)
        }
        documentView = container

        overflowHint.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        overflowHint.imageScaling = .scaleProportionallyDown
        overflowHint.contentTintColor = .secondaryLabelColor
        overflowHint.wantsLayer = true
        overflowHint.layer?.cornerRadius = 10
        overflowHint.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.72).cgColor
        addSubview(overflowHint)
        setAccessibilityElement(true)
        setAccessibilityLabel("Markdown table")
        setAccessibilityValue(layout.semanticText())
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let documentWidth = max(tableLayout.contentSize.width, contentSize.width)
        container.frame.size.width = documentWidth
        canvas.frame.size.width = tableLayout.contentSize.width
        if !fullTable, tableLayout.hiddenRowCount > 0 {
            showMoreButton.frame.size.width = documentWidth
        }
        overflowHint.frame = NSRect(x: bounds.width - 24, y: max(6, (bounds.height - 20) / 2),
                                    width: 20, height: 20)
        hasHorizontalScroller = tableLayout.contentSize.width > contentSize.width + 1
        updateOverflowHint()
    }

    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        updateOverflowHint()
    }

    override func scrollWheel(with event: NSEvent) {
        guard !fullTable else {
            #if DEBUG
            debugLastWheelRoute = "full-table"
            #endif
            super.scrollWheel(with: event)
            return
        }

        let continuousGesture = event.phase != [] || event.momentumPhase != []
        if !continuousGesture || event.phase.contains(.began) || event.momentumPhase.contains(.began) {
            wheelAxis = nil
        }
        if wheelAxis == nil {
            let horizontalIntent = event.modifierFlags.contains(.shift)
                || abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
            wheelAxis = horizontalIntent ? .horizontal : .vertical
        }

        if wheelAxis == .horizontal {
            #if DEBUG
            debugLastWheelRoute = "horizontal"
            #endif
            super.scrollWheel(with: event)
        } else if let chatScrollView = enclosingChatScrollView {
            #if DEBUG
            debugLastWheelRoute = "chat"
            #endif
            chatScrollView.scrollWheel(with: event)
        } else {
            #if DEBUG
            debugLastWheelRoute = "responder"
            #endif
            nextResponder?.scrollWheel(with: event)
        }

        if event.phase.contains(.ended) || event.phase.contains(.cancelled)
            || event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) {
            wheelAxis = nil
        }
    }

    private var enclosingChatScrollView: MacChatScrollView? {
        var candidate = superview
        while let view = candidate {
            if let chat = view as? MacChatScrollView { return chat }
            candidate = view.superview
        }
        return nil
    }

    private func updateOverflowHint() {
        let maximum = max(0, tableLayout.contentSize.width - contentSize.width)
        overflowHint.isHidden = maximum <= 1 || contentView.bounds.minX >= maximum - 1
    }

    @objc private func showAllRows() {
        guard let window else { return }
        let controller = MacTableSheetViewController(layout: tableLayout)
        window.contentViewController?.presentAsSheet(controller)
    }
}

private final class MacTableSheetViewController: NSViewController {
    private let tableLayout: MacTableLayout

    init(layout: MacTableLayout) {
        tableLayout = layout
        super.init(nibName: nil, bundle: nil)
        preferredContentSize = NSSize(
            width: min(max(layout.contentSize.width, 520), 900),
            height: 560
        )
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let title = NSTextField(labelWithString: "Table")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false

        let done = NSButton(title: "Done", target: self, action: #selector(closeSheet))
        done.bezelStyle = .rounded
        done.keyEquivalent = "\u{1b}"
        done.translatesAutoresizingMaskIntoConstraints = false

        let table = MacTableScrollView(layout: tableLayout, fullTable: true)
        table.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(title)
        view.addSubview(done)
        view.addSubview(table)
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            title.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            done.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            done.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func closeSheet() { dismiss(self) }
}

enum MacMarkdown {
    static func highlightGeneration() -> Int {
        MacCodeHighlightGeneration.shared.current()
    }

    static func prewarmSyntaxHighlighter() {
        MacCodeHighlighter.prewarm()
    }

    #if DEBUG
    static func codeHighlightCatalogDiagnostics(
        completion: @escaping ([String]) -> Void
    ) {
        MacCodeHighlighter.catalogDiagnostics { diagnostics in
            completion(diagnostics.map { diagnostic in
                "title=\(diagnostic.title) language=\(diagnostic.language) "
                    + "supported=\(diagnostic.supported ? 1 : 0) "
                    + "rawColors=\(diagnostic.rawColorCount) "
                    + "readableColors=\(diagnostic.readableColorCount) "
                    + "sourcePreserved=\(diagnostic.sourcePreserved ? 1 : 0) "
                    + "chars=\(diagnostic.characterCount)"
            })
        }
    }
    #endif

    /// Parse `text` to an `NSAttributedString` mirroring the iOS bubble.
    static func attributed(
        _ text: String,
        cacheKey: String,
        allowSyntaxHighlighting: Bool = true
    ) -> NSAttributedString {
        let key = macContentCacheKey(
            prefix: allowSyntaxHighlighting ? cacheKey : "\(cacheKey):plain-code",
            content: text
        )
        if let hit = macMarkdownCache.object(forKey: key) { return hit }
        MacCodeHighlighter.clearProvisionalFlag()
        let built = build(text, allowSyntaxHighlighting: allowSyntaxHighlighting)
        let provisional = MacCodeHighlighter.consumeProvisionalFlag()
        if !provisional {
            macMarkdownCache.setObject(
                built,
                forKey: key,
                cost: max(text.utf8.count * 2, built.length * 16)
            )
        }
        return built
    }

    private static func build(
        _ text: String,
        allowSyntaxHighlighting: Bool
    ) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let segments = splitMessageBody(text)
        for (i, seg) in segments.enumerated() {
            let piece: NSAttributedString
            switch seg {
            case .inline(let content):
                piece = inlineSegment(content)
            case .blockquote(let content):
                piece = blockquoteSegment(content)
            case .codeBlock(let language, let code):
                piece = codeSegment(
                    language: language,
                    code: code,
                    allowSyntaxHighlighting: allowSyntaxHighlighting
                )
            case .table(let rows, let alignments):
                // Tables in the test page render as a TSV block; the real
                // production mac bubble will use a scroll view like iOS.
                piece = tableSegment(rows: rows, alignments: alignments)
            }
            if i > 0 {
                out.append(NSAttributedString(string: "\n", attributes: [
                    .font: NSFont.systemFont(ofSize: 6),
                ]))
            }
            out.append(piece)
        }
        if out.length == 0 { return inlineSegment(text) }
        return out
    }

    private static func inlineSegment(_ text: String) -> NSAttributedString {
        let lines = text.components(separatedBy: "\n")
        let result = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            if let heading = parseHeading(line) {
                let piece = inlineMarkdown(heading.text, baseFont: heading.font)
                let paragraph = NSMutableParagraphStyle()
                paragraph.paragraphSpacingBefore = heading.level == 1 ? 2 : 1
                paragraph.paragraphSpacing = heading.level <= 2 ? 5 : 3
                result.append(applyingParagraph(paragraph, to: piece))
            } else if let list = parseListItem(line) {
                let marker = list.ordered ? "\(list.number)." : "•"
                let markerWidth = list.ordered ? 25.0 : 18.0
                let indent = CGFloat(list.depth) * 18
                let paragraph = NSMutableParagraphStyle()
                paragraph.firstLineHeadIndent = indent
                paragraph.headIndent = indent + markerWidth
                paragraph.tabStops = [NSTextTab(textAlignment: .left, location: indent + markerWidth)]
                paragraph.defaultTabInterval = markerWidth
                paragraph.paragraphSpacing = 3
                let row = NSMutableAttributedString(string: "\(marker)\t", attributes: [
                    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                    .foregroundColor: MacBubblePalette.secondary,
                ])
                row.append(inlineMarkdown(list.text, baseFont: NSFont.systemFont(ofSize: 15)))
                row.addAttribute(.paragraphStyle, value: paragraph,
                                 range: NSRange(location: 0, length: row.length))
                result.append(row)
            } else {
                result.append(inlineMarkdown(line, baseFont: NSFont.systemFont(ofSize: 15)))
            }
        }
        return result
    }

    private static func inlineMarkdown(_ text: String, baseFont: NSFont) -> NSAttributedString {
        inlineMarkdownFragment(text, baseFont: baseFont)
    }

    private static func inlineMarkdownFragment(
        _ text: String,
        baseFont: NSFont,
        bold: Bool = false,
        italic: Bool = false,
        link: URL? = nil
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var index = text.startIndex
        var plainStart = index

        func font(code: Bool = false) -> NSFont {
            if code { return .monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular) }
            var resolved = baseFont
            if bold { resolved = resolved.tkBold }
            if italic { resolved = resolved.tkItalic }
            return resolved
        }

        func append(_ value: String, code: Bool = false, overrideLink: URL? = nil) {
            guard !value.isEmpty else { return }
            let activeLink = overrideLink ?? link
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font(code: code),
                .foregroundColor: activeLink == nil ? MacBubblePalette.text : MacBubblePalette.link,
            ]
            if let activeLink { attributes[.link] = activeLink }
            result.append(NSAttributedString(string: value, attributes: attributes))
        }

        func flushPlain(until end: String.Index) {
            guard plainStart < end else { return }
            append(String(text[plainStart..<end]))
        }

        while index < text.endIndex {
            let next = text.index(after: index)

            if text[index] == "\\", next < text.endIndex {
                flushPlain(until: index)
                append(String(text[next]))
                index = text.index(after: next)
                plainStart = index
                continue
            }

            if text[index] == "`",
               let close = text[next...].firstIndex(of: "`") {
                flushPlain(until: index)
                append(String(text[next..<close]), code: true)
                index = text.index(after: close)
                plainStart = index
                continue
            }

            if text[index...].hasPrefix("**") {
                let contentStart = text.index(index, offsetBy: 2)
                if let close = text.range(of: "**", range: contentStart..<text.endIndex)?.lowerBound {
                    flushPlain(until: index)
                    result.append(inlineMarkdownFragment(
                        String(text[contentStart..<close]),
                        baseFont: baseFont,
                        bold: true,
                        italic: italic,
                        link: link
                    ))
                    index = text.index(close, offsetBy: 2)
                    plainStart = index
                    continue
                }
            }

            if text[index] == "*" || text[index] == "_",
               let close = text[next...].firstIndex(of: text[index]),
               close > next {
                flushPlain(until: index)
                result.append(inlineMarkdownFragment(
                    String(text[next..<close]),
                    baseFont: baseFont,
                    bold: bold,
                    italic: true,
                    link: link
                ))
                index = text.index(after: close)
                plainStart = index
                continue
            }

            if text[index] == "[",
               let labelEnd = text[next...].firstIndex(of: "]"),
               text.index(after: labelEnd) < text.endIndex,
               text[text.index(after: labelEnd)] == "(" {
                let destinationStart = text.index(labelEnd, offsetBy: 2)
                if let destinationEnd = text[destinationStart...].firstIndex(of: ")"),
                   let destination = URL(string: String(text[destinationStart..<destinationEnd])) {
                    flushPlain(until: index)
                    result.append(inlineMarkdownFragment(
                        String(text[next..<labelEnd]),
                        baseFont: baseFont,
                        bold: bold,
                        italic: italic,
                        link: destination
                    ))
                    index = text.index(after: destinationEnd)
                    plainStart = index
                    continue
                }
            }

            index = next
        }
        flushPlain(until: text.endIndex)
        return result
    }

    private static func applyingParagraph(_ paragraph: NSParagraphStyle,
                                          to string: NSAttributedString) -> NSAttributedString {
        let result = NSMutableAttributedString(attributedString: string)
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        return result
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String, font: NSFont)? {
        let chars = Array(line)
        var level = 0
        while level < min(chars.count, 6), chars[level] == "#" { level += 1 }
        guard level > 0, chars.count > level, chars[level] == " " else { return nil }
        let text = String(chars.dropFirst(level + 1))
        guard !text.isEmpty else { return nil }
        let font: NSFont
        switch level {
        case 1: font = NSFont.systemFont(ofSize: 22, weight: .bold)
        case 2: font = NSFont.systemFont(ofSize: 20, weight: .bold)
        case 3: font = NSFont.systemFont(ofSize: 17, weight: .semibold)
        case 4: font = NSFont.systemFont(ofSize: 15, weight: .bold)
        default: font = NSFont.systemFont(ofSize: 13, weight: .bold)
        }
        return (level, text, font)
    }

    private static func parseListItem(_ line: String) -> (ordered: Bool, number: Int, depth: Int, text: String)? {
        let leading = line.prefix { $0 == " " || $0 == "\t" }
        let depth = leading.reduce(0) { $1 == "\t" ? $0 + 1 : $0 + 1 } / 2
        let trimmed = line.dropFirst(leading.count)
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            return (false, 0, depth, String(trimmed.dropFirst(2)))
        }
        var digits = ""
        var cursor = trimmed.startIndex
        while cursor < trimmed.endIndex, trimmed[cursor].isNumber {
            digits.append(trimmed[cursor])
            cursor = trimmed.index(after: cursor)
        }
        guard !digits.isEmpty, cursor < trimmed.endIndex, trimmed[cursor] == "." else { return nil }
        cursor = trimmed.index(after: cursor)
        guard cursor < trimmed.endIndex, trimmed[cursor] == " " else { return nil }
        let text = String(trimmed[trimmed.index(after: cursor)...])
        return (true, Int(digits) ?? 1, depth, text)
    }

    private static func blockquoteSegment(_ content: String) -> NSAttributedString {
        let normalized = normalizeQuoteWhitespace(content)
        let result = NSMutableAttributedString(attributedString: inlineSegment(normalized))
        result.addAttribute(.foregroundColor, value: MacBubblePalette.text,
                            range: NSRange(location: 0, length: result.length))
        let paragraph = NSMutableParagraphStyle()
        paragraph.firstLineHeadIndent = 14
        paragraph.headIndent = 14
        paragraph.tailIndent = -8
        paragraph.lineSpacing = 1
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        markBlock(result, kind: .quote)
        return result
    }

    private static func normalizeQuoteWhitespace(_ content: String) -> String {
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

    private static func codeSegment(
        language: String?,
        code: String,
        allowSyntaxHighlighting: Bool
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let topHeight: CGFloat = language?.isEmpty == false ? 20 : 8
        result.append(codeSpacer(height: topHeight, terminatesLine: true))

        let highlighted = NSMutableAttributedString(
            attributedString: MacCodeHighlighter.attributed(
                code: code,
                language: language,
                allowHighlighting: allowSyntaxHighlighting
            )
        )
        // Cold provisional code has no foreground attribute, while a syntax
        // theme can occasionally emit a token too dark for our fixed editor
        // surface. Normalize only missing/low-contrast ranges so valid syntax
        // colors survive and every code glyph remains readable.
        MacCodePalette.ensuringReadableForeground(in: highlighted)
        if highlighted.length > 0 {
            let paragraph = NSMutableParagraphStyle()
            paragraph.firstLineHeadIndent = 12
            paragraph.headIndent = 12
            paragraph.tailIndent = -12
            paragraph.lineSpacing = 2
            highlighted.addAttributes([
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                .paragraphStyle: paragraph,
            ], range: NSRange(location: 0, length: highlighted.length))
            result.append(highlighted)
        }
        result.append(NSAttributedString(string: "\n"))
        result.append(codeSpacer(height: 8, terminatesLine: false))
        markBlock(result, kind: .code)
        if let language, !language.isEmpty, result.length > 0 {
            result.addAttribute(.tkBlockLabel, value: language.lowercased(),
                                range: NSRange(location: 0, length: result.length))
        }
        return result
    }

    private static func codeSpacer(height: CGFloat, terminatesLine: Bool) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = height
        paragraph.maximumLineHeight = height
        return NSAttributedString(string: terminatesLine ? "\u{200B}\n" : "\u{200B}", attributes: [
            .font: NSFont.systemFont(ofSize: 1),
            .foregroundColor: NSColor.clear,
            .paragraphStyle: paragraph,
            .tkDecorativeSpacer: true,
        ])
    }

    private static func tableSegment(rows: [[String]], alignments: [TableAlignment]) -> NSAttributedString {
        let attachment = MacTableAttachment(rows: rows, alignments: alignments)
        return NSAttributedString(attachment: attachment, attributes: [
            .tkSemanticText: attachment.tableLayout.semanticText(),
        ])
    }

    static func plainText(_ attributed: NSAttributedString?) -> String? {
        guard let attributed, attributed.length > 0 else { return nil }
        var output = ""
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length)
        ) { attributes, range, _ in
            if attributes[.tkDecorativeSpacer] != nil { return }
            if let semantic = attributes[.tkSemanticText] as? String {
                output += semantic
            } else {
                output += attributed.attributedSubstring(from: range).string
            }
        }
        return output
            .replacingOccurrences(of: "\u{FFFC}", with: "")
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func markBlock(_ string: NSMutableAttributedString, kind: TKBlockKind) {
        guard string.length > 0 else { return }
        let range = NSRange(location: 0, length: string.length)
        string.addAttribute(.tkBlockKind, value: kind.rawValue, range: range)
        string.addAttribute(.tkBlockID, value: UUID().uuidString, range: range)
    }
}

// MARK: - Bubble text view (NSTextView, TextKit2)

final class MacBubbleTextView: NSTextView {
    override var acceptsFirstResponder: Bool { false }

    init() {
        // Build a complete TextKit1 stack so drawRichBlocks can walk the
        // layoutManager: NSTextStorage → NSLayoutManager → NSTextContainer.
        let storage = NSTextStorage()
        let lm = NSLayoutManager()
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(containerSize: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        tc.widthTracksTextView = true
        lm.addTextContainer(tc)
        super.init(frame: .zero, textContainer: tc)
        isVerticallyResizable = true
        isHorizontallyResizable = false
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticLinkDetectionEnabled = false
        isAutomaticDataDetectionEnabled = false
        enabledTextCheckingTypes = 0
        // Do NOT autoresize width with the superview, and do NOT let the
        // textContainer width track the view frame - both cause the container
        // to collapse/expand during layout and balloon measured height. We
        // set the container size explicitly.
        autoresizingMask = []
        tc.widthTracksTextView = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    struct TablePlacement {
        let attachment: MacTableAttachment
        let frame: NSRect
    }

    func setTableViewportWidth(_ width: CGFloat) {
        guard let storage = textStorage else { return }
        storage.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: storage.length)
        ) { value, _, _ in
            (value as? MacTableAttachment)?.setViewportWidth(width)
        }
    }

    func tablePlacements() -> [TablePlacement] {
        guard let layoutManager,
              let textContainer,
              let storage = textStorage,
              storage.length > 0 else { return [] }
        layoutManager.ensureLayout(for: textContainer)
        var placements: [TablePlacement] = []
        storage.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: storage.length)
        ) { value, range, _ in
            guard let attachment = value as? MacTableAttachment else { return }
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: range,
                actualCharacterRange: nil
            )
            var frame = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            frame.origin.x = 0
            frame.size.width = bounds.width
            frame.size.height = attachment.tableLayout.bubbleViewportHeight
            placements.append(TablePlacement(attachment: attachment, frame: frame))
        }
        return placements
    }

    override var intrinsicContentSize: NSSize {
        guard let lm = layoutManager, let tc = textContainer else { return NSSize(width: 650, height: 20) }
        lm.ensureLayout(for: tc)
        let used = lm.usedRect(for: tc)
        return NSSize(width: max(used.width, 1), height: max(ceil(used.height), 1))
    }

    override func layout() {
        super.layout()
        invalidateIntrinsicContentSize()
    }

    /// Plain-text-only messages never enable selection so iOS-style dark
    /// highlights don't appear behind ordinary text. (We keep selection
    /// enabled in the test page — validating it works is the point.)
    override func draw(_ dirtyRect: NSRect) {
        // Draw rich-block backgrounds (code surface / quote rule) FIRST so
        // the glyphs paint on top of them.
        drawRichBlocks(dirtyRect)
        super.draw(dirtyRect)
    }

    /// Walk the attributed string's `.tkBlockKind` ranges and paint the
    /// code/quote decorations underneath the glyphs, mirroring the iOS
    /// `TKBodyTextView.drawRichBlocks`. Uses TextKit1's layoutManager to
    /// resolve each block's character range to a glyph bounding rect.
    private func drawRichBlocks(_ dirtyRect: NSRect) {
        guard let lm = layoutManager,
              let tc = textContainer,
              let ts = textStorage, ts.length > 0 else { return }
        lm.ensureLayout(for: tc)

        // Collect each block's (kind, label, charRange), keyed by blockID so
        // multi-fragment blocks (e.g. a code block with many lines) merge.
        var blocks: [(kind: TKBlockKind, label: String?, charRange: NSRange)] = []
        var seen: [String: Int] = [:]
        var range = NSRange(location: 0, length: 0)
        var idx = 0
        while idx < ts.length {
            let blockID = ts.attribute(.tkBlockID, at: idx, effectiveRange: &range) as? String
            if let blockID, let rawKind = ts.attribute(.tkBlockKind, at: idx, effectiveRange: nil) as? String,
               let kind = TKBlockKind(rawValue: rawKind) {
                let label = ts.attribute(.tkBlockLabel, at: idx, effectiveRange: nil) as? String
                if let existing = seen[blockID] {
                    // Extend the stored block's range to cover this fragment too.
                    let merged = NSUnionRange(blocks[existing].charRange, range)
                    blocks[existing] = (blocks[existing].kind, blocks[existing].label, merged)
                } else {
                    seen[blockID] = blocks.count
                    blocks.append((kind, label, range))
                }
                idx = range.location + range.length
                continue
            }
            idx += 1
        }

        // The layout manager's rect is already in the flipped NSTextView
        // coordinate system on macOS. Do not reflect y again: doing so moves
        // a quote near the bottom of a message onto the first heading.
        for block in blocks {
            let glyphRange = lm.glyphRange(forCharacterRange: block.charRange, actualCharacterRange: nil)
            let lmRect = lm.boundingRect(forGlyphRange: glyphRange, in: tc)
            let rect = NSRect(x: 0, y: lmRect.origin.y, width: bounds.width, height: lmRect.height)
            // Slight vertical padding so the surface hugs the block nicely.
            var frame = rect.insetBy(dx: 0, dy: -2)
            frame = frame.intersection(bounds.insetBy(dx: 0, dy: -1))
            guard !frame.isNull, frame.height > 0 else { continue }
            switch block.kind {
            case .quote:
                NSColor.secondarySystemFill.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
                NSColor.separatorColor.setFill()
                NSBezierPath(roundedRect: NSRect(x: frame.minX, y: frame.minY,
                                                 width: 3, height: frame.height),
                             xRadius: 1.5, yRadius: 1.5).fill()
            case .code:
                // Neutral editor surface — stable across agent/user bubble tints.
                MacCodePalette.background.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 9, yRadius: 9).fill()
                NSColor(srgbRed: 0x52/255, green: 0x52/255, blue: 0x5B/255, alpha: 0.72).setStroke()
                let outline = NSBezierPath(roundedRect: frame.insetBy(dx: 0.25, dy: 0.25),
                                           xRadius: 9, yRadius: 9)
                outline.lineWidth = 0.5
                outline.stroke()
                if let label = block.label {
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                        .foregroundColor: NSColor(srgbRed: 0xA1/255, green: 0xA1/255, blue: 0xAA/255, alpha: 1),
                    ]
                    (label as NSString).draw(at: NSPoint(x: frame.minX + 12, y: frame.minY + 5),
                                             withAttributes: attrs)
                }
            }
        }
    }
}

// MARK: - SwiftUI host

struct MacBubbleTestView: View {
    private let samples = MacBubbleCatalog.samples

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(samples.indices, id: \.self) { idx in
                    bubbleCard(samples[idx])
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("Bubble Test Page")
        .onAppear { MacMarkdown.prewarmSyntaxHighlighter() }
    }

    private func bubbleCard(_ sample: MacBubbleCatalog.Sample) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(sample.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            MacBubbleHost(markdown: sample.body)
                .frame(maxWidth: 680)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
    }
}

struct MacBubbleHost: NSViewRepresentable {
    let markdown: String

    func makeNSView(context: Context) -> MacBubbleTextView {
        let textView = MacBubbleTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.textContainer?.size = NSSize(width: 650, height: CGFloat.greatestFiniteMagnitude)
        textView.textStorage?.setAttributedString(
            MacMarkdown.attributed(markdown, cacheKey: "mactest")
        )
        textView.layoutManager?.ensureLayout(for: textView.textContainer!)
        // Use intrinsicContentSize so SwiftUI sizes the host to laid-out
        // content. Override below returns the computed height.
        textView.invalidateIntrinsicContentSize()
        return textView
    }

    func updateNSView(_ nsView: MacBubbleTextView, context: Context) {
        nsView.textStorage?.setAttributedString(
            MacMarkdown.attributed(markdown, cacheKey: "mactest")
        )
        nsView.textContainer?.size = NSSize(width: 650, height: CGFloat.greatestFiniteMagnitude)
        nsView.layoutManager?.ensureLayout(for: nsView.textContainer!)
        nsView.invalidateIntrinsicContentSize()
    }
}

// MARK: - Pure AppKit test page (for headless render)

/// Vertical stack of bubble cards built entirely in AppKit so layout
/// completes deterministically for off-screen bitmap capture. Mirrors
/// what the SwiftUI `MacBubbleTestView` shows, but without SwiftUI's
/// async layout / intrinsic-size path.
final class BubbleTestPageView: NSView {
    override var isFlipped: Bool { true }

    private let samples = MacBubbleCatalog.samples

    private var cards: [(title: String, view: NSView)] = []

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        // Force light appearance + white bg so the off-screen render is
        // legible regardless of the system appearance.
        appearance = NSAppearance(named: .aqua)
        layer?.backgroundColor = NSColor.white.cgColor
        MacMarkdown.prewarmSyntaxHighlighter()
        for s in samples {
            let card = makeCard(title: s.title, body: s.body)
            addSubview(card)
            cards.append((s.title, card))
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // Place cards top-down (isFlipped makes origin top-left).
        var y: CGFloat = 24
        let cardWidth = min(bounds.width - 48, 680)
        for (_, card) in cards {
            var f = card.frame
            f.origin = NSPoint(x: 24, y: y)
            f.size.width = cardWidth
            card.frame = f
            y += f.height + 16
        }
    }

    private func makeCard(title: String, body: String) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.sizeToFit()

        let tv = MacBubbleTextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isRichText = true
        tv.drawsBackground = false
        tv.backgroundColor = .clear
        tv.textContainer?.lineFragmentPadding = 0
        let bodyWidth: CGFloat = 680
        tv.textContainer?.size = NSSize(width: bodyWidth - 28, height: CGFloat.greatestFiniteMagnitude)
        tv.textStorage?.setAttributedString(MacMarkdown.attributed(body, cacheKey: "page:\(title)"))
        tv.layoutManager?.ensureLayout(for: tv.textContainer!)
        let used = tv.layoutManager?.usedRect(for: tv.textContainer!) ?? NSRect(x: 0, y: 0, width: bodyWidth, height: 20)
        let tvHeight = max(ceil(used.height), 16)
        tv.frame = NSRect(x: 14, y: 14, width: bodyWidth - 28, height: tvHeight)

        let card = NSView(frame: NSRect(x: 0, y: 0, width: bodyWidth, height: 18 + tvHeight + 14))
        card.wantsLayer = true
        card.layer?.cornerRadius = 12
        card.layer?.backgroundColor = NSColor(white: 0.96, alpha: 1).cgColor
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor(white: 0.85, alpha: 1).cgColor
        titleLabel.frame.origin = NSPoint(x: 14, y: 14)
        card.addSubview(titleLabel)
        card.addSubview(tv)
        return card
    }
}

#endif
