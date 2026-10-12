/// Exact heights for the Mac chat document: code highlight upgrades, warmed heights, live height animation, height cache and invalidation.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatDocumentView {
    func noteCodeHighlightGeneration() {
        let generation = MacMarkdown.highlightGeneration()
        guard generation != observedCodeHighlightGeneration else { return }
        observedCodeHighlightGeneration = generation
        scheduleCodeHighlightUpgrade()
    }

    func cacheContent(_ content: MacChatBubbleContent, forKey key: String) {
        contentCache[key] = content
        if let body = content.body,
           containsProvisionalCode(in: body) {
            // Always enqueue an upgrade from the cache insertion point. The
            // highlighter-ready notification can arrive before this content is
            // installed; relying on notification ordering left some cold code
            // blocks permanently provisional until the Session was reopened.
            scheduleCodeHighlightUpgrade()
        }
    }

    func scheduleCodeHighlightUpgrade() {
        codeHighlightUpgradePending = true
        guard !scrollInteractionActive,
              !codeHighlightUpgradeActive else { return }

        let candidates: [(index: Int, item: MacChatItem, key: String)] = contents.indices.compactMap { index in
            let item = contents[index]
            let key = cacheKey(item)
            let cachedProvisional = contentCache[key]?.body.map(containsProvisionalCode(in:)) ?? false
            let visibleProvisional = visibleCells[index]?.hasProvisionalCodeHighlight ?? false
            guard cachedProvisional || visibleProvisional else { return nil }
            return (index, item, key)
        }
        guard !candidates.isEmpty else {
            codeHighlightUpgradePending = false
            return
        }

        codeHighlightUpgradePending = false
        codeHighlightUpgradeActive = true
        let generation = warmGeneration
        contentWarmQueue.async { [weak self] in
            guard let self else { return }
            let prepared: [(Int, MacChatItem, String, MacChatBubbleContent)] = candidates.map {
                candidate in
                let content = candidate.item.makeContent()
                if let body = content.body {
                    MacCoreTextLayoutArtifact.removeCached(
                        width: content.bodyTextWidth,
                        key: candidate.key
                    )
                    _ = MacCoreTextLayoutArtifact.cached(
                        attributed: body,
                        width: content.bodyTextWidth,
                        key: candidate.key
                    )
                }
                return (candidate.index, candidate.item, candidate.key, content)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                defer {
                    self.codeHighlightUpgradeActive = false
                    if self.codeHighlightUpgradePending {
                        self.scheduleCodeHighlightUpgrade()
                    }
                }
                guard generation == self.warmGeneration,
                      !self.scrollInteractionActive else {
                    self.codeHighlightUpgradePending = true
                    return
                }
                var geometryChanged = false
                for (index, item, key, content) in prepared
                where index < self.contents.count
                    && self.cacheKey(self.contents[index]) == key
                    && self.validCacheKeys.contains(key) {
                    self.cacheContent(content, forKey: key)
                    guard let cell = self.visibleCells[index],
                          self.visibleSignatures[index] == key else { continue }
                    self.configure(cell, with: item, content: content)
                    cell.frame = self.itemFrames[index]
                    cell.documentWidthVar = self.documentWidth
                    cell.needsLayout = true
                    geometryChanged = self.stageConfiguredHeight(
                        cell,
                        for: item,
                        cacheKey: key
                    ) || geometryChanged
                }
                if geometryChanged, !self.warmedGeometryPending {
                    self.warmedGeometryPending = true
                    DispatchQueue.main.async { [weak self] in
                        self?.onWarmedHeightsReady?()
                    }
                }
            }
        }
    }

    func containsProvisionalCode(in attributed: NSAttributedString) -> Bool {
        var found = false
        attributed.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: attributed.length)
        ) { value, _, stop in
            if value != nil {
                found = true
                stop.pointee = true
            }
        }
        return found
    }

    @discardableResult
    func commitWarmedHeights(animateLive: Bool = false) -> Bool {
        MacChatCost.measure("commitWarmedHeights") { commitWarmedHeightsBody(animateLive: animateLive) }
    }

    func commitWarmedHeightsBody(animateLive: Bool) -> Bool {
        guard !pendingHeights.isEmpty else {
            warmedGeometryPending = false
            return false
        }
        let liveCacheKey = contents.first(where: { $0.key == "__live__" }).map(cacheKey)
        var animatedTarget: (key: String, from: CGFloat, to: CGFloat)?
        for (key, height) in pendingHeights where validCacheKeys.contains(key) {
            Self.exactHeightCache.setObject(
                NSNumber(value: Double(height)),
                forKey: key as NSString,
                cost: 16
            )
            if animateLive,
               key == liveCacheKey,
               let current = heightCache[key],
               abs(current - height) > 0.5 {
                animatedTarget = (key, current, height)
            } else {
                heightCache[key] = height
            }
        }
        pendingHeights.removeAll(keepingCapacity: true)
        warmedGeometryPending = false
        rebuildFrames()
        if let animatedTarget {
            startLiveHeightAnimation(
                cacheKey: animatedTarget.key,
                from: animatedTarget.from,
                to: animatedTarget.to
            )
        }
        return true
    }

    func isAnimatingLiveHeight(cacheKey: String, target: CGFloat) -> Bool {
        guard let animation = liveHeightAnimation else { return false }
        return animation.cacheKey == cacheKey && abs(animation.to - target) <= 0.5
    }

    func startLiveHeightAnimation(cacheKey: String, from: CGFloat, to: CGFloat) {
        stopLiveHeightAnimation()
        guard validCacheKeys.contains(cacheKey), abs(from - to) > 0.5 else {
            heightCache[cacheKey] = to
            rebuildFrames()
            return
        }
        heightCache[cacheKey] = from
        let distance = abs(to - from)
        let duration = min(0.32, max(0.14, CFTimeInterval(distance / 900) * 0.12))
        liveHeightAnimation = LiveHeightAnimation(
            cacheKey: cacheKey,
            from: from,
            to: to,
            startedAt: CACurrentMediaTime(),
            duration: duration
        )
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.advanceLiveHeightAnimation()
        }
        liveHeightAnimationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func advanceLiveHeightAnimation() {
        guard let animation = liveHeightAnimation,
              validCacheKeys.contains(animation.cacheKey) else {
            stopLiveHeightAnimation()
            return
        }
        let progress = min(1, max(0, (CACurrentMediaTime() - animation.startedAt) / animation.duration))
        let eased = 1 - pow(1 - progress, 3)
        let height = animation.from + (animation.to - animation.from) * CGFloat(eased)
        let oldDocumentHeight = frame.height
        heightCache[animation.cacheKey] = height
        rebuildFrames()
        let documentDelta = frame.height - oldDocumentHeight
        if abs(documentDelta) > 0.001 {
            onAnimatedGeometryStep?(documentDelta)
        }
        if progress >= 1 {
            heightCache[animation.cacheKey] = animation.to
            stopLiveHeightAnimation()
        }
    }

    func stopLiveHeightAnimation() {
        liveHeightAnimationTimer?.invalidate()
        liveHeightAnimationTimer = nil
        liveHeightAnimation = nil
    }

    func measuredHeight(forSeq seq: Int) -> CGFloat {
        guard let index = indexBySeq[seq], index < contents.count else { return 0 }
        let item = contents[index]
        let key = cacheKey(item)
        // Estimated height is already projection-aware and attributed only to
        // the bubble's terminal seq. Returning it before idle warming lets the
        // compact initial tail be px-trimmed before first presentation;
        // exact heights replace it as cells/warm jobs finish.
        return heightCache[key] ?? pendingHeights[key] ?? item.estimatedHeight
    }

    func scheduleHeightWarmup(around viewport: NSRect) {
        guard !warmBatchActive,
              documentWidth > 1,
              !contents.isEmpty else { return }
        let now = CACurrentMediaTime()
        if now < warmupNotBefore {
            guard warmupDelayWorkItem == nil else { return }
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.warmupDelayWorkItem = nil
                guard let scrollView = self.enclosingScrollView else { return }
                self.scheduleHeightWarmup(around: scrollView.contentView.bounds)
            }
            warmupDelayWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + (warmupNotBefore - now), execute: work)
            return
        }
        let nearbyIndexes = desiredIndexes(
            for: viewport,
            runway: max(viewport.height * 3, 1_800)
        )
        // The compact Mac window is at most about 60 rows. After warming the
        // viewport neighborhood, continue through the complete in-memory tail
        // so document geometry is stable before the user reaches cold history.
        let nearbySet = Set(nearbyIndexes)
        let warmIndexes = nearbyIndexes + contents.indices.filter { !nearbySet.contains($0) }
        guard !warmIndexes.isEmpty else { return }
        // Keep completed content for the compact in-memory history window.
        // Snapshot apply removes invalid keys. Evicting on every viewport move
        // made quick reverse scrolling immediately cold again.
        warmEnqueued.formIntersection(validCacheKeys)
        warmEnqueued.formUnion(contentCache.keys)
        let generation = warmGeneration
        let centerY = viewport.midY
        let centerIndex = itemFrames.indices.min(by: {
            abs(itemFrames[$0].midY - centerY) < abs(itemFrames[$1].midY - centerY)
        }) ?? 0
        let orderedIndexes = warmIndexes.sorted {
            abs($0 - centerIndex) < abs($1 - centerIndex)
        }
        guard let index = orderedIndexes.first(where: { index in
            let item = contents[index]
            let key = cacheKey(item)
            return contentCache[key] == nil && !warmEnqueued.contains(key)
        }) else { return }
        let item = contents[index]
        let key = cacheKey(item)
        warmEnqueued.insert(key)
        let documentWidth = self.documentWidth
        let sessionMode = self.sessionMode
        let job = { [weak self] in
            guard let self else { return }
            self.contentWarmQueue.async { [weak self] in
                let started = CACurrentMediaTime()
                let content = item.makeContent()
                let bodyArtifact = content.body.flatMap {
                    MacCoreTextLayoutArtifact.cached(
                        attributed: $0,
                        width: content.bodyTextWidth,
                        key: "\(item.key)|\(item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
                    )
                }
                let exactHeight: CGFloat? = content.action == nil
                    ? MacChatBubbleCell.height(
                        for: content,
                        bodyHeight: bodyArtifact?.height ?? 0
                    )
                    : nil
                let elapsedMs = (CACurrentMediaTime() - started) * 1_000
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    let valid = generation == self.warmGeneration
                        && self.validCacheKeys.contains(key)
                    if valid {
                        self.cacheContent(content, forKey: key)
                        if let exactHeight {
                            Self.exactHeightCache.setObject(
                                NSNumber(value: Double(exactHeight)),
                                forKey: key as NSString,
                                cost: 16
                            )
                            let target = self.floored(exactHeight, forKey: key)
                            if abs((self.heightCache[key] ?? item.estimatedHeight) - target) > 0.5 {
                                self.pendingHeights[key] = target
                            } else {
                                self.heightCache[key] = target
                            }
                        }
                        if elapsedMs >= 16 {
                            MacChatPerf.slow(
                                "content-warm seq=\(item.seq) chars=\(item.visibleCharacterCount) "
                                    + "ms=\(String(format: "%.1f", elapsedMs))"
                            )
                        }
                    } else {
                        self.warmEnqueued.remove(key)
                    }
                    self.warmBatchActive = false
                    // During motion, keep preparing the viewport neighborhood
                    // but do not trigger a separate geometry pass. Native
                    // scroll reflection consumes the immutable artifact.
                    if valid,
                       !self.scrollInteractionActive {
                        if !self.warmedGeometryPending {
                            self.warmedGeometryPending = true
                            self.onWarmedHeightsReady?()
                        }
                        // A prepared visible placeholder may not have changed
                        // geometry yet. Retry binding immediately; otherwise a
                        // live-card cold miss can remain a placeholder forever
                        // while waiting for an unrelated SwiftUI update.
                        if let scrollView = self.enclosingScrollView {
                            _ = self.updateVisibleCells(
                                in: scrollView.contentView.bounds,
                                runwayOverride: 0
                            )
                        }
                    }
                    guard let scrollView = self.enclosingScrollView else { return }
                    self.scheduleHeightWarmup(around: scrollView.contentView.bounds)
                }
            }
        }
        MacChatPerf.log(
            "warm-enqueue items=\(contents.count) jobs=1 center=\(centerIndex)"
        )
        warmBatchActive = true
        warmer.enqueue([job])
    }

    func rebuildFrames() {
        let heights = contents.map { heightCache[cacheKey($0)] ?? $0.estimatedHeight }
        let rawHeight = heights.reduce(0, +)
            + (showsOlderSpinner ? 44 : 0)
            + (showsNewerSpinner ? 44 : 0)
            + bottomSafeArea
        var y = max(0, minimumContentHeight - rawHeight)
        if showsOlderSpinner {
            topSpinner.frame = NSRect(x: (documentWidth - 18) / 2, y: y + 13, width: 18, height: 18)
            y += 44
        }
        itemFrames = heights.map { height in
            defer { y += height }
            return NSRect(x: 0, y: y, width: documentWidth, height: height)
        }
        if showsNewerSpinner {
            bottomSpinner.frame = NSRect(x: (documentWidth - 18) / 2, y: y + 13, width: 18, height: 18)
            y += 44
        }
        y += bottomSafeArea
        let previousFrame = frame
        frame = NSRect(x: 0, y: 0, width: documentWidth, height: max(y, minimumContentHeight) + composerOverlay)
        if abs(previousFrame.height - frame.height) > 0.5 {
            enclosingScrollView?.needsLayout = true
        }
        for (index, cell) in visibleCells where index < itemFrames.count {
            cell.frame = itemFrames[index]
            cell.documentWidthVar = documentWidth
            cell.needsLayout = true
        }
    }

    func cacheKey(_ item: MacChatItem) -> String {
        "\(item.key)|\(item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
    }

    func cachedContent(for item: MacChatItem) -> MacChatBubbleContent? {
        contentCache[cacheKey(item)]
    }

    /// At rest, a few short rows that appear with a new identity (a sent
    /// message, a question that drops its choices once answered, an echo
    /// replacing its pending input) get their content and exact height now,
    /// before any layout sees them — as on iOS. Otherwise the first pass lays
    /// them out at an estimate, and every row below a row whose height then
    /// changes waits one turn as a placeholder (seen when answering: the
    /// question shrinks and the answer bubble below it flashed grey). The same
    /// work `stage` does off-main for older pages, ~1–3ms per row.
    func primeNewShortIdentities(oldKeys: [String]) {
        guard !scrollInteractionActive, documentWidth > 1 else { return }
        let old = Set(oldKeys)
        let fresh = contents.lazy.filter {
            !old.contains($0.key) && $0.key != "__live__" && $0.visibleCharacterCount <= 1_500
        }
        var primed = 0
        for item in fresh.reversed() {
            guard heightCache[cacheKey(item)] == nil else { continue }
            guard primed < 4 else { break }
            if primeExactHeight(for: item) { primed += 1 }
        }
    }

    /// A row that keeps its identity while its text is rewritten in place — a
    /// voice bubble being corrected, a pending input changing delivery state —
    /// gets a new signature on every revision. Its new cache key has no height
    /// yet, and falling back to the character-count estimate for even one
    /// layout pass changes the document height: pinned to the newest edge,
    /// the scroll offset is clamped and the whole Chat bounces by the
    /// estimate error on every revision. Measure the short rewritten row now
    /// (as `primeNewShortIdentities` does for new rows); if that is not
    /// allowed (active scrolling, long text, action slot), keep the height it
    /// is currently displayed at until its exact geometry commits.
    func primeRewrittenRows(
        oldSignatureByKey: [String: String],
        oldDisplayedHeightByKey: [String: CGFloat]
    ) {
        guard documentWidth > 1 else { return }
        var primed = 0
        for item in contents.reversed() where item.key != "__live__" {
            guard let oldSignature = oldSignatureByKey[item.key], oldSignature != item.signature,
                  heightCache[cacheKey(item)] == nil else { continue }
            if !scrollInteractionActive, primed < 4, item.visibleCharacterCount <= 1_500,
               primeExactHeight(for: item) {
                primed += 1
            } else if let displayed = oldDisplayedHeightByKey[item.key] {
                heightCache[cacheKey(item)] = displayed
            }
        }
    }

    func updateCorrectingFloors(oldExactHeightByKey: [String: CGFloat]) {
        var floors: [String: CGFloat] = [:]
        for item in contents where item.key.contains(":pending:") {
            guard let floor = oldExactHeightByKey[item.key],
                  resolvedContent(for: item).pendingDeliveryState == "correcting" else { continue }
            let key = cacheKey(item)
            floors[key] = floor
            heightCache[key] = max(heightCache[key] ?? floor, floor)
            if let pending = pendingHeights[key] {
                if pending <= floor + 0.5 { pendingHeights.removeValue(forKey: key) }
            }
        }
        correctingHeightFloor = floors
    }

    /// A correcting row's height may grow but never drop below its floor.
    func floored(_ height: CGFloat, forKey key: String) -> CGFloat {
        max(height, correctingHeightFloor[key] ?? 0)
    }

    /// Exact height of a short non-action row, computed synchronously on main
    /// (~1–3ms). Returns false for action slots, which are measured by their
    /// hosted view once configured.
    @discardableResult
    func primeExactHeight(for item: MacChatItem) -> Bool {
        let key = cacheKey(item)
        let content = resolvedContent(for: item)
        guard content.action == nil else { return false }
        let artifact = content.body.flatMap {
            MacCoreTextLayoutArtifact.cached(
                attributed: $0,
                width: content.bodyTextWidth,
                key: "\(item.key)|\(item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
            )
        }
        let exact = MacChatBubbleCell.height(for: content, bodyHeight: artifact?.height ?? 0)
        heightCache[key] = floored(exact, forKey: key)
        Self.exactHeightCache.setObject(NSNumber(value: Double(exact)), forKey: key as NSString, cost: 16)
        return true
    }

    func resolvedContent(for item: MacChatItem) -> MacChatBubbleContent {
        let key = cacheKey(item)
        if let cached = contentCache[key] { return cached }
        let content = MacChatCost.measure("makeContent(main)") { item.makeContent() }
        cacheContent(content, forKey: key)
        return content
    }

    @discardableResult
    func stageConfiguredHeight(
        _ cell: MacChatBubbleCell,
        for item: MacChatItem,
        cacheKey key: String
    ) -> Bool {
        let exactHeight = floored(cell.configuredHeight(), forKey: key)
        guard abs((heightCache[key] ?? item.estimatedHeight) - exactHeight) > 0.5 else {
            heightCache[key] = exactHeight
            Self.exactHeightCache.setObject(
                NSNumber(value: Double(exactHeight)),
                forKey: key as NSString,
                cost: 16
            )
            return false
        }
        guard !isAnimatingLiveHeight(cacheKey: key, target: exactHeight) else { return false }
        pendingHeights[key] = exactHeight
        return true
    }

    /// SwiftUI image/artifact hosts can invalidate their intrinsic height from
    /// inside `NSHostingView.layout()`. Re-entering Chat layout synchronously
    /// from that callback trips AppKit's layout-recursion guard. Coalesce all
    /// invalidations onto the next main-loop turn and invalidate by stable
    /// render key so cell reuse cannot target the wrong bubble.
    func scheduleHeightInvalidation(for cell: MacChatBubbleCell) {
        guard let index = visibleCells.first(where: { $0.value === cell })?.key,
              index < contents.count else { return }
        pendingHeightInvalidationKeys.insert(cacheKey(contents[index]))
        guard heightInvalidationWorkItem == nil else { return }

        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.heightInvalidationWorkItem = nil
            let keys = self.pendingHeightInvalidationKeys
            self.pendingHeightInvalidationKeys.removeAll(keepingCapacity: true)
            for key in keys where self.validCacheKeys.contains(key) {
                self.heightCache.removeValue(forKey: key)
            }
            if let scrollView = self.enclosingScrollView {
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
            self.onHeightInvalidated?()
        }
        heightInvalidationWorkItem = workItem
        DispatchQueue.main.async(execute: workItem)
    }
}
#endif
