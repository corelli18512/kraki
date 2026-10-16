/// The Mac chat document view: items, frames, visible cells and their placement (see the +Cells/+Heights/+Diagnostics extensions).

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

final class MacChatDocumentView: NSView {
    override var isFlipped: Bool { true }

    static let exactHeightCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 2_048
        cache.totalCostLimit = 2 * 1024 * 1024
        return cache
    }()

    private(set) var itemKeys: [String] = []
    private(set) var lastApplyPrepended = false
    /// Bubbles newly added at the tail by the latest apply that should make an
    /// entrance (user from the trailing edge, AI from the leading edge).
    var lastApplyEntrances = 0
    /// Entrance pending until the bubble's cell is first shown on screen.
    var pendingEntrances: [String: (fromTrailing: Bool, deadline: CFTimeInterval)] = [:]
    static let entranceDuration: CFTimeInterval = 0.32
    static let entranceOffset: CGFloat = 48
    private(set) var lastApplyAppendedReplies = 0

    #if DEBUG
    var automationVisibleCells: [(key: String, cell: MacChatBubbleCell)] {
        visibleCells.sorted { $0.key < $1.key }.compactMap { index, cell in
            index < contents.count ? (contents[index].key, cell) : nil
        }
    }
    #endif

    /// Seqs the reader sees plus one viewport of margin on each side: the
    /// message window must not trim them.
    func retainedSeqRange(around viewport: NSRect) -> ClosedRange<Int>? {
        let expanded = viewport.insetBy(dx: 0, dy: -viewport.height)
        let seqs = desiredIndexes(for: expanded, runway: 0)
            .filter { $0 < contents.count && contents[$0].key != "__live__" }
            .map { contents[$0].seq }
            .filter { $0 > 0 }
        guard let low = seqs.min(), let high = seqs.max() else { return nil }
        return low...high
    }

    var latestItemIsUser: Bool { contents.last?.isUser == true }

    /// Document frames of AI replies, oldest first.
    var replyFrames: [(key: String, frame: NSRect)] {
        contents.indices.compactMap { index in
            guard contents[index].isReply, index < itemFrames.count else { return nil }
            return (contents[index].key, itemFrames[index])
        }
    }
    private var itemSignatures: [String] = []
    /// Cache key → row height a correcting voice bubble may not drop below.
    /// While correction streams, `corrected prefix + raw tail` can wrap to one
    /// line fewer and back again; the row keeps its size (it may grow) until
    /// the input leaves `correcting`, as on iOS (`allowShrink: !correcting`).
    var correctingHeightFloor: [String: CGFloat] = [:]
    var indexByKey: [String: Int] = [:]
    var indexBySeq: [Int: Int] = [:]
    var validCacheKeys: Set<String> = []
    var contents: [MacChatItem] = []
    var contentsSnapshotBeforeApply: [MacChatItem] = []
    var itemFrames: [NSRect] = []
    var visibleCells: [Int: MacChatBubbleCell] = [:]
    var visibleSignatures: [Int: String] = [:]
    var reusePool: [MacChatBubbleCell] = []
    var contentCache: [String: MacChatBubbleContent] = [:]
    var heightCache: [String: CGFloat] = [:]
    var pendingHeights: [String: CGFloat] = [:]
    // Content warming never creates offscreen TextKit layout. It only builds
    // attributed content, one item per display cadence, so nearby rows are
    // ready before they enter the viewport without batching work onto a frame.
    let warmer = HeightMeasurementScheduler(
        budgetMs: 4.0,
        maxJobsPerTick: 1,
        tickInterval: 1.0 / 60.0
    )
    let contentWarmQueue = DispatchQueue(
        label: "chat.kraki.mac.content-artifact",
        qos: .userInitiated
    )
    var warmEnqueued: Set<String> = []
    var geometryWarmCompleted: Set<String> = []
    var warmGeneration = 0
    var warmBatchActive = false
    private var warmBatchReleaseWorkItem: DispatchWorkItem?
    var viewportFillScheduled = false
    var warmedGeometryPending = false
    var heightInvalidationWorkItem: DispatchWorkItem?
    var pendingHeightInvalidationKeys: Set<String> = []
    struct LiveHeightAnimation {
        let cacheKey: String
        let from: CGFloat
        let to: CGFloat
        let startedAt: CFTimeInterval
        let duration: CFTimeInterval
    }
    var liveHeightAnimation: LiveHeightAnimation?
    var liveHeightAnimationTimer: Timer?
    var scrollInteractionActive = false
    private var codeHighlightObserver: NSObjectProtocol?
    var codeHighlightUpgradeActive = false
    var codeHighlightUpgradePending = false
    var observedCodeHighlightGeneration = 0
    private(set) var scrollerKnobTracking = false
    var warmupNotBefore: CFTimeInterval = 0
    var warmupDelayWorkItem: DispatchWorkItem?
    private var lastPerfLogTime: CFTimeInterval = 0
    var totalCellAllocations = 0
    var sessionMode: SessionMode = .auto
    var documentWidth: CGFloat = 0
    var minimumContentHeight: CGFloat = 0
    private let minimumBottomBreathingRoom: CGFloat = 24
    var bottomSafeArea: CGFloat = 24
    /// Floating Composer growth above its resting footprint (scroll reach
    /// only, never the newest edge): MacChatScrollView+ComposerOverlay.swift.
    var composerOverlay: CGFloat = 0
    var showsOlderSpinner = false
    var showsNewerSpinner = false
    let topSpinner = NSProgressIndicator()
    let bottomSpinner = NSProgressIndicator()

    var onTapSteps: ((MacChatBubbleCell) -> Void)?
    var attachmentStore: AttachmentStore?
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var onPendingAction: ((String, MacPendingAction) -> Void)?
    var onOpenImage: ((MacImagePreviewSelection) -> Void)?
    var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    var onHeightInvalidated: (() -> Void)?
    var onWarmedHeightsReady: (() -> Void)?
    var onAnimatedGeometryStep: ((CGFloat) -> Void)?
    var onFullWindowGeometryReady: (() -> Void)?

    // Older pages are prepared off-main *before* they enter the document, so
    // a fast fling that is already waiting at the top edge never exposes
    // placeholder rows (the spinner simply stays ~one frame longer).
    private var stagedContent: [String: MacChatBubbleContent] = [:]
    private var stagingInFlight: Set<String> = []
    private var stagingCompletions: [() -> Void] = []

    /// Items (by cache key at the current width/mode) not yet prepared.
    func unpreparedItems(_ items: [MacChatItem], documentWidth: CGFloat, sessionMode: SessionMode) -> [MacChatItem] {
        guard abs(self.documentWidth - documentWidth) <= 0.5, self.sessionMode == sessionMode else { return [] }
        return items.filter { item in
            let key = cacheKey(item)
            return contentCache[key] == nil && stagedContent[key] == nil
        }
    }

    func stage(_ items: [MacChatItem], completion: @escaping () -> Void) {
        stagingCompletions.append(completion)
        let jobs = items.map { (item: $0, key: cacheKey($0)) }.filter { !stagingInFlight.contains($0.key) }
        guard !jobs.isEmpty else { return }
        stagingInFlight.formUnion(jobs.map(\.key))
        let documentWidth = self.documentWidth
        let sessionMode = self.sessionMode
        contentWarmQueue.async { [weak self] in
            var results: [(String, MacChatBubbleContent, CGFloat?)] = []
            for job in jobs {
                let content = job.item.makeContent()
                let artifact = content.body.flatMap {
                    MacCoreTextLayoutArtifact.cached(
                        attributed: $0,
                        width: content.bodyTextWidth,
                        key: "\(job.item.key)|\(job.item.signature)|\(Int(documentWidth.rounded()))|\(sessionMode.rawValue)"
                    )
                }
                let exact: CGFloat? = content.action == nil
                    ? MacChatBubbleCell.height(for: content, bodyHeight: artifact?.height ?? 0)
                    : nil
                results.append((job.key, content, exact))
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for (key, content, exact) in results {
                    self.stagingInFlight.remove(key)
                    self.stagedContent[key] = content
                    if let exact {
                        Self.exactHeightCache.setObject(NSNumber(value: Double(exact)), forKey: key as NSString, cost: 16)
                    }
                }
                guard self.stagingInFlight.isEmpty else { return }
                let completions = self.stagingCompletions
                self.stagingCompletions.removeAll()
                completions.forEach { $0() }
            }
        }
    }

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
        pendingEntrances.removeAll()
        lastApplyEntrances = 0
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
    func apply(
        contents newContents: [MacChatItem],
        documentWidth: CGFloat,
        sessionMode: SessionMode
    ) {
        let oldKeys = itemKeys
        contentsSnapshotBeforeApply = contents
        defer { contentsSnapshotBeforeApply = [] }
        let oldDisplayedHeightByKey = Dictionary(
            zip(oldKeys, itemFrames.map(\.height)),
            uniquingKeysWith: { first, _ in first }
        )
        let oldSignatureByKey = Dictionary(zip(oldKeys, itemSignatures), uniquingKeysWith: { a, _ in a })
        // Only an exact, settled height can become a correcting floor; an
        // estimate must never be locked in.
        var oldExactHeightByKey: [String: CGFloat] = [:]
        for (index, item) in contents.enumerated() where index < itemFrames.count && item.key.contains(":pending:") {
            let key = cacheKey(item)
            if heightCache[key] != nil, pendingHeights[key] == nil {
                oldExactHeightByKey[item.key] = itemFrames[index].height
            }
        }
        stopLiveHeightAnimation()
        let oldVisible = visibleCells
        let oldVisibleSignatures = visibleSignatures
        let keys = newContents.map(\.key)
        let signatures = newContents.map(\.signature)
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
        indexByKey = Dictionary(keys.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
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
        for (key, content) in stagedContent where validCacheKeys.contains(key) && !widthChanged && !modeChanged {
            cacheContent(content, forKey: key)
            geometryWarmCompleted.insert(key)
        }
        stagedContent = stagedContent.filter { !validCacheKeys.contains($0.key) }
        for key in validCacheKeys where heightCache[key] == nil {
            if let cached = Self.exactHeightCache.object(forKey: key as NSString) {
                heightCache[key] = CGFloat(cached.doubleValue)
            }
        }
        primeNewShortIdentities(oldKeys: oldKeys)
        primeRewrittenRows(oldSignatureByKey: oldSignatureByKey, oldDisplayedHeightByKey: oldDisplayedHeightByKey)
        updateCorrectingFloors(oldExactHeightByKey: widthChanged || modeChanged ? [:] : oldExactHeightByKey)
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

        // Live → landed handoff: the persisted answer replaces the live card
        // in the same snapshot. Until its own content is prepared, it keeps the
        // live bubble's exact height and rendered cell, so the tail never
        // flashes an estimated placeholder or jumps.
        var handoffIndex: Int?
        if !keys.contains("__live__"),
           oldKeys.contains("__live__"),
           let liveHeight = oldDisplayedHeightByKey["__live__"] {
            let oldKeySet = Set(oldKeys)
            if let landed = newContents.indices.last(where: { !oldKeySet.contains(newContents[$0].key) }),
               landed == newContents.count - 1 || newContents[(landed + 1)...].allSatisfy({ oldKeySet.contains($0.key) }) {
                let landedKey = cacheKey(newContents[landed])
                if heightCache[landedKey] == nil { heightCache[landedKey] = liveHeight }
                handoffIndex = landed
            }
        }

        // Replies that landed after the previous tail (as on iOS: the live card
        // itself is not counted; its landed answer is).
        let newKeyIndex = Dictionary(keys.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { a, _ in a })
        if let survivingTail = oldKeys.reversed().lazy.compactMap({ newKeyIndex[$0] }).first {
            let oldKeySet = Set(oldKeys)
            lastApplyAppendedReplies = newContents[(survivingTail + 1)...].filter {
                $0.isReply && $0.key != "__live__" && !oldKeySet.contains($0.key)
            }.count
        } else {
            lastApplyAppendedReplies = 0
        }
        recordEntrances(oldKeys: oldKeys, newContents: newContents)

        let newIndexByKey = indexByKey
        visibleCells.removeAll(keepingCapacity: true)
        visibleSignatures.removeAll(keepingCapacity: true)
        for (oldIndex, cell) in oldVisible {
            if oldIndex < oldKeys.count, oldKeys[oldIndex] == "__live__",
               let handoffIndex, visibleCells[handoffIndex] == nil {
                visibleCells[handoffIndex] = cell
                visibleSignatures[handoffIndex] = oldVisibleSignatures[oldIndex]
                continue
            }
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
    #if DEBUG
    var entranceLog: [(key: String, fromTrailing: Bool, at: CFTimeInterval)] = []
    #endif

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

    func latestItemFrame() -> NSRect? {
        itemFrames.last
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
        MacChatCost.measure("updateVisibleCells") {
            updateVisibleCellsBody(in: viewport, runwayOverride: runwayOverride,
                                   allowColdContent: allowColdContent, maxConfigurations: maxConfigurations)
        }
    }

    private func updateVisibleCellsBody(
        in viewport: NSRect,
        runwayOverride: CGFloat?,
        allowColdContent: Bool,
        maxConfigurations: Int
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
            var preparedContent = cachedContent(for: item)
            // A short visible row that the warmer has not reached yet is
            // cheaper to prepare right now (~1–3ms, one per pass) than to show
            // as a grey placeholder for a few frames of a very fast glide.
            if scrollInteractionActive, preparedContent == nil, intersectsViewport,
               !geometryBarrierReached, configuredCount < maxConfigurations,
               item.visibleCharacterCount <= 1_500 {
                preparedContent = resolvedContent(for: item)
            }
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
                // The live card is the exception: its prepared revision is
                // installed immediately so streaming stays live under a
                // scrolling reader (as on iOS).
                let deferReconfiguration = scrollInteractionActive
                    && existingCell != nil
                    && visibleSignatures[index] != nil
                    && !(item.key == "__live__" && preparedContent != nil)
                if !deferReconfiguration {
                    // Installing already-prepared content costs ~0.3ms; a fast
                    // glide can bring several rows in per frame, so prepared
                    // rows share a 6ms budget instead of the one-per-pass cap
                    // (which showed them as placeholders for a frame or two).
                    let preparedWithinBudget = preparedContent != nil
                        && (CACurrentMediaTime() - started) * 1_000 < 6
                    if configuredCount >= maxConfigurations, !preparedWithinBudget {
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
                    if stageConfiguredHeight(cell, for: item, cacheKey: signature) {
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
                    configuredCount += 1
                }
            }
            if intersectsViewport,
               pendingHeights[signature] != nil || heightCache[signature] == nil {
                geometryBarrierReached = true
            }
            guard let cell else { continue }
            if !cell.isPlaceholderFlag,
               visibleSignatures[index] == signature,
               pendingHeights[signature] == nil,
               stageConfiguredHeight(cell, for: item, cacheKey: signature) {
                if intersectsViewport { geometryBarrierReached = true }
                if !warmedGeometryPending {
                    warmedGeometryPending = true
                    DispatchQueue.main.async { [weak self] in
                        self?.onWarmedHeightsReady?()
                    }
                }
            }
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
            if !pendingEntrances.isEmpty, !cell.isPlaceholderFlag {
                runEntranceIfPending(cell, key: item.key, onScreen: intersectsViewport)
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

    func desiredIndexes(for viewport: NSRect, runway: CGFloat) -> [Int] {
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
}

struct MacChatItem {
    let seq: Int
    let key: String
    let signature: String
    let estimatedHeight: CGFloat
    let visibleCharacterCount: Int
    /// An AI reply (answer, frozen terminal card, live card): the ↑ control
    /// steps through these and new ones light the ↓ unseen dot.
    let isReply: Bool
    /// The user's own message (landed or still pending). At the conversation
    /// bottom the ↑ control hides while the latest item is one of these.
    let isUser: Bool
    let makeContent: () -> MacChatBubbleContent

    init(
        seq: Int = 0,
        key: String,
        signature: String,
        estimatedHeight: CGFloat,
        visibleCharacterCount: Int = 0,
        isReply: Bool = false,
        isUser: Bool = false,
        makeContent: @escaping () -> MacChatBubbleContent
    ) {
        self.seq = seq
        self.key = key
        self.signature = signature
        self.estimatedHeight = estimatedHeight
        self.visibleCharacterCount = visibleCharacterCount
        self.isReply = isReply
        self.isUser = isUser
        self.makeContent = makeContent
    }
}
#endif
