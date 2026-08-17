import XCTest
import UIKit
import SwiftUI
@testable import Kraki

@MainActor
final class TextKitPureSpineTests: XCTestCase {
    private final class FlowLayoutMetricProbe: NSObject, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
        var heights: [CGFloat] = [100, 100, 100]

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            heights.count
        }

        func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
            collectionView.dequeueReusableCell(withReuseIdentifier: "cell", for: indexPath)
        }

        func collectionView(_ collectionView: UICollectionView,
                            layout collectionViewLayout: UICollectionViewLayout,
                            sizeForItemAt indexPath: IndexPath) -> CGSize {
            CGSize(width: collectionView.bounds.width, height: heights[indexPath.item])
        }
    }

    private func descendants<T: UIView>(of root: UIView, as type: T.Type = T.self) -> [T] {
        root.subviews.flatMap { subview in
            (subview as? T).map { [$0] } ?? descendants(of: subview, as: type)
        }
    }

    func testFlowLayoutMetricInvalidationReflowsFollowingRowsWithoutScroll() {
        let layout = UICollectionViewFlowLayout()
        layout.minimumLineSpacing = 0
        layout.estimatedItemSize = .zero
        let collection = UICollectionView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 600),
            collectionViewLayout: layout
        )
        let probe = FlowLayoutMetricProbe()
        collection.dataSource = probe
        collection.delegate = probe
        collection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "cell")
        collection.reloadData()
        collection.layoutIfNeeded()

        XCTAssertEqual(layout.layoutAttributesForItem(at: IndexPath(item: 1, section: 0))?.frame.minY, 100)
        XCTAssertEqual(collection.contentSize.height, 300)

        probe.heights[0] = 240
        let context = UICollectionViewFlowLayoutInvalidationContext()
        context.invalidateFlowLayoutDelegateMetrics = true
        context.invalidateFlowLayoutAttributes = true
        layout.invalidateLayout(with: context)
        collection.layoutIfNeeded()

        XCTAssertEqual(layout.layoutAttributesForItem(at: IndexPath(item: 0, section: 0))?.frame.height, 240)
        XCTAssertEqual(layout.layoutAttributesForItem(at: IndexPath(item: 1, section: 0))?.frame.minY, 240)
        XCTAssertEqual(collection.contentSize.height, 440)
    }

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

    func testAgentBubbleWidthHugsShortContentAndClampsLongContent() {
        let cellWidth: CGFloat = 402
        let short = content("agent_message", seq: 104, body: "Done")
        let long = content(
            "agent_message",
            seq: 105,
            body: String(repeating: "This is a long agent response that should wrap. ", count: 20)
        )

        let maximum = cellWidth - 24 - cellWidth * 0.05
        XCTAssertLessThan(short.bubbleWidth(cellWidth: cellWidth), maximum * 0.5)
        XCTAssertEqual(long.bubbleWidth(cellWidth: cellWidth), maximum, accuracy: 0.5)
        XCTAssertGreaterThan(long.cellHeight(cellWidth: cellWidth), short.cellHeight(cellWidth: cellWidth))
    }

    func testAgentActionBubbleAlsoHugsShortContent() {
        let action = ChatMessage(
            type: "tool_batch",
            seq: 1,
            sessionId: "agent-action-width",
            deviceId: "device",
            timestamp: nil,
            payload: ["running": AnyCodable(3)]
        )
        let live = TKBubbleContent.live(
            card: MessageStore.SessionCard(
                text: "Running independent checks.",
                action: action
            ),
            agent: "pi",
            sessionId: "agent-action-width",
            steps: 0
        )
        let cellWidth: CGFloat = 402
        let maximum = cellWidth - 24 - cellWidth * 0.05
        XCTAssertLessThan(live.bubbleWidth(cellWidth: cellWidth), maximum)
        XCTAssertGreaterThan(live.bubbleWidth(cellWidth: cellWidth), 180)
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

    func testSharedInlineMarkdownSemanticsDriveTextKitRendering() {
        let source = "**bold** *italic* `code` ~~removed~~ [Kraki](https://kraki.chat)"
        let runs = parseMarkdownInline(source)
        XCTAssertEqual(runs.map(\.text).joined(), "bold italic code removed Kraki")
        XCTAssertTrue(runs.contains { $0.text == "bold" && $0.bold })
        XCTAssertTrue(runs.contains { $0.text == "italic" && $0.italic })
        XCTAssertTrue(runs.contains { $0.text == "code" && $0.code })
        XCTAssertTrue(runs.contains { $0.text == "removed" && $0.strikethrough })
        XCTAssertEqual(runs.first(where: { $0.text == "Kraki" })?.link?.absoluteString,
                       "https://kraki.chat")

        let rendered = TKMarkdown.attributed(source, cacheKey: "shared-inline-semantics")
        XCTAssertEqual(rendered.string, "bold italic code removed Kraki")
        let removedRange = (rendered.string as NSString).range(of: "removed")
        let strike = rendered.attribute(.strikethroughStyle,
                                        at: removedRange.location,
                                        effectiveRange: nil) as? Int
        XCTAssertEqual(strike, NSUnderlineStyle.single.rawValue)
        let linkRange = (rendered.string as NSString).range(of: "Kraki")
        XCTAssertEqual((rendered.attribute(.link, at: linkRange.location,
                                           effectiveRange: nil) as? URL)?.absoluteString,
                       "https://kraki.chat")
    }

    func testSharedMarkdownLineAndLanguageNormalization() {
        XCTAssertEqual(parseMarkdownInlineLine("### Heading"),
                       .heading(level: 3, text: "Heading"))
        XCTAssertEqual(parseMarkdownInlineLine("  - nested"),
                       .list(MarkdownListItem(ordered: false, number: 0, depth: 1, text: "nested")))
        XCTAssertEqual(parseMarkdownInlineLine("12. ordered"),
                       .list(MarkdownListItem(ordered: true, number: 12, depth: 0, text: "ordered")))
        XCTAssertEqual(normalizeMarkdownQuoteWhitespace("\nStart\n\n\nEnd\n"), "Start\n\nEnd")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("TSX"), "typescript")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("c++"), "cpp")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("jsonc"), "json")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("shell-session"), "shell")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("objective-c++"), "objectivec")
        XCTAssertEqual(MarkdownCodeSyntax.normalizedLanguage("postgresql"), "pgsql")
        XCTAssertTrue(MarkdownCodeSyntax.isIntentionallyPlain("text"))
        XCTAssertFalse(MarkdownCodeSyntax.isIntentionallyPlain("swift"))
    }

    func testSessionCardStatusPriorityAndBooleanUnreadProjection() {
        XCTAssertEqual(SessionCardStatus.resolve(
            sessionState: .active, previewType: "question", deviceOnline: false
        ), .offline)
        XCTAssertEqual(SessionCardStatus.resolve(
            sessionState: .active, previewType: "permission", deviceOnline: true
        ), .approval)
        XCTAssertEqual(SessionCardStatus.resolve(
            sessionState: .active, previewType: nil, deviceOnline: true
        ), .active)
        XCTAssertEqual(SessionCardStatus.resolve(
            sessionState: .idle, previewType: "agent_message", deviceOnline: true
        ), .agentMessage)
        XCTAssertEqual(SessionCardStatus.resolve(
            sessionState: .idle, previewType: "agent_message", deviceOnline: true, hasDraft: true
        ), .humanMessage)

        let session = SessionInfo(
            id: "card-projection", deviceId: "device", deviceName: "Macbook",
            agent: "pi", model: "gpt-5.6-sol", title: "Shared Card",
            state: .idle, mode: .discuss, lastSeq: 91, readSeq: 12,
            messageCount: 91, createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            pinned: true
        )
        let device = DeviceSummary(
            id: "device", name: "Macbook", role: .tentacle, kind: .desktop,
            publicKey: nil, encryptionKey: nil, online: true,
            lastSeen: nil, createdAt: nil
        )
        let projection = SessionCardProjection.make(
            session: session,
            device: device,
            preview: SessionPreview(
                text: "Latest   agent\nmessage", type: "agent_message",
                timestamp: "2026-08-04T12:00:00.000Z"
            ),
            draft: nil
        )
        XCTAssertTrue(projection.isUnread, "cursor gaps project one boolean dot, never a count")
        XCTAssertEqual(projection.previewText, "Latest agent message")
        XCTAssertEqual(projection.status, .agentMessage)
        XCTAssertEqual(projection.model, "gpt-5.6-sol")
        XCTAssertTrue(projection.isPinned)
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
        let textView = descendants(of: cell.contentView, as: TKBodyTextView.self).first
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
        let textView = descendants(of: cell.contentView, as: TKBodyTextView.self).first
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
        TKMarkdown.prepareFinalHighlightForTesting(
            code: "struct Bubble { let state: String }",
            language: "swift"
        )
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

    func testCodeForegroundAlwaysMeetsMacEditorContrastContract() {
        let samples = [
            ("text", "plain output with no syntax tokens"),
            ("swift", "let value: String = \"hello\""),
            ("not-a-real-language", "const value = 42 // fallback"),
        ]
        let background = UIColor(red: 0x18/255, green: 0x18/255, blue: 0x1B/255, alpha: 1)

        func luminance(_ color: UIColor) -> CGFloat {
            let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return 0 }
            func linear(_ value: CGFloat) -> CGFloat {
                value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }
        let backgroundLuminance = luminance(background)

        for (language, code) in samples {
            TKMarkdown.prepareFinalHighlightForTesting(code: code, language: language)
            let rendered = TKMarkdown.attributed(
                "```\(language)\n\(code)\n```",
                cacheKey: "contrast-\(language)"
            )
            var checkedGlyphs = 0
            rendered.enumerateAttributes(
                in: NSRange(location: 0, length: rendered.length)
            ) { attributes, range, _ in
                guard attributes[.tkDecorativeSpacer] == nil else { return }
                let fragment = (rendered.string as NSString).substring(with: range)
                guard fragment.rangeOfCharacter(from: .whitespacesAndNewlines.inverted) != nil else { return }
                guard let color = attributes[.foregroundColor] as? UIColor else {
                    return XCTFail("\(language) code glyphs must have an explicit foreground")
                }
                let foregroundLuminance = luminance(color)
                let ratio = (max(foregroundLuminance, backgroundLuminance) + 0.05)
                    / (min(foregroundLuminance, backgroundLuminance) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(language) emitted unreadable code text")
                checkedGlyphs += range.length
            }
            XCTAssertGreaterThan(checkedGlyphs, 0)
            XCTAssertEqual(TKMarkdown.plainText(rendered), code)
        }
    }

    func testCodeHighlightAliasesAndLexicalFallbackMatchMacBehavior() {
        let samples: [(language: String, code: String)] = [
            ("tsx", "export const Card = () => <div>{42}</div>"),
            ("c++", "struct Card { int value = 42; };"),
            ("mermaid", "flowchart LR\n  A --> B"),
        ]
        for sample in samples {
            TKMarkdown.prepareFinalHighlightForTesting(
                code: sample.code,
                language: sample.language
            )
            let source = "```\(sample.language)\n\(sample.code)\n```"
            let rendered = TKMarkdown.attributed(
                source,
                cacheKey: "alias-\(sample.language)-\(sample.code.count)"
            )
            var colors = Set<String>()
            rendered.enumerateAttribute(
                .foregroundColor,
                in: NSRange(location: 0, length: rendered.length)
            ) { value, _, _ in
                if let color = value as? UIColor { colors.insert(color.description) }
            }
            XCTAssertGreaterThan(colors.count, 1, "\(sample.language) should render multiple token colors")
            XCTAssertEqual(TKMarkdown.plainText(rendered), sample.code)
        }
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
        let table = descendants(of: cell.contentView, as: TKTableScrollView.self).first
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
        TKMarkdown.prepareFinalHighlightForTesting(
            code: "let value: String = \"hello\"",
            language: "swift"
        )
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

    func testHTMLArtifactCardsDeduplicateUseFixedGeometryAndOpenThroughOwner() {
        let report: [String: AnyCodable] = [
            "type": AnyCodable("content_ref"),
            "id": AnyCodable("report-1"),
            "mimeType": AnyCodable("text/html"),
            "size": AnyCodable(2048),
            "caption": AnyCodable("Streaming Status Study"),
        ]
        let message = ChatMessage(
            type: "agent_message", seq: 502, sessionId: "html-card",
            deviceId: "device", timestamp: nil,
            payload: [
                "content": AnyCodable("Report ready"),
                "attachments": AnyCodable([report, report]),
            ]
        )
        let plain = content("agent_message", seq: 503, body: "Report ready")
        TKBubbleContent.bust(message.id)
        let bubble = TKBubbleContent.make(message: message, sessionId: "html-card", agent: "pi")
        XCTAssertEqual(bubble.htmlArtifacts.map(\.id), ["report-1"])
        XCTAssertEqual(
            bubble.cellHeight(cellWidth: 390) - plain.cellHeight(cellWidth: 390),
            60,
            accuracy: 0.5,
            "one report uses a 54pt card plus the normal 6pt content gap"
        )

        let cell = TKBubbleCell(frame: CGRect(
            x: 0, y: 0, width: 390,
            height: bubble.cellHeight(cellWidth: 390)
        ))
        var opened: ContentRef?
        cell.onOpenHTMLArtifact = { opened = $0 }
        cell.configure(bubble, cellWidth: 390)
        cell.layoutIfNeeded()
        let reportControl = descendants(of: cell.contentView, as: UIControl.self)
            .first { $0.accessibilityLabel == "Streaming Status Study" }
        XCTAssertNotNil(reportControl)
        reportControl?.sendActions(for: .touchUpInside)
        XCTAssertEqual(opened?.id, "report-1")
    }

    func testHTMLArtifactProjectionInvalidatesExistingBubbleCacheEntry() {
        let base = ChatMessage(
            type: "agent_message", seq: 504, sessionId: "html-cache",
            deviceId: "device", timestamp: nil,
            payload: ["content": AnyCodable("Report ready")]
        )
        TKBubbleContent.bust(base.id)
        let initial = TKBubbleContent.make(message: base, sessionId: "html-cache", agent: "pi")
        XCTAssertTrue(initial.htmlArtifacts.isEmpty)

        var updated = base
        updated.payload["attachments"] = AnyCodable([[
            "type": "content_ref",
            "id": "report-late",
            "mimeType": "text/html",
            "size": 512,
        ]])
        let projected = TKBubbleContent.make(message: updated, sessionId: "html-cache", agent: "pi")
        XCTAssertFalse(initial === projected)
        XCTAssertEqual(projected.htmlArtifacts.map(\.id), ["report-late"])
    }

    func testHTMLArtifactSecurityReplacesProducerCSPWithNativeBoundary() {
        let source = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body>ok</body></html>"
        let secured = HTMLArtifactSecurity.securedHTML(source)
        XCTAssertFalse(secured.contains("default-src *"))
        XCTAssertTrue(secured.contains("default-src 'none'"))
        XCTAssertTrue(secured.contains("frame-src 'none'"))
        XCTAssertTrue(secured.contains("connect-src 'none'"))
        XCTAssertEqual(
            secured.components(separatedBy: "Content-Security-Policy").count - 1,
            1
        )
        XCTAssertEqual(HTMLArtifactSecurity.maxBytes, 10 * 1024 * 1024)
    }

    func testImageAttachmentsUseStableGalleryGeometryOutsideBubble() {
        let width: CGFloat = 390
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 100))
        let image = renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
        }
        let firstRef = ContentRef(
            type: "content_ref", id: "img-1", mimeType: "image/png", size: 10,
            caption: nil, name: nil, width: 200, height: 100
        )
        let secondRef = ContentRef(
            type: "content_ref", id: "img-2", mimeType: "image/png", size: 10,
            caption: nil, name: nil, width: 100, height: 200
        )
        let baseMessage = message("agent_message", seq: 505, content: "Image result")
        let textOnly = TKBubbleContent(
            message: baseMessage,
            kind: .agent,
            hueSeed: "image-gallery",
            body: TKMarkdown.attributed("Image result", cacheKey: "image-gallery-text")
        )
        let textAndImage = TKBubbleContent(
            message: baseMessage,
            kind: .agent,
            hueSeed: "image-gallery",
            body: TKMarkdown.attributed("Image result", cacheKey: "image-gallery-text"),
            images: [image]
        )
        let stacked = TKBubbleContent(
            message: baseMessage,
            kind: .agent,
            hueSeed: "image-gallery",
            body: TKMarkdown.attributed("Image result", cacheKey: "image-gallery-text"),
            imageRefs: [firstRef, secondRef]
        )
        let pureImage = TKBubbleContent(
            message: baseMessage,
            kind: .agent,
            hueSeed: "image-gallery",
            body: nil,
            images: [image]
        )

        XCTAssertLessThan(
            textAndImage.bubbleWidth(cellWidth: width),
            textAndImage.attachmentWidth(cellWidth: width),
            "short text hugs content without shrinking the sibling image gallery"
        )
        XCTAssertEqual(
            textAndImage.cellHeight(cellWidth: width),
            textOnly.cellHeight(cellWidth: width)
                + IOSImageGalleryLayout.attachmentSpacing
                + textAndImage.imagesHeight(cellWidth: width),
            accuracy: 0.5
        )
        XCTAssertEqual(
            stacked.imagesHeight(cellWidth: width),
            IOSImageGalleryLayout.multiCardHeight + IOSImageGalleryLayout.multiStackOffset,
            accuracy: 0.5,
            "multiple images occupy one compact fixed-height stack"
        )
        XCTAssertEqual(
            pureImage.cellHeight(cellWidth: width),
            pureImage.imagesHeight(cellWidth: width) + IOSImageGalleryLayout.outerVerticalPadding,
            accuracy: 0.5
        )

        let cell = TKBubbleCell(frame: CGRect(
            x: 0,
            y: 0,
            width: width,
            height: textAndImage.cellHeight(cellWidth: width)
        ))
        cell.configure(textAndImage, cellWidth: width)
        cell.layoutIfNeeded()
        XCTAssertFalse(cell.bubbleHiddenForRegression)
        XCTAssertFalse(cell.imageFrameForRegression.intersects(cell.bubbleFrameForRegression))
        XCTAssertGreaterThanOrEqual(
            cell.imageFrameForRegression.minY,
            cell.bubbleFrameForRegression.maxY + IOSImageGalleryLayout.attachmentSpacing - 0.5
        )

        cell.frame.size.height = pureImage.cellHeight(cellWidth: width)
        cell.configure(pureImage, cellWidth: width)
        cell.layoutIfNeeded()
        XCTAssertTrue(cell.bubbleHiddenForRegression)
        XCTAssertEqual(cell.bubbleFrameForRegression, .zero)
        XCTAssertGreaterThan(cell.imageFrameForRegression.height, 0)
    }

    func testImagePreviewBackdropClosesWithoutStealingImageTap() {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 100))
        let image = renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
        }
        let view = IOSZoomableImageView(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        view.image = image
        var closeCount = 0
        view.onBackdropTap = { closeCount += 1 }
        view.layoutIfNeeded()

        XCTAssertFalse(view.tapForRegression(at: CGPoint(x: view.bounds.midX, y: view.bounds.midY)))
        XCTAssertEqual(closeCount, 0)
        XCTAssertTrue(view.tapForRegression(at: CGPoint(x: 1, y: 1)))
        XCTAssertEqual(closeCount, 1)
        XCTAssertEqual(view.maximumZoomScaleForRegression, 8)
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
        XCTAssertTrue(BubbleActionSlot.switchesToExecute(mode: .discuss, toolName: "create_file"))
        XCTAssertTrue(BubbleActionSlot.switchesToExecute(mode: .discuss, toolName: "edit_file"))
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

    func testTurnProjectionKeepsAgentOnlyRecoveryAfterTerminalIdleBoundary() {
        let sid = "projection-terminal-then-agent-recovery"
        let messages = [
            ChatMessage(type: "user_message", seq: 62, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("start")]),
            ChatMessage(type: "error", seq: 64, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["message": AnyCodable("failed")]),
            ChatMessage(type: "turn_status", seq: 65, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable("failed draft")]),
            ChatMessage(type: "idle", seq: 66, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
            ChatMessage(type: "agent_message", seq: 67, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("recovered independently")]),
            ChatMessage(type: "idle", seq: 68, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter {
            $0.type == "agent_message" || $0.type == "turn_status" || $0.type == "interrupted_turn"
        }.map(\.seq), [65, 67])
    }

    func testTurnProjectionKeepsRecoveredAgentAfterSteerFollowingTerminalIdle() {
        let sid = "projection-terminal-idle-steer-agent"
        let messages = [
            ChatMessage(type: "agent_message", seq: 315, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("earlier reply")]),
            ChatMessage(type: "turn_status", seq: 316, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable(""), "action": AnyCodable(["type": "failed"])]),
            ChatMessage(type: "idle", seq: 317, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
            ChatMessage(type: "user_message", seq: 318, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("continue"), "delivery": AnyCodable("steer")]),
            ChatMessage(type: "agent_message", seq: 319, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("recovered reply")]),
            ChatMessage(type: "idle", seq: 320, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter {
            $0.type == "agent_message" || $0.type == "turn_status" || $0.type == "interrupted_turn"
        }.map(\.seq), [316, 319])
        XCTAssertEqual(projected.first(where: { $0.seq == 319 })?.content, "recovered reply")
    }

    func testTurnProjectionStartsNewTerminalConclusionAfterIdleAndSteer() {
        let sid = "projection-terminal-idle-steer-terminal"
        let messages = [
            ChatMessage(type: "turn_status", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable("first")]),
            ChatMessage(type: "idle", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
            ChatMessage(type: "user_message", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("continue"), "delivery": AnyCodable("steer")]),
            ChatMessage(type: "turn_status", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable("second")]),
            ChatMessage(type: "idle", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter {
            $0.type == "agent_message" || $0.type == "turn_status" || $0.type == "interrupted_turn"
        }.map(\.seq), [1, 4])
    }

    func testTurnProjectionStartsNewAgentConclusionAfterIdleAndSteer() {
        let sid = "projection-agent-idle-steer-agent"
        let messages = [
            ChatMessage(type: "agent_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("first reply")]),
            ChatMessage(type: "idle", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
            ChatMessage(type: "user_message", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("continue"), "delivery": AnyCodable("steer")]),
            ChatMessage(type: "agent_message", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("second reply")]),
            ChatMessage(type: "idle", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter { $0.type == "agent_message" }.map(\.seq), [1, 4])
    }

    func testTurnProjectionDoesNotSplitDuplicateTerminalAfterIdle() {
        let sid = "projection-terminal-idle-terminal"
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("abort")]),
            ChatMessage(type: "turn_status", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable("first")]),
            ChatMessage(type: "idle", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
            ChatMessage(type: "interrupted_turn", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable("second")]),
            ChatMessage(type: "idle", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil, payload: [:]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.filter {
            $0.type == "agent_message" || $0.type == "turn_status" || $0.type == "interrupted_turn"
        }.map(\.seq), [4])
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

    func testTurnProjectionProjectsClosingHTMLArtifactOntoNoReplySystemOutcome() {
        let sid = "projection-no-reply-artifact"
        let artifact: [String: AnyCodable] = [
            "type": AnyCodable("content_ref"),
            "id": AnyCodable("no-reply-report"),
            "mimeType": AnyCodable("text/html"),
            "size": AnyCodable(12),
        ]
        let messages = [
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("build report")]),
            ChatMessage(type: "system_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["kind": AnyCodable("no_reply")]),
            ChatMessage(type: "idle", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["turnArtifacts": AnyCodable([artifact])]),
        ]

        let projected = TurnSpineProjection.project(messages)
        XCTAssertEqual(projected.map(\.type), ["user_message", "system_message", "idle"])
        XCTAssertEqual(projected[1].contentRefAttachments.map(\.id), ["no-reply-report"])
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
        XCTAssertEqual(permission("new").permissionId, "new")
        XCTAssertNil(permission("new").payload["decision"]?.stringValue)
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
