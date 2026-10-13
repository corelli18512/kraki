/// The Mac chat scenario catalog: every scripted scenario (sessions, phases, messages, attachments) the scenario test page can play.

#if os(macOS) && DEBUG
import AppKit
import Observation
import SwiftUI

extension MacChatScenarioHarness {
    static func buildCatalog() -> (
        scenarios: [MacChatScenarioDefinition],
        attachments: [MacChatScenarioAttachmentFixture]
    ) {
        let imageRed = makePNG(
            size: NSSize(width: 720, height: 420),
            colors: [NSColor.systemRed, NSColor.systemOrange],
            label: "Image A · 720 × 420"
        )
        let imageBlue = makePNG(
            size: NSSize(width: 520, height: 760),
            colors: [NSColor.systemBlue, NSColor.systemPurple],
            label: "Image B · portrait"
        )
        let imageGreen = makePNG(
            size: NSSize(width: 960, height: 320),
            colors: [NSColor.systemGreen, NSColor.systemTeal],
            label: "Image C · panoramic"
        )
        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system;margin:0;padding:28px;background:#10131a;color:#edf2ff}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px}
        .card{min-width:0;padding:18px;border:1px solid #334155;border-radius:14px;background:#18202d}
        .value{font-size:clamp(19px,5vw,28px);font-weight:700;color:#8bd5ff;overflow-wrap:anywhere} h1{margin-top:0}
        </style></head><body><h1>Real HTML Report Artifact</h1>
        <p>This is loaded through AttachmentStore and the production secure WKWebView panel.</p>
        <div class="grid"><div class="card"><div>Sessions</div><div class="value">47</div></div>
        <div class="card"><div>Scenarios</div><div class="value">47</div></div>
        <div class="card"><div>Renderer</div><div class="value">CoreText</div></div></div></body></html>
        """.data(using: .utf8) ?? Data()

        let imageRefID = "scenario-image-ref-a"
        let htmlRefID = "scenario-html-report"
        let attachments = [
            MacChatScenarioAttachmentFixture(id: imageRefID, mimeType: "image/png", data: imageRed),
            MacChatScenarioAttachmentFixture(id: htmlRefID, mimeType: "text/html", data: html),
        ]

        var definitions: [MacChatScenarioDefinition] = []

        func payload(_ values: [String: Any]) -> [String: AnyCodable] {
            values.mapValues { AnyCodable($0) }
        }

        func message(
            _ sessionID: String,
            _ seq: Int,
            _ type: String,
            _ values: [String: Any] = [:]
        ) -> ChatMessage {
            ChatMessage(
                type: type,
                seq: seq,
                sessionId: sessionID,
                deviceId: Self.onlineDeviceA,
                timestamp: String(format: "2026-08-08T00:%02d:%02d.000Z", (seq / 60) % 60, seq % 60),
                payload: payload(values)
            )
        }

        func action(
            _ sessionID: String,
            _ type: String,
            _ values: [String: Any] = [:]
        ) -> ChatMessage {
            ChatMessage(
                type: type,
                seq: 0,
                sessionId: sessionID,
                deviceId: Self.onlineDeviceA,
                timestamp: nil,
                payload: payload(values)
            )
        }

        func preview(_ text: String, _ type: String) -> SessionPreview {
            SessionPreview(text: text, type: type, timestamp: "")
        }

        func phase(
            _ name: String,
            messages: [ChatMessage] = [],
            card: MessageStore.SessionCard? = nil,
            state: SessionState? = nil,
            runtime: SessionRuntimeStatus = .idle,
            online: Bool = true,
            preview: SessionPreview? = nil,
            readSeq: Int? = nil,
            lastSeq: Int? = nil,
            loading: Bool = false,
            draft: String? = nil
        ) -> MacChatScenarioPhase {
            MacChatScenarioPhase(
                name: name,
                messages: messages,
                card: card,
                sessionState: state ?? (card == nil ? .idle : .active),
                runtimeStatus: runtime,
                deviceOnline: online,
                preview: preview,
                readSeq: readSeq,
                authoritativeLastSeq: lastSeq,
                loadingHead: loading,
                sidebarDraft: draft
            )
        }

        func add(
            _ id: String,
            category: String,
            title: String,
            summary: String,
            deviceID: String = Self.onlineDeviceA,
            mode: SessionMode = .auto,
            pinned: Bool = false,
            phases: [MacChatScenarioPhase],
            traces: [Int: [ChatMessage]] = [:]
        ) {
            definitions.append(MacChatScenarioDefinition(
                id: id,
                category: category,
                title: title,
                summary: summary,
                deviceID: deviceID,
                mode: mode,
                pinned: pinned,
                phases: phases,
                traces: traces,
                ordinal: definitions.count
            ))
        }

        func basicConversation(_ id: String, user: String, agent: String) -> [ChatMessage] {
            [
                message(id, 1, "user_message", ["content": user]),
                message(id, 2, "agent_message", ["content": agent]),
                message(id, 3, "idle", ["reason": "completed"]),
            ]
        }

        add(
            "entry-empty-online",
            category: "Entry & connectivity",
            title: "01 · Entry · Empty online",
            summary: "Online device, authoritative empty head, Composer visible and no-conversation state.",
            phases: [phase("At empty head", online: true, preview: nil, lastSeq: 0)]
        )
        add(
            "entry-empty-offline",
            category: "Entry & connectivity",
            title: "02 · Entry · Empty offline",
            summary: "Offline device with no cache; production offline empty-state and hidden Composer.",
            deviceID: Self.offlineDevice,
            phases: [phase("Offline and uncached", online: false, preview: preview("Device offline", "user_message"))]
        )
        let cachedOfflineID = "entry-cached-offline"
        let cachedOfflineMessages = basicConversation(
            cachedOfflineID,
            user: "Can I still read this while the Tentacle is offline?",
            agent: "Yes. This page is rendered from the local GRDB history window."
        )
        add(
            cachedOfflineID,
            category: "Entry & connectivity",
            title: "03 · Entry · Cached offline",
            summary: "Offline device with cached history; messages remain readable while Composer is absent.",
            deviceID: Self.offlineDevice,
            phases: [phase(
                "Cached tail",
                messages: cachedOfflineMessages,
                online: false,
                preview: preview("Yes. This page is rendered from the local cache.", "agent_message")
            )]
        )
        add(
            "entry-loading-empty",
            category: "Entry & connectivity",
            title: "04 · Entry · Empty initial head fetch",
            summary: "No local messages, online head is known, and the production center loading gate remains active.",
            phases: [phase(
                "Head request in flight",
                state: .active,
                preview: preview("Waiting for authoritative head", "user_message"),
                lastSeq: 18,
                loading: true
            )]
        )
        let reconcileID = "entry-cached-reconciling"
        let reconcileMessages = basicConversation(
            reconcileID,
            user: "Show cached content immediately.",
            agent: "This local tail stays visible while a newer Relay head is reconciled."
        )
        add(
            reconcileID,
            category: "Entry & connectivity",
            title: "05 · Entry · Cached while reconciling",
            summary: "Local presentation must stay visible while the authoritative head request is in flight.",
            phases: [phase(
                "Cached tail + head request",
                messages: reconcileMessages,
                state: .active,
                preview: preview("Reconciling newer head…", "agent_message"),
                lastSeq: 12,
                loading: true
            )]
        )

        let historyID = "history-mixed"
        add(
            historyID,
            category: "History & virtualization",
            title: "06 · History · Mixed bubble geometry",
            summary: "Short/long human and agent bubbles, Markdown, links, quote, table, and code in one real list.",
            phases: [phase(
                "Mixed immutable tail",
                messages: [
                    message(historyID, 1, "user_message", ["content": "hi"]),
                    message(historyID, 2, "agent_message", ["content": "Hello — short agent response."]),
                    message(historyID, 3, "idle"),
                    message(historyID, 4, "user_message", ["content": "Render a longer response with Markdown and wrapping behavior."]),
                    message(historyID, 5, "agent_message", ["content": """
                    ## Production renderer

                    This is the **real cached CoreText bubble** with a [link](https://kraki.chat), `inline code`, and a long sentence that wraps naturally without introducing a TextKit cell.

                    > Quoted guidance remains compact and aligned.

                    | State | Expected |
                    | --- | --- |
                    | cached | visible |
                    | scrolling | smooth |

                    ```swift
                    let renderer = "MacCoreTextLayoutArtifact"
                    print(renderer)
                    ```
                    """, "steps": 4]),
                    message(historyID, 6, "idle"),
                ],
                preview: preview("Production renderer", "agent_message")
            )],
            traces: [5: [
                action(historyID, "agent_narration", ["content": "Preparing the mixed Markdown response."]),
                action(historyID, "tool_start", ["toolName": "read", "headline": "Read MacChatBubbleCell.swift", "toolCallId": "history-read"]),
                action(historyID, "tool_complete", ["toolName": "read", "headline": "Read MacChatBubbleCell.swift", "toolCallId": "history-read", "success": true]),
            ]]
        )

        let longHistoryID = "history-long-pagination"
        var longHistory: [ChatMessage] = []
        var longSeq = 1
        for turn in 1...90 {
            longHistory.append(message(longHistoryID, longSeq, "user_message", [
                "content": "History prompt \(turn): keep pagination anchored while older rows prepend."
            ]))
            longSeq += 1
            longHistory.append(message(longHistoryID, longSeq, "agent_message", [
                "content": turn.isMultiple(of: 7)
                    ? """
                      Turn \(turn) includes a taller response.

                      - viewport virtualization
                      - reusable cells
                      - cached CoreText geometry
                      - stable prepend anchor
                      """
                    : "History response \(turn). Scroll to the top repeatedly to exercise DB-first pagination."
            ]))
            longSeq += 1
            longHistory.append(message(longHistoryID, longSeq, "idle"))
            longSeq += 1
        }
        add(
            longHistoryID,
            category: "History & virtualization",
            title: "07 · History · 90-turn pagination",
            summary: "270 persistent rows; the Mac opens a compact tail and loads older DB pages at the top edge.",
            phases: [phase(
                "Tail window",
                messages: longHistory,
                preview: preview("History response 90", "agent_message")
            )]
        )

        let scrollGateID = "history-scroll-production-gate"
        var scrollGateHistory: [ChatMessage] = []
        var scrollGateSeq = 1
        for turn in 1...75 {
            scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "user_message", [
                "content": "Scroll gate prompt \(turn): preserve the native viewport while older history arrives."
            ]))
            scrollGateSeq += 1
            scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "agent_message", [
                "content": """
                Scroll gate response \(turn) keeps production CoreText geometry deterministic.

                - preserve the visible anchor while older rows prepend
                - keep native virtualization bounded to the viewport runway
                - retain explicit older-history intent near the live tail
                """
            ]))
            scrollGateSeq += 1
            scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "idle"))
            scrollGateSeq += 1
        }
        // The Mac initial raw tail is 15 rows: 13 off-spine lifecycle rows
        // plus the final user/agent pair. The rendered entry is therefore a
        // compact tail, while the immediately preceding DB page contains
        // visible history for the first upward gesture.
        for _ in 0..<13 {
            scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "idle"))
            scrollGateSeq += 1
        }
        scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "user_message", [
            "content": "Newest compact-tail prompt."
        ]))
        scrollGateSeq += 1
        scrollGateHistory.append(message(scrollGateID, scrollGateSeq, "agent_message", [
            "content": "Newest compact-tail response."
        ]))
        add(
            scrollGateID,
            category: "History & virtualization",
            title: "07b · History · Native scroll production gate",
            summary: "Compact rendered tail over deep synthetic DB history for the cross-platform scroll-policy gate.",
            phases: [phase(
                "Compact tail",
                messages: scrollGateHistory,
                preview: preview("Newest compact-tail response", "agent_message")
            )]
        )

        let sparseID = "history-sparse-seq"
        var sparseMessages: [ChatMessage] = []
        var sparseSeq = 1
        for turn in 1...55 {
            sparseMessages.append(message(sparseID, sparseSeq, "user_message", ["content": "Sparse prompt \(turn)"]))
            sparseSeq += 3
            sparseMessages.append(message(sparseID, sparseSeq, "agent_message", ["content": "Sparse persistent seqs page by DB order, not integer adjacency."]))
            sparseSeq += 4
            sparseMessages.append(message(sparseID, sparseSeq, "idle"))
            sparseSeq += 2
        }
        add(
            sparseID,
            category: "History & virtualization",
            title: "08 · History · Sparse protocol seqs",
            summary: "Replayed legacy spine rows retain historical off-spine seq gaps; top pagination must still advance without stalling.",
            phases: [phase(
                "Sparse tail",
                messages: sparseMessages,
                preview: preview("Sparse persistent seqs", "agent_message")
            )]
        )

        let draftShortID = "stream-draft-short"
        add(
            draftShortID,
            category: "Streaming card",
            title: "09 · Stream · Draft only",
            summary: "One live card with short keep-last narration and no action slot.",
            phases: [phase(
                "Short draft",
                messages: [message(draftShortID, 1, "user_message", ["content": "What are you doing?"])],
                card: .init(text: "I’m checking the renderer now…", action: nil),
                preview: preview("I’m checking the renderer now…", "agent_message")
            )]
        )

        let draftLongID = "stream-draft-multiline"
        add(
            draftLongID,
            category: "Streaming card",
            title: "10 · Stream · Multiline Markdown",
            summary: "Growing live narration with headings, lists, quotes, table syntax, and wrapping.",
            phases: [phase(
                "Multiline draft",
                messages: [message(draftLongID, 1, "user_message", ["content": "Stream a structured status update."])],
                card: .init(text: """
                ## Investigating

                I’m comparing the live card against the frozen result.

                - preserve identity
                - grow upward from the Composer
                - do not flash during revision replacement

                > This remains provisional while streaming.

                | Check | State |
                | --- | --- |
                | Layout | running |
                | Cache | warm |
                """, action: nil),
                preview: preview("Investigating the live card", "agent_message")
            )]
        )

        let partialCodeID = "stream-partial-code"
        add(
            partialCodeID,
            category: "Streaming card",
            title: "11 · Stream · Partial code fence",
            summary: "An intentionally incomplete fenced block must stay cheap and visually stable while live.",
            phases: [
                phase(
                    "Fence opened",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\n", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
                phase(
                    "Partial expression",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\nstruct Session {\n    let id: String\n    func render() ->", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
                phase(
                    "Fence completed but still live",
                    messages: [message(partialCodeID, 1, "user_message", ["content": "Show an incomplete code stream."])],
                    card: .init(text: "```swift\nstruct Session {\n    let id: String\n    func render() -> Bool { true }\n}\n```", action: nil),
                    preview: preview("Streaming code", "agent_message")
                ),
            ]
        )

        let toolRunID = "stream-tool-running"
        add(
            toolRunID,
            category: "Streaming card",
            title: "12 · Stream · Tool running",
            summary: "Live draft plus the server-owned tool_start action slot.",
            phases: [phase(
                "Tool in flight",
                messages: [message(toolRunID, 1, "user_message", ["content": "Inspect the current files."])],
                card: .init(
                    text: "I’ll inspect the production Chat path first.",
                    action: action(toolRunID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "scenario-read-1",
                    ])
                ),
                preview: preview("Read MacChatScrollView.swift", "agent_message")
            )]
        )

        let toolCompleteID = "stream-tool-complete"
        add(
            toolCompleteID,
            category: "Streaming card",
            title: "13 · Stream · Tool completed",
            summary: "A completed action occupies the same card slot without changing live bubble identity.",
            phases: [phase(
                "Successful completion",
                messages: [message(toolCompleteID, 1, "user_message", ["content": "Run the focused checks."])],
                card: .init(
                    text: "The focused checks completed.",
                    action: action(toolCompleteID, "tool_complete", [
                        "toolName": "bash",
                        "headline": "xcodebuild KrakiMac",
                        "toolCallId": "scenario-build-1",
                        "success": true,
                    ])
                ),
                preview: preview("The focused checks completed", "agent_message")
            )]
        )

        let toolFailedID = "stream-tool-failed"
        add(
            toolFailedID,
            category: "Streaming card",
            title: "14 · Stream · Tool failed",
            summary: "tool_complete success=false renders the failure glyph inside the live card.",
            phases: [phase(
                "Failed completion",
                messages: [message(toolFailedID, 1, "user_message", ["content": "Run a command that fails."])],
                card: .init(
                    text: "The command returned a non-zero exit status.",
                    action: action(toolFailedID, "tool_complete", [
                        "toolName": "bash",
                        "headline": "swift test --filter MissingSuite",
                        "toolCallId": "scenario-build-fail",
                        "success": false,
                    ])
                ),
                preview: preview("Command failed", "error")
            )]
        )

        let batchID = "stream-tool-batch"
        add(
            batchID,
            category: "Streaming card",
            title: "15 · Stream · Parallel tool batch",
            summary: "tool_batch action with a changing running count.",
            phases: [
                phase(
                    "Three tools",
                    messages: [message(batchID, 1, "user_message", ["content": "Check these in parallel."])],
                    card: .init(text: "Running independent checks.", action: action(batchID, "tool_batch", ["running": 3])),
                    preview: preview("3 tools running", "agent_message")
                ),
                phase(
                    "One tool remains",
                    messages: [message(batchID, 1, "user_message", ["content": "Check these in parallel."])],
                    card: .init(text: "Two checks are done; one remains.", action: action(batchID, "tool_batch", ["running": 1])),
                    preview: preview("1 tool running", "agent_message")
                ),
            ]
        )

        let permissionWriteID = "permission-pending-write"
        add(
            permissionWriteID,
            category: "Permission",
            title: "16 · Permission · Safe-mode write",
            summary: "Safe-mode write request: Approve, Allow in Session, and Deny use the real action callbacks.",
            mode: .auto,
            phases: [phase(
                "Awaiting write approval",
                messages: [message(permissionWriteID, 1, "user_message", ["content": "Update the implementation."])],
                card: .init(
                    text: "I need permission before editing the file.",
                    action: action(permissionWriteID, "permission", [
                        "id": "perm-pending-write",
                        "toolName": "write_file",
                        "description": "packages/arm/ios/Kraki/Features/Chat/Mac/MacChatView.swift",
                        "args": ["path": "MacChatView.swift"],
                    ])
                ),
                preview: preview("Permission required", "permission")
            )]
        )

        let permissionSafeID = "permission-safe-read"
        add(
            permissionSafeID,
            category: "Permission",
            title: "17 · Permission · Safe read",
            summary: "Safe-mode read request with Approve, Always, Deny and free-form denial through Composer.",
            mode: .safe,
            phases: [phase(
                "Awaiting read approval",
                messages: [message(permissionSafeID, 1, "user_message", ["content": "Inspect the configuration."])],
                card: .init(
                    text: "The current mode requires explicit permission.",
                    action: action(permissionSafeID, "permission", [
                        "id": "perm-safe-read",
                        "toolName": "read_file",
                        "description": "/Users/example/project/config.json",
                        "args": ["path": "/Users/example/project/config.json"],
                    ])
                ),
                preview: preview("Permission required", "permission")
            )]
        )

        let permissionResolvedID = "permission-resolved"
        let permissionResolvedMessages = [message(permissionResolvedID, 1, "user_message", ["content": "Show every resolved permission state."])]
        func resolvedPermission(_ decision: String) -> MessageStore.SessionCard {
            .init(
                text: "The permission card remains stable while the resolution echo lands.",
                action: action(permissionResolvedID, "permission", [
                    "id": "perm-resolved",
                    "toolName": "write_file",
                    "description": "ScenarioFixture.swift",
                    "decision": decision,
                ])
            )
        }
        add(
            permissionResolvedID,
            category: "Permission",
            title: "18 · Permission · Resolved variants",
            summary: "Cycles through approved, always allowed, and denied resolved-card presentation.",
            phases: [
                phase("Approved", messages: permissionResolvedMessages, card: resolvedPermission("approve"), preview: preview("Approved", "permission")),
                phase("Always allowed", messages: permissionResolvedMessages, card: resolvedPermission("always_allow"), preview: preview("Allowed for session", "permission")),
                phase("Denied", messages: permissionResolvedMessages, card: resolvedPermission("deny"), preview: preview("Denied", "permission")),
            ]
        )

        // Questions ride the spine: an agent_message with `question`, drawn
        // as body text + choice capsules while open; answering is sending a
        // message carrying `answerTo`.
        func question(
            _ sessionID: String,
            _ seq: Int,
            lead: String,
            id: String,
            text: String,
            choices: [String]
        ) -> ChatMessage {
            var spec: [String: Any] = ["id": id, "text": text]
            if !choices.isEmpty { spec["choices"] = choices }
            return message(sessionID, seq, "agent_message", ["content": lead, "question": spec])
        }

        let questionID = "question-choices"
        add(
            questionID,
            category: "Question",
            title: "19 · Question · Choice buttons",
            summary: "Short choices exercise the production rendered-frame hit routing at every UI zoom.",
            phases: [phase(
                "Awaiting choice",
                messages: [
                    message(questionID, 1, "user_message", ["content": "Ask me which approach to use."]),
                    question(questionID, 2, lead: "I found two reasonable paths.", id: "question-choice-basic",
                             text: "Which implementation should I use?",
                             choices: ["Keep the cached CoreText renderer", "Replace it with a TextKit cell"]),
                ],
                preview: preview("Which implementation should I use?", "question")
            )]
        )

        let longQuestionID = "question-long-choices"
        add(
            longQuestionID,
            category: "Question",
            title: "20 · Question · Long Markdown choices",
            summary: "Wrapped multi-line choice rows expose clipping, hover, and hit-frame drift.",
            phases: [phase(
                "Long wrapped choices",
                messages: [
                    message(longQuestionID, 1, "user_message", ["content": "Ask a detailed architectural question."]),
                    question(longQuestionID, 2, lead: "Before continuing, I need an explicit boundary decision.",
                             id: "question-choice-long",
                             text: "How should reconnect restore an in-progress card after a rapid Session switch?",
                             choices: [
                                "Restore the **authoritative subscription snapshot** atomically, preserving the current draft and action slot.",
                                "Keep the stale local card until a later `agent_message_delta` happens to replace it.",
                                "Clear the card and show no streaming state until the final persisted response arrives.",
                             ]),
                ],
                preview: preview("How should reconnect restore the card?", "question")
            )]
        )

        let freeQuestionID = "question-freeform"
        add(
            freeQuestionID,
            category: "Question",
            title: "21 · Question · Free-form Composer",
            summary: "No choices: the real Composer answers the open question and submits through CommandSender.",
            phases: [phase(
                "Awaiting free-form answer",
                messages: [
                    message(freeQuestionID, 1, "user_message", ["content": "Ask for a custom value."]),
                    question(freeQuestionID, 2, lead: "Please type the exact value in the Composer.",
                             id: "question-freeform", text: "What debounce interval should this scenario use?",
                             choices: []),
                ],
                preview: preview("What debounce interval should this use?", "question")
            )]
        )

        let questionStateID = "question-states"
        let asked = [
            message(questionStateID, 1, "user_message", ["content": "Show question states."]),
            question(questionStateID, 2, lead: "The schema has two versions.", id: "question-state",
                     text: "Continue with the migration?", choices: ["Continue", "Stop"]),
        ]
        add(
            questionStateID,
            category: "Question",
            title: "22 · Question · Answered and aborted",
            summary: "Open → answered (choices go, the answer is a user message) → aborted (User aborted inside the question bubble).",
            phases: [
                phase("Open", messages: asked, preview: preview("Continue with the migration?", "question")),
                phase(
                    "Answered",
                    messages: asked + [
                        message(questionStateID, 3, "user_message", ["content": "Continue", "answerTo": "question-state"]),
                        message(questionStateID, 4, "agent_message", ["content": "Migrating now."]),
                        message(questionStateID, 5, "idle"),
                    ],
                    preview: preview("Migrating now.", "agent")
                ),
                phase(
                    "Aborted",
                    messages: asked + [
                        message(questionStateID, 3, "turn_status", [
                            "draft": "", "action": ["type": "user_abort", "payload": [String: Any]()],
                        ]),
                        message(questionStateID, 4, "idle"),
                    ],
                    preview: preview("Continue with the migration?", "agent")
                ),
            ]
        )

        let compactID = "runtime-compacting"
        add(
            compactID,
            category: "Runtime state",
            title: "23 · Runtime · Compacting only",
            summary: "Compaction is orthogonal runtime state: bottom status appears without creating a bubble.",
            phases: [phase(
                "Threshold compaction",
                messages: basicConversation(compactID, user: "Continue after compacting.", agent: "The previous turn remains immutable."),
                state: .compacting,
                runtime: .compacting(reason: .threshold),
                preview: preview("Compacting context", "agent_message")
            )]
        )

        let compactCardID = "runtime-compacting-card"
        add(
            compactCardID,
            category: "Runtime state",
            title: "24 · Runtime · Compacting preserves card",
            summary: "Compaction status coexists with an existing live draft/action and must not displace either.",
            phases: [
                phase(
                    "Tool card before compaction",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Inspecting the largest source file.", action: action(compactCardID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "compact-read",
                    ])),
                    state: .active,
                    preview: preview("Inspecting source", "agent_message")
                ),
                phase(
                    "Compaction with same card",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Inspecting the largest source file.", action: action(compactCardID, "tool_start", [
                        "toolName": "read",
                        "headline": "Read MacChatScrollView.swift",
                        "toolCallId": "compact-read",
                    ])),
                    state: .compacting,
                    runtime: .compacting(reason: .overflow),
                    preview: preview("Compacting context", "agent_message")
                ),
                phase(
                    "Resumed active",
                    messages: [message(compactCardID, 1, "user_message", ["content": "Inspect and then compact if required."])],
                    card: .init(text: "Compaction completed; resuming the same turn.", action: nil),
                    state: .active,
                    preview: preview("Resuming after compaction", "agent_message")
                ),
            ]
        )

        let steerID = "stream-steer"
        add(
            steerID,
            category: "Runtime state",
            title: "25 · Runtime · Steer during stream",
            summary: "A visible delivery=steer human bubble stays inside the current lifecycle and preserves the live card.",
            phases: [phase(
                "Steer appended",
                messages: [
                    message(steerID, 1, "user_message", ["content": "Analyze the current implementation."]),
                    message(steerID, 4, "user_message", ["content": "Also check reconnect behavior.", "delivery": "steer"]),
                ],
                card: .init(text: "I’m incorporating the reconnect requirement without restarting the turn.", action: nil),
                state: .active,
                preview: preview("Also check reconnect behavior", "user_message")
            )]
        )

        let frozenID = "frozen-markdown-steps"
        add(
            frozenID,
            category: "Frozen outcomes",
            title: "26 · Frozen · Markdown with Steps",
            summary: "Persisted final agent bubble with final syntax highlighting and a real Steps affordance.",
            phases: [phase(
                "Completed turn",
                messages: [
                    message(frozenID, 1, "user_message", ["content": "Summarize the result."]),
                    message(frozenID, 2, "agent_message", ["content": """
                    ## Completed

                    The final renderer now owns immutable Markdown and asynchronous highlighting.

                    ```typescript
                    const result = { renderer: 'CoreText', textKitCells: 0, passed: true }
                    ```
                    """, "steps": 3]),
                    message(frozenID, 3, "idle"),
                ],
                preview: preview("Completed", "agent_message")
            )],
            traces: [2: [
                action(frozenID, "agent_narration", ["content": "Checking the final renderer."]),
                action(frozenID, "tool_start", ["toolName": "bash", "headline": "xcodebuild KrakiMac", "toolCallId": "frozen-build"]),
                action(frozenID, "tool_complete", ["toolName": "bash", "headline": "xcodebuild KrakiMac", "toolCallId": "frozen-build", "success": true]),
            ]]
        )

        func terminalAction(_ type: String, values: [String: Any] = [:]) -> [String: AnyCodable] {
            [
                "type": AnyCodable(type),
                "payload": AnyCodable(payload(values)),
            ]
        }

        let abortID = "frozen-user-abort"
        add(
            abortID,
            category: "Frozen outcomes",
            title: "27 · Frozen · User aborted",
            summary: "turn_status owns the draft and renders the frozen user_abort outcome.",
            phases: [phase(
                "Aborted terminal",
                messages: [
                    message(abortID, 1, "user_message", ["content": "Start a long analysis."]),
                    message(abortID, 2, "agent_message", ["content": "This transient agent row must be folded into the terminal."]),
                    message(abortID, 3, "turn_status", [
                        "draft": "I inspected the first half of the pipeline before you stopped the turn.",
                        "finishedAt": "2026-08-08T00:00:03.000Z",
                        "action": terminalAction("user_abort"),
                        "steps": 2,
                    ]),
                    message(abortID, 4, "idle"),
                ],
                preview: preview("I inspected the first half…", "agent_message")
            )]
        )

        let failedID = "frozen-failed"
        add(
            failedID,
            category: "Frozen outcomes",
            title: "28 · Frozen · Failed",
            summary: "turn_status failed outcome with a preserved draft and compact error reason.",
            phases: [phase(
                "Failed terminal",
                messages: [
                    message(failedID, 1, "user_message", ["content": "Apply the migration."]),
                    message(failedID, 2, "agent_message", ["content": "The migration reached the build step."]),
                    message(failedID, 3, "turn_status", [
                        "draft": "The migration reached the build step but could not complete.",
                        "finishedAt": "2026-08-08T00:00:03.000Z",
                        "action": terminalAction("failed", values: ["message": "Build process exited with status 65"]),
                        "steps": 4,
                    ]),
                    message(failedID, 4, "idle"),
                ],
                preview: preview("Turn failed", "error")
            )]
        )

        let interruptedID = "frozen-interrupted-legacy"
        add(
            interruptedID,
            category: "Frozen outcomes",
            title: "29 · Frozen · Legacy interrupted turn",
            summary: "Legacy interrupted_turn compatibility for ordinary abort and process_lost failure.",
            phases: [
                phase(
                    "Legacy abort",
                    messages: [
                        message(interruptedID, 1, "user_message", ["content": "Run the old lifecycle."]),
                        message(interruptedID, 2, "interrupted_turn", [
                            "draft": "Legacy draft preserved after interruption.",
                            "reason": "user_abort",
                            "interruptedAt": "2026-08-08T00:00:02.000Z",
                        ]),
                        message(interruptedID, 3, "idle"),
                    ],
                    preview: preview("Legacy draft preserved", "agent_message")
                ),
                phase(
                    "Legacy process lost",
                    messages: [
                        message(interruptedID, 1, "user_message", ["content": "Run the old lifecycle."]),
                        message(interruptedID, 2, "interrupted_turn", [
                            "draft": "The agent process disappeared during the operation.",
                            "reason": "process_lost",
                            "interruptedAt": "2026-08-08T00:00:02.000Z",
                        ]),
                        message(interruptedID, 3, "idle"),
                    ],
                    preview: preview("Agent process was lost", "error")
                ),
            ]
        )

        let noReplyID = "frozen-no-reply"
        add(
            noReplyID,
            category: "Frozen outcomes",
            title: "30 · Frozen · No reply notice",
            summary: "Kraki-authored system_message kind=no_reply renders as a concluding system bubble.",
            phases: [phase(
                "No reply",
                messages: [
                    message(noReplyID, 1, "user_message", ["content": "This prompt intentionally produces no model response."]),
                    message(noReplyID, 2, "system_message", [
                        "kind": "no_reply",
                        "content": "The agent completed this turn without a text reply.",
                    ]),
                    message(noReplyID, 3, "idle"),
                ],
                preview: preview("The agent completed without a text reply", "agent_message")
            )]
        )

        let errorID = "projection-error-detail"
        add(
            errorID,
            category: "Projection edge cases",
            title: "31 · Projection · Error stays off-spine",
            summary: "A persistent error is turn detail and must not create an extra top-level bubble.",
            phases: [phase(
                "Error then idle",
                messages: [
                    message(errorID, 1, "user_message", ["content": "Trigger an internal error."]),
                    message(errorID, 2, "error", ["message": "Synthetic scenario error detail"]),
                    message(errorID, 3, "idle"),
                ],
                preview: preview("Synthetic scenario error detail", "error"),
                readSeq: 1
            )]
        )

        let duplicateID = "projection-duplicate-terminal"
        add(
            duplicateID,
            category: "Projection edge cases",
            title: "32 · Projection · Duplicate terminal collapse",
            summary: "Reconnect/import history may contain duplicate conclusions; only the final lifecycle owner remains.",
            phases: [phase(
                "Duplicate conclusions",
                messages: [
                    message(duplicateID, 1, "user_message", ["content": "Exercise duplicate terminal recovery."]),
                    message(duplicateID, 2, "agent_message", ["content": "Old conclusion that should be replaced."]),
                    message(duplicateID, 3, "turn_status", [
                        "draft": "First terminal snapshot.",
                        "action": terminalAction("user_abort"),
                    ]),
                    message(duplicateID, 4, "idle"),
                    message(duplicateID, 5, "turn_status", [
                        "draft": "Latest terminal snapshot wins.",
                        "action": terminalAction("failed", values: ["message": "Recovered final status"]),
                    ]),
                    message(duplicateID, 6, "idle"),
                ],
                preview: preview("Latest terminal snapshot wins", "error")
            )]
        )

        let inlineImagesID = "artifact-inline-images"
        let inlineAttachments: [[String: Any]] = [imageRed, imageBlue, imageGreen].enumerated().map { index, data in
            [
                "type": "image",
                "mimeType": "image/png",
                "data": data.base64EncodedString(),
                "name": "scenario-inline-\(index + 1).png",
            ]
        }
        add(
            inlineImagesID,
            category: "Images & artifacts",
            title: "33 · Artifact · Inline image gallery",
            summary: "Three decoded inline images use the real compact stack and full-window preview overlay.",
            phases: [phase(
                "Three images",
                messages: [
                    message(inlineImagesID, 1, "user_message", ["content": "Show the generated images."]),
                    message(inlineImagesID, 2, "agent_message", [
                        "content": "Three differently shaped images are attached.",
                        "attachments": inlineAttachments,
                    ]),
                    message(inlineImagesID, 3, "idle"),
                ],
                preview: preview("Three images attached", "agent_message")
            )]
        )

        let pureImageID = "artifact-pure-image"
        add(
            pureImageID,
            category: "Images & artifacts",
            title: "34 · Artifact · Pure image output",
            summary: "An agent message with images and no text suppresses the empty colored bubble.",
            phases: [phase(
                "Pure image",
                messages: [
                    message(pureImageID, 1, "user_message", ["content": "Return only the image."]),
                    message(pureImageID, 2, "agent_message", [
                        "content": "",
                        "attachments": [inlineAttachments[0]],
                    ]),
                    message(pureImageID, 3, "idle"),
                ],
                preview: preview("Image", "agent_message")
            )]
        )

        let htmlID = "artifact-html-report"
        let htmlRef: [String: Any] = [
            "type": "content_ref",
            "id": htmlRefID,
            "mimeType": "text/html",
            "size": html.count,
            "name": "scenario-report.html",
            "caption": "Scenario report",
        ]
        add(
            htmlID,
            category: "Images & artifacts",
            title: "35 · Artifact · HTML report",
            summary: "Idle-owned HTML ContentRef moves onto the final bubble and opens the real secure artifact panel.",
            phases: [phase(
                "Ready HTML artifact",
                messages: [
                    message(htmlID, 1, "user_message", ["content": "Render the report artifact."]),
                    message(htmlID, 2, "agent_message", ["content": "The report is ready below."]),
                    message(htmlID, 3, "idle", ["turnArtifacts": [htmlRef]]),
                ],
                preview: preview("The report is ready below", "agent_message")
            )]
        )

        let imageRefScenarioID = "artifact-image-ref"
        let imageRef: [String: Any] = [
            "type": "content_ref",
            "id": imageRefID,
            "mimeType": "image/png",
            "size": imageRed.count,
            "name": "scenario-ref.png",
            "caption": "Turn-owned image",
            "width": 720,
            "height": 420,
        ]
        add(
            imageRefScenarioID,
            category: "Images & artifacts",
            title: "36 · Artifact · Turn image ContentRef",
            summary: "A lazy image ref attached to idle is projected onto the concluding agent bubble.",
            phases: [phase(
                "Ready image ref",
                messages: [
                    message(imageRefScenarioID, 1, "user_message", ["content": "Attach the final image to this turn."]),
                    message(imageRefScenarioID, 2, "agent_message", ["content": "The turn-owned image is available."]),
                    message(imageRefScenarioID, 3, "idle", ["turnArtifacts": [imageRef]]),
                ],
                preview: preview("Turn-owned image available", "agent_message")
            )]
        )

        let contentStressID = "content-code-table-stress"
        add(
            contentStressID,
            category: "Images & artifacts",
            title: "37 · Content · Code and table stress",
            summary: "Final immutable bubble with wide table, many code languages, quote, links, and long tokens.",
            phases: [phase(
                "Final highlighted content",
                messages: [
                    message(contentStressID, 1, "user_message", ["content": "Render the final Markdown stress sample."]),
                    message(contentStressID, 2, "agent_message", ["content": """
                    # Final content matrix

                    [Kraki](https://kraki.chat) keeps `inline code`, **bold**, *italic*, and selectable text native.

                    | Session | State | Input Tokens | Output Tokens | Duration |
                    | :--- | :---: | ---: | ---: | ---: |
                    | streaming-card-with-a-long-name | active | 124500 | 18942 | 128.4s |
                    | reconnect-snapshot | idle | 9850 | 3201 | 42.8s |

                    ```swift
                    struct Scenario { let id: String; let connected: Bool }
                    ```

                    ```typescript
                    const session = { id: 'scenario', active: true } satisfies Session
                    ```

                    ```python
                    async def render(session_id: str) -> bool:
                        return await cache.is_ready(session_id)
                    ```

                    > A long_unbroken_token_abcdefghijklmnopqrstuvwxyz0123456789 must wrap inside the cached layout.
                    """]),
                    message(contentStressID, 3, "idle"),
                ],
                preview: preview("Final content matrix", "agent_message")
            )]
        )

        let lifecycleID = "transition-full-lifecycle"
        let lifecycleUser = [message(lifecycleID, 1, "user_message", ["content": "Run the complete production lifecycle."])]
        let lifecycleAsked = lifecycleUser + [
            question(lifecycleID, 2, lead: "One behavior remains ambiguous.", id: "lifecycle-question",
                     text: "Should I include the reconnect regression?",
                     choices: ["Yes, include it", "No, keep this focused"]),
        ]
        add(
            lifecycleID,
            category: "Transitions & reconnect",
            title: "38 · Transition · Full streaming lifecycle",
            summary: "Play through draft → tool → permission → question → final bubble using one stable live-card identity.",
            phases: [
                phase("User prompt accepted", messages: lifecycleUser, state: .active, preview: preview("Run the complete lifecycle", "user_message")),
                phase("Narration delta", messages: lifecycleUser, card: .init(text: "I’ll walk the production state machine in order.", action: nil), preview: preview("Walking the state machine", "agent_message")),
                phase("Tool running", messages: lifecycleUser, card: .init(text: "I’m reading the relevant source first.", action: action(lifecycleID, "tool_start", ["toolName": "read", "headline": "Read MessageStore.swift", "toolCallId": "lifecycle-read"])), preview: preview("Read MessageStore.swift", "agent_message")),
                phase("Permission requested", messages: lifecycleUser, card: .init(text: "The edit requires approval.", action: action(lifecycleID, "permission", ["id": "lifecycle-permission", "toolName": "write_file", "description": "MacChatScenarioTestView.swift"])), preview: preview("Permission required", "permission")),
                phase("Permission resolved", messages: lifecycleUser, card: .init(text: "Approval received; continuing.", action: action(lifecycleID, "permission", ["id": "lifecycle-permission", "toolName": "write_file", "description": "MacChatScenarioTestView.swift", "decision": "approve"])), preview: preview("Approval received", "permission")),
                phase("Question asked", messages: lifecycleAsked, preview: preview("Should I include reconnect?", "question")),
                phase("Question answered", messages: lifecycleAsked + [
                    message(lifecycleID, 3, "user_message", ["content": "Yes, include it", "answerTo": "lifecycle-question"]),
                ], card: .init(text: "I’ll include reconnect coverage.", action: nil), state: .active, preview: preview("Yes, include it", "user_message")),
                phase("Final persisted conclusion", messages: lifecycleAsked + [
                    message(lifecycleID, 3, "user_message", ["content": "Yes, include it", "answerTo": "lifecycle-question"]),
                    message(lifecycleID, 9, "agent_message", ["content": "The full lifecycle completed without replacing the live Bubble with a second transient card.", "steps": 5]),
                    message(lifecycleID, 10, "idle"),
                ], state: .idle, preview: preview("The full lifecycle completed", "agent_message")),
            ]
        )

        let reconnectID = "transition-reconnect-live"
        let reconnectMessages = [message(reconnectID, 1, "user_message", ["content": "Keep streaming across a reconnect."])]
        add(
            reconnectID,
            category: "Transitions & reconnect",
            title: "39 · Transition · Reconnect live snapshot",
            summary: "Use the Disconnect/Reconnect control: cached page stays mounted and subscription snapshot restores the live card.",
            phases: [
                phase("Live before disconnect", messages: reconnectMessages, card: .init(text: "This draft exists before the socket drops.", action: action(reconnectID, "tool_start", ["toolName": "bash", "headline": "pnpm test", "toolCallId": "reconnect-test"])), preview: preview("This draft exists before disconnect", "agent_message")),
                phase("Authoritative reconnect snapshot", messages: reconnectMessages, card: .init(text: "The reconnect snapshot replaced the draft atomically and retained the action slot.", action: action(reconnectID, "tool_start", ["toolName": "bash", "headline": "pnpm test", "toolCallId": "reconnect-test"])), preview: preview("Reconnect snapshot restored", "agent_message")),
            ]
        )

        let lateID = "transition-late-frame-gate"
        let lateUser = message(lateID, 1, "user_message", ["content": "Do not resurrect a concluded card."])
        add(
            lateID,
            category: "Transitions & reconnect",
            title: "40 · Transition · Late-frame gate",
            summary: "A conclusion closes transient state; late coalesced frames remain absent until the next ordinary user turn.",
            phases: [
                phase("Live card open", messages: [lateUser], card: .init(text: "This draft is still live.", action: nil), preview: preview("This draft is still live", "agent_message")),
                phase("Turn concluded", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle")], state: .idle, preview: preview("The durable conclusion landed", "agent_message")),
                phase("Late frame ignored", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle")], state: .idle, preview: preview("No resurrected card should appear", "agent_message")),
                phase("Next turn reopens gate", messages: [lateUser, message(lateID, 2, "agent_message", ["content": "The durable conclusion landed."]), message(lateID, 3, "idle"), message(lateID, 4, "user_message", ["content": "Start the next ordinary turn."])], card: .init(text: "A new ordinary prompt legitimately opens a fresh live card.", action: nil), state: .active, preview: preview("A fresh live card is open", "agent_message")),
            ]
        )

        func switchScenario(
            id: String,
            title: String,
            deviceID: String,
            text: String,
            actionMessage: ChatMessage
        ) {
            add(
                id,
                category: "Transitions & reconnect",
                title: title,
                summary: "Rapid-switch target with an authoritative subscription card snapshot.",
                deviceID: deviceID,
                phases: [phase(
                    "Live subscription snapshot",
                    messages: [message(id, 1, "user_message", ["content": "Open \(title) while another Session is streaming."])],
                    card: .init(text: text, action: actionMessage),
                    preview: preview(text, "agent_message")
                )]
            )
        }
        switchScenario(
            id: "switch-live-a",
            title: "41 · Switch · Live A",
            deviceID: Self.onlineDeviceA,
            text: "Session A is streaming on Tentacle A.",
            actionMessage: action("switch-live-a", "tool_start", ["toolName": "read", "headline": "Read Session A", "toolCallId": "switch-a"])
        )
        switchScenario(
            id: "switch-live-b",
            title: "42 · Switch · Live B same Tentacle",
            deviceID: Self.onlineDeviceA,
            text: "Session B needs approval on the same Tentacle.",
            actionMessage: action("switch-live-b", "permission", ["id": "switch-b-permission", "toolName": "write_file", "description": "Did same-Tentacle replacement keep the correct card?"])
        )
        switchScenario(
            id: "switch-live-c",
            title: "43 · Switch · Live C other Tentacle",
            deviceID: Self.onlineDeviceB,
            text: "Session C streams on Tentacle B after releasing Tentacle A.",
            actionMessage: action("switch-live-c", "tool_start", ["toolName": "bash", "headline": "Run on Tentacle B", "toolCallId": "switch-c"])
        )

        let unreadID = "sidebar-unread-agent"
        add(
            unreadID,
            category: "Sidebar projection",
            title: "44 · Sidebar · Unread agent attention",
            summary: "Agent conclusion advances lastSeq while readSeq remains behind, producing one red unread dot.",
            phases: [phase(
                "Unread before entry",
                messages: basicConversation(unreadID, user: "Notify me when complete.", agent: "The requested work is complete."),
                preview: preview("The requested work is complete", "agent_message"),
                readSeq: 1
            )]
        )

        let humanReadID = "sidebar-human-echo-read"
        add(
            humanReadID,
            category: "Sidebar projection",
            title: "45 · Sidebar · Human echo remains read",
            summary: "A contiguous ordinary user_message received while caught up advances both cursors.",
            phases: [phase(
                "Caught-up human append",
                messages: [message(humanReadID, 1, "user_message", ["content": "This human echo should not create unread attention."])],
                preview: preview("This human echo should not create unread attention", "user_message"),
                readSeq: 1
            )]
        )

        let sidebarDraftID = "sidebar-draft"
        add(
            sidebarDraftID,
            category: "Sidebar projection",
            title: "46 · Sidebar · Unsent draft",
            summary: "Draft text remains stored, [draft] is absent, and the draft text plus keyboard icon use a muted red reminder.",
            phases: [phase(
                "Draft retained",
                messages: basicConversation(sidebarDraftID, user: "Previous prompt", agent: "Previous response"),
                preview: preview("Previous response", "agent_message"),
                draft: "Unsent Composer draft retained across Session switches"
            )]
        )

        let pinnedID = "sidebar-pinned-active"
        add(
            pinnedID,
            category: "Sidebar projection",
            title: "47 · Sidebar · Pinned active",
            summary: "Pinned ordering, active dots, title truncation, model metadata, and live preview coexist.",
            pinned: true,
            phases: [phase(
                "Pinned and active",
                messages: [message(pinnedID, 1, "user_message", ["content": "Keep this pinned Session active."])],
                card: .init(text: "Pinned Session is actively producing text for the sidebar projection.", action: nil),
                preview: preview("Pinned Session is actively producing text", "agent_message")
            )]
        )

        return (definitions, attachments)
    }

    static func makePNG(
        size: NSSize,
        colors: [NSColor],
        label: String
    ) -> Data {
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        if let gradient = NSGradient(colors: colors) {
            gradient.draw(in: rect, angle: -24)
        } else {
            NSColor.systemBlue.setFill()
            rect.fill()
        }
        NSColor.black.withAlphaComponent(0.22).setFill()
        NSBezierPath(roundedRect: rect.insetBy(dx: 30, dy: 30), xRadius: 26, yRadius: 26).fill()
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: max(24, min(size.width, size.height) * 0.075), weight: .bold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ]
        (label as NSString).draw(
            in: NSRect(x: 40, y: size.height * 0.42, width: size.width - 80, height: size.height * 0.2),
            withAttributes: attributes
        )
        image.unlockFocus()
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [.compressionFactor: 0.92]) else {
            return Data()
        }
        return png
    }
}
#endif
