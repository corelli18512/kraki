/// Live updates while a fetched older page is held in the buffer.

#if os(iOS)
import UIKit

extension ChatPerfListVC {
    /// A page fetched between the prefetch and reveal distances from the top
    /// stays buffered (`paginationSnapshotDeferred`) until the reader reaches
    /// the top, and the live tail waits behind it. When a live change arrives
    /// and no page is fetching, measuring or applying, reveal the held page and
    /// the new tail together through the anchored edge apply: the reading
    /// position stays put and a reader at the bottom follows the new rows.
    /// Deferred to rest like any reveal; a cold buffer is measured first.
    @discardableResult
    func revealHeldOlderPageForLiveUpdate() -> Bool {
        guard paginationSnapshotDeferred, !fetchingOlder, !fetchingNewer,
              !measuringOlderPage, !measuringNewerPage, pendingApply == nil,
              bufferedOlderCount() > 0 else { return false }
        pendingApply = { [weak self] in self?.flushOlder(reason: "live-update") }
        flushPendingApply()
        return true
    }
}
#endif
