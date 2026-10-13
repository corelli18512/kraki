/// The SwiftUI bridge for the Mac chat list, and the tail motion rules shared with tests.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

struct MacChatListRepresentable: NSViewRepresentable {
    let sessionId: String
    let agent: String
    let messageStore: MessageStore
    let attachmentStore: AttachmentStore?
    let documentWidth: CGFloat
    let messages: [ChatMessage]
    let liveCard: MessageStore.SessionCard?
    let liveTraceSeq: Int
    let liveSteps: Int
    let sessionMode: SessionMode
    let entryGeneration: Int
    /// Read position this Session was entered with (lands on the first new message).
    var unreadEntryBoundary: Int? = nil
    let bottomContentInset: CGFloat
    /// Floating Composer growth above its resting footprint (scroll reach only).
    var composerOverlayInset: CGFloat = 0
    let isLoadingOlder: Bool
    let isLoadingNewer: Bool
    var hasNewerLocalRows: Bool = true
    let atOldest: Bool
    let atNewest: Bool
    let onJumpToLatest: () -> Void
    let onRequestLatestTail: () -> Void
    let onLoadOlder: () -> Void
    let onLoadNewer: () -> Void
    let onOpenSteps: (Int, Bool) -> Void
    let onResolvePermission: (String, String?, String) -> Void
    let onAnswerQuestion: (String, String) -> Void
    var onPendingAction: (String, MacPendingAction) -> Void = { _, _ in }
    let onOpenImage: (MacImagePreviewSelection) -> Void
    let onOpenHTMLArtifact: (ContentRef) -> Void

    func makeNSView(context: Context) -> MacChatScrollView {
        let scrollView = MacChatScrollView(frame: .zero)
        // Do not expose the estimated top/anchor that NSScrollView starts with.
        // First usable layout performs an atomic bottom establishment below.
        scrollView.alphaValue = 0
        scrollView.prepareForSession(sessionId, unreadBoundary: unreadEntryBoundary)
        // A compact desktop tail is enough for several screens; older history
        // is restored from SQLite when the user reaches the top edge.
        messageStore.maxWindowPx = 4_800
        messageStore.heightForSeq = { [weak documentView = scrollView.chatDocumentView] sid, seq in
            guard sid == sessionId else { return 0 }
            return documentView?.measuredHeight(forSeq: seq) ?? 0
        }
        messageStore.retainedSeqRange = { [weak scrollView] sid in
            guard sid == sessionId, let scrollView else { return nil }
            return scrollView.chatDocumentView.retainedSeqRange(around: scrollView.contentView.bounds)
        }
        MacChatPerf.log("make session=\(sessionId.prefix(12)) pxWindow=4800")
        scrollView.onRequestLatestTail = onRequestLatestTail
        scrollView.onRenderedHeightsSettled = { [weak scrollView] in
            DispatchQueue.main.async { [weak scrollView] in
                guard let scrollView,
                      !scrollView.hasUserScrolled,
                      scrollView.followingBottom,
                      scrollView.canTrimTailWindow else { return }
                _ = messageStore.trimTailWindowToRenderedHeight(sessionId)
            }
        }
        scrollView.onJumpToLatest = {
            context.coordinator.forcePinOnNextUpdate = true
            onJumpToLatest()
        }
        scrollView.onScrolledNearTop = onLoadOlder
        scrollView.onScrolledNearBottom = onLoadNewer
        scrollView.chatDocumentView.onTapSteps = { cell in
            onOpenSteps(cell.bubbleSeq, cell.isLiveFlag)
        }
        scrollView.chatDocumentView.attachmentStore = attachmentStore
        scrollView.chatDocumentView.onResolvePermission = onResolvePermission
        scrollView.chatDocumentView.onAnswerQuestion = onAnswerQuestion
        scrollView.chatDocumentView.onPendingAction = onPendingAction
        scrollView.chatDocumentView.onOpenImage = onOpenImage
        scrollView.chatDocumentView.onOpenHTMLArtifact = onOpenHTMLArtifact
        scrollView.chatDocumentView.onHeightInvalidated = { [weak scrollView] in
            guard let scrollView else { return }
            if scrollView.followingBottom { scrollView.scrollToBottom(animated: false) }
        }
        return scrollView
    }

    static func dismantleNSView(_ scrollView: MacChatScrollView, coordinator: Coordinator) {
        scrollView.chatDocumentView.tearDown()
        scrollView.onJumpToLatest = nil
        scrollView.onRequestLatestTail = nil
        scrollView.onScrolledNearTop = nil
        scrollView.onScrolledNearBottom = nil
        scrollView.onRenderedHeightsSettled = nil
        scrollView.onFirstUsableLayout = nil
        scrollView.chatDocumentView.onOpenImage = nil
        scrollView.chatDocumentView.attachmentStore = nil
        scrollView.chatDocumentView.onOpenHTMLArtifact = nil
    }

    func updateNSView(_ scrollView: MacChatScrollView, context: Context) {
        MacChatCost.measure("updateNSView") { updateNSViewBody(scrollView, context: context) }
    }

    private func updateNSViewBody(_ scrollView: MacChatScrollView, context: Context) {
        #if KRAKI_DIAG
        let diagWork = KrakiDiag.beginWork()
        defer { KrakiDiag.endWork(diagWork, source: "mac.list_update", session: sessionId) }
        #endif
        let totalStarted = CACurrentMediaTime()
        if context.coordinator.sessionId != sessionId
            || context.coordinator.entryGeneration != entryGeneration {
            context.coordinator.sessionId = sessionId
            context.coordinator.entryGeneration = entryGeneration
            context.coordinator.firstLayout = true
            context.coordinator.initialColdEstablishmentCompleted = false
            context.coordinator.initialTrimScheduled = false
            context.coordinator.forcePinOnNextUpdate = false
            context.coordinator.itemCache.removeAll(keepingCapacity: true)
            context.coordinator.itemCacheWidth = nil
            scrollView.prepareForSession(sessionId, unreadBoundary: unreadEntryBoundary)
        }
        messageStore.maxWindowPx = 4_800
        messageStore.heightForSeq = { [weak documentView = scrollView.chatDocumentView] sid, seq in
            guard sid == sessionId else { return 0 }
            return documentView?.measuredHeight(forSeq: seq) ?? 0
        }
        messageStore.retainedSeqRange = { [weak scrollView] sid in
            guard sid == sessionId, let scrollView else { return nil }
            return scrollView.chatDocumentView.retainedSeqRange(around: scrollView.contentView.bounds)
        }
        scrollView.onRequestLatestTail = onRequestLatestTail
        scrollView.onRenderedHeightsSettled = { [weak scrollView] in
            DispatchQueue.main.async { [weak scrollView] in
                guard let scrollView,
                      !scrollView.hasUserScrolled,
                      scrollView.followingBottom,
                      scrollView.canTrimTailWindow else { return }
                _ = messageStore.trimTailWindowToRenderedHeight(sessionId)
            }
        }
        scrollView.onJumpToLatest = {
            context.coordinator.forcePinOnNextUpdate = true
            onJumpToLatest()
        }
        scrollView.onScrolledNearTop = onLoadOlder
        scrollView.onScrolledNearBottom = onLoadNewer
        scrollView.chatDocumentView.onTapSteps = { cell in
            onOpenSteps(cell.bubbleSeq, cell.isLiveFlag)
        }
        scrollView.chatDocumentView.attachmentStore = attachmentStore
        scrollView.chatDocumentView.onResolvePermission = onResolvePermission
        scrollView.chatDocumentView.onAnswerQuestion = onAnswerQuestion
        scrollView.chatDocumentView.onPendingAction = onPendingAction
        scrollView.chatDocumentView.onOpenImage = onOpenImage
        scrollView.chatDocumentView.onOpenHTMLArtifact = onOpenHTMLArtifact
        scrollView.onFirstUsableLayout = { [weak scrollView] in
            guard let scrollView else { return }
            context.coordinator.establishFirstUsableLayout(
                in: scrollView,
                messageStore: messageStore,
                sessionId: sessionId,
                atNewest: atNewest
            )
        }
        let buildStarted = CACurrentMediaTime()
        let builtItems = MacChatCost.measure("buildContents") { buildContents(coordinator: context.coordinator) }
        let buildMs = (CACurrentMediaTime() - buildStarted) * 1_000
        // Live revisions keep applying while the user scrolls (as on iOS). The
        // reading anchor is preserved below, and per-revision cost is flat.
        if !context.coordinator.firstLayout,
           let oldFirst = scrollView.chatDocumentView.itemKeys.first,
           let oldFirstIndex = builtItems.firstIndex(where: { $0.key == oldFirst }),
           oldFirstIndex > 0 {
            let missing = scrollView.chatDocumentView.unpreparedItems(
                Array(builtItems[..<oldFirstIndex]),
                documentWidth: max(documentWidth, 1),
                sessionMode: sessionMode
            )
            if !missing.isEmpty {
                let coordinator = context.coordinator
                coordinator.stagedUpdateGeneration &+= 1
                let generation = coordinator.stagedUpdateGeneration
                let stagedSession = sessionId
                scrollView.chatDocumentView.stage(missing) { [weak scrollView] in
                    guard let scrollView,
                          coordinator.stagedUpdateGeneration == generation,
                          coordinator.sessionId == stagedSession else { return }
                    self.updateNSViewBody(scrollView, context: context)
                }
                return
            }
        }
        // Any snapshot applied now supersedes a still-staging older one.
        context.coordinator.stagedUpdateGeneration &+= 1
        let oldOffset = scrollView.contentView.bounds.minY
        let viewport = scrollView.contentView.bounds
        let fallbackAnchor = scrollView.chatDocumentView.stableVisibleAnchor(in: viewport)
            ?? scrollView.chatDocumentView.visibleAnchor(at: oldOffset)
        let visibleAnchor = scrollView.geometryAnchorForMutation(fallback: fallbackAnchor)
        let wasPinned = scrollView.isPinnedToBottom
            || scrollView.isEntryBottomLocked
            || context.coordinator.firstLayout

        scrollView.performAtomicSnapshotGlidingLiveCardMove {
            scrollView.chatDocumentView.apply(
                contents: builtItems,
                documentWidth: max(documentWidth, 1),
                sessionMode: sessionMode
            )
            scrollView.setBottomContentInset(bottomContentInset, composerOverlay: composerOverlayInset)
            let hasPageableContent = !builtItems.isEmpty
            scrollView.setLoading(
                // An empty Session has no edge rows to paginate. Until now its
                // unknown edge flags mounted both the older and newer spinners
                // underneath the intentional empty-state message.
                older: hasPageableContent && !atOldest,
                newer: hasPageableContent && !atNewest,
                fetchingOlder: isLoadingOlder,
                fetchingNewer: isLoadingNewer,
                newerIsLocal: hasNewerLocalRows
            )

            scrollView.canTrimTailWindow = atNewest
            let hasUsableViewport = scrollView.contentView.bounds.width > 1
                && scrollView.contentView.bounds.height > 1
            if hasUsableViewport,
               context.coordinator.firstLayout {
                context.coordinator.establishFirstUsableLayout(
                    in: scrollView,
                    messageStore: messageStore,
                    sessionId: sessionId,
                    atNewest: atNewest
                )
            } else if hasUsableViewport,
                      wasPinned || context.coordinator.forcePinOnNextUpdate {
                // A new bubble arriving at the followed bottom: the list glides
                // up to make room while the bubble slides in from its side.
                scrollView.scrollToBottom(
                    animated: context.coordinator.forcePinOnNextUpdate
                        || scrollView.chatDocumentView.lastApplyEntrances > 0
                )
                context.coordinator.forcePinOnNextUpdate = false
            } else if let visibleAnchor,
                      let frame = scrollView.chatDocumentView.frame(forKey: visibleAnchor.key) {
                let minimumY = -scrollView.contentInsets.top
                let target = max(minimumY, frame.minY + visibleAnchor.delta)
                scrollView.contentView.bounds.origin.y = target
            }
        }
        scrollView.noteAppendedReplies(
            scrollView.chatDocumentView.lastApplyAppendedReplies,
            readerWasAtBottom: wasPinned || context.coordinator.forcePinOnNextUpdate
        )
        let windowState = messageStore.windowState(sessionId)
        scrollView.notePresentationSnapshot(
            windowTop: windowState?.topSeq ?? 0,
            windowBottom: windowState?.bottomSeq ?? 0,
            rawCount: messageStore.currentWindow(sessionId).count,
            bubbleCount: builtItems.count,
            atOldest: atOldest,
            atNewest: atNewest
        )
        if scrollView.hasPendingLatestStartJump, atNewest {
            scrollView.completeLatestStartJump()
        }
        let totalMs = (CACurrentMediaTime() - totalStarted) * 1_000
        if totalMs >= 16 {
            MacChatPerf.slow(
                "update raw=\(messages.count) bubbles=\(builtItems.count) "
                    + "build=\(String(format: "%.1f", buildMs)) "
                    + "total=\(String(format: "%.1f", totalMs))"
            )
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator {
        /// Latest update deferred while a prepended page is prepared.
        var stagedUpdateGeneration = 0
        var sessionId: String?
        var entryGeneration = -1
        var firstLayout = true
        var establishingFirstLayout = false
        var initialColdEstablishmentCompleted = false
        var initialTrimScheduled = false
        var forcePinOnNextUpdate = false
        var itemCache: [String: MacChatItem] = [:]
        var itemCacheWidth: Int?

        func establishFirstUsableLayout(
            in scrollView: MacChatScrollView,
            messageStore: MessageStore,
            sessionId: String,
            atNewest: Bool
        ) {
            guard firstLayout,
                  !establishingFirstLayout,
                  scrollView.contentView.bounds.width > 1,
                  scrollView.contentView.bounds.height > 1 else { return }
            establishingFirstLayout = true
            defer { establishingFirstLayout = false }
            let allowColdContent = !initialColdEstablishmentCompleted
            scrollView.establishInitialBottom(allowColdContent: allowColdContent)
            guard scrollView.chatDocumentView.initialViewportIsReady(scrollView.contentView.bounds) else {
                scrollView.alphaValue = 0
                return
            }
            firstLayout = false
            initialColdEstablishmentCompleted = true
            scrollView.alphaValue = 1
            scrollView.onFirstUsableLayout = nil
            scrollView.noteFirstUsableLayout()
        }
    }

    private func buildContents(coordinator: Coordinator) -> [MacChatItem] {
        let widthBucket = Int(documentWidth.rounded())
        if coordinator.itemCacheWidth != widthBucket {
            coordinator.itemCacheWidth = widthBucket
            coordinator.itemCache.removeAll(keepingCapacity: true)
        }
        let validIDs = Set(messages.map(\.id))
        coordinator.itemCache = coordinator.itemCache.filter { validIDs.contains($0.key) }
        var items: [MacChatItem] = messages.map { message in
            let signature = messageSignature(message)
            if let cached = coordinator.itemCache[message.id], cached.signature == signature {
                return cached
            }
            let item: MacChatItem
            if let card = message.frozenCard {
                item = MacChatItem(
                    seq: message.seq,
                    key: "frozen:\(message.id)",
                    signature: signature,
                    estimatedHeight: estimatedHeight(for: message),
                    visibleCharacterCount: utf8Length(message.interruptedDraft ?? message.content ?? message.result),
                    isReply: true,
                    makeContent: {
                        MacChatBubbleContentBuilder.live(
                            card: card,
                            sessionId: sessionId,
                            agent: agent,
                            documentWidth: documentWidth,
                            traceSeq: message.seq,
                            steps: message.steps ?? 0,
                            frozen: true,
                            attachments: message.contentRefAttachments
                        )
                    }
                )
            } else {
                item = MacChatItem(
                    seq: message.seq,
                    key: message.id,
                    signature: signature,
                    estimatedHeight: estimatedHeight(for: message),
                    visibleCharacterCount: utf8Length(message.content ?? message.result),
                    isReply: message.type == "agent_message",
                    isUser: ["user_message", "send_input", "pending_input"].contains(message.type),
                    makeContent: {
                        MacChatBubbleContentBuilder.make(
                            message: message,
                            sessionId: sessionId,
                            agent: agent,
                            documentWidth: documentWidth
                        )
                    }
                )
            }
            coordinator.itemCache[message.id] = item
            return item
        }
        // Last, or above a steer the agent has not read yet (MessageStore+SteerPlacement).
        if let liveCard, !liveCard.text.isEmpty || liveCard.action != nil {
            items.insert(MacChatItem(
                seq: liveTraceSeq,
                key: "__live__",
                signature: liveCardSignature(liveCard),
                estimatedHeight: estimatedHeight(forText: liveCard.text, hasAction: liveCard.action != nil),
                visibleCharacterCount: liveCard.text.utf8.count,
                isReply: true,
                makeContent: {
                    MacChatBubbleContentBuilder.live(
                        card: liveCard,
                        sessionId: sessionId,
                        agent: agent,
                        documentWidth: documentWidth,
                        traceSeq: liveTraceSeq,
                        steps: liveSteps
                    )
                }
            ), at: liveCard.rowIndex(in: messages))
        }
        return items
    }

    private func estimatedHeight(for message: ChatMessage) -> CGFloat {
        let hasImages = !(message.attachments ?? []).isEmpty
            || message.contentRefAttachments.contains { $0.mimeType.hasPrefix("image/") }
        let artifactCount = message.contentRefAttachments.filter { $0.mimeType == "text/html" }.count
        return estimatedHeight(
            forText: message.interruptedDraft ?? message.content ?? message.result ?? "",
            hasAction: message.terminalAction != nil,
            hasImages: hasImages,
            artifactCount: artifactCount
        )
    }

    private func estimatedHeight(
        forText text: String,
        hasAction: Bool = false,
        hasImages: Bool = false,
        artifactCount: Int = 0
    ) -> CGFloat {
        let usableWidth = max(documentWidth - 100, 240)
        let charactersPerLine = max(Int(usableWidth / 7.2), 24)
        // Height is capped at 640pt, so scanning an unbounded Unicode String is
        // wasted work. Inspect only enough UTF-8 bytes to saturate that cap;
        // this avoids repeated grapheme-cluster walks on large tool output.
        let bytes = text.utf8
        let scanLimit = min(bytes.count, 16_384)
        var explicitLines = 1
        var scanned = 0
        for byte in bytes.prefix(scanLimit) {
            if byte == 0x0A { explicitLines += 1 }
            scanned += 1
        }
        let effectiveBytes = bytes.count > scanLimit ? max(bytes.count, scanLimit) : scanned
        let wrappedLines = max(1, Int(ceil(Double(max(effectiveBytes, 1)) / Double(charactersPerLine))))
        var height = CGFloat(max(explicitLines, wrappedLines)) * 18
            + MacChatBubbleLayout.msgPadV * 2
            + MacChatBubbleLayout.outerV * 2
        if hasImages { height += 192 + MacChatBubbleLayout.imageSpacing }
        if artifactCount > 0 {
            height += CGFloat(artifactCount) * 54
                + CGFloat(max(artifactCount - 1, 0)) * 6
                + MacChatBubbleLayout.imageSpacing
        }
        if hasAction { height += 96 }
        return min(max(height, 52), 640)
    }

    private func messageSignature(_ message: ChatMessage) -> String {
        var hasher = Hasher()
        hasher.combine(message.id)
        hasher.combine(message.type)
        combineVisibleText(message.content, into: &hasher)
        combineVisibleText(message.interruptedDraft, into: &hasher)
        combineVisibleText(message.result, into: &hasher)
        hasher.combine(message.steps ?? 0)
        hasher.combine(message.finishedAt ?? "")
        hasher.combine(message.payload["localState"]?.stringValue ?? "")
        hasher.combine(message.payload["uncorrected"]?.arrayValue?.compactMap(\.intValue) ?? [])
        hasher.combine(message.attachments?.count ?? 0)
        for ref in message.contentRefAttachments {
            hasher.combine(ref.id)
            hasher.combine(ref.mimeType)
            hasher.combine(ref.width ?? 0)
            hasher.combine(ref.height ?? 0)
        }
        if let action = message.terminalAction {
            hasher.combine(action["type"]?.stringValue ?? "")
            let payload = action["payload"]?.dictValue
            hasher.combine(payload?["message"]?.stringValue ?? "")
            hasher.combine(payload?["reason"]?.stringValue ?? "")
        }
        return String(hasher.finalize())
    }

    private func liveCardSignature(_ card: MessageStore.SessionCard) -> String {
        var hasher = Hasher()
        combineVisibleText(card.text, into: &hasher)
        if let action = card.action {
            hasher.combine(action.type)
            hasher.combine(action.toolCallId ?? "")
            hasher.combine(action.headline ?? "")
            hasher.combine(action.permissionId ?? "")
            hasher.combine(action.questionId ?? "")
            hasher.combine(action.payload["decision"]?.stringValue ?? "")
            hasher.combine(action.payload["success"]?.boolValue ?? false)
            hasher.combine(action.payload["localPending"]?.boolValue ?? false)
            hasher.combine(action.payload["localError"]?.stringValue ?? "")
        }
        return String(hasher.finalize())
    }

    /// Hash bounded UTF-8 metadata only. Persisted message ids are stable, so
    /// there is no reason for a SwiftUI update to perform grapheme-cluster
    /// traversal or allocate a new suffix String for a large message body.
    private func combineVisibleText(_ text: String?, into hasher: inout Hasher) {
        guard let text else {
            hasher.combine(0)
            return
        }
        let bytes = text.utf8
        hasher.combine(bytes.count)
        hasher.combine(Data(bytes.suffix(512)))
    }

    private func utf8Length(_ text: String?) -> Int {
        text?.utf8.count ?? 0
    }
}

/// Motion rules for content arriving at the followed bottom (shared by tests).
enum MacTailMotion {
    /// Time constant of following: ~95 % of a new line is in view after
    /// 3 τ (0.21 s).
    static let followTau: CFTimeInterval = 0.07
    /// Beyond about two lines behind (a very fast stream) following speeds up
    /// in proportion, so the newest text never drifts out of view.
    static let maxLag: CGFloat = 40
    /// pt/s: the end of a follow settles instead of creeping.
    static let minimumFollowSpeed: CGFloat = 120

    /// Distance to move this frame toward a bottom `remaining` away.
    static func followStep(remaining: CGFloat, elapsed: CFTimeInterval) -> CGFloat {
        guard abs(remaining) > 0.5 else { return remaining }
        let distance = abs(remaining)
        let tau = distance > maxLag ? followTau * Double((maxLag / distance).squareRoot()) : followTau
        // After a main-thread stall, continue at the normal pace rather than
        // catching up the whole stall in one frame (that reads as a jump).
        let dt = max(0, min(elapsed, 1.0 / 60.0))
        // Exponential approach, with a small minimum speed so the last
        // fraction of a point does not linger.
        let moved = max(distance * CGFloat(1 - exp(-dt / tau)), min(distance, minimumFollowSpeed * CGFloat(dt)))
        return remaining < 0 ? -moved : moved
    }
    /// The part of a document height change caused by the newest item growing.
    static func tailGrowth(documentDelta: CGFloat, latestHeightDelta: CGFloat) -> CGFloat {
        guard documentDelta > 0, latestHeightDelta > 0 else { return 0 }
        return min(documentDelta, latestHeightDelta)
    }
}
#endif
