/// UsagePeekController — the floating account usage panel.
///
/// Hold the shortcut (default F6) for a compact overview of every online
/// tentacle's accounts; move the pointer in and it smoothly grows into the
/// detail view; move out while still holding and it shrinks back; release
/// and it fades away. "Account Usage" in the menu bar opens it pinned.
/// Accounts are merged across devices; the one the open Session spends is listed first.
///
/// Keyboard peeks use a non-activating panel so the focused editor keeps
/// typing focus. Ported from the standalone Kraki Usage prototype.

#if os(macOS)
import AppKit
import Combine
import QuartzCore
import SwiftUI

private final class UsagePeekPanel: NSPanel {
    var onDismiss: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onDismiss?() }
}

/// Cancellable frame interpolation (a reversed resize never leaves a stale completion).
@MainActor
private final class UsagePanelFrameAnimator {
    private weak var window: NSWindow?
    private var timer: Timer?
    private var generation = 0
    init(window: NSWindow) { self.window = window }
    func cancel() { generation += 1; timer?.invalidate(); timer = nil }
    func move(to target: NSRect, animated: Bool) {
        cancel()
        guard let window else { return }
        let from = window.frame
        guard animated, from != target, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            window.setFrame(target, display: true)
            return
        }
        let token = generation, start = CACurrentMediaTime(), duration = 0.24
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token, let window = self.window else { return }
                let p = min(1, (CACurrentMediaTime() - start) / duration)
                let t = CGFloat(p * p * (3 - 2 * p))
                window.setFrame(NSRect(x: from.minX + (target.minX - from.minX) * t, y: from.minY + (target.minY - from.minY) * t,
                                       width: from.width + (target.width - from.width) * t,
                                       height: from.height + (target.height - from.height) * t), display: true)
                if p >= 1 { self.cancel() }
            }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
}

/// Fade in / out; a new press reverses from the current opacity.
@MainActor
private final class UsagePanelVisibilityAnimator {
    private weak var window: NSWindow?
    private var timer: Timer?
    private var generation = 0
    private(set) var isHiding = false
    init(window: NSWindow) { self.window = window }
    func cancel() { generation += 1; timer?.invalidate(); timer = nil; isHiding = false }
    func show(takeFocus: Bool) {
        guard let window else { return }
        cancel()
        window.ignoresMouseEvents = false
        if !window.isVisible { window.alphaValue = 0 }
        if takeFocus { window.makeKeyAndOrderFront(nil) } else { window.orderFrontRegardless() }
        fade(to: 1, duration: 0.12)
    }
    func hide(animated: Bool) {
        guard let window else { return }
        if !animated {
            cancel(); window.orderOut(nil); window.alphaValue = 1; window.ignoresMouseEvents = false
            return
        }
        guard window.isVisible, !isHiding else { return }
        cancel(); isHiding = true
        window.ignoresMouseEvents = true
        fade(to: 0, duration: 0.18)
    }
    private func fade(to target: CGFloat, duration: TimeInterval) {
        guard let window else { return }
        let from = window.alphaValue, token = generation, start = CACurrentMediaTime()
        let duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.08 : duration
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token, let window = self.window else { return }
                let p = min(1, (CACurrentMediaTime() - start) / duration)
                window.alphaValue = from + (target - from) * CGFloat(p * p * (3 - 2 * p))
                if p >= 1 {
                    self.cancel()
                    if target == 0 { window.orderOut(nil); window.alphaValue = 1; window.ignoresMouseEvents = false }
                }
            }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
}

/// Packs account cards into balanced rows. A card's minimum width follows how many
/// rings it draws (5-hour + weekly vs weekly only); rows keep the cards' order, use
/// as few rows as fit, split them as evenly as possible, and every row stretches to
/// the same width. The panel itself narrows to the content.
enum UsagePeekLayout {
    enum Mode { case compact, detail }

    struct Plan: Equatable {
        /// Card indices per row, in order.
        var rows: [[Int]]
        /// Panel size including padding.
        var size: CGSize
        /// Width of each card, by index.
        var widths: [CGFloat]
    }

    static let compactMaxWidth: CGFloat = 460
    static let detailMaxWidth: CGFloat = 790
    static let compactLimit = 6

    static func padding(_ m: Mode) -> CGFloat { m == .compact ? 9 : 18 }
    static func gap(_ m: Mode) -> CGFloat { m == .compact ? 6 : 12 }
    static func cardHeight(_ m: Mode) -> CGFloat { m == .compact ? 124 : 232 }
    static func maxWidth(_ m: Mode) -> CGFloat { m == .compact ? compactMaxWidth : detailMaxWidth }

    /// Narrowest a card can be and still fit its rings, tags and header.
    static func minWidth(rings: Int, _ m: Mode) -> CGFloat {
        switch m {
        case .compact: return rings >= 2 ? 150 : 124
        case .detail: return rings >= 2 ? 232 : 190
        }
    }

    /// Cards grow a little past their minimum before the panel stops narrowing.
    static let comfort: CGFloat = 1.18

    static func plan(rings: [Int], _ m: Mode, maxWidth limit: CGFloat? = nil) -> Plan {
        let pad = padding(m), g = gap(m), h = cardHeight(m)
        let rings = m == .compact ? Array(rings.prefix(compactLimit)) : rings
        guard !rings.isEmpty else { return Plan(rows: [], size: CGSize(width: m == .compact ? 300 : 420, height: m == .compact ? 96 : 140), widths: []) }
        let mins = rings.map { minWidth(rings: $0, m) }
        let inner = (limit ?? maxWidth(m)) - pad * 2
        func rowWidth(_ r: ArraySlice<CGFloat>) -> CGFloat { r.reduce(0, +) + g * CGFloat(max(0, r.count - 1)) }

        // Fewest rows: greedy fill (order preserved).
        var greedyRows = 1, current: CGFloat = 0
        for (i, w) in mins.enumerated() {
            let add = current == 0 ? w : current + g + w
            if add > inner && i > 0 && current > 0 { greedyRows += 1; current = w } else { current = add }
        }
        // Most even split into that many rows (minimise the widest row), order preserved.
        let n = mins.count, k = min(greedyRows, n)
        var best = Array(repeating: Array(repeating: CGFloat.infinity, count: n + 1), count: k + 1)
        var cut = Array(repeating: Array(repeating: 0, count: n + 1), count: k + 1)
        best[0][0] = 0
        for rows in 1...k {
            for end in rows...n {
                for start in (rows - 1)..<end where best[rows - 1][start] < .infinity {
                    let width = max(best[rows - 1][start], rowWidth(mins[start..<end]))
                    // Ties prefer more cards in earlier rows (current session row stays full).
                    if width < best[rows][end] - 0.01 { best[rows][end] = width; cut[rows][end] = start }
                }
            }
        }
        var rows: [[Int]] = [], end = n
        for r in stride(from: k, to: 0, by: -1) { let start = cut[r][end]; rows.insert(Array(start..<end), at: 0); end = start }

        // Panel width: the widest row at a comfortable size, never beyond the limit.
        let natural = rows.map { row in rowWidth(ArraySlice(row.map { mins[$0] * comfort })) }.max() ?? 0
        let widest = rows.map { row in rowWidth(ArraySlice(row.map { mins[$0] })) }.max() ?? 0
        let contentWidth = min(inner, max(widest, natural))
        // Every row stretches to the same width, in proportion to its cards' minimums.
        var widths = Array(repeating: CGFloat(0), count: n)
        for row in rows {
            let available = contentWidth - g * CGFloat(row.count - 1)
            let total = row.map { mins[$0] }.reduce(0, +)
            for i in row { widths[i] = (mins[i] / total * available).rounded(.down) }
        }
        let height = pad * 2 + CGFloat(rows.count) * h + CGFloat(rows.count - 1) * g
        return Plan(rows: rows, size: CGSize(width: contentWidth + pad * 2, height: height), widths: widths)
    }
}

extension MergedAccountUsage {
    /// Rings the card draws (at least one, for the empty ring).
    var ringCount: Int { max(1, account.ringWindows.count) }
}

@MainActor
final class UsagePeekController: NSObject, ObservableObject, NSWindowDelegate {
    static let shared = UsagePeekController()

    let hotkey = UsagePeekHotKey()
    @Published private(set) var peek = UsagePeekState()
    /// Kept while fading out so the closing panel doesn't flash back to compact.
    @Published private(set) var displayedPresentation: UsagePeekState.Presentation = .compact
    @Published private(set) var entranceSerial = 0
    @Published private(set) var closing = false
    @Published private(set) var compactSize = NSSize(width: UsagePeekLayout.compactMaxWidth, height: 160)
    @Published private(set) var detailedSize = NSSize(width: UsagePeekLayout.detailMaxWidth, height: 300)
    private(set) var entranceUntil = Date.distantPast

    private(set) weak var appState: AppState?
    private var currentSessionId: () -> String? = { nil }
    private var panel: UsagePeekPanel?
    private var frameAnimator: UsagePanelFrameAnimator?
    private var visibilityAnimator: UsagePanelVisibilityAnimator?
    private var anchor = NSPoint.zero
    private var maxHeight: CGFloat = 640
    private var compactFrame = NSRect.zero
    private var detailedFrame = NSRect.zero
    private var hoverTimer: Timer?
    private var hoverCandidate: Bool?
    private var hoverCandidateSince: TimeInterval = 0
    private var keyPhysicallyHeld = false
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []

    /// The account the Session open in Kraki is spending, listed first and highlighted.
    var currentAccountKey: String? {
        guard let appState, let id = currentSessionId(), let session = appState.sessionStore.sessions[id] else { return nil }
        return appState.deviceStore.accountKey(forSessionOn: session.deviceId, agent: session.agent, model: session.model)
    }

    /// Merged accounts, the current Session's first.
    func orderedAccounts() -> [MergedAccountUsage] {
        guard let store = appState?.deviceStore else { return [] }
        let current = currentAccountKey
        let list = store.mergedUsage()
        guard let current, let i = list.firstIndex(where: { $0.id == current }) else { return list }
        var out = list
        out.insert(out.remove(at: i), at: 0)
        return out
    }

    func install(appState: AppState, currentSessionId: @escaping () -> String?) {
        guard panel == nil else { return }
        self.appState = appState
        self.currentSessionId = currentSessionId

        let panel = UsagePeekPanel(contentRect: NSRect(origin: .zero, size: compactSize),
                                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Account Usage"
        panel.identifier = NSUserInterfaceItemIdentifier("kraki-usage-peek-panel")
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.hasShadow = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.animationBehavior = .none
        panel.delegate = self
        panel.onDismiss = { [weak self] in self?.dismiss() }
        let hosting = NSHostingView(rootView: UsagePeekView(controller: self).environment(appState))
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting
        self.panel = panel
        frameAnimator = UsagePanelFrameAnimator(window: panel)
        visibilityAnimator = UsagePanelVisibilityAnimator(window: panel)

        hotkey.onPress = { [weak self] in
            guard let self, !self.keyPhysicallyHeld else { return }
            self.keyPhysicallyHeld = true
            self.peek.press()
            self.present(takeFocus: false)
        }
        hotkey.onRelease = { [weak self] in
            guard let self else { return }
            self.keyPhysicallyHeld = false
            self.peek.release()
            self.stopHoverTracking()
            if !self.peek.isVisible { self.hide() }
        }
        hotkey.onRecording = { [weak self] in self?.keyPhysicallyHeld = false; self?.dismiss(animated: false) }
        hotkey.start()

        let outside: (NSEvent) -> Void = { [weak self] _ in Task { @MainActor in self?.outsideClick() } }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: outside) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { e in outside(e); return e }) { monitors.append(m) }
        #if DEBUG
        // Screenshot/automation affordance: KRAKI_USAGE_PEEK_SHOW=compact|detail
        // opens the panel a few seconds after launch (as if F6 were held / the
        // menu entry clicked).
        if let mode = ProcessInfo.processInfo.environment["KRAKI_USAGE_PEEK_SHOW"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                guard let self else { return }
                if mode == "detail" { self.peek.click() } else { self.peek.press() }
                self.present(takeFocus: false)
            }
        }
        #endif
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification,
                     NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.activeSpaceDidChangeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.keyPhysicallyHeld = false; self?.dismiss(animated: false) }
            })
        }
    }

    /// Menu bar entry: open pinned in detail, or close.
    func togglePinned() {
        guard panel != nil else { return }
        peek.click()
        if peek.isVisible { present(takeFocus: true) } else { hide() }
    }

    func dismiss(animated: Bool = true) { peek.dismiss(); hide(animated: animated) }

    /// The content changed (accounts / devices); keep the window fitted to it.
    func contentDidChange() {
        guard let panel, panel.isVisible, !(visibilityAnimator?.isHiding ?? false) else { return }
        computeFrames(screen: panel.screen)
        frameAnimator?.move(to: displayedPresentation == .detailed ? detailedFrame : compactFrame, animated: true)
    }

    private func hide(animated: Bool = true) {
        stopHoverTracking()
        frameAnimator?.cancel()
        if panel?.isVisible == true && animated { closing = true }
        visibilityAnimator?.hide(animated: animated)
    }

    private func present(takeFocus: Bool) {
        guard let panel, let visibilityAnimator else { return }
        let alreadyVisible = panel.isVisible && !visibilityAnimator.isHiding
        if !panel.isVisible {
            let mouse = NSEvent.mouseLocation
            computeFrames(screen: NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main)
            entranceUntil = Date().addingTimeInterval(0.15)
            entranceSerial += 1
        }
        closing = false
        resize(animated: alreadyVisible)
        visibilityAnimator.show(takeFocus: takeFocus)
        if peek.held && !peek.pinned { startHoverTracking() } else { stopHoverTracking() }
    }

    private func computeFrames(screen: NSScreen?) {
        guard let visible = (screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        let rings = orderedAccounts().map(\.ringCount)
        maxHeight = min(640, visible.height - 28)
        let compact = UsagePeekLayout.plan(rings: rings, .compact, maxWidth: min(UsagePeekLayout.compactMaxWidth, visible.width - 28))
        let detail = UsagePeekLayout.plan(rings: rings, .detail, maxWidth: min(UsagePeekLayout.detailMaxWidth, visible.width - 28))
        compactSize = NSSize(width: compact.size.width, height: min(compact.size.height, maxHeight))
        // The detail frame contains the compact one, so hovering can't flicker at an edge.
        detailedSize = NSSize(width: max(detail.size.width, compact.size.width),
                              height: max(min(detail.size.height, maxHeight), compactSize.height))
        // Anchored under the right end of the menu bar; both sizes share the top-right corner.
        anchor = NSPoint(x: visible.maxX - 12, y: visible.maxY - 8)
        compactFrame = NSRect(x: anchor.x - compactSize.width, y: anchor.y - compactSize.height,
                              width: compactSize.width, height: compactSize.height)
        detailedFrame = NSRect(x: anchor.x - detailedSize.width, y: anchor.y - detailedSize.height,
                               width: detailedSize.width, height: detailedSize.height)
    }

    private func resize(animated: Bool) {
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            withAnimation(.spring(response: 0.46, dampingFraction: 0.86)) { displayedPresentation = peek.presentation }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { displayedPresentation = peek.presentation }
        }
        frameAnimator?.move(to: peek.presentation == .detailed ? detailedFrame : compactFrame, animated: animated)
    }

    private func outsideClick() {
        guard let panel, peek.pinned, !peek.held, panel.isVisible else { return }
        if panel.frame.contains(NSEvent.mouseLocation) { return }
        dismiss()
    }

    nonisolated func windowDidResignKey(_ notification: Notification) {
        Task { @MainActor in
            guard notification.object as? NSWindow === self.panel, self.peek.isVisible, !self.peek.held else { return }
            self.dismiss()
        }
    }

    private func startHoverTracking() {
        guard hoverTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluateHover() }
        }
        hoverTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopHoverTracking() {
        hoverTimer?.invalidate()
        hoverTimer = nil
        hoverCandidate = nil
    }

    private func evaluateHover() {
        guard let panel, peek.held, !peek.pinned, panel.isVisible else { return }
        let inside = panel.frame.contains(NSEvent.mouseLocation)
        guard inside != peek.hovering else { hoverCandidate = nil; return }
        let now = ProcessInfo.processInfo.systemUptime
        if hoverCandidate != inside { hoverCandidate = inside; hoverCandidateSince = now; return }
        // A short dwell keeps the edge from flickering.
        guard now - hoverCandidateSince >= (inside ? 0.14 : 0.18) else { return }
        hoverCandidate = nil
        peek.hover(inside)
        resize(animated: true)
    }
}
#endif
