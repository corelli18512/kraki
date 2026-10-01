/// UsagePeekController — the floating account usage panel.
///
/// Hold the shortcut (default F6) for a compact overview of every online
/// tentacle's accounts; move the pointer in and it smoothly grows into the
/// detail view; move out while still holding and it shrinks back; release
/// and it fades away. "Account Usage" in the menu bar opens it pinned.
/// The device running the Session currently open in Kraki is listed first.
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

enum UsagePeekLayout {
    static let compactWidth: CGFloat = 460
    static let detailWidth: CGFloat = 790
    static let columns = 3
    static let compactTile: CGFloat = 124
    static let compactGap: CGFloat = 6
    static let compactHeader: CGFloat = 26
    static let compactSectionGap: CGFloat = 8
    static let detailCard: CGFloat = 214
    static let detailGap: CGFloat = 12
    static let detailHeader: CGFloat = 30
    static let detailSectionGap: CGFloat = 16
    static let detailPadding: CGFloat = 18

    static func rows(_ count: Int) -> Int { max(1, (count + columns - 1) / columns) }

    static func compactHeight(_ sections: [Int]) -> CGFloat {
        guard !sections.isEmpty else { return 96 }
        let body = sections.map { compactHeader + CGFloat(rows($0)) * compactTile + CGFloat(rows($0) - 1) * compactGap }
        return 18 + body.reduce(0, +) + CGFloat(sections.count - 1) * compactSectionGap
    }

    static func detailHeight(_ sections: [Int]) -> CGFloat {
        guard !sections.isEmpty else { return 140 }
        let body = sections.map { detailHeader + CGFloat(rows($0)) * detailCard + CGFloat(rows($0) - 1) * detailGap }
        return detailPadding * 2 + body.reduce(0, +) + CGFloat(sections.count - 1) * detailSectionGap
    }
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
    @Published private(set) var compactSize = NSSize(width: UsagePeekLayout.compactWidth, height: 160)
    @Published private(set) var detailedSize = NSSize(width: UsagePeekLayout.detailWidth, height: 300)
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

    /// The device running the Session open in Kraki, listed first and highlighted.
    var currentDeviceId: String? {
        guard let appState, let id = currentSessionId() else { return nil }
        return appState.sessionStore.sessions[id]?.deviceId
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

    private func sectionCounts() -> [Int] {
        appState?.deviceStore.onlineUsageDevices(preferredDeviceId: currentDeviceId).map(\.usage.accounts.count) ?? []
    }

    private func computeFrames(screen: NSScreen?) {
        guard let visible = (screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        let counts = sectionCounts()
        maxHeight = min(640, visible.height - 28)
        compactSize = NSSize(width: min(UsagePeekLayout.compactWidth, visible.width - 28),
                             height: min(UsagePeekLayout.compactHeight(counts.map { min($0, 6) }), maxHeight))
        detailedSize = NSSize(width: min(UsagePeekLayout.detailWidth, visible.width - 28),
                              height: min(UsagePeekLayout.detailHeight(counts), maxHeight))
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
