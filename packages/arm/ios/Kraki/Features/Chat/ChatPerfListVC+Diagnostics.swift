/// Log-based correctness checks and the frame-time monitor of the iOS chat list.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    func newTxn(_ kind: String) -> PaginateTxn {
        nextTxnId += 1
        return PaginateTxn(id: nextTxnId, kind: kind)
    }

    func f1(_ d: Double) -> String { String(format: "%.1f", d) }
    func yn(_ b: Bool) -> String { b ? "Y" : "N" }

    /// First index where two id slices differ (for the reconcile-invalid dump).
    func firstMismatch(_ a: [String], _ b: [String]) -> (idx: Int, a: String, b: String) {
        let n = min(a.count, b.count)
        for i in 0..<n where a[i] != b[i] { return (i, a[i], b[i]) }
        return (n, a.count > n ? a[n] : "—", b.count > n ? b[n] : "—")
    }

    #if DEBUG
    var alignmentLoggingEnabled: Bool {
        ProcessInfo.processInfo.environment["KRAKI_IOS_CHAT_ALIGNMENT_PREVIEW"] == "1"
    }
    #endif

    func logEntryState(_ reason: String) {
        let collectionCount = collectionView?.numberOfItems(inSection: 0) ?? -1
        let signature = [
            "session=\(sessionId)",
            "attached=\(viewIfLoaded?.window == nil ? 0 : 1)",
            "hidden=\(viewIfLoaded?.isHidden == true ? 1 : 0)",
            "alpha=\(String(format: "%.1f", viewIfLoaded?.alpha ?? -1))",
            "gate=\(vm.isWaitingForLatestBubble ? 1 : 0)",
            "metaHead=\(vm.session?.lastSeq ?? 0)",
            "providerHead=\(vm.sessionLastSeq)",
            "window=\(vm.windowTopSeq)-\(vm.windowBottomSeq)",
            "raw=\(vm.filteredMessages.count)",
            "projected=\(messages.count)",
            "items=\(items.count)",
            "collection=\(collectionCount)",
            "atHead=\(vm.atHead ? 1 : 0)",
            "card=\(vm.card == nil ? 0 : 1)",
        ].joined(separator: " ")
        guard signature != lastEntryDiagnosticSignature else { return }
        lastEntryDiagnosticSignature = signature
        KLog.chatEntry("list reason=\(reason) \(signature)")
    }

    func liveContent(_ card: MessageStore.SessionCard) -> TKBubbleContent {
        let signature = liveCardSignature
        let width = collectionView?.bounds.width ?? 0
        if let memo = liveContentMemo, memo.signature == signature, memo.width == width {
            return memo.content
        }
        let content = TKBubbleContent.live(card: card, agent: agentName,
                                           sessionId: sessionId, steps: vm.lastUserStepsHint)
        liveContentMemo = (signature, width, content)
        return content
    }

    var liveCardSignature: String {
        // Hash the streaming text instead of inlining it: syncLive fires on
        // every frame while idle (≈10–20 Hz), so embedding the full draft text
        // into the signature string wasted memory + made logs unreadable. A
        // stable hash captures "did the text change" at a fraction of the cost.
        let text = vm.card?.text ?? ""
        var hasher = Hasher()
        hasher.combine(text)
        hasher.combine(vm.card?.action?.id ?? "")
        // Every card action decodes with the same id; the permission id is
        // what tells a newer pending request apart from the one shown.
        hasher.combine(vm.card?.action?.payload["id"]?.stringValue ?? "")
        hasher.combine(vm.card?.action?.type ?? "")
        hasher.combine(vm.card?.action?.payload["decision"]?.stringValue ?? "")
        hasher.combine(vm.card?.action?.payload["localPending"]?.boolValue ?? false)
        hasher.combine(vm.card?.action?.payload["localError"]?.stringValue ?? "")
        hasher.combine(vm.card?.action?.payload["retained"]?.boolValue ?? false)
        hasher.combine(vm.card?.action?.cancelled ?? false)
        return String(hasher.finalize(), radix: 16)
    }

    /// Animated user navigation is owned by the shared policy. UIKit only
    /// executes the offset animation and reports its end/cancellation.
    var suppressPagingForBottom: Bool { scrollPolicy.suppressesEdgePaging }

    /// Reading line for navigation landings: status bar (≈62) + chat header
    /// (54) + the same 8pt gap used above the first message.
    static let latestMessageTopPadding: CGFloat = 124
    /// Round navigation controls: iOS minimum comfortable tap target.
    static let jumpControlSize: CGFloat = 44
    /// The ↓ control sits above the composer's 44 pt send circle, which stays
    /// on the composer's bottom row. Its position is fixed to the ONE-LINE
    /// composer (48 pt capsule + 6 pt padding each side = 60 pt), so a growing
    /// composer (multi-line text, dictation) never pushes it up. The circle
    /// top is 8 pt below that line; 1 extra pt balances the bordered glass
    /// controls against the solid send circle.
    static let oneLineComposerHeight: CGFloat = 60
    static func jumpBottomGap(_ composerInset: CGFloat) -> CGFloat {
        composerInset <= 0 ? 16 : oneLineComposerHeight + (IOSComposerMetrics.stackGap - 8)
    }
    /// The chat header (back / title / more) is part of the page, drawn by
    /// SessionDetailView over the top glass band, not a system navigation
    /// bar; reserve its height plus breathing room under it.
    static let topContentPadding: CGFloat = ChatHeaderMetrics.height + 16

    func startHitchMonitor() {
        startFrameMonitor()
    }

    func startFrameMonitor() {
        // CADisplayLink retains its target. Targeting the controller directly
        // kept every opened chat alive forever (deinit, which invalidates the
        // link, could never run). The proxy holds the controller weakly.
        let proxy = ChatDisplayLinkProxy(self)
        let link = CADisplayLink(target: proxy, selector: #selector(ChatDisplayLinkProxy.onFrame(_:)))
        link.add(to: .main, forMode: .common)
        displayLink?.invalidate()
        displayLink = link
    }

    @objc func onFrame(_ link: CADisplayLink) {
        defer { lastFrameTs = link.timestamp }
        guard lastFrameTs != 0 else { return }
        // Only judge smoothness while actively scrolling. When idle,
        // ProMotion ramps the refresh rate down (10–24 Hz), so frame gaps
        // grow legitimately and would otherwise be miscounted as hitches.
        guard collectionView.isDragging || collectionView.isDecelerating else { return }
        let dtMs = (link.timestamp - lastFrameTs) * 1000
        // Expected frame ≈ link.targetTimestamp - link.timestamp. A frame
        // is "dropped" when the gap is meaningfully longer than expected.
        let expectedMs = (link.targetTimestamp - link.timestamp) * 1000
        if dtMs > max(12, expectedMs * 1.6) {
            hitchCount += 1
            if dtMs > worstFrameMs { worstFrameMs = dtMs }
            chatPerfLog.log("[hitch] \(String(format: "%.1f", dtMs))ms during=\(self.lastReason)")
            updateOverlay()
        }
    }

    func updateOverlay() {
        guard Self.perfOverlayEnabled else { return }
        let loading = [loadingOlder ? "▲older" : nil, loadingNewer ? "▼newer" : nil]
            .compactMap { $0 }.joined(separator: " ")
        overlay.text = """
        win [\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) n=\(messageCount)
        old:\(atOldest ? "✓" : "·") new:\(atNewest ? "✓" : "·")
        last: \(lastReason) \(String(format: "%.1f", lastApplyMs))ms
        hitches: \(hitchCount) worst:\(String(format: "%.0f", worstFrameMs))ms
        loading: \(loading.isEmpty ? "—" : loading)
        """
    }
}

/// Weak bridge between a `CADisplayLink` and the chat controller (see
/// `startFrameMonitor`). Invalidates the link once the controller is gone.
@MainActor
final class ChatDisplayLinkProxy: NSObject {
    private weak var target: ChatPerfListVC?

    init(_ target: ChatPerfListVC) {
        self.target = target
    }

    @objc func onFrame(_ link: CADisplayLink) {
        guard let target else {
            link.invalidate()
            return
        }
        target.onFrame(link)
    }
}
#endif
