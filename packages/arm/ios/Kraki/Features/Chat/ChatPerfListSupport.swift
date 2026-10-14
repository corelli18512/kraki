/// Helpers of the iOS chat list: the perf log, the edge spinner view, the real-cell sizer and the pagination transaction.

#if os(iOS)
import SwiftUI
import UIKit
import os

/// Perf logger. Mirrors every line to BOTH the unified-logging store (for
/// `log stream` on the simulator) AND `print` (stdout) — the latter so
/// `devicectl device process launch --console` streams the lines live over
/// the CoreDevice tunnel on a physical device. (idevicesyslog can't see
/// `os.Logger`/`NSLog` output on modern iOS, and `log collect` needs root.)
/// Debug harness only.
final class ChatPerfLog {
    private let logger = Logger(subsystem: "chat.kraki.ios", category: "chatperf")
    private let enabled = ProcessInfo.processInfo.environment["KRAKI_CHAT_PERF_OVERLAY"] == "1"
        || ProcessInfo.processInfo.environment["KRAKI_CHAT_PERF_LOG"] == "1"
    private let queue = DispatchQueue(label: "chatperf.filelog")
    private let handle: FileHandle?
    /// Sandbox path (pull with `devicectl device copy from`):
    /// Documents/chatperf.log on iOS (~/Library/Logs/<bundle id>/ on macOS) —
    /// a durable sink that survives USB/syslog drops.
    static let fileURL = KrakiDiagnosticFiles.url("chatperf.log")

    init() {
        guard enabled else {
            handle = nil
            return
        }
        // Fresh file each diagnostic launch so a pull only sees this session.
        let url = Self.fileURL
        try? FileManager.default.removeItem(at: url)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
    }

    func log(_ message: String) {
        guard enabled else { return }
        logger.log("\(message, privacy: .public)")
        let t = CFAbsoluteTimeGetCurrent().truncatingRemainder(dividingBy: 100)
        let line = "[chatperf] \(String(format: "%07.3f", t)) \(message)\n"
        print(line, terminator: "")
        queue.async { [handle] in
            if let data = line.data(using: .utf8) { handle?.write(data) }
        }
    }
}
let chatPerfLog = ChatPerfLog()

// MARK: - Cells

/// Production chat uses one TextKit-backed cell path. Keeping a single
/// renderer prevents sizing and interaction drift.

// MARK: - Inline loading spinner (section header/footer)

/// A supplementary view holding a centered spinner. Used as the section
/// header (top / loadOlder) and footer (bottom / loadNewer) so the
/// loading indicator lives INSIDE the scroll content — level with the
/// bubbles and scrolling with them — instead of floating over the view.
final class SpinnerReusableView: UICollectionReusableView {
    static let reuseID = "SpinnerReusableView"
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = false
        addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        spinner.startAnimating()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        spinner.startAnimating()
    }
}

// MARK: - Height cache (REAL self-size, measure once, reuse forever)

/// Computes a message's rendered height EXACTLY as the live cell self-sizes
/// it — by configuring a reusable offscreen `UICollectionViewListCell` with
/// the SAME `ChatPerfCellContent` hosting config and asking it to
/// `systemLayoutSizeFitting`. This is the production measurement path (see
/// the production TextKit sizer), so the cached height is identical
/// to what UIKit would self-size — no drift, no jump.
///
/// It is also the EXPENSIVE path (15–60 ms for a rich markdown cell), which
/// is the whole point of phase 2: we pay the real cost, then hide it behind
/// measure-ahead (the scheduler pre-warms the cache off the critical frame).
/// Because the flow layout uses `estimatedItemSize = .zero`, the height we
/// return is definitive once the row is warm. Cold rows use a lightweight
/// estimate during entry, then the same cache is upgraded by the scheduler;
/// layout and anchor correction read that single source of truth thereafter.
///
/// `container` must be installed in the view hierarchy by the VC so traits
/// (Dynamic Type, interface style) resolve identically to the live list.
final class RealCellSizer {
    private var cache: [String: CGFloat] = [:]
    private var estimateCache: [String: CGFloat] = [:]
    private var measuredWidth: CGFloat = 0

    /// Real session id / agent so the offscreen measure renders the SAME
    /// TextKit config the live cell uses. Set by the VC right after init.
    var sessionId: String = "perf"
    var agent: String = "claude"
    /// Builds the same geometry description used by a visible cell.
    var contentBuilder: ((ChatMessage) -> TKBubbleContent)?
    var onHeightReady: ((String) -> Void)?

    /// Container whose safe-area insets are forced to zero — a real list
    /// cell self-sizes with none, but an offscreen view pinned into the VC
    /// inherits the screen insets, biasing every measurement. Mirrors the
    /// production safe-area-neutral sizer.
    private final class SafeAreaZeroingView: UIView {
        override var safeAreaInsets: UIEdgeInsets { .zero }
    }

    let container: UIView = {
        let v = SafeAreaZeroingView()
        v.alpha = 0
        v.isUserInteractionEnabled = false
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    /// The single cell reused for every measurement — a plain list cell, so
    /// it always runs the REAL self-size (never a cache short-circuit).
    /// Reused UILabel for the pure-UIKit A/B arm. Measuring with the SAME
    /// label config the live `ChatPerfUIKitCell` renders guarantees the cached
    /// height matches what's drawn — otherwise frontDelta (the anchor
    /// correction) is computed from SwiftUI-measured heights while UIKit lays
    /// out different ones, and every page insert visibly jumps.
    private let measureLabel: UILabel = {
        let l = UILabel()
        l.numberOfLines = 0
        l.font = .preferredFont(forTextStyle: .subheadline)
        return l
    }()

    init() {}

    /// Drop the cache when the measure width changes (rotation / split).
    private func resetIfWidthChanged(_ width: CGFloat) {
        if width != measuredWidth {
            cache.removeAll(keepingCapacity: true)
            estimateCache.removeAll(keepingCapacity: true)
            measuredWidth = width
        }
    }

    func cached(_ id: String) -> CGFloat? { cache[id] }

    /// Forget every height (the text size changed).
    func reset() {
        cache.removeAll(keepingCapacity: true)
        estimateCache.removeAll(keepingCapacity: true)
    }

    func prepare(width: CGFloat) {
        guard width > 0 else { return }
        resetIfWidthChanged(width)
    }

    /// Cheap first-pass geometry for rows that have not been measured yet.
    /// This path must stay free of Markdown, TextKit, image decoding, and
    /// SwiftUI host measurement because UICollectionView asks for every row
    /// during the initial layout.
    func estimatedHeight(for t: ChatMessage, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 44 }
        resetIfWidthChanged(width)
        if let cached = estimateCache[t.id] { return cached }

        let isUser = t.type == "user_message" || t.type == "send_input" || t.type == "pending_input"
        let usable = width - TKMetrics.outerH * 2
        let bubbleWidth = isUser
            ? usable - width * TKMetrics.userLeadingGapFraction
            : usable - width * TKMetrics.trailingGapFraction
        let bodyWidth = max(80, bubbleWidth - TKMetrics.msgPadH * 2)
        let text = t.imageUnavailable ? ChatMessage.imageUnavailableText : (t.content ?? t.result ?? t.interruptedDraft ?? "")
        let bodyHeight: CGFloat
        if text.isEmpty || text == "[image]" {
            bodyHeight = 0
        } else {
            // Structure-aware (line breaks, code, tables, lists, CJK) but free
            // of Markdown/TextKit work: every loaded row is asked during layout.
            bodyHeight = ChatHeightEstimator.bodyHeight(text, bodyWidth: bodyWidth)
        }

        var height = bodyHeight > 0 ? bodyHeight + 32 : 1
        let attachmentCount = t.contentRefAttachments.count
            + (t.attachments?.filter { $0.type == "image" }.count ?? 0)
        if attachmentCount > 0 {
            let imageWidth = max(80, min(bodyWidth, 280))
            let imageHeight = min(240, imageWidth * 0.66)
            height += bodyHeight > 0 ? 6 : 16
            height += imageHeight * CGFloat(min(attachmentCount, 3))
            height += CGFloat(max(0, min(attachmentCount, 3) - 1)) * 6
        }
        if t.type == "turn_status" || t.type == "interrupted_turn" {
            height += 44
        }
        let result = min(max(ceil(height), 1), 1_600)
        estimateCache[t.id] = result
        return result
    }

    /// Cache-or-measure. A miss measures SYNCHRONOUSLY on the calling
    /// thread — when that caller is `sizeForItemAt` during a scroll, the
    /// cost lands on the scroll frame, so we log it as the key jank signal.
    func height(for t: ChatMessage, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 44 }
        resetIfWidthChanged(width)
        if let h = cache[t.id] { return h }
        let t0 = CFAbsoluteTimeGetCurrent()
        let h = measure(t, width: width)
        cache[t.id] = h
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        chatPerfLog.log("[size] sync-miss id=\(t.id) ms=\(String(format: "%.1f", ms))")
        return h
    }

    /// Warm path: measure + cache off the critical frame (called by the
    /// scheduler). Cheap no-op if already cached. No sync-miss log — this is
    /// the intended, budget-sliced measurement.
    func prime(_ t: ChatMessage, width: CGFloat, notify: Bool = true) {
        guard width > 0 else { return }
        resetIfWidthChanged(width)
        if cache[t.id] != nil { return }
        let t0 = CFAbsoluteTimeGetCurrent()
        cache[t.id] = measure(t, width: width)
        if notify { onHeightReady?(t.id) }
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        if ms > 8 {
            chatPerfLog.log("[prime] slow id=\(t.id) ms=\(String(format: "%.1f", ms))")
        }
    }

    /// Re-measure a row whose content changed under a stable id (an
    /// optimistic voice bubble streaming its correction). True if it moved.
    @discardableResult
    func remeasure(_ t: ChatMessage, width: CGFloat, allowShrink: Bool = true) -> Bool {
        guard width > 0 else { return false }
        resetIfWidthChanged(width)
        let old = cache[t.id]
        var new = measure(t, width: width)
        if !allowShrink, let old { new = max(old, new) }
        cache[t.id] = new
        estimateCache.removeValue(forKey: t.id)
        return old != new
    }

    /// The real self-size: configure the offscreen cell exactly like the
    /// live one and ask UIKit for its fitting height.
    private func measure(_ t: ChatMessage, width: CGFloat) -> CGFloat {
        (contentBuilder?(t) ?? TKBubbleContent.make(message: t, sessionId: sessionId, agent: agent))
            .cellHeight(cellWidth: width)
    }
}

// MARK: - Pagination transaction (txn) — log-based correctness/timing trace

/// One pagination cycle threaded across its async/deferred phases (trigger →
/// rawLoad → snapshot refresh → reconcile → measure → apply) so the log reads as a
/// single `[txn N]` transaction. `lap()` returns ms since the previous lap;
/// `mark()` resets the lap clock (used to drop idle wait between phases).
final class PaginateTxn {
    let id: Int
    let kind: String
    private let t0: CFAbsoluteTime
    private var last: CFAbsoluteTime
    init(id: Int, kind: String) {
        self.id = id
        self.kind = kind
        let now = CFAbsoluteTimeGetCurrent()
        self.t0 = now
        self.last = now
    }
    func mark() { last = CFAbsoluteTimeGetCurrent() }
    func lap() -> Double {
        let now = CFAbsoluteTimeGetCurrent()
        let d = (now - last) * 1000
        last = now
        return d
    }
    func total() -> Double { (CFAbsoluteTimeGetCurrent() - t0) * 1000 }
}
#endif
