/// The live card changing places with the rows next to it (steer placement), on Mac.

#if os(macOS)
import AppKit
import QuartzCore

extension MacChatScrollView {
    /// `performAtomicSnapshot`. When the snapshot takes the live card from
    /// above a steer to the bottom (the agent's next segment, or the turn
    /// ending: MessageStore+SteerPlacement), the bubbles that were on screen
    /// glide from where they were to their new place instead of jumping.
    func performAtomicSnapshotGlidingLiveCardMove(_ updates: () -> Void) {
        let document = chatDocumentView
        let oldKeys = document.itemKeys
        let oldScreenY = Dictionary(document.visibleCells.compactMap { index, cell -> (ObjectIdentifier, CGFloat)? in
            index < document.itemFrames.count ? (ObjectIdentifier(cell), document.itemFrames[index].minY - contentView.bounds.minY) : nil
        }, uniquingKeysWith: { first, _ in first })
        performAtomicSnapshot(updates)
        guard Self.liveCardMovesDown(old: oldKeys, new: document.itemKeys) else { return }
        // The moved card shows its new segment at the height of the old one
        // until its exact height commits, a frame later: that shrink would
        // jump. Measure it now, so the glide ends where the card settles.
        if let live = document.indexByKey["__live__"], document.primeExactHeight(for: document.contents[live]) {
            let pinned = isPinnedToBottom
            performAtomicSnapshot {
                document.rebuildFrames()
                if pinned { scrollToBottom(animated: false) }
            }
        }
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        for (index, cell) in document.visibleCells where index < document.itemFrames.count {
            guard let oldY = oldScreenY[ObjectIdentifier(cell)], let layer = cell.layer else { continue }
            let delta = oldY - (document.itemFrames[index].minY - contentView.bounds.minY)
            guard abs(delta) > 0.5 else { continue }
            // Layer space runs the same way as the flipped document when AppKit
            // flips the backing layer; otherwise it runs bottom-up.
            let layerFollowsView = abs(layer.frame.minY - cell.frame.minY) < 0.5
            let glide = CASpringAnimation(keyPath: "transform.translation.y")
            glide.fromValue = layerFollowsView ? delta : -delta
            glide.toValue = 0
            glide.isAdditive = true
            glide.damping = 26
            glide.stiffness = 300
            glide.duration = glide.settlingDuration
            layer.add(glide, forKey: "kraki.liveCardMove")
        }
    }

    /// The live card was above another row and is now last, or gone.
    static func liveCardMovesDown(old: [String], new: [String]) -> Bool {
        guard let from = old.firstIndex(of: "__live__"), from < old.count - 1 else { return false }
        return new.last == "__live__" || !new.contains("__live__")
    }
}
extension MacChatDocumentView {
    /// The row that grows while the agent streams: the live card wherever it
    /// sits (above an unread steer, too), else the newest row.
    func growingItemFrame() -> NSRect? { frame(forKey: "__live__") ?? latestItemFrame() }
}
#endif
