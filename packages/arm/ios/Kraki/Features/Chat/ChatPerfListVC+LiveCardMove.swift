/// The live card going below the rows it sat above (steer placement).

#if os(iOS)
import UIKit

extension ChatPerfListVC {
    /// The live card was above another row and is now last, or gone (its
    /// reply landed). A steer the agent has not read yet holds the card above
    /// it (MessageStore+SteerPlacement); the agent's next segment, or the turn
    /// ending, takes it below.
    static func liveCardMovesDown(old: [String], new: [String]) -> Bool {
        guard let from = old.firstIndex(of: liveCardID), from < old.count - 1 else { return false }
        return new.last == liveCardID || !new.contains(liveCardID)
    }

    /// The rows change in place, as any tail change (the cells stay, their
    /// content is reassigned; no collection-view move, which leaves stale or
    /// hidden cells and blank frames when the card is taller than the screen,
    /// and no animated scroll). Then every bubble that was on screen glides
    /// from where it was drawn to its new place: the steer slides up, the card
    /// slides down below it (anchored at its bottom edge, as its height
    /// changes with the new segment). A reader pinned to the bottom stays pinned.
    func applyLiveCardMove(old: [String], new: [String]) -> Bool {
        let following = shouldFollowLiveTail
        let before = Dictionary(collectionView.visibleCells.compactMap { cell in
            glideKey(cell).map { ($0, screenFrame(cell, presented: true)) }
        }, uniquingKeysWith: { first, _ in first })
        // A height or scroll animation still running (the previous revision
        // growing) would keep drawing the old geometry over the new one, and
        // with a card taller than the screen that is an empty viewport. The
        // glides below start from what is drawn now instead.
        stopGeometryAnimations()
        guard applyTailInPlace(old: old, new: new, glidingLiveCardMove: false) else { return false }
        UIView.performWithoutAnimation {
            collectionView.layoutIfNeeded()
            if following {
                let maxY = followPinOffset(keepingRevealed: true)
                collectionView.contentOffset.y = maxY
                scrollPolicy.pinToTail(observedOffset: maxY)
                collectionView.layoutIfNeeded()
            }
        }
        stopGeometryAnimations()
        chatPerfLog.log("[apply] live-card-move rows=\(old.count)->\(new.count)")
        guard !UIAccessibility.isReduceMotionEnabled else { return true }
        for cell in collectionView.visibleCells {
            guard var key = glideKey(cell), let indexPath = collectionView.indexPath(for: cell) else { continue }
            // The reply that replaced the card lands from the card's place.
            if before[key] == nil, !new.contains(Self.liveCardID), indexPath.item == new.count - 1 { key = Self.liveCardID }
            guard let old = before[key] else { continue }
            let now = screenFrame(cell, presented: false)
            let delta = key == Self.liveCardID ? old.maxY - now.maxY : old.minY - now.minY
            guard abs(delta) > 0.5 else { continue }
            let glide = CASpringAnimation(keyPath: "transform.translation.y")
            glide.fromValue = delta
            glide.toValue = 0
            glide.isAdditive = true
            glide.damping = 26
            glide.stiffness = 300
            glide.duration = glide.settlingDuration
            cell.layer.add(glide, forKey: "kraki.liveCardMove")
        }
        return true
    }

    /// A bubble's identity across the move: the live card, an input by its
    /// clientId (its pending and echoed rows share it), else the row id.
    private func glideKey(_ cell: UICollectionViewCell) -> String? {
        guard let content = (cell as? TKBubbleCell)?.contentSnapshot else { return nil }
        if content.isLive { return Self.liveCardID }
        return content.message.payload["clientId"]?.stringValue ?? content.message.id
    }

    /// Where the cell is drawn in the viewport (`presented`: as on screen
    /// now, mid-animation too; else its final place).
    private func screenFrame(_ cell: UICollectionViewCell, presented: Bool) -> CGRect {
        guard presented else { return cell.frame.offsetBy(dx: 0, dy: -collectionView.contentOffset.y) }
        let offset = collectionView.layer.presentation()?.bounds.minY ?? collectionView.contentOffset.y
        return (cell.layer.presentation()?.frame ?? cell.frame).offsetBy(dx: 0, dy: -offset)
    }

    /// Ends running scroll and frame animations of the list and its cells
    /// (they jump to their end); entrances and glides are additive and stay.
    private func stopGeometryAnimations() {
        func stop(_ layer: CALayer) {
            for key in layer.animationKeys() ?? [] where key.hasPrefix("bounds") || key.hasPrefix("position") {
                layer.removeAnimation(forKey: key)
            }
        }
        stop(collectionView.layer)
        collectionView.visibleCells.forEach { stop($0.layer) }
    }
}
#endif
