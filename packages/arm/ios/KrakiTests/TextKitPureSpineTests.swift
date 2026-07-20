import XCTest
import UIKit
import SwiftUI
@testable import Kraki

@MainActor
final class TextKitPureSpineTests: XCTestCase {
    private func message(_ type: String, seq: Int, content: String? = nil) -> ChatMessage {
        var payload: [String: AnyCodable] = [:]
        if let content { payload["content"] = AnyCodable(content) }
        return ChatMessage(
            type: type,
            seq: seq,
            sessionId: "textkit-test-\(type)-\(seq)",
            deviceId: "device",
            timestamp: "2026-07-12T00:00:00Z",
            payload: payload
        )
    }

    private func content(_ type: String, seq: Int, body: String, steps: Int? = nil) -> TKBubbleContent {
        var message = message(type, seq: seq, content: body)
        if let steps { message.payload["steps"] = AnyCodable(steps) }
        TKBubbleContent.bust(message.id)
        return TKBubbleContent.make(message: message, sessionId: "textkit-test", agent: "pi")
    }

    func testFlatPureSpineMessagesOnlyExposeTraceHint() {
        XCTAssertFalse(content("agent_message", seq: 1, body: "body").canShowSteps)
        XCTAssertTrue(content("agent_message", seq: 2, body: "body", steps: 3).canShowSteps)
        XCTAssertTrue(content("system_message", seq: 3, body: "body", steps: 1).canShowSteps)
        XCTAssertFalse(content("user_message", seq: 4, body: "body", steps: 2).canShowSteps)
    }

    func testComposerIntentPrioritizesStructuredResponsesThenSteer() {
        XCTAssertEqual(MessageComposerPolicy.intent(isBusy: false, hasPermission: false, hasQuestion: false), .prompt)
        XCTAssertEqual(MessageComposerPolicy.intent(isBusy: true, hasPermission: false, hasQuestion: false), .steer)
        XCTAssertEqual(MessageComposerPolicy.intent(isBusy: true, hasPermission: false, hasQuestion: true), .answerQuestion)
        XCTAssertEqual(MessageComposerPolicy.intent(isBusy: true, hasPermission: true, hasQuestion: true), .denyPermission)
    }

    func testSVGAbsoluteMoveAfterCloseStartsNewSubpath() {
        // Official Pi P path shape: outer contour closes, then an absolute M
        // starts the square hole. It must not be connected by an accidental
        // line, otherwise even-odd fill removes a corner from the P.
        let path = parseSVGPath("M0 0H10V10H0ZM3 3H7V7H3Z")
        var moves = 0
        var lines = 0
        path.cgPath.applyWithBlock { element in
            switch element.pointee.type {
            case .moveToPoint: moves += 1
            case .addLineToPoint: lines += 1
            default: break
            }
        }
        XCTAssertEqual(moves, 2, "outer contour and inner hole must be separate subpaths")
        XCTAssertEqual(lines, 6, "two rectangles have three explicit line segments each")
    }

    func testUserBubbleUsesWhiteTextAndBrandBackground() {
        let content = content("user_message", seq: 101, body: "hello **world**")
        XCTAssertEqual(content.kind, .user)
        XCTAssertEqual(content.body?.string, "hello world")
        let color = content.body?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        XCTAssertEqual(color, UIColor.white)
        XCTAssertEqual(
            content.bubbleColor(dark: false).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)),
            UIColor(Color.krakiPrimary).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        )
    }

    func testUserBubbleWidthHugsShortContentAndClampsLongContent() {
        let cellWidth: CGFloat = 402
        let short = content("user_message", seq: 102, body: "OK")
        let long = content(
            "user_message",
            seq: 103,
            body: String(repeating: "This is a long user message that should wrap. ", count: 20)
        )

        let maximum = cellWidth - 24 - cellWidth * 0.18
        XCTAssertLessThan(short.bubbleWidth(cellWidth: cellWidth), maximum * 0.5)
        XCTAssertEqual(long.bubbleWidth(cellWidth: cellWidth), maximum, accuracy: 0.5)
        XCTAssertGreaterThan(long.cellHeight(cellWidth: cellWidth), short.cellHeight(cellWidth: cellWidth))
    }

    func testErrorAndSystemHaveDedicatedSemantics() {
        let error = content("error", seq: 201, body: "Request failed")
        let system = content("system_message", seq: 202, body: "No reply")
        XCTAssertEqual(error.kind, .error)
        XCTAssertEqual(system.kind, .system)
        XCTAssertNotEqual(error.bubbleColor(dark: false), system.bubbleColor(dark: false))
        XCTAssertEqual(error.body?.string, "Request failed")
        XCTAssertEqual(system.body?.string, "No reply")
    }

    func testInterruptedTurnBuildIsSafeButExcluded() {
        // Terminal messages with non-empty drafts can use the unified frozen
        // TextKit path. Empty-draft terminal metadata is filtered upstream.
        let message = ChatMessage(
            type: "interrupted_turn",
            seq: 203,
            sessionId: "textkit-test-interrupted",
            deviceId: "device",
            timestamp: "2026-07-12T00:00:00Z",
            payload: ["draft": AnyCodable("Partial response")]
        )
        TKBubbleContent.bust(message.id)
        let content = TKBubbleContent.make(message: message, sessionId: "textkit-test", agent: "pi")
        XCTAssertNotNil(content)
    }

    func testEmptyDraftTerminalMessagesDoNotRenderAirBubbles() {
        for type in ["interrupted_turn", "turn_status"] {
            let empty = ChatMessage(
                type: type, seq: 205, sessionId: "textkit-empty-terminal",
                deviceId: "device", timestamp: "2026-07-13T00:00:00Z",
                payload: [
                    "draft": AnyCodable(""),
                    "steps": AnyCodable(43),
                    "action": AnyCodable(["type": "failed", "payload": ["message": "524"]]),
                ])
            XCTAssertFalse(ChatViewModel.shouldRender(empty), "\(type) must not create a footer-only bubble")

            var drafted = empty
            drafted.payload["draft"] = AnyCodable("Partial answer")
            XCTAssertTrue(ChatViewModel.shouldRender(drafted))
        }
    }

    func testQuestionRecoveryFlagsDecodeFromPayload() {
        let question = ChatMessage(
            type: "question",
            seq: 0,
            sessionId: "textkit-test-question",
            deviceId: "device",
            timestamp: nil,
            payload: [
                "id": AnyCodable("q1"),
                "cancelled": AnyCodable(true),
                "allowFreeform": AnyCodable(false),
            ]
        )
        XCTAssertTrue(question.cancelled)
        XCTAssertFalse(question.allowFreeform)
    }

    func testChatEntryWaitsForAuthoritativeHeadWithoutBlockingEmptySession() {
        XCTAssertTrue(ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: 250,
            windowBottomSeq: 200,
            hasMessages: true,
            sessionLoading: false
        ))
        XCTAssertFalse(ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: 250,
            windowBottomSeq: 250,
            hasMessages: true,
            sessionLoading: true
        ))
        XCTAssertTrue(ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: 0,
            windowBottomSeq: 0,
            hasMessages: false,
            sessionLoading: true
        ))
        XCTAssertFalse(ChatEntryLoading.isWaitingForLatest(
            expectedLastSeq: 0,
            windowBottomSeq: 0,
            hasMessages: false,
            sessionLoading: false
        ))
        XCTAssertTrue(ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: true,
            hasMaterializedLatest: false
        ))
        XCTAssertFalse(ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: true,
            hasMaterializedLatest: true
        ), "history pagination must not reactivate the full-screen entry gate")
        XCTAssertFalse(ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: false,
            hasMaterializedLatest: false
        ))
    }

    func testPendingQuestionIgnoresAllowFreeformAndRequiresNoResolution() {
        let pending = ChatMessage(
            type: "question", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
            payload: [
                "id": AnyCodable("q1"),
                "question": AnyCodable("Choose one"),
                "choices": AnyCodable(["A", "B"]),
                "allowFreeform": AnyCodable(false),
            ])
        XCTAssertEqual(pending.questionId, "q1")
        XCTAssertEqual(pending.choices, ["A", "B"])
        XCTAssertNil(pending.answer)
        XCTAssertFalse(pending.cancelled)

        var answered = pending
        answered.payload["answer"] = AnyCodable("typed in composer")
        XCTAssertEqual(answered.answer, "typed in composer")

        var cancelled = pending
        cancelled.payload["cancelled"] = AnyCodable(true)
        XCTAssertTrue(cancelled.cancelled)
    }

    func testRichMarkdownNormalizesHeadingsListsAndTables() {
        let source = """
        # Heading
        - First item
        - Second item

        | Name | Count |
        | :--- | ---: |
        | A | 2 |
        """
        let rendered = TKMarkdown.attributed(source, cacheKey: "rich-normalization-test").string
        XCTAssertFalse(rendered.contains("# Heading"))
        XCTAssertTrue(rendered.contains("Heading"))
        XCTAssertTrue(rendered.contains("•\tFirst item"))
        XCTAssertTrue(rendered.contains("•\tSecond item"))
        XCTAssertFalse(rendered.contains(":---"))
        XCTAssertEqual(rendered.filter { $0 == "\u{FFFC}" }.count, 1)
        XCTAssertFalse(rendered.contains("│"))
        XCTAssertFalse(rendered.contains("┌"))
    }

    func testReusedCodeCellDoesNotLeaveEditorSurfaceBehindPlainText() {
        let codeBubble = content("user_message", seq: 496, body: "```\nhi\n```")
        let plainBubble = content("user_message", seq: 497, body: "say hi")
        let width: CGFloat = 390
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: width,
                                               height: codeBubble.cellHeight(cellWidth: width)))
        cell.configure(codeBubble, cellWidth: width)
        cell.layoutIfNeeded()

        cell.frame.size.height = plainBubble.cellHeight(cellWidth: width)
        cell.configure(plainBubble, cellWidth: width)
        cell.layoutIfNeeded()
        let renderer = UIGraphicsImageRenderer(size: cell.bounds.size)
        let image = renderer.image { context in
            cell.layer.render(in: context.cgContext)
        }
        guard let cg = image.cgImage,
              let data = cg.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else {
            return XCTFail("Could not render reused TextKit cell")
        }
        let target = (r: UInt8(0x18), g: UInt8(0x18), b: UInt8(0x1B))
        var editorPixels = 0
        for y in 0..<cg.height {
            for x in 0..<cg.width {
                let offset = y * cg.bytesPerRow + x * 4
                let b = bytes[offset]
                let g = bytes[offset + 1]
                let r = bytes[offset + 2]
                if r == target.r, g == target.g, b == target.b { editorPixels += 1 }
            }
        }
        XCTAssertEqual(editorPixels, 0, "plain text retained the neutral code editor surface")
    }

    func testPlainBubbleTextViewCannotEnterEditorFocusState() {
        let bubble = content("agent_message", seq: 499, body: "hi")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390,
                                               height: bubble.cellHeight(cellWidth: 390)))
        cell.configure(bubble, cellWidth: 390)
        cell.setBodyInteractive(true)
        let textView = cell.contentView.subviews.compactMap { $0 as? TKBodyTextView }.first
        XCTAssertNotNil(textView)
        XCTAssertFalse(textView?.canBecomeFirstResponder ?? true)
        XCTAssertFalse(textView?.isSelectable ?? true)
        XCTAssertFalse(textView?.isUserInteractionEnabled ?? true)
        XCTAssertEqual(textView?.selectedRange.location, 0)
        XCTAssertEqual(textView?.selectedRange.length, 0)
        XCTAssertEqual(textView?.backgroundColor, UIColor.clear)
        XCTAssertEqual(textView?.tintColor, UIColor.clear)
        var hasBackgroundAttribute = false
        bubble.body?.enumerateAttribute(.backgroundColor,
                                        in: NSRange(location: 0, length: bubble.body?.length ?? 0)) { value, _, stop in
            if value != nil {
                hasBackgroundAttribute = true
                stop.pointee = true
            }
        }
        XCTAssertFalse(hasBackgroundAttribute)
    }

    func testLinkBubbleKeepsTextInteractionWithoutEditorFocus() {
        let bubble = content("agent_message", seq: 498, body: "Open [Kraki](https://kraki.chat)")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390,
                                               height: bubble.cellHeight(cellWidth: 390)))
        cell.configure(bubble, cellWidth: 390)
        cell.setBodyInteractive(true)
        let textView = cell.contentView.subviews.compactMap { $0 as? TKBodyTextView }.first
        XCTAssertTrue(textView?.isSelectable == true)
        XCTAssertTrue(textView?.isUserInteractionEnabled == true)
        XCTAssertFalse(textView?.canBecomeFirstResponder ?? true)
    }

    func testLiveMarkdownCacheDoesNotLeakCodeSurfaceIntoEqualLengthPlainText() {
        let code = "```\nhi\n```"
        let plain = "plain text"
        XCTAssertEqual(code.count, plain.count)

        let first = TKMarkdown.attributed(code, cacheKey: "session:live:\(code.count)")
        var firstHasCode = false
        first.enumerateAttribute(.tkBlockKind,
                                 in: NSRange(location: 0, length: first.length)) { value, _, stop in
            if value as? String == TKBlockKind.code.rawValue {
                firstHasCode = true
                stop.pointee = true
            }
        }
        XCTAssertTrue(firstHasCode)

        let second = TKMarkdown.attributed(plain, cacheKey: "session:live:\(plain.count)")
        var secondHasBlock = false
        second.enumerateAttribute(.tkBlockKind,
                                  in: NSRange(location: 0, length: second.length)) { value, _, stop in
            if value != nil {
                secondHasBlock = true
                stop.pointee = true
            }
        }
        XCTAssertEqual(second.string, plain)
        XCTAssertFalse(secondHasBlock)
    }

    func testCodeHighlightingAddsSyntaxColorsAndKeepsSemanticCopyClean() {
        let source = """
        ```swift
        struct Bubble { let state: String }
        ```
        """
        let rendered = TKMarkdown.attributed(source, cacheKey: "code-highlight-test")
        var colors = Set<String>()
        rendered.enumerateAttribute(.foregroundColor,
                                    in: NSRange(location: 0, length: rendered.length)) { value, _, _ in
            if let color = value as? UIColor { colors.insert(color.description) }
        }
        XCTAssertGreaterThan(colors.count, 1)
        XCTAssertEqual(TKMarkdown.plainText(rendered), "struct Bubble { let state: String }")
        XCTAssertFalse(TKMarkdown.plainText(rendered)?.contains("\u{200B}") ?? true)
    }

    func testCodeBadgeHasDedicatedLayoutSpaceBeforeLongFirstLine() {
        let source = """
        ```swift
        let extremelyLongVariableNameThatMustWrap = makeBubble(configuration: .production)
        ```
        """
        let rendered = TKMarkdown.attributed(source, cacheKey: "code-badge-space-test")
        let withBadge = TKMeasure.height(rendered, width: 220)
        let plain = TKMeasure.height(NSAttributedString(
            string: "let extremelyLongVariableNameThatMustWrap = makeBubble(configuration: .production)",
            attributes: [.font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)]
        ), width: 196)
        XCTAssertGreaterThanOrEqual(withBadge, plain + 24)
    }

    func testTableBubbleExposesInteractiveAccessibleTable() {
        let message = ChatMessage(type: "agent_message", seq: 501, sessionId: "s1",
                                  deviceId: nil, timestamp: nil, payload: [
                                    "content": AnyCodable("| A | B |\n| --- | --- |\n| one | two |")
                                  ])
        let content = TKBubbleContent.make(message: message, sessionId: "s1", agent: "pi")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390,
                                               height: content.cellHeight(cellWidth: 390)))
        cell.configure(content, cellWidth: 390)
        cell.setBodyInteractive(true)
        cell.layoutIfNeeded()
        XCTAssertFalse(cell.isAccessibilityElement)
        let table = cell.contentView.subviews.compactMap { $0 as? TKTableScrollView }.first
        XCTAssertNotNil(table)
        XCTAssertTrue(table?.accessibilityTraits.contains(.adjustable) == true)
        XCTAssertTrue(table?.accessibilityValue?.contains("one\ttwo") == true)
    }

    func testUserBubbleRecolorPreservesCodeSyntaxColors() {
        let source = """
        Before

        ```swift
        let value: String = "hello"
        ```
        """
        let highlighted = TKMarkdown.attributed(source, cacheKey: "user-code-recolor-test")
        let recolored = TKMarkdown.recolored(highlighted, color: .white)
        var codeColors = Set<String>()
        recolored.enumerateAttributes(in: NSRange(location: 0, length: recolored.length)) { attrs, _, _ in
            if attrs[.tkBlockKind] as? String == TKBlockKind.code.rawValue,
               let color = attrs[.foregroundColor] as? UIColor {
                codeColors.insert(color.description)
            }
        }
        XCTAssertGreaterThan(codeColors.count, 1)
    }

    func testWideTableUsesScrollableAttachmentWithoutTruncatingSemanticText() {
        let source = """
        | Session | Agent | Model | Status | Started | Duration | Input Tokens | Output Tokens |
        | :--- | :--- | :--- | :---: | :--- | ---: | ---: | ---: |
        | production-session-with-a-long-name | pi | claude-sonnet-4 | streaming | 2026-07-15 21:42 | 128.4s | 124500 | 18942 |
        """
        let rendered = TKMarkdown.attributed(source, cacheKey: "wide-table-attachment-test")
        var attachment: TKTableAttachment?
        rendered.enumerateAttribute(.attachment,
                                    in: NSRange(location: 0, length: rendered.length)) { value, _, _ in
            attachment = value as? TKTableAttachment
        }
        let table = try! XCTUnwrap(attachment)
        XCTAssertGreaterThan(table.tableLayout.contentSize.width, 320)
        XCTAssertFalse(table.usesTextAttachmentView)
        XCTAssertLessThanOrEqual(table.tableLayout.bubbleViewportHeight, 280)
        let semantic = TKMarkdown.plainText(rendered) ?? ""
        XCTAssertTrue(semantic.contains("production-session-with-a-long-name"))
        XCTAssertTrue(semantic.contains("Output Tokens"))
        XCTAssertTrue(semantic.contains("18942"))
        XCTAssertFalse(semantic.contains("…"))
    }

    func testWideTableScrollViewCanReachRightmostColumns() {
        let rows = [
            ["Session", "Agent", "Model", "Status", "Started", "Duration", "Input Tokens", "Output Tokens"],
            ["production-session-with-a-long-name", "pi", "claude-sonnet-4", "streaming", "2026-07-15 21:42", "128.4s", "124500", "18942"],
        ]
        let layout = TKTableLayout(rows: rows, alignments: Array(repeating: .leading, count: 8))
        let view = TKTableScrollView(layout: layout)
        view.frame = CGRect(x: 0, y: 0, width: 330, height: layout.bubbleViewportHeight)
        let maxOffset = max(0, view.contentSize.width - view.bounds.width)
        XCTAssertGreaterThan(maxOffset, 0)
        view.setContentOffset(CGPoint(x: maxOffset, y: 0), animated: false)
        XCTAssertEqual(view.contentOffset.x, maxOffset, accuracy: 0.5)
        XCTAssertTrue(layout.semanticText().contains("Output Tokens"))
        XCTAssertTrue(layout.semanticText().contains("18942"))
    }

    func testTallTableUsesPreviewAndShowAllInsteadOfNestedVerticalScroll() {
        let rows = (0..<40).map { "| row-\($0) | value-\($0) |" }.joined(separator: "\n")
        let source = "| Key | Value |\n| --- | --- |\n" + rows
        let rendered = TKMarkdown.attributed(source, cacheKey: "tall-table-attachment-test")
        var attachment: TKTableAttachment?
        rendered.enumerateAttribute(.attachment,
                                    in: NSRange(location: 0, length: rendered.length)) { value, _, _ in
            attachment = value as? TKTableAttachment
        }
        let table = try! XCTUnwrap(attachment)
        XCTAssertLessThanOrEqual(table.tableLayout.bubbleViewportHeight, 280)
        XCTAssertGreaterThan(table.tableLayout.hiddenRowCount, 0)
        XCTAssertGreaterThan(table.tableLayout.contentSize.height, table.tableLayout.bubbleRowsHeight)
        XCTAssertGreaterThanOrEqual(TKMeasure.height(rendered, width: 280),
                                    table.tableLayout.bubbleViewportHeight)

        let preview = TKTableScrollView(layout: table.tableLayout)
        XCTAssertEqual(preview.contentSize.height, table.tableLayout.bubbleViewportHeight)
        XCTAssertFalse(preview.alwaysBounceVertical)
        var opened = false
        preview.onShowAll = { opened = true }
        preview.subviews.compactMap { $0 as? UIButton }.first?.sendActions(for: .touchUpInside)
        XCTAssertTrue(opened)

        let full = TKTableScrollView(layout: table.tableLayout, fullTable: true)
        XCTAssertEqual(full.contentSize.height, table.tableLayout.contentSize.height)
    }

    func testRepeatedEmptyQuoteMarkersAreCollapsed() {
        let source = "> Start\n>\n>\n>\n>\n> End"
        let rendered = TKMarkdown.attributed(source, cacheKey: "quote-empty-collapse-test")
        XCTAssertEqual(rendered.string, "Start\n\nEnd")
        let height = TKMeasure.height(rendered, width: 280)
        XCTAssertLessThan(height, 100)
    }

    func testRichMarkdownMarksQuoteCodeAndTableBlocks() {
        let source = """
        > A quote that wraps onto another line when narrow.

        ```swift
        let answer = 42
        ```

        | A | B |
        | --- | --- |
        | 1 | 2 |
        """
        let rendered = TKMarkdown.attributed(source, cacheKey: "rich-block-metadata-test")
        var kinds = Set<String>()
        rendered.enumerateAttribute(.tkBlockKind,
                                    in: NSRange(location: 0, length: rendered.length)) { value, _, _ in
            if let value = value as? String { kinds.insert(value) }
        }
        XCTAssertTrue(kinds.contains(TKBlockKind.quote.rawValue))
        XCTAssertTrue(kinds.contains(TKBlockKind.code.rawValue))
        var hasTableAttachment = false
        rendered.enumerateAttribute(.attachment,
                                    in: NSRange(location: 0, length: rendered.length)) { value, _, _ in
            hasTableAttachment = hasTableAttachment || value is TKTableAttachment
        }
        XCTAssertTrue(hasTableAttachment)
    }

    func testLandscapeContentRefPlaceholderFitsBubbleWidth() {
        let ref = ContentRef(
            type: "content_ref", id: "img", mimeType: "image/png", size: 10,
            caption: nil, name: nil, width: 100, height: 50
        )
        XCTAssertEqual(TKImageMeasure.height(refs: [ref], sessionId: "s", width: 320), 160)
    }

    func testLongQuestionChoiceExpandsActionHeightInsteadOfTruncating() {
        let short = ChatMessage(
            type: "question", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
            payload: [
                "id": AnyCodable("short"),
                "question": AnyCodable("Choose one"),
                "choices": AnyCodable(["Wait"]),
            ])
        let long = ChatMessage(
            type: "question", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
            payload: [
                "id": AnyCodable("long"),
                "question": AnyCodable("Choose one"),
                "choices": AnyCodable([
                    "Wait for the latest bubble before showing content when the authoritative head is still loading"
                ]),
            ])
        let width: CGFloat = 280
        XCTAssertGreaterThan(
            TKActionMeasure.height(action: long, width: width),
            TKActionMeasure.height(action: short, width: width) + 10
        )
    }

    func testDiscussWritePermissionUsesExecuteAction() {
        XCTAssertTrue(BubbleActionSlot.switchesToExecute(mode: .discuss, toolName: "write_file"))
        XCTAssertTrue(BubbleActionSlot.switchesToExecute(mode: .discuss, toolName: "edit"))
        XCTAssertFalse(BubbleActionSlot.switchesToExecute(mode: .discuss, toolName: "bash"))
        XCTAssertFalse(BubbleActionSlot.switchesToExecute(mode: .safe, toolName: "write_file"))
        XCTAssertFalse(BubbleActionSlot.switchesToExecute(mode: .execute, toolName: "write_file"))
    }

    func testTurnProjectionFoldsErrorsReplyAndTerminalIntoOneAgentBubble() {
        let sid = "projection-terminal"
        let messages = [
            ChatMessage(type: "user_message", seq: 70, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("retry")]),
            ChatMessage(type: "error", seq: 71, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["message": AnyCodable("524")]),
            ChatMessage(type: "agent_message", seq: 73, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("Restarted successfully"), "steps": AnyCodable(2)]),
            ChatMessage(type: "turn_status", seq: 74, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: [
                            "draft": AnyCodable(""), "steps": AnyCodable(2),
                            "action": AnyCodable(["type": "failed", "payload": ["message": "524"]]),
                        ]),
            ChatMessage(type: "idle", seq: 75, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.type), ["user_message", "turn_status", "idle"])
        XCTAssertEqual(projected[1].interruptedDraft, "Restarted successfully")
    }

    func testTurnProjectionKeepsOnlyLatestDuplicateTerminalAcrossIdleMarkers() {
        let sid = "projection-prod-duplicate-terminal"
        let messages = [
            ChatMessage(type: "user_message", seq: 424, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("draw it")]),
            ChatMessage(type: "error", seq: 425, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["message": AnyCodable("terminated")]),
            ChatMessage(type: "interrupted_turn", seq: 429, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["reason": AnyCodable("user_aborted"), "draft": AnyCodable("first draft")]),
            ChatMessage(type: "idle", seq: 430, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["reason": AnyCodable("aborted")]),
            ChatMessage(type: "interrupted_turn", seq: 431, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["reason": AnyCodable("user_aborted"), "draft": AnyCodable("final draft")]),
            ChatMessage(type: "idle", seq: 432, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["reason": AnyCodable("aborted")]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter {
            $0.type == "agent_message" || $0.type == "turn_status" || $0.type == "interrupted_turn"
        }.map(\.seq), [431])
        XCTAssertEqual(projected.first(where: { $0.seq == 431 })?.interruptedDraft, "final draft")
        XCTAssertFalse(projected.contains(where: { $0.type == "error" }))
    }

    func testTurnProjectionKeepsSteerVisibleInsideOneAgentTurn() {
        let sid = "projection-steer"
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("run tests")]),
            ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("early draft")]),
            ChatMessage(type: "user_message", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("only iOS"), "delivery": AnyCodable("steer")]),
            ChatMessage(type: "agent_message", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("final result")]),
            ChatMessage(type: "idle", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.seq), [1, 3, 4, 5])
        XCTAssertEqual(projected[1].payload["delivery"]?.stringValue, "steer")
        XCTAssertEqual(projected[2].content, "final result")
    }

    func testTurnProjectionProjectsClosingArtifactsAcrossSteerOntoFinalOutcome() {
        let sid = "projection-steer-artifact"
        let artifact: [String: AnyCodable] = [
            "type": AnyCodable("content_ref"),
            "id": AnyCodable("steered-image"),
            "mimeType": AnyCodable("image/png"),
            "size": AnyCodable(42),
        ]
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("run tests")]),
            ChatMessage(type: "user_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("only iOS"), "delivery": AnyCodable("steer")]),
            ChatMessage(type: "agent_message", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("done"), "attachments": AnyCodable([artifact])]),
            ChatMessage(type: "idle", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["turnArtifacts": AnyCodable([artifact])]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(projected[1].payload["delivery"]?.stringValue, "steer")
        XCTAssertEqual(projected[2].contentRefAttachments.map(\.id), ["steered-image"])
    }

    func testTurnProjectionProjectsClosingArtifactOntoTerminalOutcome() {
        let sid = "projection-terminal-artifact"
        let artifact: [String: AnyCodable] = [
            "type": AnyCodable("content_ref"),
            "id": AnyCodable("report"),
            "mimeType": AnyCodable("text/html"),
            "size": AnyCodable(9),
        ]
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("build report")]),
            ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("draft")]),
            ChatMessage(type: "turn_status", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable(""), "action": AnyCodable(["type": "user_abort", "payload": [:]])]),
            ChatMessage(type: "idle", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["reason": AnyCodable("aborted"), "turnArtifacts": AnyCodable([artifact])]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.type), ["user_message", "turn_status", "idle"])
        XCTAssertEqual(projected[1].contentRefAttachments.map(\.id), ["report"])
        XCTAssertEqual(projected[1].interruptedDraft, "draft")
    }

    func testTurnProjectionHidesRecoverableErrorsAndIntermediateAgentMessages() {
        let sid = "projection-normal"
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("go")]),
            ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("intermediate")]),
            ChatMessage(type: "error", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["message": AnyCodable("recoverable")]),
            ChatMessage(type: "agent_message", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("final")]),
            ChatMessage(type: "idle", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.type), ["user_message", "agent_message", "idle"])
        XCTAssertEqual(projected[1].content, "final")
    }

    func testLiveStepsRefreshKeyTracksSemanticActionBoundaries() {
        let start = ChatMessage(type: "tool_start", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
                                payload: ["toolCallId": AnyCodable("tc1"), "toolName": AnyCodable("bash")])
        let complete = ChatMessage(type: "tool_complete", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
                                   payload: ["toolCallId": AnyCodable("tc1"), "toolName": AnyCodable("bash"), "success": AnyCodable(true)])
        let compaction = ChatMessage(type: "compaction", seq: 0, sessionId: "s", deviceId: "d", timestamp: nil,
                                     payload: ["phase": AnyCodable("running")])

        XCTAssertEqual(StepsLiveSync.actionKey(start), "tool_start:tc1")
        XCTAssertEqual(StepsLiveSync.actionKey(complete), "tool_complete:tc1")
        XCTAssertNotEqual(StepsLiveSync.actionKey(start), StepsLiveSync.actionKey(complete))
        XCTAssertNil(StepsLiveSync.actionKey(compaction), "session compaction is not TRACE activity")
        XCTAssertNil(StepsLiveSync.actionKey(nil))
    }

    func testLiveStepsSignatureChangesForInPlaceToolCompletion() {
        let start = ChatMessage(type: "tool_start", seq: 9001, sessionId: "s", deviceId: "d", timestamp: nil,
                                payload: ["toolCallId": AnyCodable("tc1"), "toolName": AnyCodable("bash"), "headline": AnyCodable("$ pwd")])
        let complete = ChatMessage(type: "tool_complete", seq: 9001, sessionId: "s", deviceId: "d", timestamp: nil,
                                   payload: ["toolCallId": AnyCodable("tc1"), "toolName": AnyCodable("bash"), "headline": AnyCodable("$ pwd"), "success": AnyCodable(true)])

        XCTAssertNotEqual(StepsLiveSync.stepsSignature([start]), StepsLiveSync.stepsSignature([complete]))
    }

    func testActionHostRebuildsPendingPermissionAfterResolvedPermission() {
        func permission(_ id: String, decision: String? = nil) -> ChatMessage {
            var payload: [String: AnyCodable] = [
                "id": AnyCodable(id),
                "toolName": AnyCodable("shell"),
                "description": AnyCodable("echo STEERED"),
            ]
            if let decision { payload["decision"] = AnyCodable(decision) }
            return ChatMessage(type: "permission", seq: 0, sessionId: "s", deviceId: nil,
                               timestamp: nil, payload: payload)
        }

        let host = BubbleActionHostView(frame: CGRect(x: 0, y: 0, width: 300, height: 80))
        host.configure(action: permission("old", decision: "approve"), sessionMode: .safe)
        let resolvedController = host.hostingController
        let resolvedHeight = host.measuredHeight(forWidth: 300)
        host.configure(action: permission("new"), sessionMode: .safe)
        let pendingHeight = host.measuredHeight(forWidth: 300)
        host.frame.size.height = pendingHeight
        host.layoutIfNeeded()

        XCTAssertFalse(resolvedController === host.hostingController,
                       "a different permission must rebuild the SwiftUI host")
        XCTAssertGreaterThan(pendingHeight, resolvedHeight)
        let labels = host.hostingController?.view.accessibilityElements?
            .compactMap { ($0 as? NSObject)?.accessibilityLabel } ?? []
        XCTAssertTrue(labels.contains("Approve permission"))
        XCTAssertTrue(labels.contains("Always permission"))
        XCTAssertTrue(labels.contains("Deny permission"))
    }

    func testStepsButtonOpensDirectlyAndLongPressExposesActions() {
        let content = content("agent_message", seq: 302, body: "Traceable answer", steps: 2)
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        var openedSeq: Int?
        cell.onOpenSteps = { openedSeq = $0.seq }
        cell.configure(content, cellWidth: 390)
        cell.layoutIfNeeded()

        let button = cell.contentView.subviews.compactMap { $0 as? UIButton }.first
        XCTAssertEqual(button?.accessibilityLabel, "Show steps")
        XCTAssertFalse(button?.isHidden ?? true)
        button?.sendActions(for: .touchUpInside)
        XCTAssertEqual(openedSeq, 302)
        XCTAssertEqual(cell.messageActions().map(\.title), ["Copy", "Show Steps"])
    }

    func testPlainBubbleHidesStepsButtonButStillSupportsLongPressCopy() {
        let content = content("agent_message", seq: 303, body: "Plain answer")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        cell.configure(content, cellWidth: 390)

        let button = cell.contentView.subviews.compactMap { $0 as? UIButton }.first
        XCTAssertTrue(button?.isHidden ?? false)
        XCTAssertEqual(cell.messageActions().map(\.title), ["Copy"])
    }

    func testTerminalTurnUsesUnifiedTextKitPathSafely() {
        // Non-empty terminal drafts remain renderable by the same TextKit cell;
        // empty drafts are filtered by ChatViewModel.shouldRender above.
        for type in ["interrupted_turn", "turn_status"] {
            let message = ChatMessage(
                type: type,
                seq: 204,
                sessionId: "textkit-test-terminal",
                deviceId: "device",
                timestamp: "2026-07-13T00:00:00Z",
                payload: ["draft": AnyCodable("Partial work"), "steps": AnyCodable(3)]
            )
            // If it WERE built, it must not crash — but the contract is that it
            // is excluded upstream. Here we just confirm build() is safe.
            TKBubbleContent.bust(message.id)
            let content = TKBubbleContent.make(message: message, sessionId: "textkit-test", agent: "pi")
            XCTAssertNotNil(content, "\(type) must not crash TKBubbleContent.build")
        }
    }

    func testVisibleComposerHasDeterministicBottomObstructionFloor() {
        XCTAssertEqual(
            ChatBottomObstruction.height(
                measuredComposerHeight: 0,
                composerVisible: true,
                compacting: false
            ),
            54
        )
        XCTAssertEqual(
            ChatBottomObstruction.height(
                measuredComposerHeight: 76,
                composerVisible: true,
                compacting: false
            ),
            76
        )
        XCTAssertEqual(
            ChatBottomObstruction.height(
                measuredComposerHeight: 0,
                composerVisible: true,
                compacting: true
            ),
            102
        )
    }

    func testInlineImageAttachmentParsesFromUserMessagePayload() {
        let json = """
        {"seq":139,"type":"user_message","sessionId":"img-test","deviceId":"d","timestamp":"2026-07-14T07:18:24Z",
         "payload":{"content":"look","clientId":"c1","attachments":[{"type":"image","mimeType":"image/jpeg","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}]}}
        """
        let msg = try! JSONDecoder().decode(ChatMessage.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(msg.attachments?.count, 1)
        XCTAssertEqual(msg.attachments?.first?.type, "image")
        XCTAssertEqual(msg.attachments?.first?.mimeType, "image/jpeg")
    }

    func testBubblesHaveNoTimestampFooter() {
        let persisted = content("agent_message", seq: 304, body: "done")
        XCTAssertNil(persisted.footerDate)

        let live = TKBubbleContent.live(
            card: MessageStore.SessionCard(text: "working", action: nil),
            agent: "pi", sessionId: "footer-live", steps: 0)
        XCTAssertNil(live.footerDate)
    }

    func testCellExposesMessageToAccessibility() {
        let content = content("agent_message", seq: 301, body: "Accessible answer")
        let cell = TKBubbleCell(frame: CGRect(x: 0, y: 0, width: 390, height: 100))
        cell.configure(content, cellWidth: 390)
        XCTAssertTrue(cell.isAccessibilityElement)
        XCTAssertEqual(cell.accessibilityLabel, "Accessible answer")
    }

    // MARK: - Trace entry identity (Steps sheet multi-step rendering)

    /// Trace entries arrive off-spine (seq=0). Before the fix they all shared
    /// ChatMessage.id "session:0", so SwiftUI ForEach collapsed a 5-step turn
    /// into a single row — the "只有一个 step" bug. After assigning synthetic
    /// seqs, every entry must have a unique id.
    func testTraceEntriesGetUniqueIdsAfterSyntheticSeq() {
        // Simulate 3 tools + 2 narrations = 8 raw entries, all seq=0
        let raw: [ChatMessage] = [
            ChatMessage(type: "agent_narration", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["content": AnyCodable("thinking")]),
            ChatMessage(type: "tool_start", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("tc1")]),
            ChatMessage(type: "tool_complete", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("tc1")]),
            ChatMessage(type: "tool_start", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("edit"), "toolCallId": AnyCodable("tc2")]),
            ChatMessage(type: "tool_complete", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("edit"), "toolCallId": AnyCodable("tc2")]),
            ChatMessage(type: "agent_narration", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["content": AnyCodable("more thinking")]),
            ChatMessage(type: "tool_start", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc3")]),
            ChatMessage(type: "tool_complete", seq: 0, sessionId: "s1", deviceId: nil, timestamp: nil,
                        payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc3")]),
        ]
        // Before fix: all ids are identical → ForEach renders 1 row
        let rawIds = Set(raw.map { $0.id })
        XCTAssertEqual(rawIds.count, 1, "raw trace entries collide on id (the bug)")

        // After fix: assign synthetic seqs like the router does
        let fixed = raw.enumerated().map { idx, msg in
            ChatMessage(type: msg.type, seq: 9001 + idx, sessionId: msg.sessionId,
                        deviceId: msg.deviceId, timestamp: msg.timestamp, payload: msg.payload)
        }
        let fixedIds = Set(fixed.map { $0.id })
        XCTAssertEqual(fixedIds.count, raw.count, "every trace entry must have a unique id after synthetic seq")
    }
}
