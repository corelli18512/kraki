/// The live card changing places with the rows next to it (steer placement).

#if os(iOS)
import UIKit

extension ChatPerfListVC {
    static let liveCardMoveDuration: TimeInterval = 0.5

    /// `old` with only the live card moved to where `new` puts it: its index
    /// there, or last when it lands as the reply or goes. Nil when it stays.
    /// A steer the agent has not read yet holds the card above it
    /// (MessageStore+SteerPlacement); the agent's next segment, or the turn
    /// ending, takes it below.
    func liveCardMoved(old: [String], new: [String]) -> [String]? {
        guard let from = old.firstIndex(of: Self.liveCardID) else { return nil }
        var moved = old
        moved.remove(at: from)
        let to = min(new.firstIndex(of: Self.liveCardID) ?? moved.count, moved.count)
        guard to != from else { return nil }
        moved.insert(Self.liveCardID, at: to)
        return moved
    }

    /// One animated collection-view move (not delete + insert, which flashes):
    /// the card travels to its new row while the rows it passes slide the other
    /// way, with its new content. A reader pinned to the bottom stays pinned
    /// through the move.
    func applyLiveCardMove(old: [String], to moved: [String]) -> Bool {
        guard let from = old.firstIndex(of: Self.liveCardID),
              let to = moved.firstIndex(of: Self.liveCardID),
              collectionView.numberOfItems(inSection: 0) == old.count else { return false }
        let following = shouldFollowLiveTail
        let liveCell = collectionView.cellForItem(at: IndexPath(item: from, section: 0)) as? TKBubbleCell
        items = moved
        let move = {
            // New content inside the animation: its bubble resizes with the move.
            if let liveCell {
                self.configureCell(liveCell, at: IndexPath(item: to, section: 0))
                liveCell.layoutIfNeeded()
            }
            let context = UICollectionViewFlowLayoutInvalidationContext()
            context.invalidateFlowLayoutDelegateMetrics = true
            self.collectionView.collectionViewLayout.invalidateLayout(with: context)
            self.collectionView.performBatchUpdates {
                self.collectionView.moveItem(at: IndexPath(item: from, section: 0), to: IndexPath(item: to, section: 0))
            }
            self.collectionView.layoutIfNeeded()
            if following {
                let maxY = self.followPinOffset(keepingRevealed: true)
                self.collectionView.contentOffset.y = maxY
                self.scrollPolicy.pinToTail(observedOffset: maxY)
            }
        }
        if UIAccessibility.isReduceMotionEnabled {
            UIView.performWithoutAnimation(move)
        } else {
            UIView.animate(withDuration: Self.liveCardMoveDuration, delay: 0, usingSpringWithDamping: 0.9,
                           initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction],
                           animations: move)
        }
        chatPerfLog.log("[apply] live-card-move from=\(from) to=\(to)")
        return true
    }
}
#endif
