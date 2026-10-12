/// Diagnostics and hit-testing helpers of the Mac chat document (presentation health, layout diagnostics, action hit targets, HTML artifact cards).

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatDocumentView {
    func presentationHealth(in viewport: NSRect) -> MacChatPresentationHealth {
        let indexes = desiredIndexes(for: viewport, runway: 0).filter {
            $0 < contents.count && $0 < itemFrames.count && itemFrames[$0].intersects(viewport)
        }
        let visible = indexes.compactMap { index -> (Int, MacChatBubbleCell)? in
            guard let cell = visibleCells[index], !cell.isHidden, cell.alphaValue > 0.01 else {
                return nil
            }
            return (index, cell)
        }
        let visibleIndexes = Set(visible.map { $0.0 })
        return MacChatPresentationHealth(
            itemCount: contents.count,
            intersectingSeqs: indexes.map { contents[$0].seq },
            realSeqs: visible.compactMap { index, cell in
                cell.isPlaceholderFlag ? nil : contents[index].seq
            }.sorted(),
            placeholderSeqs: visible.compactMap { index, cell in
                cell.isPlaceholderFlag ? contents[index].seq : nil
            }.sorted(),
            unmaterializedSeqs: indexes.compactMap { index in
                visibleIndexes.contains(index) ? nil : contents[index].seq
            }.sorted(),
            preparedContentCount: contentCache.count,
            exactHeightCount: heightCache.count,
            pendingHeightCount: pendingHeights.count,
            warmActive: warmBatchActive,
            viewportFillScheduled: viewportFillScheduled
        )
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
        let stableAnchor = stableVisibleAnchor(in: viewport)
        let intersectingIndexes = desiredIndexes(for: viewport, runway: 0).filter {
            $0 < contents.count && $0 < itemFrames.count && itemFrames[$0].intersects(viewport)
        }
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
            "pendingHeightCount": pendingHeights.count,
            "preparedContentCount": contentCache.count,
            "geometryWarmCompletedCount": geometryWarmCompleted.count,
            "viewportFillScheduled": viewportFillScheduled,
            "intersectingItemSeqs": intersectingIndexes.map { contents[$0].seq },
            "intersectingRealSeqs": intersecting.compactMap { index, cell in
                cell.isPlaceholderFlag ? nil : contents[index].seq
            },
            "intersectingPlaceholderSeqs": intersecting.compactMap { index, cell in
                cell.isPlaceholderFlag ? contents[index].seq : nil
            },
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
                    "configuredHeight": Double(cell.configuredHeight()),
                    "heightDelta": Double(cell.configuredHeight() - cell.frame.height),
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
        if let stableAnchor,
           let index = indexByKey[stableAnchor.key],
           index < contents.count {
            result["stableAnchorSeq"] = contents[index].seq
            result["stableAnchorDelta"] = Double(stableAnchor.delta)
        }
        return result
    }

    func rectDiagnostics(_ rect: NSRect, viewport: NSRect) -> [String: Double] {
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
}
#endif
