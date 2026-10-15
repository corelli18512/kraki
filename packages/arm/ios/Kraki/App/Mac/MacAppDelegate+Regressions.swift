/// Debug-only launch regressions (KRAKI_* environment switches): release polish, image preview, HTML artifacts, voice transcript.

#if os(macOS) && DEBUG
import AppKit
import SwiftUI

extension MacAppDelegate {
    func runReleasePolishRegression() {
        MacComposerPasteFocusRegression.run { composerResult in
            let placeholderHidden = composerResult["placeholderHiddenForNativeText"] as? Bool == true
            let placeholderRestored = composerResult["placeholderRestoredAfterClear"] as? Bool == true

            let artifact = ContentRef(
                type: "content_ref",
                id: "release-polish-html",
                mimeType: "text/html",
                size: 1_024,
                caption: "Release polish report",
                name: "release-polish.html",
                width: nil,
                height: nil
            )
            var artifactCache = MacHTMLArtifactSessionCache()
            artifactCache.open(sessionId: "session-a", ref: artifact)
            artifactCache.toggleExpanded(for: "session-a")
            let otherSessionStayedClosed = artifactCache.presentation(for: "session-b") == nil
            let restoredArtifact = artifactCache.presentation(for: "session-a")
            let artifactRestored = restoredArtifact?.selection.ref.id == artifact.id
            let artifactModeRestored = restoredArtifact?.expanded == true

            var liveCardCached = false
            var liveCardReplaced = false
            var durableConclusionCleared = false
            var storeError: String?
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("kraki-release-polish-\(UUID().uuidString)", isDirectory: true)
            do {
                let database = try MessageDatabase(
                    databaseURL: root.appendingPathComponent("messages.sqlite")
                )
                let store = MessageStore(db: database)
                let sessionID = "cached-live-card"
                let user = ChatMessage(
                    type: "user_message",
                    seq: 1,
                    sessionId: sessionID,
                    deviceId: nil,
                    timestamp: nil,
                    payload: ["content": AnyCodable("go")]
                )
                let final = ChatMessage(
                    type: "agent_message",
                    seq: 2,
                    sessionId: sessionID,
                    deviceId: nil,
                    timestamp: nil,
                    payload: ["content": AnyCodable("done")]
                )

                store.beginCardTurn(sessionID)
                store.applyCardMessage(sessionID, "cached first frame", reset: true)
                store.restoreCardTurnGate(sessionID, from: [user])
                liveCardCached = store.cards[sessionID]?.text == "cached first frame"

                store.replaceCardFromSubscription(
                    sessionID,
                    draft: "authoritative live frame",
                    action: nil,
                    state: .active
                )
                liveCardReplaced = store.cards[sessionID]?.text == "authoritative live frame"

                store.restoreCardTurnGate(sessionID, from: [user, final])
                durableConclusionCleared = store.cards[sessionID] == nil
            } catch {
                storeError = error.localizedDescription
            }
            try? FileManager.default.removeItem(at: root)

            let passed = placeholderHidden
                && placeholderRestored
                && otherSessionStayedClosed
                && artifactRestored
                && artifactModeRestored
                && liveCardCached
                && liveCardReplaced
                && durableConclusionCleared
                && storeError == nil
            NSLog(
                "[release-polish-regression] placeholderHidden=%d placeholderRestored=%d artifactIsolated=%d artifactRestored=%d artifactMode=%d liveCached=%d liveReplaced=%d conclusionCleared=%d storeError=%@ passed=%d",
                placeholderHidden ? 1 : 0,
                placeholderRestored ? 1 : 0,
                otherSessionStayedClosed ? 1 : 0,
                artifactRestored ? 1 : 0,
                artifactModeRestored ? 1 : 0,
                liveCardCached ? 1 : 0,
                liveCardReplaced ? 1 : 0,
                durableConclusionCleared ? 1 : 0,
                storeError ?? "none",
                passed ? 1 : 0
            )
            NSApp.terminate(nil)
        }
    }

    func runImagePreviewRegression() {
        func makeImage(
            size: NSSize,
            background: NSColor,
            foreground: NSColor,
            label: String
        ) -> NSImage {
            let image = NSImage(size: size)
            image.lockFocus()
            background.setFill()
            NSRect(origin: .zero, size: size).fill()
            foreground.setFill()
            NSRect(
                x: size.width * 0.15,
                y: size.height * 0.15,
                width: size.width * 0.70,
                height: size.height * 0.70
            ).fill()
            let text = NSAttributedString(
                string: label,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 56, weight: .heavy),
                    .foregroundColor: NSColor.white,
                ]
            )
            let textSize = text.size()
            text.draw(at: NSPoint(
                x: (size.width - textSize.width) / 2,
                y: (size.height - textSize.height) / 2
            ))
            image.unlockFocus()
            return image
        }

        let image = makeImage(
            size: NSSize(width: 800, height: 600),
            background: .systemBlue,
            foreground: .systemYellow,
            label: "IMAGE 1"
        )
        let secondImage = makeImage(
            size: NSSize(width: 600, height: 900),
            background: .systemPurple,
            foreground: .systemGreen,
            label: "IMAGE 2"
        )
        let width: CGFloat = 640
        let content = MacChatBubbleContent(
            seq: 1,
            sessionId: "image-preview-regression",
            kind: .agent,
            body: MacMarkdown.attributed(
                "Text bubble stays separate from the image gallery.",
                cacheKey: "image-preview-regression-body"
            ),
            inlineImages: [image, secondImage],
            imageRefs: [],
            htmlArtifacts: [],
            action: nil,
            isLive: false,
            canShowSteps: false,
            bubbleColor: .controlBackgroundColor,
            cornerRadii: (4, 16, 16, 16),
            bubbleWidth: 580,
            attachmentWidth: 580
        )
        var openedCount = 0
        var openedFirstSize = NSSize.zero
        let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        cell.configure(
            content: content,
            renderKey: "image-preview-regression",
            documentWidth: width,
            sessionMode: .auto,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { selection in
                openedCount = selection.items.count
                openedFirstSize = selection.items.first?.image?.size ?? .zero
            },
            onOpenHTMLArtifact: { _ in },
            onHeightInvalidated: {}
        )
        cell.frame.size.height = cell.configuredHeight()

        let pureImageContent = MacChatBubbleContent(
            seq: 2,
            sessionId: "image-preview-regression",
            kind: .agent,
            body: nil,
            inlineImages: [image],
            imageRefs: [],
            htmlArtifacts: [],
            action: nil,
            isLive: false,
            canShowSteps: false,
            bubbleColor: .controlBackgroundColor,
            cornerRadii: (4, 16, 16, 16),
            bubbleWidth: 580,
            attachmentWidth: 580
        )
        let pureImageCell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        pureImageCell.configure(
            content: pureImageContent,
            renderKey: "image-preview-pure-regression",
            documentWidth: width,
            sessionMode: .auto,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { _ in },
            onOpenHTMLArtifact: { _ in },
            onHeightInvalidated: {}
        )
        pureImageCell.frame.size.height = pureImageCell.configuredHeight()
        pureImageCell.layoutSubtreeIfNeeded()
        let pureImageNoBubble = pureImageCell.bubbleHiddenForRegression

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: cell.frame.size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = cell
        cell.layoutSubtreeIfNeeded()
        let capturePath = "/tmp/kraki-image-gallery-regression.png"
        var captureOK = false
        if let bitmap = cell.bitmapImageRepForCachingDisplay(in: cell.bounds) {
            cell.cacheDisplay(in: cell.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [.compressionFactor: 1]) {
                captureOK = (try? png.write(to: URL(fileURLWithPath: capturePath), options: .atomic)) != nil
            }
        }

        let canvas = MacZoomableImageView(frame: NSRect(x: 0, y: 0, width: 600, height: 420))
        canvas.image = image
        var backdropCloseCount = 0
        canvas.onBackdropClick = { backdropCloseCount += 1 }
        let imageClickPreserved = !canvas.clickBackdropForRegression(
            at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
        ) && backdropCloseCount == 0
        let backdropCloses = canvas.clickBackdropForRegression(at: CGPoint(x: 1, y: 1))
            && backdropCloseCount == 1
        canvas.setZoom(20)
        let upperClamp = abs(canvas.zoomForRegression - 8) < 0.001
        canvas.setZoom(0.1)
        let lowerClamp = abs(canvas.zoomForRegression - 1) < 0.001
        canvas.setZoom(2)
        let zoomed = abs(canvas.zoomForRegression - 2) < 0.001

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            cell.layoutSubtreeIfNeeded()
            let frame = cell.imageFrameForRegression
            let bubbleFrame = cell.bubbleFrameForRegression
            let separate = frame.minY >= bubbleFrame.maxY + MacChatBubbleLayout.attachmentSpacing - 0.5
                && !frame.intersects(bubbleFrame)
            let expectedStackHeight = MacImageGalleryLayout.height(
                inlineImages: [image, secondImage],
                refs: [],
                maxWidth: content.bodyTextWidth
            )
            let compactStack = abs(frame.height - expectedStackHeight) < 0.5
            let result = cell.openFirstImageForRegression()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                let opened = openedCount == 2 && openedFirstSize == image.size
                let passed = opened
                    && result.found
                    && result.hitTested
                    && separate
                    && compactStack
                    && pureImageNoBubble
                    && upperClamp
                    && lowerClamp
                    && zoomed
                    && imageClickPreserved
                    && backdropCloses
                    && captureOK
                    && frame.width > 0
                    && frame.height > 0
                NSLog(
                    "[image-preview-regression] click=%d items=%d nativeButton=%d hitTest=%d separate=%d compactStack=%d pureNoBubble=%d upperClamp=%d lowerClamp=%d zoomed=%d imageClick=%d backdropClose=%d capture=%d frame=%.0fx%.0f passed=%d",
                    opened ? 1 : 0,
                    openedCount,
                    result.found ? 1 : 0,
                    result.hitTested ? 1 : 0,
                    separate ? 1 : 0,
                    compactStack ? 1 : 0,
                    pureImageNoBubble ? 1 : 0,
                    upperClamp ? 1 : 0,
                    lowerClamp ? 1 : 0,
                    zoomed ? 1 : 0,
                    imageClickPreserved ? 1 : 0,
                    backdropCloses ? 1 : 0,
                    captureOK ? 1 : 0,
                    frame.width,
                    frame.height,
                    passed ? 1 : 0
                )
                window.close()
                NSApp.terminate(nil)
            }
        }
    }

    func runHTMLArtifactRegression() {
        func encoded(_ ref: ContentRef) -> [String: AnyCodable] {
            var value: [String: AnyCodable] = [
                "type": AnyCodable(ref.type),
                "id": AnyCodable(ref.id),
                "mimeType": AnyCodable(ref.mimeType),
                "size": AnyCodable(ref.size),
            ]
            if let caption = ref.caption { value["caption"] = AnyCodable(caption) }
            if let name = ref.name { value["name"] = AnyCodable(name) }
            return value
        }

        let first = ContentRef(
            type: "content_ref", id: "html-first", mimeType: "text/html", size: 11_688,
            caption: "Reviewee Review Generation", name: "reviewee-gen.html",
            width: nil, height: nil
        )
        let second = ContentRef(
            type: "content_ref", id: "html-second", mimeType: "text/html", size: 14_847,
            caption: "Reviewee Merchant Email Plan", name: "email-plan.html",
            width: nil, height: nil
        )
        let sid = "html-artifact-regression"
        let normal = TurnSpineProjection.project([
            ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("build reports")]),
            ChatMessage(type: "agent_message", seq: 2, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("Both reports are ready.")]),
            ChatMessage(type: "idle", seq: 3, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["turnArtifacts": AnyCodable([encoded(first), encoded(second), encoded(first)])]),
        ])
        let terminal = TurnSpineProjection.project([
            ChatMessage(type: "user_message", seq: 4, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("terminal report")]),
            ChatMessage(type: "agent_message", seq: 5, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("Draft report")]),
            ChatMessage(type: "turn_status", seq: 6, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["draft": AnyCodable(""), "action": AnyCodable(["type": "failed", "payload": [:]])]),
            ChatMessage(type: "idle", seq: 7, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["turnArtifacts": AnyCodable([encoded(first)])]),
        ])
        let noReply = TurnSpineProjection.project([
            ChatMessage(type: "user_message", seq: 8, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("no reply report")]),
            ChatMessage(type: "system_message", seq: 9, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["kind": AnyCodable("no_reply")]),
            ChatMessage(type: "idle", seq: 10, sessionId: sid, deviceId: "d", timestamp: nil,
                        payload: ["turnArtifacts": AnyCodable([encoded(second)])]),
        ])

        guard let normalMessage = normal.first(where: { $0.type == "agent_message" }),
              let terminalMessage = terminal.first(where: { $0.type == "turn_status" }),
              let noReplyMessage = noReply.first(where: { $0.type == "system_message" }) else {
            NSLog("[html-artifact-regression] projection-missing")
            NSApp.terminate(nil)
            return
        }

        let width: CGFloat = 720
        let normalContent = MacChatBubbleContentBuilder.make(
            message: normalMessage, sessionId: sid, agent: "pi", documentWidth: width
        )
        let plainMessage = ChatMessage(
            type: "agent_message", seq: 11, sessionId: sid, deviceId: "d", timestamp: nil,
            payload: ["content": AnyCodable("Both reports are ready.")]
        )
        let plainContent = MacChatBubbleContentBuilder.make(
            message: plainMessage, sessionId: sid, agent: "pi", documentWidth: width
        )
        let frozenContent = MacChatBubbleContentBuilder.live(
            card: MessageStore.SessionCard(text: terminalMessage.interruptedDraft ?? "", action: nil),
            sessionId: sid,
            agent: "pi",
            documentWidth: width,
            traceSeq: terminalMessage.seq,
            steps: 0,
            frozen: true,
            attachments: terminalMessage.contentRefAttachments
        )
        let noReplyContent = MacChatBubbleContentBuilder.make(
            message: noReplyMessage, sessionId: sid, agent: "pi", documentWidth: width
        )

        var openedID: String?
        let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        cell.configure(
            content: normalContent,
            renderKey: "html-artifact-regression",
            documentWidth: width,
            sessionMode: .auto,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { _ in },
            onOpenHTMLArtifact: { openedID = $0.id },
            onHeightInvalidated: {}
        )
        let artifactHeight = cell.configuredHeight()
        cell.frame.size.height = artifactHeight
        cell.layoutSubtreeIfNeeded()
        let captureOK = cell.captureHTMLArtifactCard(to: "/tmp/kraki-html-two-cards.png")
        let secondOpenOK = cell.openHTMLArtifact(id: second.id) && openedID == second.id

        cell.prepareForReuse()
        cell.configure(
            content: plainContent,
            renderKey: "html-artifact-regression-plain",
            documentWidth: width,
            sessionMode: .auto,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { _ in },
            onOpenHTMLArtifact: { _ in },
            onHeightInvalidated: {}
        )
        let plainHeight = cell.configuredHeight()
        let heightDelta = artifactHeight - plainHeight
        let allOK = normalContent.htmlArtifacts.map(\.id) == [first.id, second.id]
            && frozenContent.htmlArtifacts.map(\.id) == [first.id]
            && noReplyContent.htmlArtifacts.map(\.id) == [second.id]
            && abs(heightDelta - 120) < 0.5
            && cell.htmlArtifactCount == 0
            && secondOpenOK
            && captureOK
        NSLog(
            "[html-artifact-regression] allOK=%d normal=%d frozen=%d noReply=%d heightDelta=%.1f reuseCount=%d secondOpen=%d capture=%d",
            allOK ? 1 : 0,
            normalContent.htmlArtifacts.count,
            frozenContent.htmlArtifacts.count,
            noReplyContent.htmlArtifacts.count,
            heightDelta,
            cell.htmlArtifactCount,
            secondOpenOK ? 1 : 0,
            captureOK ? 1 : 0
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    func runVoiceTranscriptRegression() {
        let existingDraft = "Existing typed draft"
        let samples = [
            "Requesting microphone access…",
            "Listening…  ⌥ Space to finish",
            "A short live transcript that updates while voice input is recording.",
            String(repeating: "This longer transcript verifies an eight-line scroller-free viewport and bottom anchoring without recursive AppKit layout. ", count: 14),
        ]
        func transcriptPieces(_ voice: String) -> [MacComposerVoiceTranscriptView.Piece] {
            [(VoiceDraftMerger.merge(existing: existingDraft, final: voice), 1)]
        }
        func voiceOnlyPieces(_ voice: String) -> [MacComposerVoiceTranscriptView.Piece] {
            [(voice, 1)]
        }
        func descendants(of view: NSView) -> [NSView] {
            view.subviews.flatMap { [$0] + descendants(of: $0) }
        }
        let host = NSHostingView(
            rootView: AnyView(
                MacComposerVoiceTranscript(
                    pieces: transcriptPieces(samples[0]),
                    revision: "0"
                )
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 560)
            )
        )
        let window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 600, height: 180),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        host.frame = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 600, height: 180)

        let layoutProbe = MacComposerVoiceTranscriptView(frame: NSRect(x: 0, y: 0, width: 560, height: 18))
        _ = layoutProbe.update(pieces: transcriptPieces(samples[0]), width: 560)
        _ = layoutProbe.update(pieces: transcriptPieces(samples[3]), width: 560)
        let dynamicLongHeight = layoutProbe.intrinsicContentSize.height
        let surfaceHost = NSHostingView(
            rootView: AnyView(
                HStack(spacing: 12) {
                    MacComposerVoiceTranscript(
                        pieces: transcriptPieces(samples[3]),
                        revision: "surface-long"
                    )
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(width: 38, height: 32)
                }
                .padding(.leading, 18)
                .padding(.trailing, 12)
                .padding(.vertical, 4)
                .frame(width: 500, alignment: .leading)
            )
        )
        let surfaceWindow = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 500, height: 220),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        surfaceWindow.contentView = surfaceHost
        surfaceHost.frame = surfaceWindow.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 500, height: 220)
        surfaceHost.layoutSubtreeIfNeeded()
        let started = CACurrentMediaTime()
        for round in 0..<200 {
            let index = round % samples.count
            host.rootView = AnyView(
                MacComposerVoiceTranscript(pieces: transcriptPieces(samples[index]), revision: "\(round)")
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: 560)
            )
            host.layoutSubtreeIfNeeded()
        }
        let appendController = KrakiVoiceInputController()
        appendController.debugApplyPartial("The first spoken segment is complete and should remain")
        appendController.debugApplyPartial("the second segment")
        let appendedPartial = appendController.rawText
        let appendedFinal = appendController.debugResolvedFinalText(
            "the corrected second segment",
            gatewayRawText: "the second segment"
        )
        NSLog(
            "[voice-append-regression] partialOK=%d finalOK=%d partialLen=%d finalLen=%d",
            appendedPartial == "The first spoken segment is complete and should remain the second segment" ? 1 : 0,
            appendedFinal == "The first spoken segment is complete and should remain the corrected second segment" ? 1 : 0,
            appendedPartial.count,
            appendedFinal.count
        )
        let prefixPreserved = descendants(of: host)
            .compactMap { $0 as? MacComposerVoiceTranscriptView }
            .first?.debugAttributedText.string.hasPrefix(existingDraft) == true
        let chineseStream = Array("\u{73B0}\u{5728}\u{5F00}\u{59CB}\u{6D4B}\u{8BD5}\u{4E2D}\u{6587}\u{8BED}\u{97F3}\u{9010}\u{5B57}\u{6D41}\u{5F0F}\u{663E}\u{793A}\u{5E94}\u{8BE5}\u{8FDE}\u{7EED}\u{4FDD}\u{7559}\u{5B8C}\u{6574}\u{4E0A}\u{4E0B}\u{6587}\u{800C}\u{4E0D}\u{662F}\u{6BCF}\u{6B21}\u{53EA}\u{5269}\u{6700}\u{540E}\u{4E00}\u{4E2A}\u{5B57}")
        var minimumStreamingWidth = CGFloat.greatestFiniteMagnitude
        var minimumVisibleCharacters = Int.max
        var streamingCollapsed = false
        for count in 1...chineseStream.count {
            let streamed = String(chineseStream.prefix(count))
            host.rootView = AnyView(
                MacComposerVoiceTranscript(pieces: voiceOnlyPieces(streamed), revision: "cjk-\(count)")
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: 560)
            )
            host.layoutSubtreeIfNeeded()
            let currentViews = descendants(of: host)
            guard let current = currentViews.compactMap({ $0 as? MacComposerVoiceTranscriptView }).first else {
                streamingCollapsed = true
                continue
            }
            minimumStreamingWidth = min(minimumStreamingWidth, current.bounds.width)
            let visibleRange = current.debugVisibleRange(
                width: current.bounds.width,
                height: current.bounds.height
            )
            let visibleCharacters = (current.debugAttributedText.string as NSString)
                .substring(with: NSRange(location: visibleRange.location, length: visibleRange.length))
                .count
            if count >= 4 {
                minimumVisibleCharacters = min(minimumVisibleCharacters, visibleCharacters)
                if current.bounds.width < 100 || visibleCharacters < 4 {
                    streamingCollapsed = true
                }
            }
        }
        let elapsed = (CACurrentMediaTime() - started) * 1_000
        let allViews = descendants(of: host)
        let transcriptView = allViews.compactMap { $0 as? MacComposerVoiceTranscriptView }.first
        let scrollViewCount = allViews.compactMap { $0 as? NSScrollView }.count
        let rendered = transcriptView?.debugAttributedText
        let renderedFont = rendered?.length ?? 0 > 0
            ? rendered?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
            : nil
        let appearancePieces: [MacComposerVoiceTranscriptView.Piece] = [
            ("Streaming voice transcript", 1),
            (" lookahead", 0.30),
        ]
        let lightText = MacComposerVoiceTranscriptView.debugAttributedText(
            pieces: appearancePieces,
            appearance: NSAppearance(named: .aqua)!
        )
        let darkText = MacComposerVoiceTranscriptView.debugAttributedText(
            pieces: appearancePieces,
            appearance: NSAppearance(named: .darkAqua)!
        )
        let lightColor = lightText.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        let darkColor = darkText.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        let lightBrightness = lightColor?.usingColorSpace(.deviceRGB)?.brightnessComponent ?? 1
        let darkBrightness = darkColor?.usingColorSpace(.deviceRGB)?.brightnessComponent ?? 0
        let adaptiveColor = lightBrightness < 0.25 && darkBrightness > 0.75
        let lookaheadAlpha = darkText.attribute(
            .foregroundColor,
            at: max(0, darkText.length - 1),
            effectiveRange: nil
        ) as? NSColor
        let lookaheadOpacityOK = abs((lookaheadAlpha?.alphaComponent ?? 0) - 0.30) < 0.01
        NSLog(
            "[voice-transcript-regression] rounds=200 ms=%.3f pureCoreText=%d scrollViews=%d prefixOK=%d font=%.1f adaptiveColor=%d lookaheadOpacity=%d lightBrightness=%.3f darkBrightness=%.3f dynamicHeight=%.1f dynamicHeightOK=%d surfaceHeight=%.1f surfaceHeightOK=%d height=%.1f",
            elapsed,
            transcriptView == nil ? 0 : 1,
            scrollViewCount,
            prefixPreserved ? 1 : 0,
            renderedFont?.pointSize ?? 0,
            adaptiveColor ? 1 : 0,
            lookaheadOpacityOK ? 1 : 0,
            lightBrightness,
            darkBrightness,
            dynamicLongHeight,
            dynamicLongHeight >= 140 ? 1 : 0,
            surfaceHost.fittingSize.height,
            surfaceHost.fittingSize.height >= 140 ? 1 : 0,
            transcriptView?.bounds.height ?? 0
        )
        NSLog(
            "[voice-streaming-regression] cjkSteps=%d collapsed=%d minWidth=%.1f minVisible=%d",
            chineseStream.count,
            streamingCollapsed ? 1 : 0,
            minimumStreamingWidth.isFinite ? minimumStreamingWidth : 0,
            minimumVisibleCharacters == Int.max ? 0 : minimumVisibleCharacters
        )
        MacComposerPasteFocusRegression.run { result in
            NSLog(
                "[composer-paste-focus-regression] passed=%d teardown=%d replacement=%d binding=%d firstResponder=%d placeholderHidden=%d placeholderRestored=%d imeDraft=%d imeRequested=%d imeFocus=%d externalCleared=%d",
                result["passed"] as? Bool == true ? 1 : 0,
                result["teardownPreserved"] as? Bool == true ? 1 : 0,
                result["replacementPreserved"] as? Bool == true ? 1 : 0,
                result["pasteRestoredBinding"] as? Bool == true ? 1 : 0,
                result["replacementBecameFirstResponder"] as? Bool == true ? 1 : 0,
                result["placeholderHiddenForNativeText"] as? Bool == true ? 1 : 0,
                result["placeholderRestoredAfterClear"] as? Bool == true ? 1 : 0,
                result["imeDraftCommitted"] as? Bool == true ? 1 : 0,
                result["imeRequestedFocus"] as? Bool == true ? 1 : 0,
                result["imeRetainedFirstResponder"] as? Bool == true ? 1 : 0,
                result["externalCleared"] as? Bool == true ? 1 : 0
            )
            window.contentView = nil
            NSApp.terminate(nil)
        }
    }
}
#endif
