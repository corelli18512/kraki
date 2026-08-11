#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

private enum MacChatPerf {
    private static let logger = OSLog(subsystem: "chat.kraki.ios", category: "mac-chat-perf")
    static let enabled: Bool = {
        #if DEBUG
        ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_PERF"] == "1"
        #else
        false
        #endif
    }()

    private static var lastSlowLogTime: CFTimeInterval = 0

    static func slow(_ message: @autoclosure () -> String) {
        #if DEBUG
        let now = CACurrentMediaTime()
        guard now - lastSlowLogTime >= 0.2 else { return }
        lastSlowLogTime = now
        let line = "[SLOW][MacChat] \(message())"
        os_log("%{public}s", log: logger, type: .default, line)
        #endif
    }

    static func log(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        let line = "[PERF][MacChat] \(message())"
        print(line)
        os_log("%{public}s", log: logger, type: .default, line)
    }
}

final class MacChatDocumentView: NSView {
    override var isFlipped: Bool { true }

    private static let exactHeightCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 2_048
        cache.totalCostLimit = 2 * 1024 * 1024
        return cache
    }()

    private(set) var itemKeys: [String] = []
    private(set) var lastApplyPrepended = false
    private var itemSignatures: [String] = []
    private var indexByKey: [String: Int] = [:]
    private var indexBySeq: [Int: Int] = [:]
    private var validCacheKeys: Set<String> = []
    private var contents: [MacChatItem] = []
    private var itemFrames: [NSRect] = []
    private var visibleCells: [Int: MacChatBubbleCell] = [:]
    private var visibleSignatures: [Int: String] = [:]
    private var reusePool: [MacChatBubbleCell] = []
    private var contentCache: [String: MacChatBubbleContent] = [:]
    private var heightCache: [String: CGFloat] = [:]
    private var pendingHeights: [String: CGFloat] = [:]
    // Content warming never creates offscreen TextKit layout. It only builds
    // attributed content, one item per display cadence, so nearby rows are
    // ready before they enter the viewport without batching work onto a frame.
    private let warmer = HeightMeasurementScheduler(
        budgetMs: 4.0,
        maxJobsPerTick: 1,
        tickInterval: 1.0 / 60.0
    )
    private let contentWarmQueue = DispatchQueue(
        label: "chat.kraki.mac.content-artifact",
        qos: .userInitiated
    )
    private var warmEnqueued: Set<String> = []
    private var geometryWarmCompleted: Set<String> = []
    private var warmGeneration = 0
    private var warmBatchActive = false
    private var warmBatchReleaseWorkItem: DispatchWorkItem?
    private var viewportFillScheduled = false
    private var warmedGeometryPending = false
    private var heightInvalidationWorkItem: DispatchWorkItem?
    private var pendingHeightInvalidationKeys: Set<String> = []
    private struct LiveHeightAnimation {
        let cacheKey: String
        let from: CGFloat
        let to: CGFloat
        let startedAt: CFTimeInterval
        let duration: CFTimeInterval
    }
    private var liveHeightAnimation: LiveHeightAnimation?
    private var liveHeightAnimationTimer: Timer?
    private var scrollInteractionActive = false
    private var deferredLiveSnapshot: (
        contents: [MacChatItem],
        documentWidth: CGFloat,
        sessionMode: SessionMode
    )?
    private var codeHighlightObserver: NSObjectProtocol?
    private var codeHighlightUpgradeActive = false
    private var codeHighlightUpgradePending = false
    private var observedCodeHighlightGeneration = 0
    private(set) var scrollerKnobTracking = false
    private var warmupNotBefore: CFTimeInterval = 0
    private var warmupDelayWorkItem: DispatchWorkItem?
    private var lastPerfLogTime: CFTimeInterval = 0
    private var totalCellAllocations = 0
    private var sessionMode: SessionMode = .discuss
    private var documentWidth: CGFloat = 0
    private var minimumContentHeight: CGFloat = 0
    private let minimumBottomBreathingRoom: CGFloat = 24
    private var bottomSafeArea: CGFloat = 24
    private var showsOlderSpinner = false
    private var showsNewerSpinner = false
    private let topSpinner = NSProgressIndicator()
    private let bottomSpinner = NSProgressIndicator()

    var onTapSteps: ((MacChatBubbleCell) -> Void)?
    var attachmentStore: AttachmentStore?
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var onOpenImage: ((MacImagePreviewSelection) -> Void)?
    var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    var onHeightInvalidated: (() -> Void)?
    var onWarmedHeightsReady: (() -> Void)?
    var onAnimatedGeometryStep: ((CGFloat) -> Void)?
    var onFullWindowGeometryReady: (() -> Void)?

    var isFullWindowGeometryReady: Bool {
        !contents.isEmpty
            && !warmBatchActive
            && geometryWarmCompleted.count >= validCacheKeys.count
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        for spinner in [topSpinner, bottomSpinner] {
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.isDisplayedWhenStopped = false
            spinner.isHidden = true
            addSubview(spinner)
        }
        codeHighlightObserver = NotificationCenter.default.addObserver(
            forName: .macCodeHighlightReady,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.noteCodeHighlightGeneration()
        }
        observedCodeHighlightGeneration = MacMarkdown.highlightGeneration()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func resetForSessionReuse() {
        warmGeneration += 1
        warmer.cancelAll()
        warmupDelayWorkItem?.cancel()
        warmupDelayWorkItem = nil
        warmBatchReleaseWorkItem?.cancel()
        warmBatchReleaseWorkItem = nil
        heightInvalidationWorkItem?.cancel()
        heightInvalidationWorkItem = nil
        pendingHeightInvalidationKeys.removeAll(keepingCapacity: true)
        stopLiveHeightAnimation()
        warmBatchActive = false
        viewportFillScheduled = false
        let cells = Array(visibleCells.values)
        visibleCells.removeAll()
        visibleSignatures.removeAll()
        for cell in cells { recycle(cell) }
        contents.removeAll(keepingCapacity: true)
        itemKeys.removeAll(keepingCapacity: true)
        itemSignatures.removeAll(keepingCapacity: true)
        indexByKey.removeAll(keepingCapacity: true)
        indexBySeq.removeAll(keepingCapacity: true)
        validCacheKeys.removeAll(keepingCapacity: true)
        itemFrames.removeAll(keepingCapacity: true)
        contentCache.removeAll(keepingCapacity: true)
        heightCache.removeAll(keepingCapacity: true)
        pendingHeights.removeAll(keepingCapacity: true)
        warmEnqueued.removeAll(keepingCapacity: true)
        geometryWarmCompleted.removeAll(keepingCapacity: true)
        warmedGeometryPending = false
        scrollInteractionActive = false
        deferredLiveSnapshot = nil
        codeHighlightUpgradePending = false
        scrollerKnobTracking = false
        lastApplyPrepended = false
        warmupNotBefore = CACurrentMediaTime() + 0.05
        showsOlderSpinner = false
        showsNewerSpinner = false
        topSpinner.stopAnimation(nil)
        bottomSpinner.stopAnimation(nil)
        topSpinner.isHidden = true
        bottomSpinner.isHidden = true
        rebuildFrames()
    }

    func tearDown() {
        resetForSessionReuse()
        if let codeHighlightObserver {
            NotificationCenter.default.removeObserver(codeHighlightObserver)
            self.codeHighlightObserver = nil
        }
        onTapSteps = nil
        attachmentStore = nil
        onResolvePermission = nil
        onAnswerQuestion = nil
        onOpenImage = nil
        onOpenHTMLArtifact = nil
        onHeightInvalidated = nil
        onWarmedHeightsReady = nil
        onAnimatedGeometryStep = nil
        onFullWindowGeometryReady = nil
        for cell in reusePool {
            cell.prepareForReuse()
            cell.removeFromSuperview()
        }
        reusePool.removeAll()
    }

    func setMinimumContentHeight(_ height: CGFloat) {
        let clamped = max(0, height)
        guard abs(minimumContentHeight - clamped) > 0.5 else { return }
        minimumContentHeight = clamped
        rebuildFrames()
    }

    func setBottomSafeArea(_ height: CGFloat) {
        let clamped = max(minimumBottomBreathingRoom, height)
        guard abs(bottomSafeArea - clamped) > 0.5 else { return }
        bottomSafeArea = clamped
        rebuildFrames()
    }

    func setEdgeSpinners(older: Bool, newer: Bool) {
        guard older != showsOlderSpinner || newer != showsNewerSpinner else { return }
        showsOlderSpinner = older
        showsNewerSpinner = newer
        if older { topSpinner.startAnimation(nil) } else { topSpinner.stopAnimation(nil) }
        if newer { bottomSpinner.startAnimation(nil) } else { bottomSpinner.stopAnimation(nil) }
        topSpinner.isHidden = !older
        bottomSpinner.isHidden = !newer
        rebuildFrames()
    }

    @discardableResult
    func deferLiveSnapshotIfNeeded(
        contents newContents: [MacChatItem],
        documentWidth: CGFloat,
        sessionMode: SessionMode
    ) -> Bool {
        guard scrollInteractionActive,
              abs(self.documentWidth - documentWidth) <= 0.5,
              self.sessionMode == sessionMode else { return false }
        let keys = newContents.map(\.key)
        let signatures = newContents.map(\.signature)
        guard itemKeys == keys,
              itemSignatures.count == signatures.count,
              keys.contains("__live__"),
              keys.indices.allSatisfy({ index in
                  keys[index] == "__live__" || itemSignatures[index] == signatures[index]
              }) else { return false }
        deferredLiveSnapshot = (newContents, documentWidth, sessionMode)
        return true
    }

    func apply(
        contents newContents: [MacChatItem],
        documentWidth: CGFloat,
        sessionMode: SessionMode
    ) {
        let oldKeys = itemKeys
        let oldDisplayedHeightByKey = Dictionary(
            uniqueKeysWithValues: zip(oldKeys, itemFrames.map(\.height))
        )
        stopLiveHeightAnimation()
        let oldVisible = visibleCells
        let oldVisibleSignatures = visibleSignatures
        let keys = newContents.map(\.key)
        let signatures = newContents.map(\.signature)
        let onlyLiveRevisionChanged = scrollInteractionActive
            && oldKeys == keys
            && itemSignatures.count == signatures.count
            && keys.indices.allSatisfy { index in
                keys[index] == "__live__" || itemSignatures[index] == signatures[index]
            }
            && keys.contains("__live__")
        if onlyLiveRevisionChanged {
            deferredLiveSnapshot = (newContents, documentWidth, sessionMode)
            return
        }
        deferredLiveSnapshot = nil
        if let oldFirst = oldKeys.first,
           let oldFirstInNew = keys.firstIndex(of: oldFirst) {
            lastApplyPrepended = oldFirstInNew > 0
        } else {
            lastApplyPrepended = false
        }
        let widthChanged = abs(self.documentWidth - documentWidth) > 0.5
        let modeChanged = self.sessionMode != sessionMode

        self.documentWidth = documentWidth
        self.sessionMode = sessionMode
        contents = newContents
        itemKeys = keys
        itemSignatures = signatures
        indexByKey = Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, $0.offset) })
        indexBySeq = Dictionary(
            newContents.enumerated().map { ($0.element.seq, $0.offset) },
            uniquingKeysWith: { _, latest in latest }
        )
        validCacheKeys = Set(newContents.map(cacheKey))

        if widthChanged || modeChanged {
            warmGeneration += 1
            warmer.cancelAll()
            warmupDelayWorkItem?.cancel()
            warmupDelayWorkItem = nil
            warmBatchReleaseWorkItem?.cancel()
            warmBatchReleaseWorkItem = nil
            warmBatchActive = false
            viewportFillScheduled = false
            // The first visible cells are established while hidden. Start
            // preparing their neighbors almost immediately instead of leaving
            // a perceptible placeholder-only grace period.
            warmupNotBefore = CACurrentMediaTime() + 0.05
            warmEnqueued.removeAll(keepingCapacity: true)
            geometryWarmCompleted.removeAll(keepingCapacity: true)
            pendingHeights.removeAll(keepingCapacity: true)
            contentCache.removeAll(keepingCapacity: true)
            heightCache.removeAll(keepingCapacity: true)
        } else {
            warmEnqueued.formIntersection(validCacheKeys)
            geometryWarmCompleted.formIntersection(validCacheKeys)
            pendingHeights = pendingHeights.filter { validCacheKeys.contains($0.key) }
            contentCache = contentCache.filter { validCacheKeys.contains($0.key) }
            heightCache = heightCache.filter { validCacheKeys.contains($0.key) }
        }
        for key in validCacheKeys where heightCache[key] == nil {
            if let cached = Self.exactHeightCache.object(forKey: key as NSString) {
                heightCache[key] = CGFloat(cached.doubleValue)
            }
        }
        // A live card keeps one logical identity while its text revision changes.
        // Carry the currently displayed height into the new signature so a token
        // update never collapses the bubble back to its capped estimate while the
        // next immutable CoreText artifact is warming.
        if let liveIndex = newContents.firstIndex(where: { $0.key == "__live__" }),
           let displayedHeight = oldDisplayedHeightByKey["__live__"] {
            let liveCacheKey = cacheKey(newContents[liveIndex])
            if heightCache[liveCacheKey] == nil {
                heightCache[liveCacheKey] = displayedHeight
            }
        }

        let newIndexByKey = indexByKey
        visibleCells.removeAll(keepingCapacity: true)
        visibleSignatures.removeAll(keepingCapacity: true)
        for (oldIndex, cell) in oldVisible {
            guard oldIndex < oldKeys.count,
                  let newIndex = newIndexByKey[oldKeys[oldIndex]],
                  visibleCells[newIndex] == nil else {
                recycle(cell)
                continue
            }
            visibleCells[newIndex] = cell
            visibleSignatures[newIndex] = oldVisibleSignatures[oldIndex]
        }

        rebuildFrames()
        scheduleFullWindowWarmup()
    }

    private func scheduleFullWindowWarmup() {
        guard !warmBatchActive,
              documentWidth > 1,
              !contents.isEmpty else { return }
        let missing = contents.filter { item in
            let key = cacheKey(item)
            return contentCache[key] == nil || !geometryWarmCompleted.contains(key)
        }
        guard !missing.isEmpty else { return }
        warmBatchActive = true
        let generation = warmGeneration
        let documentWidth = self.documentWidth
        let sessionMode = self.sessionMode
        let jobs = missing.map { item in
            (item: item, key: cacheKey(item))
        }
        warmEnqueued.formUnion(jobs.map(\.key))
        contentWarmQueue.async { [weak self] in
            var results: [(String, MacChatBubbleContent, CGFloat?)] = []
            results.reserveCapacity(jobs.count)
            for job in jobs {
                let content = job.item.makeContent()
                let artifact = content.body.flatMap {
                    MacCoreTextLayoutArtifact.cached(
                        attributed: $0,
                        width: content.bodyTextWidth,
                        key: "\(job.item.key)|\(job.item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
                    )
                }
                let exactHeight: CGFloat? = content.action == nil
                    ? MacChatBubbleCell.height(
                        for: content,
                        bodyHeight: artifact?.height ?? 0
                    )
                    : nil
                results.append((job.key, content, exactHeight))
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let generationMatches = generation == self.warmGeneration
                if generationMatches {
                    for (key, content, exactHeight) in results
                    where self.validCacheKeys.contains(key) {
                        self.cacheContent(content, forKey: key)
                        self.geometryWarmCompleted.insert(key)
                        if let exactHeight {
                            Self.exactHeightCache.setObject(
                                NSNumber(value: Double(exactHeight)),
                                forKey: key as NSString,
                                cost: 16
                            )
                            if abs((self.heightCache[key] ?? 0) - exactHeight) > 0.5 {
                                self.pendingHeights[key] = exactHeight
                            } else {
                                self.heightCache[key] = exactHeight
                            }
                        }
                    }
                }
                self.warmBatchActive = false
                if generationMatches, !self.pendingHeights.isEmpty {
                    self.warmedGeometryPending = true
                    self.onWarmedHeightsReady?()
                }
                if generationMatches, self.isFullWindowGeometryReady {
                    self.onFullWindowGeometryReady?()
                }
                // A snapshot may have arrived while this batch was running.
                // Pick up only its missing keys in the next serial batch.
                self.scheduleFullWindowWarmup()
            }
        }
    }

    func visibleAnchor(at offset: CGFloat) -> (key: String, delta: CGFloat)? {
        guard !itemFrames.isEmpty else { return nil }
        var low = 0
        var high = itemFrames.count
        while low < high {
            let mid = (low + high) / 2
            if itemFrames[mid].maxY < offset {
                low = mid + 1
            } else {
                high = mid
            }
        }
        guard low < itemKeys.count else { return nil }
        return (itemKeys[low], offset - itemFrames[low].minY)
    }

    /// Prefer an already-rendered bubble whose exact height is authoritative.
    /// Loading placeholders and newly configured rows may still change height;
    /// anchoring those would push older real bubbles when geometry settles.
    /// This mirrors iOS's frontDelta rule: preserve existing content, not the
    /// loading row that is being replaced.
    func stableVisibleAnchor(in viewport: NSRect) -> (key: String, delta: CGFloat)? {
        let candidates = visibleCells.compactMap { index, cell -> (Int, CGFloat)? in
            guard index < contents.count,
                  index < itemFrames.count,
                  !cell.isHidden,
                  !cell.isPlaceholderFlag,
                  itemFrames[index].intersects(viewport) else { return nil }
            let signature = cacheKey(contents[index])
            guard visibleSignatures[index] == signature,
                  heightCache[signature] != nil,
                  pendingHeights[signature] == nil else { return nil }
            return (index, abs(itemFrames[index].minY - viewport.minY))
        }
        guard let index = candidates.min(by: { $0.1 < $1.1 })?.0 else { return nil }
        return (itemKeys[index], viewport.minY - itemFrames[index].minY)
    }

    var didLastApplyPrepend: Bool { lastApplyPrepended }

    func frame(forKey key: String) -> NSRect? {
        guard let index = indexByKey[key], index < itemFrames.count else { return nil }
        return itemFrames[index]
    }

    func frame(forSeq seq: Int) -> NSRect? {
        guard let index = indexBySeq[seq], index < itemFrames.count else { return nil }
        return itemFrames[index]
    }

    /// Materialize only the viewport plus a small runway. A scrollbar-thumb
    /// drag may jump across the whole document in one event, so it never does
    /// cold Markdown/TextKit work synchronously; idle warming fills those
    /// caches in 4ms display-link slices, matching the iOS list engine.
    @discardableResult
    func updateVisibleCells(
        in viewport: NSRect,
        runwayOverride: CGFloat? = nil,
        allowColdContent: Bool = false,
        maxConfigurations: Int = 1
    ) -> CGFloat {
        guard documentWidth > 1, viewport.width > 1, viewport.height > 1 else { return 0 }
        let started = CACurrentMediaTime()
        var configuredCount = 0
        var hasPendingVisibleContent = false
        var geometryBarrierReached = false
        var recycledCount = 0
        let allocationsBefore = totalCellAllocations

        // Never synchronously self-size a cold bubble on the scroll path.
        // Configuring the visible cell already lays out its TextKit body; doing
        // a second offscreen MacTextMeasure pass here caused 30–65ms stalls on
        // session entry and on every streaming-card update. Estimated frames
        // remain stable until the idle warmer commits exact heights.

        let runway: CGFloat = runwayOverride
            ?? (scrollerKnobTracking ? 0 : max(viewport.height * 0.5, 240))
        let desired = Set(desiredIndexes(for: viewport, runway: runway))
        let orderedDesired = desired.sorted { lhs, rhs in
            let lhsVisible = itemFrames[lhs].intersects(viewport)
            let rhsVisible = itemFrames[rhs].intersects(viewport)
            if lhsVisible != rhsVisible { return lhsVisible }
            if lhsVisible { return lhs < rhs }
            let lhsDistance = min(
                abs(itemFrames[lhs].maxY - viewport.minY),
                abs(itemFrames[lhs].minY - viewport.maxY)
            )
            let rhsDistance = min(
                abs(itemFrames[rhs].maxY - viewport.minY),
                abs(itemFrames[rhs].minY - viewport.maxY)
            )
            return lhsDistance < rhsDistance
        }
        let staleIndexes = visibleCells.keys.filter { !desired.contains($0) }
        for index in staleIndexes {
            guard let cell = visibleCells.removeValue(forKey: index) else { continue }
            visibleSignatures.removeValue(forKey: index)
            recycle(cell)
            recycledCount += 1
        }

        for index in orderedDesired where index < contents.count && index < itemFrames.count {
            let item = contents[index]
            let signature = cacheKey(item)
            let intersectsViewport = itemFrames[index].intersects(viewport)
            if geometryBarrierReached, intersectsViewport {
                hasPendingVisibleContent = true
                installPlaceholderCellIfNeeded(at: index, item: item)
                continue
            }
            let preparedContent = cachedContent(for: item)
            // Active scrolling may install content prepared ahead of time, one
            // visible cell per invocation. Only a true content-cache miss falls
            // back to a placeholder. Exact height is still committed later.
            if scrollInteractionActive, preparedContent == nil {
                installPlaceholderCellIfNeeded(at: index, item: item)
                if intersectsViewport { geometryBarrierReached = true }
                continue
            }
            let existingCell = visibleCells[index]
            var cell = existingCell
            if visibleSignatures[index] != signature {
                // Streaming-card signatures may change 10–20 times per second.
                // Keep an already-visible cell stable while the user scrolls;
                // the next settled update applies the newest signature once.
                let deferReconfiguration = scrollInteractionActive
                    && existingCell != nil
                    && visibleSignatures[index] != nil
                if !deferReconfiguration {
                    if configuredCount >= maxConfigurations {
                        hasPendingVisibleContent = true
                        installPlaceholderCellIfNeeded(at: index, item: item)
                        if intersectsViewport { geometryBarrierReached = true }
                        continue
                    }
                    let resolved = preparedContent ?? (allowColdContent ? resolvedContent(for: item) : nil)
                    guard let content = resolved else {
                        hasPendingVisibleContent = true
                        installPlaceholderCellIfNeeded(at: index, item: item)
                        if intersectsViewport { geometryBarrierReached = true }
                        continue
                    }
                    if cell == nil {
                        let dequeued = dequeueCell()
                        visibleCells[index] = dequeued
                        cell = dequeued
                    }
                    guard let cell else { continue }
                    let configureStarted = CACurrentMediaTime()
                    configure(cell, with: item, content: content)
                    let configureMs = (CACurrentMediaTime() - configureStarted) * 1_000
                    if configureMs >= 16 {
                        MacChatPerf.slow(
                            "cell-configure seq=\(item.seq) chars=\(item.visibleCharacterCount) "
                                + "ms=\(String(format: "%.1f", configureMs))"
                        )
                    }
                    visibleSignatures[index] = signature
                    // The visible cell has already paid for TextKit layout.
                    // Keep that configured content instead of clearing it back
                    // to a placeholder and repeating the same 20–45ms layout
                    // on the next frame. Exact geometry commits on the next
                    // main-loop turn while the stable viewport anchor is held.
                    let exactHeight = cell.configuredHeight()
                    if abs((heightCache[signature] ?? item.estimatedHeight) - exactHeight) > 0.5 {
                        if !isAnimatingLiveHeight(cacheKey: signature, target: exactHeight) {
                            pendingHeights[signature] = exactHeight
                            if intersectsViewport { geometryBarrierReached = true }
                            if !warmedGeometryPending {
                                warmedGeometryPending = true
                                DispatchQueue.main.async { [weak self] in
                                    guard let self else { return }
                                    self.onWarmedHeightsReady?()
                                }
                            }
                        }
                        visibleSignatures[index] = signature
                    } else {
                        heightCache[signature] = exactHeight
                        Self.exactHeightCache.setObject(
                            NSNumber(value: Double(exactHeight)),
                            forKey: signature as NSString,
                            cost: 16
                        )
                        visibleSignatures[index] = signature
                    }
                    configuredCount += 1
                }
            }
            if intersectsViewport,
               pendingHeights[signature] != nil || heightCache[signature] == nil {
                geometryBarrierReached = true
            }
            guard let cell else { continue }
            cell.frame = itemFrames[index]
            cell.documentWidthVar = documentWidth
            cell.needsLayout = true
            if cell.isHidden {
                // A pooled cell still has the previous bubble's layer backing.
                // Finish color/path/layout before exposing it so Core Animation
                // cannot commit one stale-color frame during session switches.
                cell.layoutSubtreeIfNeeded()
                cell.isHidden = false
            }
        }

        scheduleHeightWarmup(around: viewport)
        if hasPendingVisibleContent, !viewportFillScheduled, !scrollInteractionActive {
            viewportFillScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { [weak self] in
                guard let self else { return }
                self.viewportFillScheduled = false
                guard !self.scrollInteractionActive,
                      let scrollView = self.enclosingScrollView else { return }
                _ = self.updateVisibleCells(
                    in: scrollView.contentView.bounds,
                    runwayOverride: 0
                )
            }
        }
        let elapsedMs = (CACurrentMediaTime() - started) * 1_000
        let now = CACurrentMediaTime()
        if elapsedMs >= 16 {
            MacChatPerf.slow(
                "viewport items=\(contents.count) desired=\(desired.count) "
                    + "configured=\(configuredCount) visible=\(visibleCells.count) "
                    + "ms=\(String(format: "%.1f", elapsedMs))"
            )
        }
        if MacChatPerf.enabled,
           elapsedMs >= 8 || (scrollerKnobTracking && now - lastPerfLogTime >= 0.25) {
            lastPerfLogTime = now
            MacChatPerf.log(
                "viewport thumb=\(scrollerKnobTracking ? 1 : 0) items=\(contents.count) "
                    + "desired=\(desired.count) visible=\(visibleCells.count) "
                    + "measure=0 configure=\(configuredCount) "
                    + "alloc=\(totalCellAllocations - allocationsBefore) recycle=\(recycledCount) "
                    + "warmPending=\(warmer.pendingCount) ms=\(String(format: "%.1f", elapsedMs))"
            )
        }
        return 0
    }

    func initialViewportIsReady(_ viewport: NSRect) -> Bool {
        let visibleIndexes = desiredIndexes(for: viewport, runway: 0).filter {
            $0 < itemFrames.count && itemFrames[$0].intersects(viewport)
        }
        guard !visibleIndexes.isEmpty else { return contents.isEmpty }
        return visibleIndexes.allSatisfy { index in
            guard index < contents.count,
                  let cell = visibleCells[index],
                  !cell.isPlaceholderFlag,
                  !cell.isHidden else { return false }
            let key = cacheKey(contents[index])
            return visibleSignatures[index] == key
                && pendingHeights[key] == nil
                && heightCache[key] != nil
        }
    }

    private func desiredIndexes(for viewport: NSRect, runway: CGFloat) -> [Int] {
        guard !itemFrames.isEmpty else { return [] }
        let targetMinY = max(0, viewport.minY - runway)
        let targetMaxY = viewport.maxY + runway

        var low = 0
        var high = itemFrames.count
        while low < high {
            let mid = (low + high) / 2
            if itemFrames[mid].maxY < targetMinY {
                low = mid + 1
            } else {
                high = mid
            }
        }

        var result: [Int] = []
        var index = low
        while index < itemFrames.count, itemFrames[index].minY <= targetMaxY {
            result.append(index)
            index += 1
        }
        return result
    }

    func beginScrollInteraction(scrollerKnob: Bool) {
        scrollInteractionActive = true
        stopLiveHeightAnimation()
        scrollerKnobTracking = scrollerKnob
        // Content-only warming remains active during scrolling. It never
        // creates offscreen TextKit layout and is limited to one item per
        // display cadence, so it can stay ahead of the viewport without
        // blocking the native gesture.
        if let scrollView = enclosingScrollView {
            scheduleHeightWarmup(around: scrollView.contentView.bounds)
        }
    }

    func endScrollInteraction(in viewport: NSRect) {
        scrollInteractionActive = false
        scrollerKnobTracking = false
        if let deferred = deferredLiveSnapshot {
            deferredLiveSnapshot = nil
            apply(
                contents: deferred.contents,
                documentWidth: deferred.documentWidth,
                sessionMode: deferred.sessionMode
            )
        }
        if codeHighlightUpgradePending {
            scheduleCodeHighlightUpgrade()
        }
        // Preserve completed and in-flight content warming. Cancelling it here
        // discarded exactly the rows the user had just approached and could
        // leave placeholders waiting for a later lifecycle reset.
        _ = commitWarmedHeights()
        _ = updateVisibleCells(in: viewport, runwayOverride: 0)
        warmEnqueued.formUnion(contentCache.keys)
        scheduleHeightWarmup(around: viewport)
        MacChatPerf.log(
            "interaction-end items=\(contents.count) measured=\(heightCache.count) "
                + "visible=\(visibleCells.count) warmPending=\(warmer.pendingCount)"
        )
    }

    private func noteCodeHighlightGeneration() {
        let generation = MacMarkdown.highlightGeneration()
        guard generation != observedCodeHighlightGeneration else { return }
        observedCodeHighlightGeneration = generation
        scheduleCodeHighlightUpgrade()
    }

    private func cacheContent(_ content: MacChatBubbleContent, forKey key: String) {
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

    private func scheduleCodeHighlightUpgrade() {
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
                }
            }
        }
    }

    private func containsProvisionalCode(in attributed: NSAttributedString) -> Bool {
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

    private func isAnimatingLiveHeight(cacheKey: String, target: CGFloat) -> Bool {
        guard let animation = liveHeightAnimation else { return false }
        return animation.cacheKey == cacheKey && abs(animation.to - target) <= 0.5
    }

    private func startLiveHeightAnimation(cacheKey: String, from: CGFloat, to: CGFloat) {
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

    private func advanceLiveHeightAnimation() {
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

    private func stopLiveHeightAnimation() {
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
        // initial 200-row bootstrap be px-trimmed before first presentation;
        // exact heights replace it as cells/warm jobs finish.
        return heightCache[key] ?? pendingHeights[key] ?? item.estimatedHeight
    }

    private func scheduleHeightWarmup(around viewport: NSRect) {
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
                            if abs((self.heightCache[key] ?? item.estimatedHeight) - exactHeight) > 0.5 {
                                self.pendingHeights[key] = exactHeight
                            } else {
                                self.heightCache[key] = exactHeight
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

    private func rebuildFrames() {
        let heights = contents.map { item in
            heightCache[cacheKey(item)] ?? item.estimatedHeight
        }
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
        frame = NSRect(x: 0, y: 0, width: documentWidth, height: max(y, minimumContentHeight))
        if abs(previousFrame.height - frame.height) > 0.5 {
            enclosingScrollView?.needsLayout = true
        }
        for (index, cell) in visibleCells where index < itemFrames.count {
            cell.frame = itemFrames[index]
            cell.documentWidthVar = documentWidth
            cell.needsLayout = true
        }
    }

    private func cacheKey(_ item: MacChatItem) -> String {
        "\(item.key)|\(item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
    }

    private func cachedContent(for item: MacChatItem) -> MacChatBubbleContent? {
        contentCache[cacheKey(item)]
    }

    private func resolvedContent(for item: MacChatItem) -> MacChatBubbleContent {
        let key = cacheKey(item)
        if let cached = contentCache[key] { return cached }
        let content = item.makeContent()
        cacheContent(content, forKey: key)
        return content
    }

    func layoutDiagnostics(viewport: NSRect) -> [String: Any] {
        let indexedCells = visibleCells.compactMap { index, cell -> (Int, MacChatBubbleCell)? in
            guard index < contents.count else { return nil }
            return (index, cell)
        }
        let shown = indexedCells.filter { !$0.1.isHidden && $0.1.alphaValue > 0.01 }
        let intersecting = shown.filter { $0.1.frame.intersects(viewport) }
        let intersectingArtifactCells = shown.filter {
            $0.1.htmlArtifactFrameInSuperview?.intersects(viewport) == true
        }
        let anchor = visibleAnchor(at: viewport.minY)
        var result: [String: Any] = [
            "itemCount": contents.count,
            "visibleCellCount": indexedCells.count,
            "shownCellCount": shown.count,
            "intersectingCellCount": intersecting.count,
            "placeholderCount": shown.filter { $0.1.isPlaceholderFlag }.count,
            "intersectingPlaceholderCount": intersecting.filter { $0.1.isPlaceholderFlag }.count,
            "realCellCount": shown.filter { !$0.1.isPlaceholderFlag }.count,
            "coreTextCellCount": shown.filter { !$0.1.isPlaceholderFlag && $0.1.usesCoreTextBodyFlag }.count,
            "textKitCellCount": shown.filter { !$0.1.isPlaceholderFlag && !$0.1.usesCoreTextBodyFlag }.count,
            "htmlArtifactCardCount": shown.reduce(0) { $0 + $1.1.htmlArtifactCount },
            "intersectingHTMLArtifactCardCount": intersectingArtifactCells.reduce(0) { $0 + $1.1.htmlArtifactCount },
            "documentX": Double(frame.minX), "documentY": Double(frame.minY),
            "documentWidth": Double(frame.width), "documentHeight": Double(frame.height),
            "viewportX": Double(viewport.minX), "viewportY": Double(viewport.minY),
            "viewportWidth": Double(viewport.width), "viewportHeight": Double(viewport.height),
            "exactHeightCount": heightCache.count,
            "preparedContentCount": contentCache.count,
            "geometryWarmCompletedCount": geometryWarmCompleted.count,
            "viewportFillScheduled": viewportFillScheduled,
            "windowWarmActive": warmBatchActive,
            "provisionalContentCount": contentCache.values.reduce(0) { count, content in
                guard let body = content.body else { return count }
                return count + (containsProvisionalCode(in: body) ? 1 : 0)
            },
            "codeHighlightUpgradeActive": codeHighlightUpgradeActive,
            "codeHighlightUpgradePending": codeHighlightUpgradePending,
            "observedCodeHighlightGeneration": observedCodeHighlightGeneration,
            "liveHeightAnimating": liveHeightAnimation != nil,
            "liveHeightTarget": liveHeightAnimation.map { Double($0.to) } ?? NSNull(),
            "bottomSafeArea": Double(bottomSafeArea),
            "olderSpinnerVisible": showsOlderSpinner && !topSpinner.isHidden,
            "newerSpinnerVisible": showsNewerSpinner && !bottomSpinner.isHidden,
            "olderSpinnerFrame": rectDiagnostics(topSpinner.frame, viewport: viewport),
            "newerSpinnerFrame": rectDiagnostics(bottomSpinner.frame, viewport: viewport),
            "cellFrames": intersecting.prefix(12).map { index, cell in
                let artifactFrame = cell.htmlArtifactFrameInSuperview
                return [
                    "seq": contents[index].seq,
                    "index": index,
                    "documentX": Double(cell.frame.minX),
                    "documentY": Double(cell.frame.minY),
                    "screenY": Double(cell.frame.minY - viewport.minY),
                    "width": Double(cell.frame.width),
                    "height": Double(cell.frame.height),
                    "hidden": cell.isHidden,
                    "alpha": Double(cell.alphaValue),
                    "placeholder": cell.isPlaceholderFlag,
                    "coreText": cell.usesCoreTextBodyFlag,
                    "live": cell.isLiveFlag,
                    "cellObjectID": String(describing: ObjectIdentifier(cell)),
                    "renderRevision": cell.renderRevision,
                    "provisionalCodeHighlight": cell.hasProvisionalCodeHighlight,
                    "htmlArtifactCount": cell.htmlArtifactCount,
                    "htmlArtifactIDs": cell.htmlArtifactIDs,
                    "htmlArtifactScreenY": artifactFrame.map { Double($0.minY - viewport.minY) } ?? NSNull(),
                    "htmlArtifactHeight": artifactFrame.map { Double($0.height) } ?? NSNull(),
                ] as [String: Any]
            },
        ]
        if let anchor,
           let index = indexByKey[anchor.key],
           index < contents.count {
            result["anchorSeq"] = contents[index].seq
            result["anchorDelta"] = Double(anchor.delta)
        }
        return result
    }

    private func rectDiagnostics(_ rect: NSRect, viewport: NSRect) -> [String: Double] {
        [
            "documentX": Double(rect.minX),
            "documentY": Double(rect.minY),
            "screenY": Double(rect.minY - viewport.minY),
            "width": Double(rect.width),
            "height": Double(rect.height),
        ]
    }

    func actionHitTarget(
        atWindowPoint point: NSPoint
    ) -> MacBubbleActionHitTarget? {
        for (_, cell) in visibleCells.sorted(by: { $0.key > $1.key })
        where !cell.isHidden && !cell.isPlaceholderFlag {
            if let target = cell.actionHitTarget(atWindowPoint: point) {
                return target
            }
        }
        return nil
    }

    func actionCapture(atWindowPoint point: NSPoint) -> MacBubbleActionCapture? {
        actionCaptureContext(atWindowPoint: point)?.capture
    }

    func actionCaptureContext(
        atWindowPoint point: NSPoint
    ) -> MacBubbleActionCaptureContext? {
        for (_, cell) in visibleCells.sorted(by: { $0.key > $1.key })
        where !cell.isHidden && !cell.isPlaceholderFlag {
            if let context = cell.actionCaptureContext(atWindowPoint: point) {
                return context
            }
        }
        return nil
    }

    func actionHitTarget(
        for capture: MacBubbleActionCapture,
        atActionPoint point: NSPoint
    ) -> MacBubbleActionHitTarget? {
        for (_, cell) in visibleCells.sorted(by: { $0.key > $1.key })
        where !cell.isHidden && !cell.isPlaceholderFlag {
            if let target = cell.actionHitTarget(for: capture, atActionPoint: point) {
                return target
            }
        }
        return nil
    }

    @discardableResult
    func openVisibleHTMLArtifact(id: String? = nil) -> Bool {
        let viewport = enclosingScrollView?.contentView.bounds ?? bounds
        for (_, cell) in visibleCells.sorted(by: { $0.key < $1.key })
        where !cell.isHidden && cell.htmlArtifactFrameInSuperview?.intersects(viewport) == true {
            if cell.openHTMLArtifact(id: id) { return true }
        }
        return false
    }

    @discardableResult
    func captureVisibleHTMLArtifactCard(to path: String) -> Bool {
        let viewport = enclosingScrollView?.contentView.bounds ?? bounds
        for (_, cell) in visibleCells.sorted(by: { $0.key < $1.key })
        where !cell.isHidden && cell.htmlArtifactFrameInSuperview?.intersects(viewport) == true {
            if cell.captureHTMLArtifactCard(to: path) { return true }
        }
        return false
    }

    private func installPlaceholderCellIfNeeded(at index: Int, item: MacChatItem) {
        guard visibleCells[index] == nil, index < itemFrames.count else { return }
        let cell = dequeueCell()
        visibleCells[index] = cell
        cell.configurePlaceholder(
            documentWidth: documentWidth,
            estimatedHeight: item.estimatedHeight
        )
        cell.frame = itemFrames[index]
        cell.documentWidthVar = documentWidth
        cell.layoutSubtreeIfNeeded()
        cell.isHidden = false
    }

    private func dequeueCell() -> MacChatBubbleCell {
        if let cell = reusePool.popLast() {
            return cell
        }
        totalCellAllocations += 1
        let cell = MacChatBubbleCell(frame: .zero)
        cell.isHidden = true
        addSubview(cell)
        return cell
    }

    private func recycle(_ cell: MacChatBubbleCell) {
        cell.isHidden = true
        if reusePool.count < 16 {
            reusePool.append(cell)
        } else {
            cell.prepareForReuse()
            cell.removeFromSuperview()
        }
    }

    private func configure(
        _ cell: MacChatBubbleCell,
        with item: MacChatItem,
        content: MacChatBubbleContent? = nil
    ) {
        cell.configure(
            content: content ?? resolvedContent(for: item),
            renderKey: cacheKey(item),
            documentWidth: documentWidth,
            sessionMode: sessionMode,
            attachmentStore: attachmentStore,
            onTapSteps: { [weak self] cell in self?.onTapSteps?(cell) },
            onResolvePermission: { [weak self] id, tool, decision in
                self?.onResolvePermission?(id, tool, decision)
            },
            onAnswerQuestion: { [weak self] id, answer in
                self?.onAnswerQuestion?(id, answer)
            },
            onOpenImage: { [weak self] selection in
                self?.onOpenImage?(selection)
            },
            onOpenHTMLArtifact: { [weak self] artifact in
                self?.onOpenHTMLArtifact?(artifact)
            },
            onHeightInvalidated: { [weak self, weak cell] in
                guard let self, let cell else { return }
                self.scheduleHeightInvalidation(for: cell)
            }
        )
    }

    /// SwiftUI image/artifact hosts can invalidate their intrinsic height from
    /// inside `NSHostingView.layout()`. Re-entering Chat layout synchronously
    /// from that callback trips AppKit's layout-recursion guard. Coalesce all
    /// invalidations onto the next main-loop turn and invalidate by stable
    /// render key so cell reuse cannot target the wrong bubble.
    private func scheduleHeightInvalidation(for cell: MacChatBubbleCell) {
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

struct MacChatItem {
    let seq: Int
    let key: String
    let signature: String
    let estimatedHeight: CGFloat
    let visibleCharacterCount: Int
    let makeContent: () -> MacChatBubbleContent

    init(
        seq: Int = 0,
        key: String,
        signature: String,
        estimatedHeight: CGFloat,
        visibleCharacterCount: Int = 0,
        makeContent: @escaping () -> MacChatBubbleContent
    ) {
        self.seq = seq
        self.key = key
        self.signature = signature
        self.estimatedHeight = estimatedHeight
        self.visibleCharacterCount = visibleCharacterCount
        self.makeContent = makeContent
    }
}

/// Keeps an AppKit overlay scroller invisible at rest, reveals it immediately
/// for user scrolling, then fades it after the interaction settles. This is
/// intentionally app-controlled so the Session and Chat lists behave the same
/// even when macOS is configured to always show scroll bars.
final class MacTransientOverlayScrollerController {
    private weak var scrollView: NSScrollView?
    private weak var observedVerticalScroller: NSScroller?
    private var hideWorkItem: DispatchWorkItem?
    private var finishFadeWorkItem: DispatchWorkItem?
    private var fadeGeneration = 0
    private var interactionActive = false
    private var requestedVisible = false
    private var liveScrollStartObserver: NSObjectProtocol?
    private var liveScrollObserver: NSObjectProtocol?
    private var liveScrollEndObserver: NSObjectProtocol?
    private var preferredStyleObserver: NSObjectProtocol?

    deinit {
        hideWorkItem?.cancel()
        finishFadeWorkItem?.cancel()
        for observer in [
            liveScrollStartObserver,
            liveScrollObserver,
            liveScrollEndObserver,
            preferredStyleObserver,
        ].compactMap({ $0 }) {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func attach(to scrollView: NSScrollView) {
        guard self.scrollView !== scrollView else {
            applyConfiguration()
            return
        }
        detachObservers()
        self.scrollView = scrollView
        observedVerticalScroller = nil
        applyConfiguration()
        hideImmediately()

        let center = NotificationCenter.default
        liveScrollStartObserver = center.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.interactionActive = true
            self?.reveal(scheduleHide: false)
        }
        liveScrollObserver = center.addObserver(
            forName: NSScrollView.didLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.reveal(scheduleHide: false)
        }
        liveScrollEndObserver = center.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: scrollView,
            queue: .main
        ) { [weak self] _ in
            self?.interactionActive = false
            self?.scheduleHide()
        }
        preferredStyleObserver = center.addObserver(
            forName: NSScroller.preferredScrollerStyleDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.async { self?.applyConfiguration() }
        }
    }

    func noteScrollEvent(_ event: NSEvent) {
        guard abs(event.scrollingDeltaY) > 0.01 || abs(event.scrollingDeltaX) > 0.01 else { return }
        reveal(scheduleHide: !interactionActive)
    }

    func hideImmediately() {
        hideWorkItem?.cancel()
        finishFadeWorkItem?.cancel()
        fadeGeneration += 1
        requestedVisible = false
        guard let scroller = scrollView?.verticalScroller else { return }
        scroller.layer?.removeAllAnimations()
        scroller.alphaValue = 0
        scroller.isEnabled = false
    }

    private func reveal(scheduleHide: Bool) {
        requestedVisible = true
        applyConfiguration()
        hideWorkItem?.cancel()
        finishFadeWorkItem?.cancel()
        fadeGeneration += 1
        guard let scroller = scrollView?.verticalScroller else { return }
        scroller.layer?.removeAllAnimations()
        scroller.isHidden = false
        scroller.isEnabled = true
        scroller.alphaValue = 1
        scrollView?.flashScrollers()
        if scheduleHide { self.scheduleHide() }
    }

    private func scheduleHide() {
        guard !interactionActive else { return }
        hideWorkItem?.cancel()
        let generation = fadeGeneration + 1
        fadeGeneration = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  generation == self.fadeGeneration,
                  !self.interactionActive,
                  let scroller = self.scrollView?.verticalScroller else { return }
            self.requestedVisible = false
            scroller.isEnabled = false
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.22
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                scroller.animator().alphaValue = 0
            }
            let finish = DispatchWorkItem { [weak self] in
                guard let self,
                      generation == self.fadeGeneration,
                      !self.interactionActive else { return }
                self.scrollView?.verticalScroller?.alphaValue = 0
                self.scrollView?.verticalScroller?.isEnabled = false
            }
            self.finishFadeWorkItem = finish
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: finish)
        }
        hideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55, execute: work)
    }

    private func applyConfiguration() {
        guard let scrollView else { return }
        scrollView.scrollerStyle = .overlay
        scrollView.autohidesScrollers = false
        if !scrollView.hasVerticalScroller { scrollView.hasVerticalScroller = true }
        scrollView.verticalScroller?.scrollerStyle = .overlay
        scrollView.verticalScroller?.wantsLayer = true
        if let scroller = scrollView.verticalScroller {
            if scroller !== observedVerticalScroller {
                observedVerticalScroller = scroller
            }
            if requestedVisible {
                scroller.isHidden = false
                scroller.alphaValue = 1
                scroller.isEnabled = true
            } else {
                scroller.alphaValue = 0
                scroller.isEnabled = false
            }
        }
    }

    private func detachObservers() {
        let center = NotificationCenter.default
        for observer in [
            liveScrollStartObserver,
            liveScrollObserver,
            liveScrollEndObserver,
            preferredStyleObserver,
        ].compactMap({ $0 }) {
            center.removeObserver(observer)
        }
        liveScrollStartObserver = nil
        liveScrollObserver = nil
        liveScrollEndObserver = nil
        preferredStyleObserver = nil
    }
}

/// AppKit production chat list mirroring the iOS flat-spine list behavior.
/// Adds a short AppKit animation to discrete mouse-wheel ticks while leaving
/// precise trackpad deltas on the native scrolling path.
final class MacSmoothWheelController {
    private weak var scrollView: NSScrollView?
    private var targetY: CGFloat?
    private var completionWorkItem: DispatchWorkItem?
    private var generation = 0
    var onActivityChanged: ((Bool) -> Void)?
    var onTargetChanged: ((CGFloat) -> Void)?

    func handle(_ event: NSEvent, in scrollView: NSScrollView) -> Bool {
        guard !event.hasPreciseScrollingDeltas,
              abs(event.scrollingDeltaY) > 0.01,
              abs(event.scrollingDeltaX) < abs(event.scrollingDeltaY) else {
            reset()
            return false
        }

        if self.scrollView !== scrollView {
            reset()
            self.scrollView = scrollView
        }
        let currentY = targetY ?? scrollView.contentView.bounds.origin.y
        // AppKit's default verticalLineScroll is commonly only 10pt. That is
        // appropriate when AppKit applies a full native wheel sequence, but it
        // feels abnormally slow when each discrete notch is routed through our
        // animator. Use roughly three native lines per notch, with a 36pt floor.
        let lineDistance = max(scrollView.verticalLineScroll * 3, 36)
        let minimumY = -scrollView.contentInsets.top
        let maximumY = max(
            minimumY,
            (scrollView.documentView?.frame.height ?? 0)
                - scrollView.contentView.bounds.height
                + scrollView.contentInsets.bottom
        )
        let nextY = min(
            maximumY,
            max(minimumY, currentY - event.scrollingDeltaY * lineDistance)
        )
        guard abs(nextY - currentY) > 0.01 else { return true }

        targetY = nextY
        onTargetChanged?(nextY)
        completionWorkItem?.cancel()
        generation += 1
        onActivityChanged?(true)
        let currentGeneration = generation
        let target = NSPoint(x: scrollView.contentView.bounds.origin.x, y: nextY)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.09
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            scrollView.contentView.animator().bounds.origin = target
        }
        let completion = DispatchWorkItem { [weak self, weak scrollView] in
            guard let self,
                  let scrollView,
                  currentGeneration == self.generation else { return }
            self.targetY = nil
            self.onTargetChanged?(scrollView.contentView.bounds.minY)
            self.onActivityChanged?(false)
        }
        completionWorkItem = completion
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10, execute: completion)
        return true
    }

    func reset() {
        let wasActive = targetY != nil
        completionWorkItem?.cancel()
        completionWorkItem = nil
        targetY = nil
        generation += 1
        if wasActive { onActivityChanged?(false) }
    }
}

private final class MacChatScroller: NSScroller {
    var onKnobTrackingChanged: ((Bool) -> Void)?

    override class var isCompatibleWithOverlayScrollers: Bool {
        self == MacChatScroller.self
    }

    override func trackKnob(with event: NSEvent) {
        onKnobTrackingChanged?(true)
        defer { onKnobTrackingChanged?(false) }
        super.trackKnob(with: event)
    }
}

class MacSmoothScrollView: NSScrollView {
    private let smoothWheelController = MacSmoothWheelController()
    private let transientScrollerController = MacTransientOverlayScrollerController()

    var onSmoothWheelActivityChanged: ((Bool) -> Void)? {
        didSet { smoothWheelController.onActivityChanged = onSmoothWheelActivityChanged }
    }
    var onSmoothWheelTargetChanged: ((CGFloat) -> Void)? {
        didSet { smoothWheelController.onTargetChanged = onSmoothWheelTargetChanged }
    }

    func configureTransientOverlayScroller() {
        transientScrollerController.attach(to: self)
    }

    func resetSmoothWheelAnimation() {
        smoothWheelController.reset()
        contentView.layer?.removeAllAnimations()
        transientScrollerController.hideImmediately()
    }

    override func scrollWheel(with event: NSEvent) {
        transientScrollerController.noteScrollEvent(event)
        if smoothWheelController.handle(event, in: self) { return }
        super.scrollWheel(with: event)
    }
}

final class MacChatScrollView: MacSmoothScrollView {
    let chatDocumentView = MacChatDocumentView()

    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set { super.scrollerStyle = .overlay }
    }

    private(set) var followingBottom = true
    private var bottomContentInset: CGFloat = 0
    private let topContentInset: CGFloat = 0
    private var loadingOlder = false
    private var loadingNewer = false
    private var hasUnloadedNewer = false
    private var suppressPagingForBottom = false
    private var suppressNewerPagingAfterOlder = false
    /// Programmatic initial layout / reanchoring must not masquerade as a user
    /// scroll at the top edge. Paging is enabled only after the first usable
    /// viewport has been laid out and the run loop has settled.
    private var allowsEdgePaging = false
    private var entryBottomLocked = true
    private var lastDocumentWidth: CGFloat = 0
    private var liveScrollObserver: NSObjectProtocol?
    private var liveScrollEndObserver: NSObjectProtocol?
    private var liveScrollActive = false
    private var knobScrollActive = false
    private var discreteWheelActive = false
    private var scrollSettlePending = false
    private var scrollSettleWorkItem: DispatchWorkItem?
    private var deferredEdgePaging = false
    private var thumbViewportUpdateScheduled = false
    private var thumbViewportGeneration = 0
    private var snapshotApplyActive = false
    private var suppressRunwayForNextReflect = false
    private var olderEdgeArmed = true
    private(set) var hasUserScrolled = false
    private var initialTailTrimRequested = false
    private(set) var representedSessionId: String?
    private var geometryAnchorLock: (key: String, delta: CGFloat)?
    private var bubbleActionMouseMonitor: Any?
    private var pendingBubbleActionClick: (
        target: MacBubbleActionHitTarget?,
        capture: MacBubbleActionCapture,
        start: NSPoint,
        cancelled: Bool
    )?

    private let jumpMaterial = NSVisualEffectView()
    private let jumpButton = NSButton()

    var onJumpToLatest: (() -> Void)?
    var onScrolledNearTop: (() -> Void)?
    var onScrolledNearBottom: (() -> Void)?
    var onRenderedHeightsSettled: (() -> Void)?
    var onFirstUsableLayout: (() -> Void)?
    var canTrimTailWindow = false {
        didSet { requestInitialTailTrimIfReady() }
    }

    private func requestInitialTailTrimIfReady() {
        guard canTrimTailWindow,
              !hasUserScrolled,
              !initialTailTrimRequested,
              chatDocumentView.isFullWindowGeometryReady else { return }
        initialTailTrimRequested = true
        onRenderedHeightsSettled?()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        drawsBackground = true
        backgroundColor = NSColor(Color.surfacePrimary)
        borderType = .noBorder
        let chatScroller = MacChatScroller()
        chatScroller.onKnobTrackingChanged = { [weak self] tracking in
            if tracking {
                self?.entryBottomLocked = false
                self?.allowsEdgePaging = true
                self?.beginScrollInteraction(scrollerKnob: true)
            } else {
                self?.endScrollInteraction(scrollerKnob: true)
            }
        }
        verticalScroller = chatScroller
        scrollerStyle = .overlay
        hasVerticalScroller = true
        autohidesScrollers = false
        verticalPageScroll = 40
        onSmoothWheelActivityChanged = { [weak self] active in
            guard let self else { return }
            self.discreteWheelActive = active
            if active {
                self.entryBottomLocked = false
                self.allowsEdgePaging = true
                self.chatDocumentView.beginScrollInteraction(scrollerKnob: self.knobScrollActive)
            } else {
                self.settleScrollInteractionIfIdle()
            }
        }
        onSmoothWheelTargetChanged = { [weak self] targetY in
            self?.prefetchOlderIfNeeded(proposedY: targetY)
        }
        automaticallyAdjustsContentInsets = false
        contentInsets.top = topContentInset
        scrollerInsets.top = topContentInset
        documentView = chatDocumentView
        chatDocumentView.frame = NSRect(x: 0, y: 0, width: frameRect.width, height: 0)
        configureTransientOverlayScroller()

        liveScrollObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: self,
            queue: .main
        ) { [weak self] _ in
            self?.beginScrollInteraction(scrollerKnob: false)
        }
        liveScrollEndObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: self,
            queue: .main
        ) { [weak self] _ in
            self?.endScrollInteraction(scrollerKnob: false)
        }

        chatDocumentView.onWarmedHeightsReady = { [weak self] in
            guard let self else { return }
            self.commitWarmedHeightsPreservingViewport()
            _ = self.chatDocumentView.updateVisibleCells(
                in: self.contentView.bounds,
                runwayOverride: 0
            )
        }
        chatDocumentView.onAnimatedGeometryStep = { [weak self] delta in
            self?.applyAnimatedLiveHeightStep(delta)
        }
        chatDocumentView.onFullWindowGeometryReady = { [weak self] in
            self?.requestInitialTailTrimIfReady()
        }

        jumpMaterial.material = .popover
        jumpMaterial.blendingMode = .withinWindow
        jumpMaterial.state = .active
        jumpMaterial.wantsLayer = true
        jumpMaterial.layer?.cornerRadius = 15
        jumpMaterial.layer?.masksToBounds = true
        jumpMaterial.layer?.borderWidth = 0.5
        jumpMaterial.isHidden = true
        addSubview(jumpMaterial)

        jumpButton.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: "Jump to latest")
        jumpButton.imagePosition = .imageOnly
        jumpButton.isBordered = false
        jumpButton.target = self
        jumpButton.action = #selector(jumpTapped)
        jumpButton.isHidden = true
        jumpButton.setAccessibilityLabel("Jump to latest")
        addSubview(jumpButton)

        bubbleActionMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            self?.interceptBubbleActionMouseEvent(event) ?? event
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        chatDocumentView.tearDown()
        if let bubbleActionMouseMonitor {
            NSEvent.removeMonitor(bubbleActionMouseMonitor)
        }
        if let liveScrollObserver {
            NotificationCenter.default.removeObserver(liveScrollObserver)
        }
        if let liveScrollEndObserver {
            NotificationCenter.default.removeObserver(liveScrollEndObserver)
        }
    }

    private func interceptBubbleActionMouseEvent(_ event: NSEvent) -> NSEvent? {
        guard let window,
              event.windowNumber == window.windowNumber,
              !isHidden,
              alphaValue > 0.01 else { return event }
        let windowPoint = event.locationInWindow

        switch event.type {
        case .leftMouseDown:
            guard let context = chatDocumentView.actionCaptureContext(
                atWindowPoint: windowPoint
            ) else {
                pendingBubbleActionClick = nil
                return event
            }
            let capture = context.capture
            let target = chatDocumentView.actionHitTarget(
                for: capture,
                atActionPoint: context.actionPoint
            )
            // SwiftUI propagates rendered choice frames asynchronously. Capture
            // the whole interactive action region while that cache is empty so
            // a zoomed click never falls through to SwiftUI's shifted hit test.
            pendingBubbleActionClick = (target, capture, windowPoint, false)
            return nil

        case .leftMouseDragged:
            guard var pending = pendingBubbleActionClick else { return event }
            if hypot(windowPoint.x - pending.start.x, windowPoint.y - pending.start.y) > 5 {
                pending.cancelled = true
                pendingBubbleActionClick = pending
            }
            return nil

        case .leftMouseUp:
            guard let pending = pendingBubbleActionClick else { return event }
            pendingBubbleActionClick = nil
            guard !pending.cancelled,
                  let context = chatDocumentView.actionCaptureContext(
                    atWindowPoint: windowPoint
                  ),
                  context.capture == pending.capture else {
                return nil
            }
            if let expectedTarget = pending.target {
                guard chatDocumentView.actionHitTarget(
                    for: pending.capture,
                    atActionPoint: context.actionPoint
                  ) == expectedTarget else { return nil }
                dispatchBubbleAction(expectedTarget)
            } else {
                dispatchBubbleActionWhenReady(
                    atActionPoint: context.actionPoint,
                    expectedCapture: pending.capture
                )
            }
            return nil

        default:
            return event
        }
    }

    private func dispatchBubbleAction(_ target: MacBubbleActionHitTarget) {
        let answerCallback = chatDocumentView.onAnswerQuestion
        let permissionCallback = chatDocumentView.onResolvePermission
        DispatchQueue.main.async {
            switch target {
            case .question(let target):
                answerCallback?(target.questionId, target.answer)
            case .permission(let target):
                permissionCallback?(target.permissionId, target.toolName, target.decision)
            }
        }
    }

    private func dispatchBubbleActionWhenReady(
        atActionPoint point: NSPoint,
        expectedCapture: MacBubbleActionCapture,
        attemptsRemaining: Int = 8
    ) {
        if let target = chatDocumentView.actionHitTarget(
            for: expectedCapture,
            atActionPoint: point
        ) {
            dispatchBubbleAction(target)
            return
        }
        guard attemptsRemaining > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 120.0) { [weak self] in
            self?.dispatchBubbleActionWhenReady(
                atActionPoint: point,
                expectedCapture: expectedCapture,
                attemptsRemaining: attemptsRemaining - 1
            )
        }
    }

    func prepareForSession(_ sessionId: String) {
        guard representedSessionId != sessionId else { return }
        representedSessionId = sessionId
        resetSmoothWheelAnimation()
        scrollSettleWorkItem?.cancel()
        scrollSettleWorkItem = nil
        scrollSettlePending = false
        liveScrollActive = false
        knobScrollActive = false
        discreteWheelActive = false
        deferredEdgePaging = false
        thumbViewportGeneration += 1
        thumbViewportUpdateScheduled = false
        pendingBubbleActionClick = nil
        snapshotApplyActive = false
        suppressRunwayForNextReflect = false
        olderEdgeArmed = true
        hasUserScrolled = false
        initialTailTrimRequested = false
        allowsEdgePaging = false
        entryBottomLocked = true
        loadingOlder = false
        loadingNewer = false
        hasUnloadedNewer = false
        suppressPagingForBottom = false
        suppressNewerPagingAfterOlder = false
        followingBottom = true
        canTrimTailWindow = false
        geometryAnchorLock = nil
        onFirstUsableLayout = nil
        chatDocumentView.resetForSessionReuse()
        contentView.bounds.origin = NSPoint(x: 0, y: -topContentInset)
        alphaValue = 0
        setAgentTint(sessionId: sessionId)
        updateJumpButtonVisibility(animated: false)
    }

    /// Apply a SwiftUI snapshot as one visual transaction. NSScrollView can
    /// synchronously reflect a document-frame mutation before the caller has
    /// restored its visible anchor; suppress those intermediate callbacks so a
    /// prepend cannot commit one frame at the unanchored offset.
    func performAtomicSnapshot(_ updates: () -> Void) {
        snapshotApplyActive = true
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        NSAnimationContext.current.allowsImplicitAnimation = false
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        updates()
        if chatDocumentView.lastApplyPrepended {
            // The preserved viewport consists of already-existing cells. Do not
            // synchronously configure the newly-prepended half-screen runway on
            // the pagination landing frame; the idle warmer prepares it after
            // the anchor is visible and stable.
            suppressRunwayForNextReflect = true
        }
        chatDocumentView.layoutSubtreeIfNeeded()
        contentView.layoutSubtreeIfNeeded()
        layoutSubtreeIfNeeded()
        snapshotApplyActive = false
        CATransaction.commit()
        NSAnimationContext.endGrouping()
        reflectScrolledClipView(contentView)
    }

    private var isScrollInteractionActive: Bool {
        liveScrollActive || knobScrollActive || discreteWheelActive || scrollSettlePending
    }

    private var hasDirectScrollInteraction: Bool {
        liveScrollActive || knobScrollActive || discreteWheelActive
    }

    private func beginScrollInteraction(scrollerKnob: Bool) {
        scrollSettleWorkItem?.cancel()
        scrollSettleWorkItem = nil
        scrollSettlePending = false
        geometryAnchorLock = nil
        hasUserScrolled = true
        entryBottomLocked = false
        followingBottom = false
        allowsEdgePaging = true
        if scrollerKnob {
            knobScrollActive = true
        } else {
            liveScrollActive = true
        }
        chatDocumentView.beginScrollInteraction(scrollerKnob: knobScrollActive)
    }

    private func endScrollInteraction(scrollerKnob: Bool) {
        if scrollerKnob {
            knobScrollActive = false
        } else {
            liveScrollActive = false
        }
        scheduleScrollSettleIfIdle()
    }

    private func scheduleScrollSettleIfIdle() {
        guard !hasDirectScrollInteraction else {
            settleScrollInteractionIfIdle()
            return
        }
        scrollSettleWorkItem?.cancel()
        scrollSettlePending = true
        // AppKit may emit didEndLiveScroll between two adjacent trackpad
        // phases. Keep the list in scroll-protection mode across that tiny gap
        // so a live Markdown revision cannot start a 60 Hz height animation or
        // atomic snapshot immediately before the next gesture packet arrives.
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.scrollSettleWorkItem = nil
            self.scrollSettlePending = false
            self.settleScrollInteractionIfIdle()
        }
        scrollSettleWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
    }

    private func settleScrollInteractionIfIdle() {
        if hasDirectScrollInteraction {
            chatDocumentView.beginScrollInteraction(scrollerKnob: knobScrollActive)
            return
        }
        if scrollSettlePending { return }
        thumbViewportGeneration += 1
        thumbViewportUpdateScheduled = false
        commitWarmedHeightsPreservingViewport(restartWarmup: true)
        // Materialize only the actual landing viewport. A normal half-screen
        // runway can include several huge cold Markdown rows and synchronously
        // stall the first settled frame for hundreds of milliseconds.
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds, runwayOverride: 0)
        adoptStableGeometryAnchorIfNeeded()
        if deferredEdgePaging {
            deferredEdgePaging = false
            driveEdgePagingIfNeeded(in: contentView)
        }
    }

    private func commitWarmedHeightsPreservingViewport(restartWarmup: Bool = false) {
        let viewport = contentView.bounds
        let fallbackAnchor = chatDocumentView.stableVisibleAnchor(in: viewport)
            ?? chatDocumentView.visibleAnchor(at: viewport.minY)
        let anchor = geometryAnchorForMutation(fallback: fallbackAnchor)
        let oldHeight = chatDocumentView.frame.height
        if restartWarmup {
            chatDocumentView.endScrollInteraction(in: viewport)
        } else {
            guard chatDocumentView.commitWarmedHeights(animateLive: alphaValue > 0.99) else { return }
        }
        let heightDelta = chatDocumentView.frame.height - oldHeight
        if followingBottom || isEntryBottomLocked, abs(heightDelta) > 0.5 {
            contentView.bounds.origin.y += heightDelta
        } else if let anchor,
                  let frame = chatDocumentView.frame(forKey: anchor.key) {
            contentView.bounds.origin.y = frame.minY + anchor.delta
        }
        super.reflectScrolledClipView(contentView)
        adoptStableGeometryAnchorIfNeeded()
    }

    private func applyAnimatedLiveHeightStep(_ delta: CGFloat) {
        guard abs(delta) > 0.001 else { return }
        if followingBottom || isEntryBottomLocked {
            contentView.bounds.origin.y += delta
        }
        chatDocumentView.layoutSubtreeIfNeeded()
        super.reflectScrolledClipView(contentView)
        updateJumpButtonVisibility(animated: false)
    }

    func geometryAnchorForMutation(
        fallback: (key: String, delta: CGFloat)?
    ) -> (key: String, delta: CGFloat)? {
        if let geometryAnchorLock,
           chatDocumentView.frame(forKey: geometryAnchorLock.key) != nil {
            return geometryAnchorLock
        }
        geometryAnchorLock = fallback
        return fallback
    }

    private func adoptStableGeometryAnchorIfNeeded() {
        if let geometryAnchorLock,
           chatDocumentView.frame(forKey: geometryAnchorLock.key) != nil {
            return
        }
        geometryAnchorLock = chatDocumentView.stableVisibleAnchor(in: contentView.bounds)
    }

    func setAgentTint(sessionId: String) {
        let tint = NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hue = stringToHue(sessionId) / 360
            let hsb = hslToHSB(h: hue, s: dark ? 0.75 : 0.70, l: dark ? 0.65 : 0.45)
            return NSColor(calibratedHue: hsb.0, saturation: hsb.1, brightness: hsb.2, alpha: 1)
        }
        jumpButton.contentTintColor = tint
        jumpMaterial.layer?.borderColor = tint.withAlphaComponent(0.25).cgColor
    }

    override func layout() {
        super.layout()
        configureTransientOverlayScroller()
        let width = contentSize.width
        if abs(width - lastDocumentWidth) > 0.5 {
            lastDocumentWidth = width
        }
        chatDocumentView.setMinimumContentHeight(
            max(0, contentSize.height - topContentInset)
        )
        onFirstUsableLayout?()
        if isEntryBottomLocked, distanceToBottom > 0.5 {
            let bottom = max(
                -topContentInset,
                chatDocumentView.frame.height - contentView.bounds.height
            )
            contentView.bounds.origin.y = bottom
            followingBottom = true
        }
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds)
        let jumpFrame = NSRect(
            x: bounds.width - 16 - 52,
            y: bounds.height - bottomContentInset - 16 - 30,
            width: 52,
            height: 30
        )
        jumpMaterial.frame = jumpFrame
        jumpButton.frame = jumpFrame
    }

    @objc private func jumpTapped() {
        geometryAnchorLock = nil
        suppressNewerPagingAfterOlder = false
        suppressPagingForBottom = true
        // Always act on the live AppKit list immediately. Previously the button
        // only set a flag for the next SwiftUI update; when the model was already
        // at authoritative head no update occurred, so the button did nothing.
        scrollToBottom(animated: true)
        onJumpToLatest?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.suppressPagingForBottom = false
        }
    }

    func setBottomContentInset(_ inset: CGFloat) {
        guard abs(bottomContentInset - inset) > 0.5 else { return }
        let wasPinned = isPinnedToBottom || isEntryBottomLocked
        bottomContentInset = max(0, inset)
        // The Chat viewport and scrollbar remain full-height. The Composer is a
        // completely independent overlay; a fixed document footer reserves its
        // base 62pt footprint plus 16pt of visible breathing room.
        contentInsets.bottom = 0
        scrollerInsets.bottom = 0
        // Add one point of rounding tolerance so a 24pt visible gap remains
        // at least 24pt after CoreText/backing-scale pixel quantization.
        chatDocumentView.setBottomSafeArea(bottomContentInset + 25)
        needsLayout = true
        if wasPinned { scrollToBottom(animated: false) }
        updateJumpButtonVisibility(animated: false)
    }

    func setLoading(
        older: Bool,
        newer: Bool,
        fetchingOlder: Bool,
        fetchingNewer: Bool
    ) {
        loadingOlder = fetchingOlder
        loadingNewer = fetchingNewer
        hasUnloadedNewer = newer
        chatDocumentView.setEdgeSpinners(older: older, newer: newer)
        updateJumpButtonVisibility(animated: false)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 116 || event.keyCode == 115 || event.keyCode == 126 {
            geometryAnchorLock = nil
            entryBottomLocked = false
            allowsEdgePaging = true
        }
        super.keyDown(with: event)
    }

    @discardableResult
    func automationScrollToBubble(seq: Int, screenY: CGFloat = 96) -> Bool {
        guard let frame = chatDocumentView.frame(forSeq: seq) else { return false }
        geometryAnchorLock = nil
        hasUserScrolled = true
        resetSmoothWheelAnimation()
        entryBottomLocked = false
        followingBottom = false
        allowsEdgePaging = true
        let minimumY = -contentInsets.top
        let maximumY = max(minimumY, chatDocumentView.frame.height - contentView.bounds.height)
        contentView.bounds.origin.y = min(maximumY, max(minimumY, frame.minY - screenY))
        super.reflectScrolledClipView(contentView)
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds, runwayOverride: 0)
        return true
    }

    func automationScroll(direction: String, ticks: Int) -> (before: CGFloat, after: CGFloat) {
        geometryAnchorLock = nil
        hasUserScrolled = true
        if direction == "down" { suppressNewerPagingAfterOlder = false }
        resetSmoothWheelAnimation()
        entryBottomLocked = false
        allowsEdgePaging = true
        let before = contentView.bounds.minY
        let minimumY = -contentInsets.top
        let maximumY = max(
            minimumY,
            chatDocumentView.frame.height - contentView.bounds.height
        )
        let distance = CGFloat(max(ticks, 1)) * max(verticalLineScroll * 3, 36)
        let signedDistance = direction == "down" ? distance : -distance
        let target = min(maximumY, max(minimumY, before + signedDistance))
        discreteWheelActive = true
        chatDocumentView.beginScrollInteraction(scrollerKnob: false)
        contentView.bounds.origin.y = target
        reflectScrolledClipView(contentView)
        discreteWheelActive = false
        settleScrollInteractionIfIdle()
        return (before, contentView.bounds.minY)
    }

    override func scrollWheel(with event: NSEvent) {
        geometryAnchorLock = nil
        hasUserScrolled = true
        if event.scrollingDeltaY < -0.01 {
            suppressNewerPagingAfterOlder = false
        }
        entryBottomLocked = false
        followingBottom = false
        allowsEdgePaging = true
        super.scrollWheel(with: event)
    }

    override func reflectScrolledClipView(_ clipView: NSClipView) {
        let started = CACurrentMediaTime()
        if NSApp.currentEvent?.type == .leftMouseDragged {
            entryBottomLocked = false
            allowsEdgePaging = true
        }
        super.reflectScrolledClipView(clipView)
        // `MacChatDocumentView.apply` changes the document frame before the
        // representable restores its anchor. Ignore AppKit's synchronous
        // reflection of that intermediate geometry; the atomic snapshot emits
        // one final reflect after the anchor and cells are settled.
        if snapshotApplyActive { return }
        if chatDocumentView.scrollerKnobTracking {
            scheduleThumbViewportUpdate()
            deferredEdgePaging = true
            followingBottom = isEntryBottomLocked || distanceToBottom <= 24
            updateJumpButtonVisibility(animated: false)
            return
        }
        let oldHeight = chatDocumentView.frame.height
        let runwayOverride: CGFloat? = suppressRunwayForNextReflect ? 0 : nil
        suppressRunwayForNextReflect = false
        let anchorShift = chatDocumentView.updateVisibleCells(
            in: clipView.bounds,
            runwayOverride: runwayOverride
        )
        if followingBottom || isEntryBottomLocked {
            let delta = chatDocumentView.frame.height - oldHeight
            if abs(delta) > 0.5 {
                clipView.bounds.origin.y += delta
                super.reflectScrolledClipView(clipView)
            }
        } else if abs(anchorShift) > 0.5 {
            clipView.bounds.origin.y += anchorShift
            super.reflectScrolledClipView(clipView)
        }
        if isScrollInteractionActive {
            // Prefetch as soon as a live trackpad/wheel gesture reaches the
            // edge. Waiting for didEndLiveScroll makes long momentum gestures
            // appear stuck at the top even though history is available.
            deferredEdgePaging = true
            driveEdgePagingIfNeeded(in: clipView)
        } else {
            driveEdgePagingIfNeeded(in: clipView)
        }
        followingBottom = isEntryBottomLocked || distanceToBottom <= 24
        updateJumpButtonVisibility(animated: true)
        let elapsedMs = (CACurrentMediaTime() - started) * 1_000
        if elapsedMs >= 8 {
            MacChatPerf.log(
                "reflect interaction=\(isScrollInteractionActive ? 1 : 0) "
                    + "offset=\(Int(clipView.bounds.minY)) document=\(Int(chatDocumentView.frame.height)) "
                    + "ms=\(String(format: "%.1f", elapsedMs))"
            )
        }
    }

    private func scheduleThumbViewportUpdate() {
        guard !thumbViewportUpdateScheduled else { return }
        thumbViewportUpdateScheduled = true
        let generation = thumbViewportGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { [weak self] in
            guard let self else { return }
            self.thumbViewportUpdateScheduled = false
            guard generation == self.thumbViewportGeneration,
                  self.chatDocumentView.scrollerKnobTracking else { return }
            _ = self.chatDocumentView.updateVisibleCells(in: self.contentView.bounds)
        }
    }

    private func prefetchOlderIfNeeded(proposedY: CGFloat) {
        if proposedY > 640 {
            olderEdgeArmed = true
        }
        if allowsEdgePaging,
           olderEdgeArmed,
           !suppressPagingForBottom,
           proposedY <= max(320, contentView.bounds.height * 2),
           !loadingOlder {
            olderEdgeArmed = false
            suppressNewerPagingAfterOlder = true
            onScrolledNearTop?()
        }
    }

    private func driveEdgePagingIfNeeded(in clipView: NSClipView) {
        // A completed prepend should move the preserved anchor safely away from
        // the trigger band. Require that departure before another page can
        // fire; this prevents store expansion from releasing its single-flight
        // guard and immediately loading a second page against stale geometry.
        prefetchOlderIfNeeded(proposedY: clipView.bounds.minY)
        if allowsEdgePaging,
           !suppressPagingForBottom,
           !suppressNewerPagingAfterOlder,
           distanceToBottom <= 320,
           hasUnloadedNewer,
           !loadingNewer {
            onScrolledNearBottom?()
        }
    }

    var edgePagingDiagnostics: [String: Any] {
        [
            "allowsEdgePaging": allowsEdgePaging,
            "olderEdgeArmed": olderEdgeArmed,
            "loadingOlder": loadingOlder,
            "hasUserScrolled": hasUserScrolled,
            "discreteWheelActive": discreteWheelActive,
            "liveScrollActive": liveScrollActive,
        ]
    }

    var distanceToBottom: CGFloat {
        max(0, chatDocumentView.frame.height - contentView.bounds.maxY)
    }

    var isPinnedToBottom: Bool { distanceToBottom <= 24 }
    var isEntryBottomLocked: Bool { entryBottomLocked }

    private func updateJumpButtonVisibility(animated: Bool) {
        let farFromBottom = distanceToBottom > 1.5 * max(contentView.bounds.height, 1)
        let shouldShow = farFromBottom || hasUnloadedNewer
        guard shouldShow != !jumpButton.isHidden else { return }
        if shouldShow {
            jumpButton.isHidden = false
            jumpMaterial.isHidden = false
        }
        let changes = {
            self.jumpButton.alphaValue = shouldShow ? 1 : 0
            self.jumpMaterial.alphaValue = shouldShow ? 1 : 0
        }
        let completion = {
            if !shouldShow {
                self.jumpButton.isHidden = true
                self.jumpMaterial.isHidden = true
            }
        }
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                changes()
            } completionHandler: { completion() }
        } else {
            changes()
            completion()
        }
    }

    /// Establish Session entry atomically: position the estimated document at
    /// latest, materialize/layout the bottom cells, then position again using
    /// their promoted exact heights. Callers keep the list hidden until this
    /// returns, so users never see an intermediate anchor or corrective jump.
    func establishInitialBottom(allowColdContent: Bool) {
        guard contentView.bounds.width > 1, contentView.bounds.height > 1 else { return }
        let mayBuildColdEntry = allowColdContent && !allowsEdgePaging
        // A Session transition is a hidden presentation transaction. Fully
        // establish only the actual viewport, commit exact CoreText heights,
        // and re-anchor before exposing the list. Ordinary scrolling still
        // installs at most one cold cell per frame.
        for _ in 0..<12 {
            scrollToBottom(animated: false)
            _ = chatDocumentView.updateVisibleCells(
                in: contentView.bounds,
                runwayOverride: 0,
                allowColdContent: mayBuildColdEntry,
                maxConfigurations: .max
            )
            _ = chatDocumentView.commitWarmedHeights()
            scrollToBottom(animated: false)
            chatDocumentView.layoutSubtreeIfNeeded()
            contentView.layoutSubtreeIfNeeded()
            if chatDocumentView.initialViewportIsReady(contentView.bounds) { break }
        }
    }

    func scrollToBottom(animated: Bool) {
        geometryAnchorLock = nil
        guard chatDocumentView.frame.height > 0 else { return }
        let bottom = max(
            -topContentInset,
            chatDocumentView.frame.height - contentView.bounds.height
        )
        let point = NSPoint(x: 0, y: bottom)
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                contentView.animator().bounds.origin = point
            }
        } else {
            contentView.bounds.origin = point
        }
        followingBottom = true
        updateJumpButtonVisibility(animated: animated)
        reflectScrolledClipView(contentView)
    }
}

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
    let bottomContentInset: CGFloat
    let isLoadingOlder: Bool
    let isLoadingNewer: Bool
    let atOldest: Bool
    let atNewest: Bool
    let onJumpToLatest: () -> Void
    let onLoadOlder: () -> Void
    let onLoadNewer: () -> Void
    let onOpenSteps: (Int, Bool) -> Void
    let onResolvePermission: (String, String?, String) -> Void
    let onAnswerQuestion: (String, String) -> Void
    let onOpenImage: (MacImagePreviewSelection) -> Void
    let onOpenHTMLArtifact: (ContentRef) -> Void

    func makeNSView(context: Context) -> MacChatScrollView {
        let scrollView = MacChatScrollView(frame: .zero)
        // Do not expose the estimated top/anchor that NSScrollView starts with.
        // First usable layout performs an atomic bottom establishment below.
        scrollView.alphaValue = 0
        scrollView.prepareForSession(sessionId)
        // A compact desktop tail is enough for several screens; older history
        // is restored from SQLite when the user reaches the top edge.
        messageStore.maxWindowPx = 4_800
        messageStore.heightForSeq = { [weak documentView = scrollView.chatDocumentView] sid, seq in
            guard sid == sessionId else { return 0 }
            return documentView?.measuredHeight(forSeq: seq) ?? 0
        }
        MacChatPerf.log("make session=\(sessionId.prefix(12)) pxWindow=4800")
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
        scrollView.onScrolledNearTop = nil
        scrollView.onScrolledNearBottom = nil
        scrollView.onRenderedHeightsSettled = nil
        scrollView.onFirstUsableLayout = nil
        scrollView.chatDocumentView.onOpenImage = nil
        scrollView.chatDocumentView.attachmentStore = nil
        scrollView.chatDocumentView.onOpenHTMLArtifact = nil
    }

    func updateNSView(_ scrollView: MacChatScrollView, context: Context) {
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
            scrollView.prepareForSession(sessionId)
        }
        messageStore.maxWindowPx = 4_800
        messageStore.heightForSeq = { [weak documentView = scrollView.chatDocumentView] sid, seq in
            guard sid == sessionId else { return 0 }
            return documentView?.measuredHeight(forSeq: seq) ?? 0
        }
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
        let builtItems = buildContents(coordinator: context.coordinator)
        let buildMs = (CACurrentMediaTime() - buildStarted) * 1_000
        if scrollView.chatDocumentView.deferLiveSnapshotIfNeeded(
            contents: builtItems,
            documentWidth: max(documentWidth, 1),
            sessionMode: sessionMode
        ) {
            return
        }
        let oldOffset = scrollView.contentView.bounds.minY
        let viewport = scrollView.contentView.bounds
        let fallbackAnchor = scrollView.chatDocumentView.stableVisibleAnchor(in: viewport)
            ?? scrollView.chatDocumentView.visibleAnchor(at: oldOffset)
        let visibleAnchor = scrollView.geometryAnchorForMutation(fallback: fallbackAnchor)
        let wasPinned = scrollView.isPinnedToBottom
            || scrollView.isEntryBottomLocked
            || context.coordinator.firstLayout

        scrollView.performAtomicSnapshot {
            scrollView.chatDocumentView.apply(
                contents: builtItems,
                documentWidth: max(documentWidth, 1),
                sessionMode: sessionMode
            )
            scrollView.setBottomContentInset(bottomContentInset)
            let hasPageableContent = !builtItems.isEmpty
            scrollView.setLoading(
                // An empty Session has no edge rows to paginate. Until now its
                // unknown edge flags mounted both the older and newer spinners
                // underneath the intentional empty-state message.
                older: hasPageableContent && !atOldest,
                newer: hasPageableContent && !atNewest,
                fetchingOlder: isLoadingOlder,
                fetchingNewer: isLoadingNewer
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
                scrollView.scrollToBottom(animated: context.coordinator.forcePinOnNextUpdate)
                context.coordinator.forcePinOnNextUpdate = false
            } else if let visibleAnchor,
                      let frame = scrollView.chatDocumentView.frame(forKey: visibleAnchor.key) {
                let minimumY = -scrollView.contentInsets.top
                let target = max(minimumY, frame.minY + visibleAnchor.delta)
                scrollView.contentView.bounds.origin.y = target
            }
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
            if message.type == "turn_status" || message.type == "interrupted_turn" {
                let card = frozenCard(from: message)
                item = MacChatItem(
                    seq: message.seq,
                    key: "frozen:\(message.id)",
                    signature: signature,
                    estimatedHeight: estimatedHeight(for: message),
                    visibleCharacterCount: utf8Length(message.interruptedDraft ?? message.content ?? message.result),
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
        if let liveCard, !liveCard.text.isEmpty || liveCard.action != nil {
            items.append(MacChatItem(
                seq: liveTraceSeq,
                key: "__live__",
                signature: liveCardSignature(liveCard),
                estimatedHeight: estimatedHeight(forText: liveCard.text, hasAction: liveCard.action != nil),
                visibleCharacterCount: liveCard.text.utf8.count,
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
            ))
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
            hasher.combine(action.answer ?? "")
            hasher.combine(action.payload["decision"]?.stringValue ?? "")
            hasher.combine(action.payload["success"]?.boolValue ?? false)
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

    private func frozenCard(from message: ChatMessage) -> MessageStore.SessionCard {
        let text = message.interruptedDraft ?? ""
        let action: ChatMessage?
        if message.type == "turn_status" {
            if let terminal = message.terminalAction, let type = terminal["type"]?.stringValue {
                action = ChatMessage(
                    type: type,
                    seq: 0,
                    sessionId: message.sessionId,
                    deviceId: message.deviceId,
                    timestamp: message.timestamp,
                    payload: terminal["payload"]?.dictValue ?? [:]
                )
            } else {
                action = nil
            }
        } else {
            let processLost = message.payload["reason"]?.stringValue == "process_lost"
            action = ChatMessage(
                type: processLost ? "failed" : "user_abort",
                seq: 0,
                sessionId: message.sessionId,
                deviceId: message.deviceId,
                timestamp: message.timestamp,
                payload: processLost ? ["message": AnyCodable("Agent process was lost")] : [:]
            )
        }
        return MessageStore.SessionCard(text: text, action: action)
    }
}
#endif
