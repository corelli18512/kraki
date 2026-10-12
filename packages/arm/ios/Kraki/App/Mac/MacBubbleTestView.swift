/// MacBubbleTestView.swift — the Mac bubble test pages and their stress
/// catalog, compiled in Debug builds only (Debug menu → "Bubble Test Page",
/// KRAKI_RENDER_BUBBLE_TEST).
///
/// The production renderer they exercise lives in MacMarkdown.swift,
/// MacCodeHighlighter.swift, MacTables.swift and MacBubbleTextView.swift.

#if os(macOS)
import AppKit
import SwiftUI
import Highlightr

#if DEBUG
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
               body: "\u{4E2D}\u{6587}\u{6392}\u{7248}\u{3001}かな\u{3001}한국어, emoji 🦑🚀, combining café, and a verylongtoken_without_breaks_abcdefghijklmnopqrstuvwxyz0123456789."),
    ]
}
#endif

// MARK: - SwiftUI host (Debug test pages only)

#if DEBUG

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

#endif
