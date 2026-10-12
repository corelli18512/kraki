/// Debug-only launch benchmarks: CoreText scrolling, code highlighting, CoreText layout.

#if os(macOS) && DEBUG
import AppKit
import SwiftUI

extension MacAppDelegate {
    func runCoreTextScrollBenchmark() {
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
            sessionMode: .auto
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
        let deferredLiveCount = 0
        var maxStreamingScrollMs: Double = 0
        var totalStreamingScrollMs: Double = 0
        scrollView.chatDocumentView.beginScrollInteraction(scrollerKnob: false)
        for round in 1...240 {
            var revisionItems = items
            revisionItems[revisionItems.count - 1] = liveItem(round)
            let started = CACurrentMediaTime()
            // Live revisions apply while scrolling (no scroll-time deferral).
            scrollView.chatDocumentView.apply(
                contents: revisionItems,
                documentWidth: width,
                sessionMode: .auto
            )
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

    func runCodeHighlightBenchmark() {
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

    func runCodeHighlightUpgradeBenchmark() {
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
            sessionMode: .auto
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

    func provisionalCodeHighlight(in scrollView: MacChatScrollView) -> Bool {
        let diagnostics = scrollView.chatDocumentView.layoutDiagnostics(
            viewport: scrollView.contentView.bounds
        )
        guard let frames = diagnostics["cellFrames"] as? [[String: Any]] else { return false }
        return frames.contains { $0["provisionalCodeHighlight"] as? Bool == true }
    }

    func codeHighlightUpgradeState(in scrollView: MacChatScrollView) -> String {
        let diagnostics = scrollView.chatDocumentView.layoutDiagnostics(
            viewport: scrollView.contentView.bounds
        )
        return "provisional=\(diagnostics["provisionalContentCount"] ?? -1),active=\(diagnostics["codeHighlightUpgradeActive"] ?? false),pending=\(diagnostics["codeHighlightUpgradePending"] ?? false),generation=\(diagnostics["observedCodeHighlightGeneration"] ?? -1)"
    }


    func runCoreTextBenchmark() {
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
            sessionMode: .auto,
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

        let selectionNeedle = "Cached immutable layout artifact"
        let selectionRange = (body.string as NSString).range(
            of: selectionNeedle,
            options: .caseInsensitive
        )
        let selectionProbe = cell.selectBodyTextForRegression(selectionRange)
        let startPoint = first?.point(forStringIndex: selectionRange.location)
        let endPoint = first?.point(forStringIndex: NSMaxRange(selectionRange))
        let mappedStart = startPoint.flatMap { first?.stringIndex(at: $0) }
        let mappedEnd = endPoint.flatMap { first?.stringIndex(at: $0) }
        let selectionPassed = selectionRange.location != NSNotFound
            && selectionProbe.text?.localizedCaseInsensitiveCompare(selectionNeedle) == .orderedSame
            && selectionProbe.rectCount > 0
            && mappedStart == selectionRange.location
            && mappedEnd == NSMaxRange(selectionRange)

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

        let dragStartNeedle = "Incremental render spine"
        let dragEndNeedle = "Layer-backed read-only drawing"
        let dragStartRange = (body.string as NSString).range(
            of: dragStartNeedle,
            options: .caseInsensitive
        )
        let dragEndRange = (body.string as NSString).range(
            of: dragEndNeedle,
            options: .caseInsensitive
        )
        let dragRange = dragStartRange.location != NSNotFound && dragEndRange.location != NSNotFound
            ? NSRange(
                location: dragStartRange.location,
                length: NSMaxRange(dragEndRange) - dragStartRange.location
            )
            : NSRange(location: NSNotFound, length: 0)
        let dragProbe = cell.dragSelectBodyTextForRegression(
            dragRange,
            windowNumber: window.windowNumber
        )
        let dragPassed = dragProbe.hitTested
            && dragProbe.rectCount >= 3
            && dragProbe.text?.localizedCaseInsensitiveContains(dragStartNeedle) == true
            && dragProbe.text?.localizedCaseInsensitiveContains(dragEndNeedle) == true

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
            "[coretext-bench] bytes=%d chars=%d blocks=%d bodyHeight=%.1f textKitHeight=%.1f heightDelta=%.1f totalHeight=%.1f firstMs=%.3f hits100Ms=%.3f hitMaxMs=%.3f configureMs=%.3f drawMs=%.3f coreText=%d selection=%d selectionRects=%d mappedStart=%d mappedEnd=%d dragSelection=%d dragRects=%d hitTest=%d",
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
            cell.usesCoreTextBodyFlag ? 1 : 0,
            selectionPassed ? 1 : 0,
            selectionProbe.rectCount,
            mappedStart ?? -1,
            mappedEnd ?? -1,
            dragPassed ? 1 : 0,
            dragProbe.rectCount,
            dragProbe.hitTested ? 1 : 0
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}
#endif
