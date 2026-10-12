/// Bubble cells of the Mac chat document: entrance animations, full-window warm-up, cell reuse and configuration.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatDocumentView {
    /// New tail bubbles get an entrance; a bubble that only changes identity
    /// does not: the live card landing as its answer (or a frozen card), and a
    /// pending input landing as its user_message, remove an old tail item of
    /// the same role in the same snapshot, so they are treated as replacements.
    func recordEntrances(oldKeys: [String], newContents: [MacChatItem]) {
        lastApplyEntrances = 0
        let now = CACurrentMediaTime()
        pendingEntrances = pendingEntrances.filter { $0.value.deadline > now }
        guard !oldKeys.isEmpty, !lastApplyPrepended else { return }
        let newKeySet = Set(newContents.map(\.key))
        let oldKeySet = Set(oldKeys)
        let oldItemsByKey = Dictionary(contentsSnapshotBeforeApply.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var removedUser = 0, removedReply = 0
        for key in oldKeys where !newKeySet.contains(key) {
            guard let item = oldItemsByKey[key] else { continue }
            if item.isUser { removedUser += 1 } else if item.isReply { removedReply += 1 }
        }
        // Only the tail: items after the last surviving old item.
        guard let survivingTail = newContents.lastIndex(where: { oldKeySet.contains($0.key) }) else { return }
        let appended = newContents[(survivingTail + 1)...].filter { $0.isUser || $0.isReply }
        // A catch-up burst (reconnect, newer page) is not a conversation beat.
        guard !appended.isEmpty, appended.count <= 2 else { return }
        for item in appended {
            if item.isUser {
                if removedUser > 0 { removedUser -= 1; continue }
            } else if removedReply > 0 {
                removedReply -= 1; continue
            }
            pendingEntrances[item.key] = (item.isUser, now + 0.8)
            lastApplyEntrances += 1
        }
    }

    /// Runs a pending entrance the first time the bubble is on screen. It is
    /// a Core Animation presentation-only transform/opacity, never the view
    /// frame, so frame and height updates during streaming never fight it.
    func runEntranceIfPending(_ cell: MacChatBubbleCell, key: String, onScreen: Bool) {
        guard onScreen, let entrance = pendingEntrances.removeValue(forKey: key),
              entrance.deadline > CACurrentMediaTime() else { return }
        cell.wantsLayer = true
        guard let layer = cell.layer else { return }
        let timing = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
        let slide = CABasicAnimation(keyPath: "transform.translation.x")
        slide.fromValue = (entrance.fromTrailing ? 1 : -1) * Self.entranceOffset
        slide.toValue = 0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        let group = CAAnimationGroup()
        group.animations = [slide, fade]
        group.duration = Self.entranceDuration
        group.timingFunction = timing
        group.fillMode = .backwards
        layer.add(group, forKey: "kraki.entrance")
        #if DEBUG
        entranceLog.append((key, entrance.fromTrailing, CACurrentMediaTime()))
        #endif
    }

    func scheduleFullWindowWarmup() {
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
        #if DEBUG
        let warmStarted = CACurrentMediaTime()
        #endif
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
                #if DEBUG
                if MacChatCost.enabled {
                    MacChatCost.measure("warmBatch(bg) jobs=\(min(jobs.count, 9))+") {}
                    var b = MacChatCost.buckets["warmBatch latency"] ?? (0, 0, 0)
                    let ms = (CACurrentMediaTime() - warmStarted) * 1000
                    b.count += 1; b.total += ms; b.max = max(b.max, ms)
                    MacChatCost.buckets["warmBatch latency"] = b
                }
                #endif
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
                            let target = self.floored(exactHeight, forKey: key)
                            if abs((self.heightCache[key] ?? 0) - target) > 0.5 {
                                self.pendingHeights[key] = target
                            } else {
                                self.heightCache[key] = target
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

    func installPlaceholderCellIfNeeded(at index: Int, item: MacChatItem) {
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

    func dequeueCell() -> MacChatBubbleCell {
        if let cell = reusePool.popLast() {
            return cell
        }
        totalCellAllocations += 1
        let cell = MacChatBubbleCell(frame: .zero)
        cell.isHidden = true
        addSubview(cell)
        return cell
    }

    func recycle(_ cell: MacChatBubbleCell) {
        cell.isHidden = true
        if reusePool.count < 16 {
            reusePool.append(cell)
        } else {
            cell.prepareForReuse()
            cell.removeFromSuperview()
        }
    }

    func configure(
        _ cell: MacChatBubbleCell,
        with item: MacChatItem,
        content: MacChatBubbleContent? = nil
    ) {
        let content = content ?? resolvedContent(for: item)
        MacChatCost.measure("cell.configure") { configureBody(cell, with: item, content: content) }
    }

    func configureBody(
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
        cell.onPendingAction = { [weak self] clientId, action in
            self?.onPendingAction?(clientId, action)
        }
    }
}
#endif
