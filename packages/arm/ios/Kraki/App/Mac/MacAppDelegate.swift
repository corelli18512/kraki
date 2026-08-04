/// MacAppDelegate — Bridges the AppKit application lifecycle to our
/// SwiftUI App scene. We use this for a small handful of things SwiftUI
/// doesn't expose directly:
///
///   - Closing the last window should HIDE the app rather than quit it
///     (we have a MenuBarExtra to live in). Use ⌘Q to actually quit.
///   - Catch `applicationWillTerminate` for a final flush (AppState
///     already observes the NotificationCenter event; this is a
///     belt-and-braces redundancy).
///   - Apply a dock badge label when AppState's unread-aggregate changes.

#if os(macOS)
import AppKit
import SwiftUI

/// A flipped (origin top-left) container that paints the white canvas +
/// rounded card backgrounds itself, then hosts the title labels and body
/// text views as real subviews. Because the container is flipped and the
/// text views are flipped too, the framework places everything correctly
/// with NO manual CGContext transforms - which previously drew text
/// upside down. We render it via display()+cacheDisplay inside a borderless
/// window that is never ordered front, so nothing ever appears on screen.
private final class FlippedContainerView: NSView {
    override var isFlipped: Bool { true }
    var cardRects: [NSRect] = []
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        for r in cardRects {
            NSColor(white: 0.96, alpha: 1).setFill()
            NSBezierPath(roundedRect: r, xRadius: 12, yRadius: 12).fill()
            NSColor(white: 0.85, alpha: 1).setStroke()
            let border = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5),
                                      xRadius: 12, yRadius: 12)
            border.lineWidth = 1
            border.stroke()
        }
    }
}

@MainActor
final class MacAppDelegate: NSObject, NSApplicationDelegate {

    /// User opted to keep the app running in the menu bar when the
    /// last window closes? Default YES — surfacing it in Preferences
    /// later (m3-mac-prefs-general).
    @AppStorage("mac.keepRunningInMenuBar")
    private var keepRunningInMenuBar: Bool = true

    func applicationWillFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KRAKI_HTML_ARTIFACT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runHTMLArtifactRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_IMAGE_PREVIEW_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runImagePreviewRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CORETEXT_SCROLL_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCoreTextScrollBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CORETEXT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCoreTextBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CODE_HIGHLIGHT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCodeHighlightBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CODE_HIGHLIGHT_UPGRADE_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCodeHighlightUpgradeBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_VOICE_TRANSCRIPT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runVoiceTranscriptRegression() }
        }
        if ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1" {
            // A native automation host is a background rendering/control
            // process, not a foreground desktop app. Prohibited prevents it
            // from becoming active or owning the menu bar/Dock while its
            // SwiftUI view tree remains available for semantic automation.
            NSApp.setActivationPolicy(.prohibited)
        }
        #endif
        // Single-window app: kill window tabbing before any window is
        // created/restored. SwiftUI persists a "Show Tab Bar" toggle
        // (NSWindowTabbingShoudShowTabBarKey-… — Apple's own misspelling)
        // per WindowGroup, which otherwise restores a Safari-style tab bar
        // on launch even with one window and tabbingMode = .disallowed.
        // Clearing it here, before window restoration, prevents that.
        NSWindow.allowsAutomaticWindowTabbing = false
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix("NSWindowTabbingShoudShowTabBarKey") {
            defaults.set(false, forKey: key)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        let nativeAutomation = ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1"
        if !nativeAutomation {
            NSApp.setActivationPolicy(.regular)
        }
        #else
        NSApp.setActivationPolicy(.regular)
        #endif

        // Remove the "File" and "Window" menus. SwiftUI synthesizes both,
        // but this app has no file concept (New Session lives under
        // Session) and is single-window. SwiftUI builds the main menu
        // during launch, so we strip them on the next runloop tick and
        // again whenever the app reactivates.
        removeUnwantedMenus()
        DispatchQueue.main.async { [weak self] in self?.removeUnwantedMenus() }

        #if DEBUG
        if nativeAutomation {
            ensureMainWindowLaidOutOffscreen()
        }
        // Headless screenshot affordance (dev-local only). We do NOT try
        // to make ScreenCaptureKit grab a background window — a SwiftUI
        // WindowGroup launched without activation never gets a real
        // window-server surface, so SCK only ever sees a tiny placeholder.
        //
        // Instead we render the window's *view tree* directly into a
        // bitmap via `bitmapImageRepForCachingDisplay(in:)`. That draws
        // the layer hierarchy itself — it works even when the window is
        // off-screen and never activated, and it never touches focus, the
        // Dock, or the foreground app. A lightweight file-watch lets an
        // external tool request a shot by touching a sentinel file.
        let environment = ProcessInfo.processInfo.environment
        let devLocal = environment["KRAKI_DEV_LOCAL"] == "1"
        let headlessShot = environment["KRAKI_HEADLESS_SHOT"] == "1"
        if devLocal {
            // The shot watcher is harmless in normal viewing — it only
            // renders on an explicit file trigger.
            startHeadlessShotWatcher()
        }
        if headlessShot {
            ensureMainWindowLaidOutOffscreen()
        } else {
            let automatedWindowMode = nativeAutomation || [
                "KRAKI_HTML_ARTIFACT_BENCH",
                "KRAKI_IMAGE_PREVIEW_BENCH",
                "KRAKI_CORETEXT_SCROLL_BENCH",
                "KRAKI_CORETEXT_BENCH",
                "KRAKI_CODE_HIGHLIGHT_BENCH",
                "KRAKI_CODE_HIGHLIGHT_UPGRADE_BENCH",
                "KRAKI_VOICE_TRANSCRIPT_BENCH",
                "KRAKI_RENDER_BUBBLE_TEST",
                "KRAKI_RENDER_CHAT_TEST",
                "KRAKI_RENDER_COMPOSER_TEST",
                "KRAKI_E2E_SELFTEST",
                "KRAKI_MAC_CHAT_SNAPSHOT_TEST",
                "KRAKI_MAC_CHAT_PERF_PAGE",
            ].contains { environment[$0] == "1" }
            if !automatedWindowMode {
                // Any ordinary foreground Debug launch may start with the
                // tiny SwiftUI placeholder surface. Inflate only when needed;
                // this covers both production-relay Dev and local-relay Dev.
                inflateAndCenterMainWindowOnce()
            }
        }

        if ProcessInfo.processInfo.environment["KRAKI_RENDER_BUBBLE_TEST"] == "1" {
            renderBubbleTestToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_RENDER_CHAT_TEST"] == "1" {
            renderChatListToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_RENDER_COMPOSER_TEST"] == "1" {
            renderComposerStatesToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_E2E_SELFTEST"] == "1" {
            renderE2ESelfTestToPNG()
        }
        #endif
    }

    #if DEBUG
    private func runImagePreviewRegression() {
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
            bubbleWidth: 580
        )
        var openedCount = 0
        var openedFirstSize = NSSize.zero
        let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        cell.configure(
            content: content,
            renderKey: "image-preview-regression",
            documentWidth: width,
            sessionMode: .discuss,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { selection in
                openedCount = selection.items.count
                openedFirstSize = selection.items.first?.image.size ?? .zero
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
            bubbleWidth: 580
        )
        let pureImageCell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        pureImageCell.configure(
            content: pureImageContent,
            renderKey: "image-preview-pure-regression",
            documentWidth: width,
            sessionMode: .discuss,
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

    private func runHTMLArtifactRegression() {
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
            sessionMode: .discuss,
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
            sessionMode: .discuss,
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

    private func runVoiceTranscriptRegression() {
        let existingDraft = "Existing typed draft"
        let samples = [
            "Requesting microphone access…",
            "Listening…  ⌥ Space to finish",
            "A short live transcript that updates while voice input is recording.",
            String(repeating: "This longer transcript verifies an eight-line scroller-free viewport and bottom anchoring without recursive AppKit layout. ", count: 14),
        ]
        func transcriptText(_ voice: String) -> AttributedString {
            var text = AttributedString(VoiceDraftMerger.merge(existing: existingDraft, final: voice))
            text.font = .system(size: 15)
            text.foregroundColor = NSColor.labelColor
            return text
        }
        func voiceOnlyText(_ voice: String) -> AttributedString {
            var text = AttributedString(voice)
            text.font = .system(size: 15)
            text.foregroundColor = NSColor.labelColor
            return text
        }
        func descendants(of view: NSView) -> [NSView] {
            view.subviews.flatMap { [$0] + descendants(of: $0) }
        }
        let host = NSHostingView(
            rootView: AnyView(
                MacComposerVoiceTranscript(
                    text: transcriptText(samples[0]),
                    revision: "0"
                )
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

        let started = CACurrentMediaTime()
        for round in 0..<200 {
            let index = round % samples.count
            host.rootView = AnyView(
                MacComposerVoiceTranscript(text: transcriptText(samples[index]), revision: "\(round)")
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
        let chineseStream = Array("现在开始测试中文语音逐字流式显示应该连续保留完整上下文而不是每次只剩最后一个字")
        var minimumStreamingWidth = CGFloat.greatestFiniteMagnitude
        var minimumVisibleCharacters = Int.max
        var streamingCollapsed = false
        for count in 1...chineseStream.count {
            let streamed = String(chineseStream.prefix(count))
            host.rootView = AnyView(
                MacComposerVoiceTranscript(text: voiceOnlyText(streamed), revision: "cjk-\(count)")
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
        let renderedColor = rendered?.length ?? 0 > 0
            ? rendered?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
            : nil
        let labelColorMatch = renderedColor?.usingColorSpace(.deviceRGB)
            == NSColor.labelColor.usingColorSpace(.deviceRGB)
        NSLog(
            "[voice-transcript-regression] rounds=200 ms=%.3f pureCoreText=%d scrollViews=%d prefixOK=%d font=%.1f labelColor=%d height=%.1f",
            elapsed,
            transcriptView == nil ? 0 : 1,
            scrollViewCount,
            prefixPreserved ? 1 : 0,
            renderedFont?.pointSize ?? 0,
            labelColorMatch ? 1 : 0,
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
                "[composer-paste-focus-regression] passed=%d teardown=%d replacement=%d binding=%d firstResponder=%d imeDraft=%d imeRequested=%d imeFocus=%d externalCleared=%d",
                result["passed"] as? Bool == true ? 1 : 0,
                result["teardownPreserved"] as? Bool == true ? 1 : 0,
                result["replacementPreserved"] as? Bool == true ? 1 : 0,
                result["pasteRestoredBinding"] as? Bool == true ? 1 : 0,
                result["replacementBecameFirstResponder"] as? Bool == true ? 1 : 0,
                result["imeDraftCommitted"] as? Bool == true ? 1 : 0,
                result["imeRequestedFocus"] as? Bool == true ? 1 : 0,
                result["imeRetainedFirstResponder"] as? Bool == true ? 1 : 0,
                result["externalCleared"] as? Bool == true ? 1 : 0
            )
            window.contentView = nil
            NSApp.terminate(nil)
        }
    }

    private func runCoreTextScrollBenchmark() {
        let width: CGFloat = 900
        let viewportHeight: CGFloat = 720
        let base = """
        ## Render artifact
        A normal assistant response with **bold**, *italic*, `inline code`, and a [link](https://example.com).

        > Viewport anchors remain stable while history is prepended.

        ```swift
        let artifact = await renderer.layout(markdown, width: width)
        cell.bind(artifact)
        ```
        """
        let table = """

        | Stage | Thread | Result |
        | --- | --- | --- |
        | Markdown | background | cached |
        | CoreText | background | exact geometry |
        | Bind | main | sub-millisecond |
        """
        var items: [MacChatItem] = []
        for index in 0..<120 {
            let body = base
                + (index % 5 == 0 ? table : "")
                + String(repeating: "\nProduction-shaped chat text wraps across the available bubble width.", count: index % 7)
            let message = ChatMessage(
                type: index.isMultiple(of: 4) ? "user_message" : "agent_message",
                seq: index + 1,
                sessionId: "coretext-scroll-bench",
                deviceId: nil,
                timestamp: nil,
                payload: ["content": AnyCodable(body)]
            )
            items.append(MacChatItem(
                seq: index + 1,
                key: "bench-\(index)",
                signature: "r1",
                estimatedHeight: 220,
                visibleCharacterCount: body.utf8.count,
                makeContent: {
                    MacChatBubbleContentBuilder.make(
                        message: message,
                        sessionId: "coretext-scroll-bench",
                        agent: "pi",
                        documentWidth: width
                    )
                }
            ))
        }

        let liveBase = "Streaming response "
        func liveItem(_ revision: Int) -> MacChatItem {
            let text = liveBase + String(repeating: "token ", count: revision + 1)
            let card = MessageStore.SessionCard(text: text, action: nil)
            return MacChatItem(
                seq: 10_000,
                key: "__live__",
                signature: "live-\(revision)",
                estimatedHeight: 72 + CGFloat(revision / 12) * 18,
                visibleCharacterCount: text.utf8.count,
                makeContent: {
                    MacChatBubbleContentBuilder.live(
                        card: card,
                        sessionId: "coretext-scroll-bench",
                        agent: "pi",
                        documentWidth: width,
                        traceSeq: 10_000,
                        steps: 1
                    )
                }
            )
        }
        items.append(liveItem(0))

        let scrollView = MacChatScrollView(
            frame: NSRect(x: 0, y: 0, width: width, height: viewportHeight)
        )
        scrollView.chatDocumentView.apply(
            contents: items,
            documentWidth: width,
            sessionMode: .discuss
        )
        scrollView.contentView.frame = scrollView.bounds
        scrollView.layoutSubtreeIfNeeded()

        // Warm and establish exact geometry through the production document/cell
        // path before measuring steady-state reuse. Each pass remains limited to
        // one configuration invocation, just like the live viewport filler.
        let warmStart = CACurrentMediaTime()
        for index in items.indices {
            let y = CGFloat(index) * 220
            scrollView.contentView.bounds.origin.y = max(-scrollView.contentInsets.top, y)
            _ = scrollView.chatDocumentView.updateVisibleCells(
                in: scrollView.contentView.bounds,
                runwayOverride: 0,
                allowColdContent: true,
                maxConfigurations: 1
            )
            _ = scrollView.chatDocumentView.commitWarmedHeights()
        }
        let warmMs = (CACurrentMediaTime() - warmStart) * 1_000

        var maxScrollMs: Double = 0
        var totalScrollMs: Double = 0
        var maxPlaceholder = 0
        var maxCoreText = 0
        var maxTextKit = 0
        var moved = 0
        for round in 0..<240 {
            let direction = (round / 40).isMultiple(of: 2) ? "up" : "down"
            let started = CACurrentMediaTime()
            let result = scrollView.automationScroll(direction: direction, ticks: 3)
            let elapsed = (CACurrentMediaTime() - started) * 1_000
            maxScrollMs = max(maxScrollMs, elapsed)
            totalScrollMs += elapsed
            if abs(result.after - result.before) > 0.5 { moved += 1 }
            let diagnostics = scrollView.chatDocumentView.layoutDiagnostics(
                viewport: scrollView.contentView.bounds
            )
            maxPlaceholder = max(maxPlaceholder, diagnostics["placeholderCount"] as? Int ?? 0)
            maxCoreText = max(maxCoreText, diagnostics["coreTextCellCount"] as? Int ?? 0)
            maxTextKit = max(maxTextKit, diagnostics["textKitCellCount"] as? Int ?? 0)
        }
        var deferredLiveCount = 0
        var maxStreamingScrollMs: Double = 0
        var totalStreamingScrollMs: Double = 0
        scrollView.chatDocumentView.beginScrollInteraction(scrollerKnob: false)
        for round in 1...240 {
            var revisionItems = items
            revisionItems[revisionItems.count - 1] = liveItem(round)
            let started = CACurrentMediaTime()
            if scrollView.chatDocumentView.deferLiveSnapshotIfNeeded(
                contents: revisionItems,
                documentWidth: width,
                sessionMode: .discuss
            ) {
                deferredLiveCount += 1
            }
            let minimumY = -scrollView.contentInsets.top
            let maximumY = max(
                minimumY,
                scrollView.chatDocumentView.frame.height - scrollView.contentView.bounds.height
            )
            let progress = CGFloat(round % 80) / 79
            scrollView.contentView.bounds.origin.y = minimumY + (maximumY - minimumY) * progress
            _ = scrollView.chatDocumentView.updateVisibleCells(
                in: scrollView.contentView.bounds,
                runwayOverride: 0
            )
            let elapsed = (CACurrentMediaTime() - started) * 1_000
            maxStreamingScrollMs = max(maxStreamingScrollMs, elapsed)
            totalStreamingScrollMs += elapsed
        }
        scrollView.chatDocumentView.endScrollInteraction(in: scrollView.contentView.bounds)
        NSLog(
            "[streaming-scroll-bench] revisions=240 deferred=%d avgMs=%.3f maxMs=%.3f",
            deferredLiveCount,
            totalStreamingScrollMs / 240,
            maxStreamingScrollMs
        )

        let final = scrollView.chatDocumentView.layoutDiagnostics(
            viewport: scrollView.contentView.bounds
        )
        NSLog(
            "[coretext-scroll-bench] items=%d warmMs=%.3f rounds=240 moved=%d avgScrollMs=%.3f maxScrollMs=%.3f maxPlaceholder=%d maxCoreText=%d maxTextKit=%d finalPlaceholder=%d allocations=%d",
            items.count,
            warmMs,
            moved,
            totalScrollMs / 240,
            maxScrollMs,
            maxPlaceholder,
            maxCoreText,
            maxTextKit,
            final["placeholderCount"] as? Int ?? 0,
            final["visibleCellCount"] as? Int ?? 0
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    private func runCodeHighlightBenchmark() {
        MacMarkdown.codeHighlightCatalogDiagnostics { rows in
            let failures = rows.filter { row in
                if row.contains("sourcePreserved=0") { return true }
                let intentionallyPlain = row.contains("language=text ")
                    || row.contains("language=txt ")
                    || row.contains("language=plaintext ")
                return row.contains("readableColors=1") && !intentionallyPlain
            }
            for row in rows {
                NSLog("[code-highlight-bench] %@", row)
            }
            NSLog(
                "[code-highlight-summary] languages=%d failures=%d",
                rows.count,
                failures.count
            )
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func runCodeHighlightUpgradeBenchmark() {
        let width: CGFloat = 760
        let scrollView = MacChatScrollView(
            frame: NSRect(x: 0, y: 0, width: width, height: 420)
        )
        scrollView.contentView.frame = scrollView.bounds
        let markdown = """
        ```java
        public record Session(String id, boolean active) {
            public boolean isReady() { return active && !id.isBlank(); }
        }
        ```
        """
        let message = ChatMessage(
            type: "agent_message",
            seq: 1,
            sessionId: "code-highlight-upgrade-bench",
            deviceId: nil,
            timestamp: nil,
            payload: ["content": AnyCodable(markdown)]
        )
        let item = MacChatItem(
            seq: 1,
            key: "upgrade-code",
            signature: "cold",
            estimatedHeight: 180,
            visibleCharacterCount: markdown.utf8.count,
            makeContent: {
                MacChatBubbleContentBuilder.make(
                    message: message,
                    sessionId: "code-highlight-upgrade-bench",
                    agent: "pi",
                    documentWidth: width
                )
            }
        )
        scrollView.chatDocumentView.apply(
            contents: [item],
            documentWidth: width,
            sessionMode: .discuss
        )
        scrollView.layoutSubtreeIfNeeded()
        _ = scrollView.chatDocumentView.updateVisibleCells(
            in: scrollView.contentView.bounds,
            runwayOverride: 0,
            allowColdContent: true,
            maxConfigurations: 1
        )
        let initial = provisionalCodeHighlight(in: scrollView)
        let initialState = codeHighlightUpgradeState(in: scrollView)
        scrollView.chatDocumentView.beginScrollInteraction(scrollerKnob: false)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            let duringScroll = self.provisionalCodeHighlight(in: scrollView)
            let duringState = self.codeHighlightUpgradeState(in: scrollView)
            scrollView.chatDocumentView.endScrollInteraction(in: scrollView.contentView.bounds)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                let final = self.provisionalCodeHighlight(in: scrollView)
                let finalState = self.codeHighlightUpgradeState(in: scrollView)
                NSLog(
                    "[code-highlight-upgrade] initial=%d duringScroll=%d final=%d passed=%d initialState=%@ duringState=%@ finalState=%@",
                    initial ? 1 : 0,
                    duringScroll ? 1 : 0,
                    final ? 1 : 0,
                    initial && duringScroll && !final ? 1 : 0,
                    initialState,
                    duringState,
                    finalState
                )
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
    }

    private func provisionalCodeHighlight(in scrollView: MacChatScrollView) -> Bool {
        let diagnostics = scrollView.chatDocumentView.layoutDiagnostics(
            viewport: scrollView.contentView.bounds
        )
        guard let frames = diagnostics["cellFrames"] as? [[String: Any]] else { return false }
        return frames.contains { $0["provisionalCodeHighlight"] as? Bool == true }
    }

    private func codeHighlightUpgradeState(in scrollView: MacChatScrollView) -> String {
        let diagnostics = scrollView.chatDocumentView.layoutDiagnostics(
            viewport: scrollView.contentView.bounds
        )
        return "provisional=\(diagnostics["provisionalContentCount"] ?? -1),active=\(diagnostics["codeHighlightUpgradeActive"] ?? false),pending=\(diagnostics["codeHighlightUpgradePending"] ?? false),generation=\(diagnostics["observedCodeHighlightGeneration"] ?? -1)"
    }

    private func runCoreTextBenchmark() {
        let markdown = """
        # CoreText chat rendering

        This is a production-shaped Markdown bubble with **bold**, *italic*, `inline code`, and a [link](https://example.com).

        - Incremental render spine
        - Cached immutable layout artifact
        - Layer-backed read-only drawing
        - Native link hit regions

        > Existing bubbles remain anchored while exact geometry commits.

        | Pipeline | Renderer | Main-thread bind |
        | --- | --- | --- |
        | Markdown | CoreText artifact | sub-millisecond |
        | Table | Native overlay | cached geometry |

        ```swift
        struct BubbleRenderModel: Sendable {
            let id: String
            let revision: Int
            let markdown: String
        }
        """ + String(repeating: "\nA normal assistant paragraph containing enough text to exercise line wrapping without using TextKit layout.", count: 45)

        let message = ChatMessage(
            type: "agent_message",
            seq: 1,
            sessionId: "coretext-bench",
            deviceId: nil,
            timestamp: nil,
            payload: ["content": AnyCodable(markdown)]
        )
        let width: CGFloat = 760
        let content = MacChatBubbleContentBuilder.make(
            message: message,
            sessionId: "coretext-bench",
            agent: "pi",
            documentWidth: width
        )
        guard let body = content.body else {
            NSLog("[coretext-bench] missing-body")
            NSApp.terminate(nil)
            return
        }
        let key = "coretext-bench|\(body.length)"
        let firstStart = CACurrentMediaTime()
        let first = MacCoreTextLayoutArtifact.cached(
            attributed: body,
            width: content.bodyTextWidth,
            key: key
        )
        let firstMs = (CACurrentMediaTime() - firstStart) * 1_000
        var cacheHitMaxMs: Double = 0
        let hitsStart = CACurrentMediaTime()
        for _ in 0..<100 {
            let hitStart = CACurrentMediaTime()
            _ = MacCoreTextLayoutArtifact.cached(
                attributed: body,
                width: content.bodyTextWidth,
                key: key
            )
            cacheHitMaxMs = max(cacheHitMaxMs, (CACurrentMediaTime() - hitStart) * 1_000)
        }
        let hitsMs = (CACurrentMediaTime() - hitsStart) * 1_000

        let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: width, height: 1))
        let configureStart = CACurrentMediaTime()
        cell.configure(
            content: content,
            renderKey: key,
            documentWidth: width,
            sessionMode: .discuss,
            onTapSteps: { _ in },
            onResolvePermission: { _, _, _ in },
            onAnswerQuestion: { _, _ in },
            onOpenImage: { _ in },
            onOpenHTMLArtifact: { _ in },
            onHeightInvalidated: {}
        )
        let configureMs = (CACurrentMediaTime() - configureStart) * 1_000
        let textKitHeight = MacTextMeasure.height(body, width: content.bodyTextWidth)
        let coreTextBodyHeight = first?.height ?? 0
        let heightDelta = coreTextBodyHeight - textKitHeight
        let height = cell.configuredHeight()
        cell.frame.size.height = height
        cell.layoutSubtreeIfNeeded()
        let drawStart = CACurrentMediaTime()
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: cell.bounds.size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isOpaque = true
        window.backgroundColor = .windowBackgroundColor
        window.contentView = cell
        cell.layoutSubtreeIfNeeded()
        cell.displayIgnoringOpacity(cell.bounds)
        if let rep = cell.bitmapImageRepForCachingDisplay(in: cell.bounds) {
            cell.cacheDisplay(in: cell.bounds, to: rep)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "/tmp/kraki-coretext-bench.png"))
            }
        }
        window.contentView = nil
        let drawMs = (CACurrentMediaTime() - drawStart) * 1_000
        NSLog(
            "[coretext-bench] bytes=%d chars=%d blocks=%d bodyHeight=%.1f textKitHeight=%.1f heightDelta=%.1f totalHeight=%.1f firstMs=%.3f hits100Ms=%.3f hitMaxMs=%.3f configureMs=%.3f drawMs=%.3f coreText=%d",
            markdown.utf8.count,
            body.length,
            first?.blocks.count ?? 0,
            coreTextBodyHeight,
            textKitHeight,
            heightDelta,
            height,
            firstMs,
            hitsMs,
            cacheHitMaxMs,
            configureMs,
            drawMs,
            cell.usesCoreTextBodyFlag ? 1 : 0
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    private func inflateAndCenterMainWindowOnce() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            let builtin = NSScreen.screens.first { screen in
                guard let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
                else { return false }
                return CGDisplayIsBuiltin(num) != 0
            }
            guard let target = NSScreen.screens.first ?? NSScreen.main ?? builtin else { return }
            let vf = target.visibleFrame
            let size = MacLocalConfigStore.shared.constrainedMainWindowSize(to: vf.size)
            let origin = NSPoint(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2)
            for window in NSApp.windows
            where window.styleMask.contains(.titled) && window.contentView != nil {
                let hasUsableVisibleArea = NSScreen.screens.contains { screen in
                    let overlap = window.frame.intersection(screen.visibleFrame)
                    return overlap.width >= 320 && overlap.height >= 240
                }
                if window.frame.width < 800 || window.frame.height < 500 || !hasUsableVisibleArea {
                    window.setFrame(NSRect(origin: origin, size: size), display: true, animate: false)
                }
                window.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }
    #endif

    #if DEBUG
    /// Park the main window off-screen at a sane full size so its view
    /// tree lays out (a background-launched window otherwise stays at a
    /// tiny placeholder frame). Off-screen + no activation = invisible to
    /// the user and steals no focus.
    private func ensureMainWindowLaidOutOffscreen() {
        let target = NSSize(width: 1100, height: 720)
        let offscreenFrame = NSRect(origin: NSPoint(x: -6000, y: 200), size: target)
        var ticks = 0
        let timer = Timer(timeInterval: 0.5, repeats: true) { t in
            ticks += 1
            for window in NSApp.windows where window.styleMask.contains(.titled) && window.contentView != nil {
                if window.frame.size != target || window.frame.minX > -1000 {
                    window.setFrame(offscreenFrame, display: true, animate: false)
                }
            }
            if ticks >= 10 { t.invalidate() }
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private let headlessShotRequestPath = "/tmp/kraki-shot-request"

    /// Watch for a sentinel file; when present, render the main window's
    /// content view to a PNG and delete the sentinel.
    private func startHeadlessShotWatcher() {
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self else { return }
            let fm = FileManager.default
            guard fm.fileExists(atPath: self.headlessShotRequestPath) else { return }
            // Read optional output path from the sentinel contents.
            let requested = (try? String(contentsOfFile: self.headlessShotRequestPath, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            try? fm.removeItem(atPath: self.headlessShotRequestPath)
            let raw = (requested?.isEmpty == false) ? requested! : "/tmp/kraki-shot.png"
            let sheetOnly = raw.hasPrefix("sheet:")
            let out = sheetOnly ? String(raw.dropFirst("sheet:".count)) : raw
            self.renderWindowToPNG(path: out, sheetOnly: sheetOnly)
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private func renderMainWindowToPNG(path: String) {
        renderWindowToPNG(path: path, sheetOnly: false)
    }

    private func renderWindowToPNG(path: String, sheetOnly: Bool) {
        let candidates = NSApp.windows.filter {
            $0.contentView != nil && $0.frame.width > 300 && $0.frame.height > 200
        }
        let selected: NSWindow? = {
            if sheetOnly {
                return candidates.first(where: { $0.sheetParent != nil })
                    ?? candidates.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            }
            return candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        }()
        guard let window = selected,
              let view = window.contentView else {
            NSLog("[headless-shot] no suitable window/contentView")
            return
        }
        // In-process renders (cacheDisplay) cannot reproduce NSVisualEffectView
        // vibrancy — it's composited by the window server, so it captures as
        // blank white. Our seamless-flat design is solid-color anyway, so for
        // the capture we hide the effect views and paint the window's solid
        // background (already surfacePrimary) behind them, then restore.
        var hiddenEffectViews: [NSVisualEffectView] = []
        func hideEffects(_ v: NSView) {
            if let fx = v as? NSVisualEffectView, !fx.isHidden {
                fx.isHidden = true
                hiddenEffectViews.append(fx)
            }
            v.subviews.forEach(hideEffects)
        }
        hideEffects(view)
        view.wantsLayer = true
        let priorBG = view.layer?.backgroundColor
        view.layer?.backgroundColor = (window.backgroundColor.usingColorSpace(.deviceRGB) ?? window.backgroundColor).cgColor

        view.layoutSubtreeIfNeeded()
        let bounds = view.bounds
        defer {
            hiddenEffectViews.forEach { $0.isHidden = false }
            view.layer?.backgroundColor = priorBG
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            NSLog("[headless-shot] bitmapImageRepForCachingDisplay returned nil")
            return
        }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            NSLog("[headless-shot] PNG encode failed")
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            NSLog("[headless-shot] wrote %dx%d -> %@", Int(bounds.width), Int(bounds.height), path)
        } catch {
            NSLog("[headless-shot] write failed: %@", error.localizedDescription)
        }
    }

    /// Headless END-TO-END self-test: drives the REAL production data chain
    /// (MessageStore → MessageProvider.currentWindow → ChatViewModel.filteredMessages
    /// → TurnSpineProjection.project → displayMessages → MacChatView →
    /// MacChatScrollView → MacChatBubbleCell), then self-captures via cacheDisplay.
    /// No window is shown, no focus is taken, and NO Accessibility/screen-recording
    /// permission is required (cacheDisplay renders the view tree in-process).
    ///
    /// This is the strongest self-test that does not require operator-granted
    /// permissions: it proves the full data→SwiftUI→TextKit rendering pipeline
    /// end-to-end, including the projection rules that collapse turns.
    private func renderE2ESelfTestToPNG() {
        MacMarkdown.prewarmSyntaxHighlighter()
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let width: CGFloat = 760
        let sessionId = "e2e-selftest"
        let deviceId = "dev-e2e"
        let agent = "pi"

        @MainActor func buildAppState() -> AppState {
            let appState = AppState()
            appState.deviceId = deviceId
            // Session.
            let session = SessionInfo(
                id: sessionId, deviceId: deviceId, deviceName: "Mac",
                agent: agent, model: "claude-sonnet-4",
                title: "E2E Self-Test",
                state: .idle, mode: .discuss,
                lastSeq: 8, readSeq: 8, messageCount: 8,
                createdAt: Date(), pinned: false)
            appState.sessionStore.sessions[sessionId] = session
            appState.sessionStore.activeSessionId = sessionId
            appState.sessionStore.loadingSessions.remove(sessionId)

            // Register the owning device as online so the composer renders.
            appState.deviceStore.devices[deviceId] = DeviceSummary(
                id: deviceId, name: "Mac", role: .tentacle, kind: .desktop,
                publicKey: nil, encryptionKey: nil, online: true,
                lastSeen: nil, createdAt: nil)

            // Seed a real message window via the provider so ChatViewModel's
            // currentWindow / windowState paths resolve identically to live use.
            let provider = MessageProvider(appState: appState)
            appState.setMessageProviderForTesting(provider)

            // Build the window directly (matches what a tail fill would produce).
            let msgs: [ChatMessage] = [
                ChatMessage(type: "user_message", seq: 1, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Help me ship the Mac chat.")]),
                ChatMessage(type: "agent_message", seq: 2, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [
                                "content": AnyCodable("""
On it. Here's the plan:## Goal
Render the chat with native TextKit.

- Reuse the iOS bubble
- Add a composer
- Wire the real view model

```swift
let vm = ChatViewModel(sessionId: id, appState: appState)
```

> Make sure focus is never stolen.
""")]),
                ChatMessage(type: "user_message", seq: 3, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Status?")]),
                ChatMessage(type: "agent_message", seq: 4, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [
                                "content": AnyCodable("""
| Phase | Status |
| :--- | :---: |
| Render | done |
| Composer | done |
| Steps | done |
| Images | done |
"""),
                                "steps": AnyCodable(5)]),
                ChatMessage(type: "idle", seq: 5, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [:]),
                ChatMessage(type: "system_message", seq: 8, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Context compacted.")]),
            ]
            appState.messageStore.messages[sessionId] = msgs
            appState.messageStore.windows[sessionId] = .init(topSeq: 1, bottomSeq: 8)
            return appState
        }

        let appState = MainActor.assumeIsolated { buildAppState() }

        // Pre-build the view model so the SwiftUI host renders content
        // immediately (no .task dependency on window attachment).
        let prebuiltVM = MainActor.assumeIsolated {
            let vm = ChatViewModel(sessionId: sessionId, appState: appState)
            vm.refreshMessageCache()
            return vm
        }
        NSLog("[e2e-diag] displayMessages=\(prebuiltVM.displayMessages.count) waiting=\(prebuiltVM.isWaitingForLatestBubble)")

        let render = {
            // Host the REAL MacChatView (SwiftUI) via NSHostingController.
            let view = MacChatView(sessionId: sessionId, prebuiltViewModel: prebuiltVM)
                .environment(appState)
            let host = NSHostingController(rootView: view)
            host.view.frame = NSRect(x: 0, y: 0, width: width, height: 1200)
            host.view.layoutSubtreeIfNeeded()

            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: width, height: 1200),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentViewController = host
            host.view.layoutSubtreeIfNeeded()
            host.view.frame = NSRect(x: 0, y: 0, width: width, height: 1200)
            // Several runloop passes for SwiftUI .task / onChange to settle.
            for delay in [0.3, 0.6, 1.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    host.view.needsLayout = true
                    host.view.layoutSubtreeIfNeeded()
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                let bounds = host.view.bounds
                guard let rep = host.view.bitmapImageRepForCachingDisplay(in: bounds) else {
                    NSLog("[e2e] bitmapRep nil")
                    NSAppearance.current = priorAppearance
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                    return
                }
                host.view.cacheDisplay(in: bounds, to: rep)
                window.contentViewController = nil
                if let data = rep.representation(using: .png, properties: [:]) {
                    let out = "/tmp/kraki-mac-e2e.png"
                    try? data.write(to: URL(fileURLWithPath: out))
                    NSLog("[e2e] wrote %.0fx%.0f -> %@", width, bounds.height, out)
                }
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { render() }
    }

    /// Headless render of every production composer state. Uses real
    /// `MacChatComposer` instances in an off-screen borderless window and exits
    /// automatically; it never orders a window front or takes focus.
    @MainActor
    private func renderComposerStatesToPNG() {
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)
        let width: CGFloat = 760
        let deviceId = "composer-device"

        @MainActor func makeState(
            id: String,
            state: SessionState,
            mode: SessionMode,
            online: Bool,
            connection: ConnectionStatus,
            draft: String
        ) -> AppState {
            let app = AppState()
            app.connectionStatus = connection
            app.hasCompletedInitialConnect = true
            app.sessionStore.sessions[id] = SessionInfo(
                id: id, deviceId: deviceId, deviceName: "Mac Studio",
                agent: "pi", model: "claude-sonnet-4", title: id,
                state: state, mode: mode, lastSeq: 1, readSeq: 1,
                messageCount: 1, createdAt: Date(), pinned: false
            )
            app.sessionStore.setDraft(id, draft)
            app.deviceStore.devices[deviceId] = DeviceSummary(
                id: deviceId, name: "Mac Studio", role: .tentacle, kind: .desktop,
                publicKey: nil, encryptionKey: nil, online: online,
                lastSeen: nil, createdAt: nil
            )
            return app
        }

        let imageData: Data? = {
            let image = NSImage(size: NSSize(width: 96, height: 64))
            image.lockFocus()
            NSColor.systemTeal.setFill()
            NSRect(x: 0, y: 0, width: 96, height: 64).fill()
            NSColor.white.setFill()
            NSBezierPath(ovalIn: NSRect(x: 32, y: 16, width: 32, height: 32)).fill()
            image.unlockFocus()
            guard let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff) else { return nil }
            return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
        }()

        struct Sample {
            let title: String
            let state: AppState
            let composer: MacChatComposer
        }

        let samples: [Sample] = {
            let idle = makeState(id: "Idle prompt", state: .idle, mode: .discuss,
                                 online: true, connection: .connected, draft: "Draft prompt")
            let active = makeState(id: "Active steer", state: .active, mode: .execute,
                                   online: true, connection: .connected, draft: "Steer the current turn")
            let permission = makeState(id: "Permission reason", state: .active, mode: .discuss,
                                       online: true, connection: .connected, draft: "Not safe to modify this file")
            let question = makeState(id: "Question answer", state: .active, mode: .safe,
                                     online: true, connection: .connected, draft: "Preserve the visible anchor")
            let image = makeState(id: "Image attachment", state: .idle, mode: .delegate,
                                  online: true, connection: .connected, draft: "Describe this image")
            let offline = makeState(id: "Device offline", state: .idle, mode: .discuss,
                                    online: false, connection: .connected, draft: "Compose while offline")
            let reconnecting = makeState(id: "Relay reconnecting", state: .idle, mode: .discuss,
                                         online: true, connection: .connecting, draft: "Queued draft")
            let compacting = makeState(id: "Compacting", state: .compacting, mode: .execute,
                                       online: true, connection: .connected, draft: "Steer after compaction")
            let scrollable = makeState(
                id: "Scrollable multiline",
                state: .idle,
                mode: .discuss,
                online: true,
                connection: .connected,
                draft: (1...8).map { "SCROLLABLE-DRAFT line \($0) with enough text to wrap inside the Composer." }.joined(separator: "\n")
            )

            let pendingPermission = PendingPermission(
                id: "perm", sessionId: "Permission reason",
                description: "Write file", toolName: "write_file", args: nil, timestamp: Date())
            let pendingQuestion = PendingQuestion(
                id: "question", sessionId: "Question answer", question: "What should be preserved?",
                choices: nil, timestamp: Date())

            return [
                Sample(title: "Idle prompt", state: idle,
                       composer: MacChatComposer(sessionId: "Idle prompt")),
                Sample(title: "Active steer + stop", state: active,
                       composer: MacChatComposer(sessionId: "Active steer", hasLiveCard: true)),
                Sample(title: "Permission deny reason", state: permission,
                       composer: MacChatComposer(sessionId: "Permission reason", pendingPermission: pendingPermission,
                                                 hasLiveCard: true)),
                Sample(title: "Question freeform answer", state: question,
                       composer: MacChatComposer(sessionId: "Question answer", pendingQuestion: pendingQuestion,
                                                 hasLiveCard: true)),
                Sample(title: "Image preview", state: image,
                       composer: MacChatComposer(sessionId: "Image attachment", initialImageData: imageData)),
                Sample(title: "Device offline hint", state: offline,
                       composer: MacChatComposer(sessionId: "Device offline")),
                Sample(title: "Relay reconnecting hint", state: reconnecting,
                       composer: MacChatComposer(sessionId: "Relay reconnecting")),
                Sample(title: "Compacting + stop", state: compacting,
                       composer: MacChatComposer(sessionId: "Compacting", isCompacting: true, hasLiveCard: true)),
                Sample(title: "Scrollable multiline draft", state: scrollable,
                       composer: MacChatComposer(sessionId: "Scrollable multiline")),
            ]
        }()

        let root = VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                VStack(alignment: .leading, spacing: 6) {
                    Text(sample.title)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 16)
                    sample.composer.environment(sample.state)
                }
            }
        }
        .padding(.vertical, 18)
        .frame(width: width)
        .background(Color.surfacePrimary)

        let host = NSHostingController(rootView: root)
        host.view.frame = NSRect(x: 0, y: 0, width: width, height: 760)
        host.view.layoutSubtreeIfNeeded()
        let fitting = host.view.fittingSize
        let height = max(760, fitting.height)
        host.view.frame = NSRect(x: 0, y: 0, width: width, height: height)

        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
            styleMask: .borderless, backing: .buffered, defer: false
        )
        window.isOpaque = true
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.contentViewController = host

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            host.view.layoutSubtreeIfNeeded()
            func descendants(of view: NSView) -> [NSView] {
                view.subviews.flatMap { [$0] + descendants(of: $0) }
            }
            if let textView = descendants(of: host.view).compactMap({ $0 as? NSTextView }).first(where: {
                $0.string.contains("SCROLLABLE-DRAFT")
            }), let scrollView = textView.enclosingScrollView {
                scrollView.contentView.scroll(to: .zero)
                scrollView.reflectScrolledClipView(scrollView.contentView)
                let before = scrollView.contentView.bounds.minY
                let maximumY = max(0, textView.frame.height - scrollView.contentView.bounds.height)
                scrollView.contentView.scroll(to: NSPoint(x: 0, y: maximumY))
                scrollView.reflectScrolledClipView(scrollView.contentView)
                let after = scrollView.contentView.bounds.minY
                NSLog(
                    "[composer-scroll-regression] viewport=%.1f document=%.1f scroller=%d scrollerObject=%d before=%.1f after=%.1f moved=%d font=%.1f",
                    scrollView.contentView.bounds.height,
                    textView.frame.height,
                    scrollView.hasVerticalScroller ? 1 : 0,
                    scrollView.verticalScroller == nil ? 0 : 1,
                    before,
                    after,
                    abs(after - before) > 0.5 ? 1 : 0,
                    textView.font?.pointSize ?? 0
                )
            } else {
                NSLog("[composer-scroll-regression] missing scrollable text view")
            }
            let bounds = host.view.bounds
            guard let rep = host.view.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSApp.terminate(nil)
                return
            }
            host.view.cacheDisplay(in: bounds, to: rep)
            window.contentViewController = nil
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: "/tmp/kraki-mac-composer-states.png"))
                NSLog("[composer-test] wrote %.0fx%.0f", bounds.width, bounds.height)
            }
            NSAppearance.current = priorAppearance
            NSApp.terminate(nil)
        }
    }

    /// Headless render of the PRODUCTION chat list path (`MacChatScrollView` +
    /// `MacChatBubbleCell`) with mock messages, so the real bubble geometry,
    /// TextKit body, tables, images, action slots, and trace affordances are
    /// validated geometrically without ever showing a window. Mirrors the
    /// zero-focus, borderless-hidden-window capture path used by the bubble
    /// test page.
    private func renderChatListToPNG() {
        MacMarkdown.prewarmSyntaxHighlighter()
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let documentWidth: CGFloat = 760
        let sessionId = "render-chat-test"
        let agent = "pi"

        func msg(_ type: String, seq: Int, content: String) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sessionId, deviceId: nil,
                        timestamp: nil, payload: ["content": AnyCodable(content)])
        }

        let messages: [ChatMessage] = [
            msg("user_message", seq: 1, content: "Can you summarize the chat surface work?"),
            msg("agent_message", seq: 2, content: """
Sure. Here's the summary:

- Replaced the Mac placeholder with a fully functional chat list
- Reused the validated TextKit bubble renderer
- Composer sends input, resolves permissions and questions, aborts turns

```swift
struct MacChatView: View {
    let sessionId: String
}
```

> Note: the production cell path is what this render exercises.
"""),
            msg("user_message", seq: 3, content: "And tables?"),
            msg("agent_message", seq: 4, content: """
| Layer | Status | Owner | Notes |
| :--- | :---: | :--- | :--- |
| Render | done | TextKit | Bubble cells use exact iOS metrics |
| List | done | AppKit | Pagination keeps the visible anchor stable |
| Composer | done | SwiftUI | Floating liquid-glass input capsule |
| Steps | done | Trace | Live semantic refresh boundaries |
| Images | done | Attachments | Lazy refs retry on failure |
| Permissions | done | Card | Actions stay inside the live bubble |
| Questions | done | Card | Long choices expand without truncation |
| Tables | done | TextKit | Wide columns scroll horizontally |
"""),
            msg("system_message", seq: 5, content: "Session resumed from another device."),
        ]

        // One agent message with a live tool action + steps hint, to exercise
        // the action slot + steps button.
        let toolAction = ChatMessage(
            type: "tool_start", seq: 6, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "toolName": AnyCodable("bash"),
                "toolCallId": AnyCodable("tc-demo"),
                "headline": AnyCodable("$ rg -n pulse"),
            ])
        var livePayload: [String: AnyCodable] = ["content": AnyCodable("Inspecting the repository now…")]
        livePayload["steps"] = AnyCodable(3)
        let liveStepsMsg = ChatMessage(
            type: "agent_message", seq: 7, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: livePayload)
        let liveCard = MessageStore.SessionCard(text: "Inspecting the repository now…", action: toolAction)
        let permissionAction = ChatMessage(
            type: "permission", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "id": AnyCodable("perm-demo"),
                "toolName": AnyCodable("write_file"),
                "description": AnyCodable("Write the final ChatView implementation to Kraki/Features/Chat/Mac."),
            ])
        let questionAction = ChatMessage(
            type: "question", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "id": AnyCodable("question-demo"),
                "question": AnyCodable("Which visual behavior should be validated before delivery?"),
                "choices": AnyCodable([
                    "Open history and preserve the visible anchor while paging",
                    "Send a prompt, steer the active turn, then abort it",
                    "Resolve permission and question cards inside the live bubble",
                ]),
            ])
        let failedAction = ChatMessage(
            type: "failed", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: ["message": AnyCodable("Agent process was lost")])

        let render = {
            var contents: [MacChatItem] = []
            for m in messages {
                contents.append(MacChatItem(
                    key: m.id,
                    signature: m.id,
                    estimatedHeight: 120,
                    makeContent: {
                        MacChatBubbleContentBuilder.make(
                            message: m, sessionId: sessionId, agent: agent,
                            documentWidth: documentWidth)
                    }
                ))
            }
            // Steps-enabled bubble (agent with steps hint).
            let stepsContent = MacChatBubbleContentBuilder.make(
                message: liveStepsMsg, sessionId: sessionId, agent: agent,
                documentWidth: documentWidth)
            contents.append(MacChatItem(
                key: liveStepsMsg.id,
                signature: liveStepsMsg.id,
                estimatedHeight: 120,
                makeContent: { stepsContent }
            ))
            // Live card with tool action.
            let liveContent = MacChatBubbleContentBuilder.live(
                card: liveCard, sessionId: sessionId, agent: agent,
                documentWidth: documentWidth, traceSeq: 1, steps: 3)
            contents.append(MacChatItem(
                key: "__live__",
                signature: "live-tool",
                estimatedHeight: 180,
                makeContent: { liveContent }
            ))
            for (key, card, traceSeq) in [
                ("permission", MessageStore.SessionCard(text: "", action: permissionAction), 8),
                ("question", MessageStore.SessionCard(text: "", action: questionAction), 9),
                ("failed", MessageStore.SessionCard(text: "Finalizing the turn…", action: failedAction), 10),
            ] {
                let content = MacChatBubbleContentBuilder.live(
                    card: card, sessionId: sessionId, agent: agent,
                    documentWidth: documentWidth, traceSeq: traceSeq, steps: 1,
                    frozen: key == "failed")
                contents.append(MacChatItem(
                    key: key,
                    signature: key,
                    estimatedHeight: 180,
                    makeContent: { content }
                ))
            }

            let sv = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: documentWidth, height: 1000))
            sv.chatDocumentView.apply(contents: contents, documentWidth: documentWidth, sessionMode: .discuss)
            sv.chatDocumentView.onTapSteps = { _ in }
            sv.chatDocumentView.onResolvePermission = { _, _, _ in }
            sv.chatDocumentView.onAnswerQuestion = { _, _ in }
            let docH = sv.chatDocumentView.bounds.height
            sv.frame = NSRect(x: 0, y: 0, width: documentWidth, height: min(docH, 4000))
            sv.contentView.frame = sv.bounds
            sv.layoutSubtreeIfNeeded()
            sv.scrollToBottom(animated: false)

            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: documentWidth, height: sv.bounds.height),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = sv
            sv.layoutSubtreeIfNeeded()
            sv.displayIgnoringOpacity(sv.bounds)
            let bounds = sv.bounds
            guard let rep = sv.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSLog("[chat-test] bitmapRep nil")
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                return
            }
            sv.cacheDisplay(in: bounds, to: rep)
            window.contentView = nil
            if let data = rep.representation(using: .png, properties: [:]) {
                let out = "/tmp/kraki-mac-chat-test.png"
                try? data.write(to: URL(fileURLWithPath: out))
                NSLog("[chat-test] wrote %.0fx%.0f -> %@", documentWidth, sv.bounds.height, out)
            }
            NSAppearance.current = priorAppearance
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { render() }
    }

    /// Render the macOS bubble test page into a PNG with ZERO user impact:
    /// no window is ever created, ordered front, or shown. Each bubble is
    /// rendered directly into an `NSImage` via `lockFocus` + the text view's
    /// `draw(_:)` — a graphics context is enough for NSTextView to lay out
    /// and paint; it never needs to be attached to a window.
    ///
    /// This is the only approach that provably never steals focus or shows
    /// anything on screen: `orderFront*` (even `orderFrontRegardless` on a
    /// `.nonactivatingPanel`) still puts a window in the window server and
    /// can briefly appear / bounce the Dock. We avoid windows entirely.
    private func renderBubbleTestToPNG() {
        let samples = MacBubbleCatalog.samples
        MacMarkdown.prewarmSyntaxHighlighter()

        // Light appearance so the render is legible regardless of system theme.
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let canvasWidth: CGFloat = 760
        let bodyWidth: CGFloat = 700

        // Pass 1: warm the syntax highlighter by building all attributed
        // strings (Highlightr is lazy + async on first call).
        let _ = samples.map { MacMarkdown.attributed($0.body, cacheKey: "warm:\($0.title)") }

        let render = {
            // Pass 2 (after warmup): build each bubble text view and measure height.
            var cards: [(title: NSAttributedString, tv: MacBubbleTextView, height: CGFloat)] = []
            for s in samples {
                let tv = MacBubbleTextView()
                tv.isEditable = false
                tv.isSelectable = true
                tv.isRichText = true
                tv.drawsBackground = false
                tv.backgroundColor = .clear
                tv.textContainer?.lineFragmentPadding = 0
                tv.textStorage?.setAttributedString(MacMarkdown.attributed(s.body, cacheKey: "page:\(s.title)"))
                tv.textContainer?.size = NSSize(width: bodyWidth, height: 100000)
                tv.layoutManager?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: tv.textStorage?.length ?? 0), actualCharacterRange: nil)
                tv.layoutManager?.ensureLayout(for: tv.textContainer!)
                let used = tv.layoutManager?.usedRect(for: tv.textContainer!) ?? NSRect(x: 0, y: 0, width: bodyWidth, height: 20)
                let h = max(ceil(used.height), 16)
                let titleAttr: NSAttributedString = NSAttributedString(string: s.title, attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                    .foregroundColor: MacBubblePalette.secondary,
                ])
                cards.append((titleAttr, tv, h))
            }

            let padTitle: CGFloat = 18
            let padCard: CGFloat = 14
            let gap: CGFloat = 16
            let topPad: CGFloat = 24
            let heights: [CGFloat] = cards.map { padCard + padTitle + $0.height + padCard }
            let totalHeight = topPad + heights.reduce(0, +) + CGFloat(heights.count - 1) * gap + 24

            // Build a real flipped view hierarchy. The container paints the
            // canvas + card backgrounds; title labels and body text views are
            // subviews positioned in top-down (flipped) coordinates. No manual
            // CGContext flipping - the framework handles NSTextView's own flip
            // correctly, so text renders right-side up.
            let container = FlippedContainerView()
            container.wantsLayer = false
            let cardX: CGFloat = (canvasWidth - bodyWidth) / 2
            var y: CGFloat = topPad
            for (i, c) in cards.enumerated() {
                let cardHeight = heights[i]
                let cardRect = NSRect(x: cardX, y: y, width: bodyWidth, height: cardHeight)

                // Title label (top of card).
                let titleField = NSTextField(labelWithAttributedString: c.title)
                titleField.isBezeled = false
                titleField.drawsBackground = false
                titleField.isEditable = false
                titleField.isSelectable = false
                titleField.frame = NSRect(x: cardX + padCard, y: y + padCard,
                                          width: bodyWidth - padCard * 2, height: 14)

                // Body text view sized to its measured content height.
                let bodyW = bodyWidth - padCard * 2
                c.tv.frame = NSRect(x: cardX + padCard, y: y + padCard + padTitle,
                                    width: bodyW, height: c.height)
                c.tv.textContainer?.size = NSSize(width: bodyW, height: CGFloat.greatestFiniteMagnitude)
                c.tv.layoutManager?.ensureLayout(for: c.tv.textContainer!)

                container.cardRects.append(cardRect)
                container.addSubview(titleField)
                container.addSubview(c.tv)
                y += cardHeight + gap
            }
            container.frame = NSRect(x: 0, y: 0, width: canvasWidth, height: totalHeight)

            // Host the container in a borderless window created with
            // defer:false so it has a backing store immediately. We NEVER call
            // orderFront - the window is never shown, never becomes key/main,
            // so the user's focus is untouched. display() rasterizes the view
            // hierarchy into the window backing; cacheDisplay captures it.
            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: canvasWidth, height: totalHeight),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = container
            container.layoutSubtreeIfNeeded()
            container.displayIgnoringOpacity(container.bounds)

            let bounds = container.bounds
            guard let rep = container.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSLog("[bubble-test] bitmapImageRepForCachingDisplay returned nil")
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                return
            }
            container.cacheDisplay(in: bounds, to: rep)
            // Release the hidden window now that we have the rep.
            window.contentView = nil

            if let data = rep.representation(using: .png, properties: [:]) {
                let out = "/tmp/kraki-mac-bubble-test.png"
                try? data.write(to: URL(fileURLWithPath: out))
                NSLog("[bubble-test] wrote %.0fx%.0f -> %@", canvasWidth, totalHeight, out)
            } else {
                NSLog("[bubble-test] PNG encode failed")
            }
            NSAppearance.current = priorAppearance
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                NSApp.terminate(nil)
            }
        }

        // Wait for Highlightr to warm, then render.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            render()
        }
    }
    #endif

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // false → keep the app alive in the menu bar after the user
        // hits red-circle close on the main window. They can ⌘Q to
        // actually quit, or click "Quit" from the MenuBarExtra menu.
        return !keepRunningInMenuBar
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // SwiftUI can rebuild the main menu on reactivation — re-strip
        // the menus we don't want so they never reappear.
        removeUnwantedMenus()
    }

    /// Removes the synthesized "File" and "Window" menus from the menu
    /// bar. This app has no file concept (New Session lives under Session)
    /// and is single-window, so the standard Window menu is noise.
    private func removeUnwantedMenus() {
        guard let mainMenu = NSApp.mainMenu else { return }
        for title in ["File", "Window"] {
            if let item = mainMenu.items.first(where: { $0.submenu?.title == title }) {
                mainMenu.removeItem(item)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // AppState already registered for NSApplication.willTerminate
        // and flushes its stores. Nothing extra to do here yet.
    }
}

#endif
