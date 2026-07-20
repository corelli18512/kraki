#if os(iOS) && DEBUG
import SwiftUI
import UIKit

/// Exhaustive visual catalog for the production TextKit bubble renderer.
/// Launch with `KRAKI_BUBBLE_CATALOG=1`; never linked from production UI.
struct BubbleCatalogTestView: View {
    @Environment(AppState.self) private var appState
    @State private var callbackEvent = "No action selected"

    private let sessionId = "bubble-catalog"

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    catalogHeader
                        .padding(.horizontal, 12)
                    catalogSection("Persisted spine", cases: persistedCases)
                    catalogSection("Markdown matrix", cases: markdownCases)
                    catalogSection("Streaming and tools", cases: toolCases)
                    catalogSection("Permissions", cases: permissionCases)
                    catalogSection("Questions", cases: questionCases)
                    catalogSection("Terminal outcomes", cases: terminalCases)
                    catalogSection("Images", cases: imageCases)
                }
                .padding(.vertical, 16)
            }
            .background(Color.surfacePrimary)
            .navigationTitle("Bubble Catalog")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var catalogHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Production renderer matrix")
                .font(.title2.bold())
            Text("Every sample below uses TKBubbleContent + TKBubbleCell. No alternate preview renderer.")
                .font(.footnote)
                .foregroundStyle(Color.textSecondary)
            Text(callbackEvent)
                .font(.caption.monospaced())
                .foregroundStyle(callbackEvent == "No action selected" ? Color.textMuted : Color.krakiPrimary)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color.surfaceSecondary, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func catalogSection(_ title: String, cases: [BubbleCatalogCase]) -> some View {
        Section {
            ForEach(cases) { sample in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(sample.title).font(.headline)
                        Spacer()
                        Text(sample.badge)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Color.textMuted)
                    }
                    if let note = sample.note {
                        Text(note).font(.caption).foregroundStyle(Color.textSecondary)
                    }
                }
                .padding(.horizontal, 12)
                BubbleCatalogCell(
                    content: sample.content,
                    sessionMode: sample.sessionMode,
                    attachmentStore: appState.attachmentStore,
                    onPermission: { id, _, decision in
                        callbackEvent = "permission \(id): \(decision)"
                    },
                    onQuestion: { id, answer in
                        callbackEvent = "question \(id): \(answer)"
                    }
                )
                .frame(height: sample.content.cellHeight(cellWidth: UIScreen.main.bounds.width) + 2)
            }
        } header: {
            Text(title)
                .font(.title3.bold())
                .foregroundStyle(Color.textPrimary)
                .padding(.horizontal, 12)
        }
    }

    private var persistedCases: [BubbleCatalogCase] {
        [
            persisted("user-short", "User · short", type: "user_message", content: "Yes"),
            persisted("user-long", "User · wrapped", type: "user_message", content: "A longer user message that should hug its content until it reaches the maximum user bubble width, then wrap naturally without clipping or stretching to full width."),
            persisted("agent-plain", "Agent · plain", type: "agent_message", content: "A completed agent response with normal body text."),
            persisted("agent-steps", "Agent · Steps affordance", type: "agent_message", content: "Completed answer with trace available.", extra: ["steps": AnyCodable(4)]),
            persisted("system", "System message", type: "system_message", content: "System notice: the session resumed on another device."),
            persisted("send-input", "Optimistic send_input", type: "send_input", content: "Pending optimistic input"),
        ]
    }

    private var markdownCases: [BubbleCatalogCase] {
        [
            persisted("md-inline", "Inline styles", type: "agent_message", content: "**Bold**, *italic*, `inline code`, ~~literal strikethrough boundary~~, and a [Kraki link](https://kraki.chat)."),
            persisted("md-headings", "ATX headings", type: "agent_message", content: "# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5"),
            persisted("md-lists", "Lists and whitespace", type: "agent_message", content: "- First bullet\n- Second bullet with **bold**\n  - Nested-looking line\n\n1. First numbered item\n2. Second numbered item"),
            persisted("md-quote", "Blockquote · compact", type: "agent_message", content: "> Quoted line with **emphasis**\n> Second quoted line\n\nFollowing paragraph."),
            persisted("md-quote-long", "Blockquote · long wrapping", type: "agent_message", content: "> This is a deliberately long quotation that should wrap across several lines while keeping one continuous background and one leading rule. It should grow only by the actual TextKit line height, without creating a giant empty region above or below the quoted text.\n> A second quoted paragraph continues the same compact block."),
            persisted("md-quote-empty-lines", "Blockquote · repeated empty lines", type: "agent_message", content: "> Start of quote.\n>\n>\n>\n>\n>\n> End of quote after repeated empty markers."),
            persisted("md-quote-multiblock", "Blockquote · separate blocks", type: "agent_message", content: "> First quote block.\n> It has two lines.\n\nNormal paragraph between quotes.\n\n> Second quote block with a long_unbroken_token_abcdefghijklmnopqrstuvwxyz0123456789 that must wrap without exploding the measured height."),
            persisted("md-code", "Code · Swift highlight", type: "agent_message", content: "Before code.\n\n```swift\nstruct Bubble {\n    let state: String\n    func render() -> Bool { true }\n}\n```\n\nAfter code."),
            persisted("md-code-long-first", "Code · long first line + badge", type: "agent_message", content: "```swift\nlet extremelyLongVariableNameThatMustWrapWithoutTouchingTheLanguageBadge = makeBubble(configuration: .production, enabled: true)\n```"),
            persisted("md-code-ts", "Code · TypeScript highlight", type: "agent_message", content: "```typescript\ninterface Session { id: string; active: boolean }\nconst current: Session = { id: 'abc', active: true }\n```"),
            persisted("md-code-json", "Code · JSON highlight", type: "agent_message", content: "```json\n{ \"session\": \"abc\", \"count\": 42, \"ready\": true }\n```"),
            persisted("md-code-shell", "Code · shell highlight", type: "agent_message", content: "```bash\nrg -n \"TKBubbleCell\" packages/arm/ios | head -20\n```"),
            persisted("md-code-unknown", "Code · unknown language fallback", type: "agent_message", content: "```not-a-real-language\nwidget => value + 42\n```"),
            persisted("md-long-code", "Long code line", type: "agent_message", content: "```text\nhttps://example.com/a/very/long/unbroken/path/that/should/wrap/inside/the/textkit/bubble/without/escaping/the/card/bounds?query=abcdefghijklmnopqrstuvwxyz0123456789\n```"),
            persisted("md-table", "GFM table fallback", type: "agent_message", content: "| State | Result | Note |\n| :--- | :---: | ---: |\n| idle | ready | 1 |\n| streaming | active | 2 |"),
            persisted("md-table-large", "GFM table · wide stress", type: "agent_message", content: "| Session | Agent | Model | Status | Started | Duration | Input Tokens | Output Tokens |\n| :--- | :--- | :--- | :---: | :--- | ---: | ---: | ---: |\n| production-session-with-a-long-name | pi | claude-sonnet-4 | streaming | 2026-07-15 21:42 | 128.4s | 124500 | 18942 |\n| simulator-catalog | codex | gpt-5-codex | completed | 2026-07-15 20:01 | 42.8s | 9850 | 3201 |\n| device-debug | pi | claude-opus-4 | failed | 2026-07-15 19:18 | 301.2s | 245900 | 12003 |"),
            persisted("md-table-tall", "GFM table · tall stress", type: "agent_message", content: "| Index | Event | Status |\n| ---: | :--- | :---: |\n| 1 | Connect relay | done |\n| 2 | Fetch session head | done |\n| 3 | Load local window | done |\n| 4 | Merge live tail | done |\n| 5 | Project turn spine | done |\n| 6 | Measure bubbles | done |\n| 7 | Attach collection | done |\n| 8 | Restore anchor | done |\n| 9 | Render images | done |\n| 10 | Hydrate content refs | done |\n| 11 | Resolve action cards | done |\n| 12 | Update live draft | running |\n| 13 | Persist terminal turn | pending |\n| 14 | Refresh session list | pending |\n| 15 | Flush diagnostics | pending |"),
            persisted("md-mixed", "Mixed blocks", type: "agent_message", content: "## Summary\nA paragraph with `code` and a [link](https://example.com).\n\n> Important quoted guidance.\n\n```bash\npnpm test\n```\n\n| Check | Status |\n| --- | --- |\n| Build | Pass |"),
            persisted("md-unicode", "Unicode and emoji", type: "agent_message", content: "中文排版、かな、한국어, emoji 🦑🚀, combining café, and a verylongtoken_without_breaks_abcdefghijklmnopqrstuvwxyz0123456789."),
        ]
    }

    private var toolCases: [BubbleCatalogCase] {
        [
            live("live-idle", "Live draft · no action", text: "Streaming narration with **inline markdown** and no current action.", action: nil),
            live("tool-running", "Tool · running", text: "I’ll inspect the repository.", action: action("tool_start", id: "tool-running", payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc-running"), "headline": AnyCodable("$ rg -n BubbleCatalog")])) ,
            live("tool-success", "Tool · completed success", text: "The command finished.", action: action("tool_complete", id: "tool-success", payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc-success"), "headline": AnyCodable("$ xcodebuild test"), "success": AnyCodable(true)])),
            live("tool-failure", "Tool · completed failure", text: "The command returned an error.", action: action("tool_complete", id: "tool-failure", payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc-failure"), "headline": AnyCodable("$ false"), "success": AnyCodable(false)])),
            live("tool-batch", "Tool · parallel batch", text: "Running independent checks in parallel.", action: action("tool_batch", id: "tool-batch", payload: ["running": AnyCodable(3)])),
            live("action-only", "Action only · no draft", text: "", action: action("tool_start", id: "action-only", payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("tc-only"), "headline": AnyCodable("README.md")])),
        ]
    }

    private var permissionCases: [BubbleCatalogCase] {
        [
            live("perm-discuss-write", "Permission · pending write/discuss", text: "I need to update the file.", action: permission("perm-write", tool: "edit", description: "Edit Sources/App.swift"), sessionMode: .discuss),
            live("perm-execute-write", "Permission · pending write/execute", text: "I need to update the file.", action: permission("perm-execute", tool: "edit", description: "Edit Sources/App.swift"), sessionMode: .execute),
            live("perm-read", "Permission · pending read", text: "This command needs approval.", action: permission("perm-read", tool: "bash", description: "$ cat ~/.config/private")),
            live("perm-approved", "Permission · approved", text: "Permission was resolved.", action: permission("perm-approved", tool: "bash", description: "$ pwd", decision: "approve"), frozen: true),
            live("perm-always", "Permission · always allowed", text: "Permission was resolved.", action: permission("perm-always", tool: "bash", description: "$ pwd", decision: "always_allow"), frozen: true),
            live("perm-denied", "Permission · denied", text: "Permission was denied.", action: permission("perm-denied", tool: "bash", description: "$ rm file", decision: "deny"), frozen: true),
        ]
    }

    private var questionCases: [BubbleCatalogCase] {
        [
            live("question-choices", "Question · pending choices", text: "I need one decision.", action: question("q-choices", prompt: "Which target should I use?", choices: ["Simulator", "Physical device", "Both **targets**"])),
            live("question-freeform", "Question · composer answer", text: "Waiting for a typed answer in the normal composer.", action: question("q-freeform", prompt: "What should the release note say?", choices: nil), note: "No editor inside the card by design; production composer owns freeform answers."),
            live("question-answered", "Question · answered", text: "Decision received.", action: question("q-answered", prompt: "Which target should I use?", choices: ["Simulator", "Device"], answer: "Both **targets**"), frozen: true),
            live("question-cancelled", "Question · cancelled", text: "The question is no longer pending.", action: question("q-cancelled", prompt: "Continue deployment?", choices: ["Yes", "No"], cancelled: true), frozen: true),
            live("question-long", "Question · long wrapping", text: "A longer decision is needed.", action: question("q-long", prompt: "Choose the behavior that should be used when the authoritative session head is newer than the locally materialized window and the device reconnects while the page is opening.", choices: ["Wait for the latest bubble before showing content", "Show cached content immediately and jump later"])),
        ]
    }

    private var terminalCases: [BubbleCatalogCase] {
        [
            live("terminal-abort", "Frozen · user abort", text: "Partial draft preserved before the user stopped the turn.", action: action("user_abort", id: "terminal-abort", payload: [:]), frozen: true),
            live("terminal-failed", "Frozen · failed", text: "Partial draft preserved before failure.", action: action("failed", id: "terminal-failed", payload: ["message": AnyCodable("Model error: context length exceeded")]), frozen: true),
            live("terminal-failed-empty", "Frozen · failed action only", text: "", action: action("failed", id: "terminal-failed-empty", payload: ["message": AnyCodable("Connection lost")]), frozen: true),
        ]
    }

    private var imageCases: [BubbleCatalogCase] {
        [
            persisted("image-inline", "User · embedded image", type: "user_message", content: "Image attachment", extra: [
                "attachments": AnyCodable([["type": "image", "mimeType": "image/png", "data": Self.onePixelPNG]])
            ]),
            persisted("image-only", "User · image only", type: "user_message", content: "[image]", extra: [
                "attachments": AnyCodable([["type": "image", "mimeType": "image/png", "data": Self.onePixelPNG]])
            ]),
            persisted("content-ref", "Agent · unresolved content_ref", type: "agent_message", content: "Generated image reference", extra: [
                "attachments": AnyCodable([["type": "content_ref", "mimeType": "image/png", "id": "catalog-unresolved-image", "size": 12345, "width": 100, "height": 50]])
            ], note: "Expected to show the lazy unresolved placeholder unless matching chunks exist in AttachmentStore."),
        ]
    }

    private func persisted(_ key: String, _ title: String, type: String, content: String,
                           extra: [String: AnyCodable] = [:], note: String? = nil) -> BubbleCatalogCase {
        var payload = extra
        payload["content"] = AnyCodable(content)
        let message = ChatMessage(type: type, seq: stableSeq(key), sessionId: sessionId,
                                  deviceId: "catalog-device", timestamp: "2026-07-15T00:00:00Z",
                                  payload: payload)
        return BubbleCatalogCase(id: key, title: title, badge: type, note: note,
                                 content: TKBubbleContent.make(message: message, sessionId: sessionId, agent: "pi"))
    }

    private func live(_ key: String, _ title: String, text: String, action: ChatMessage?,
                      sessionMode: SessionMode = .discuss, frozen: Bool = false,
                      note: String? = nil) -> BubbleCatalogCase {
        let card = MessageStore.SessionCard(text: text, action: action)
        let content = TKBubbleContent.live(card: card, agent: "pi", sessionId: sessionId,
                                           steps: 2, isFrozen: frozen,
                                           frozenTimestamp: frozen ? "2026-07-15T00:00:00Z" : nil)
        return BubbleCatalogCase(id: key, title: title,
                                 badge: frozen ? "frozen/\(action?.type ?? "idle")" : "live/\(action?.type ?? "idle")",
                                 note: note, content: content, sessionMode: sessionMode)
    }

    private func action(_ type: String, id: String, payload: [String: AnyCodable]) -> ChatMessage {
        ChatMessage(type: type, seq: 0, sessionId: sessionId, deviceId: "catalog-device",
                    timestamp: nil, payload: payload.merging(["id": AnyCodable(id)]) { current, _ in current })
    }

    private func permission(_ id: String, tool: String, description: String, decision: String? = nil) -> ChatMessage {
        var payload: [String: AnyCodable] = [
            "id": AnyCodable(id), "permissionId": AnyCodable(id),
            "toolName": AnyCodable(tool), "description": AnyCodable(description),
        ]
        if let decision { payload["decision"] = AnyCodable(decision) }
        return action("permission", id: id, payload: payload)
    }

    private func question(_ id: String, prompt: String, choices: [String]?,
                          answer: String? = nil, cancelled: Bool = false) -> ChatMessage {
        var payload: [String: AnyCodable] = [
            "id": AnyCodable(id), "questionId": AnyCodable(id),
            "question": AnyCodable(prompt), "cancelled": AnyCodable(cancelled),
        ]
        if let choices { payload["choices"] = AnyCodable(choices) }
        if let answer { payload["answer"] = AnyCodable(answer) }
        return action("question", id: id, payload: payload)
    }

    private func stableSeq(_ value: String) -> Int {
        value.utf8.reduce(17) { (($0 &* 31) &+ Int($1)) % 900_000 } + 1
    }

    private static let onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAABPElEQVR4nO3ZvW2CMRSFYSMxAQ27kBGyAgyQHUJ1tkjNCoyQYU6RzIASS1EQzfWH/fn+vYXl8uqRLVny5v3wVfT18XYqauLxWjfb2ZOo7o+pllgipv3lNbGkTLU8WSKmWmKJmGrRsShjio7FFqa4WGxniojFpUyxsPgcUxQs9mDyj8V+TJ6x2JvJJxbHMHnD4kgmP1gcz+QBi2sx2cbiukxWsTiDyR4W5zFZwuJsJhtY1MGkHYuamJRi4XP3s5arKiZ1WPhl+p8eJkVYuGc6v3yr+pHWgoUHpqK4aVgwxTQNCwaZJmDBLNOqWDDOtBIWXDANx4IjpoFYcMc0BAtOmTpjwTVTNywEYOqAhTBMT2EhGNNCLIRkasZCYKYGrGQSYSWTCCuZRFjJJMJKJhFWMknaJtOSaxjw3VQauwF+mJe7s1c+PQAAAABJRU5ErkJggg=="
}

private struct BubbleCatalogCase: Identifiable {
    let id: String
    let title: String
    let badge: String
    var note: String?
    let content: TKBubbleContent
    var sessionMode: SessionMode = .discuss
}

private struct BubbleCatalogCell: UIViewRepresentable {
    let content: TKBubbleContent
    let sessionMode: SessionMode
    let attachmentStore: AttachmentStore
    let onPermission: (String, String?, String) -> Void
    let onQuestion: (String, String) -> Void

    func makeUIView(context: Context) -> TKBubbleCell {
        TKBubbleCell(frame: .zero)
    }

    func updateUIView(_ cell: TKBubbleCell, context: Context) {
        let width = UIScreen.main.bounds.width
        let height = content.cellHeight(cellWidth: width)
        cell.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        cell.sessionMode = sessionMode
        cell.attachmentStore = attachmentStore
        cell.onResolvePermission = onPermission
        cell.onAnswerQuestion = onQuestion
        cell.onOpenSteps = { _ in }
        cell.onShowTable = { [weak cell] layout in
            guard let presenter = cell?.nearestViewController else { return }
            let table = TKTableSheetViewController(layout: layout)
            presenter.present(UINavigationController(rootViewController: table), animated: true)
        }
        cell.configure(content, cellWidth: width)
        cell.setBodyInteractive(true)
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
    }
}
private extension UIView {
    var nearestViewController: UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }
}
#endif
