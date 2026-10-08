/// MacPresence — what "Kraki on this Mac" means to the user.
///
/// Kraki for Mac is three things: the window, the app process (menu bar) and
/// the built-in background service launchd runs. Users should only have to
/// think about one of them: **is this Mac online**, i.e. can my phone and my
/// other computers use the agents here. The window is just a remote control,
/// like the phone app.
///
/// Rules this file enforces (built-in tentacle, "run agents on this Mac"):
///   • Online ⇒ visible. While the service runs the menu bar octopus is there:
///     the app starts in the menu bar at login, closing the window or ⌘Q only
///     puts the window away, and the Dock icon goes with the last window.
///   • Quitting Kraki takes this Mac offline (confirmed once). Opening Kraki
///     brings it back online.
///   • Log out, restart, shutdown and app updates terminate the app without
///     touching the service, so the Mac comes back online by itself.
///
/// A standalone-CLI install (external mode) keeps its old behavior: the CLI
/// owns that daemon, so quitting the app never stops it.

#if os(macOS)
import AppKit
import ServiceManagement
import SwiftUI

// MARK: - Status

/// The single user-facing status of this Mac.
enum MacOnlineStatus: Equatable {
    case checking
    case online
    case goingOnline
    case goingOffline
    case offline
    /// The user turned Kraki off in System Settings › Login Items.
    case needsLoginItems
    case problem(String)
    /// This Mac doesn't run agents (remote-only role, or no tentacle at all).
    case controlsOthersOnly

    static func resolve(
        installState: TentacleCLIManager.InstallState,
        daemonState: TentacleCLIManager.DaemonState,
        mode: TentacleMode,
        role: BuiltInTentacle.ThisMacRole
    ) -> MacOnlineStatus {
        if mode == .builtIn, role == .remoteOnly { return .controlsOthersOnly }
        switch installState {
        case .unknown: return .checking
        case .notFound: return .controlsOthersOnly
        case .available: break
        }
        switch daemonState {
        case .unknown: return .checking
        case .running: return .online
        case .starting: return .goingOnline
        case .stopping: return .goingOffline
        case .stopped: return .offline
        case .needsApproval: return .needsLoginItems
        case .error(let message): return .problem(message)
        }
    }

    var isOnline: Bool { self == .online }

    /// Whether anything about this Mac is wrong enough to badge the icon.
    var needsFixing: Bool {
        switch self {
        case .needsLoginItems, .problem: return true
        default: return false
        }
    }

    var title: String {
        switch self {
        case .checking: return "Checking this Mac…"
        case .online: return "This Mac is online"
        case .goingOnline: return "This Mac is going online…"
        case .goingOffline: return "This Mac is going offline…"
        case .offline: return "This Mac is offline"
        case .needsLoginItems, .problem: return "This Mac can't go online"
        case .controlsOthersOnly: return "This Mac controls other computers"
        }
    }

    var detail: String? {
        switch self {
        case .online: return "Your phone and other computers can use its agents"
        case .offline: return "Your phone can't use the agents on this Mac"
        case .needsLoginItems: return "Turn Kraki on in System Settings › Login Items"
        case .problem(let message): return message
        case .controlsOthersOnly: return "No agents run on this Mac"
        case .checking, .goingOnline, .goingOffline: return nil
        }
    }
}

extension TentacleCLIManager {
    var onlineStatus: MacOnlineStatus {
        MacOnlineStatus.resolve(
            installState: installState,
            daemonState: daemonState,
            mode: mode,
            role: BuiltInTentacle.thisMacRole
        )
    }

    /// True when this app owns whether the Mac is online: the built-in
    /// service, running agents here. Only then does quitting go offline.
    var managesOnlinePresence: Bool {
        mode == .builtIn && builtIn.isAvailable && BuiltInTentacle.thisMacRole != .remoteOnly
    }

    var canGoOnline: Bool {
        guard case .available = installState else { return false }
        switch onlineStatus {
        case .offline, .problem, .needsLoginItems: return true
        default: return false
        }
    }

    var canGoOffline: Bool {
        switch onlineStatus {
        case .online, .goingOnline: return true
        default: return false
        }
    }

    func goOnline() async {
        if case .needsApproval = daemonState {
            BuiltInTentacle.openLoginItemsSettings()
        }
        await startDaemon()
        MacPresenceController.shared.syncLoginItem()
    }

    func goOffline() async {
        await stopDaemon()
    }

    /// Opening Kraki brings this Mac online (it went offline when Kraki was
    /// last quit). First-time setup still runs through BuiltInSetupView.
    func goOnlineAtLaunchIfNeeded() async {
        guard managesOnlinePresence, installLocation == .stable else { return }
        await refreshDaemonState()
        guard configInfo?.exists == true else { return }
        if case .stopped = daemonState {
            KLog.diag("[Presence] offline at launch; going online")
            await startDaemon()
        }
    }
}

// MARK: - Quit classification

enum MacQuitSource: Equatable {
    /// A person asked to quit: the Dock's Quit, AppleScript `quit`, …
    case user
    /// Log out / restart / shut down, an app update, our own terminate calls.
    case system

    /// `kAEQuitApplication` without a quit reason is a person quitting the
    /// app; the session ending adds `keyAEQuitReason`. Direct
    /// `NSApp.terminate` calls (Sparkle, the offline quit flow) carry no quit
    /// event at all.
    static func classify(eventClass: AEEventClass?, eventID: AEEventID?, hasQuitReason: Bool) -> MacQuitSource {
        guard eventClass == AEEventClass(kCoreEventClass),
              eventID == AEEventID(kAEQuitApplication),
              !hasQuitReason else { return .system }
        return .user
    }

    static func classify(_ event: NSAppleEventDescriptor?) -> MacQuitSource {
        guard let event else { return .system }
        return classify(
            eventClass: event.eventClass,
            eventID: event.eventID,
            hasQuitReason: event.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason)) != nil
                || event.paramDescriptor(forKeyword: AEKeyword(kAEQuitReason)) != nil
        )
    }
}

// MARK: - Menu bar icon

enum MacMenuBarIcon {
    enum Badge: Equatable { case none, attention, problem }

    static let size = NSSize(width: 18, height: 18)

    static func badge(for status: MacOnlineStatus, needsYou: Bool) -> Badge {
        if status.needsFixing { return .problem }
        if needsYou { return .attention }
        return .none
    }

    static func alpha(for status: MacOnlineStatus) -> CGFloat {
        switch status {
        case .online, .checking, .controlsOthersOnly, .needsLoginItems, .problem: return 1
        case .goingOnline, .goingOffline: return 0.6
        case .offline: return 0.4
        }
    }

    /// The logo silhouette. Plain states stay template images (macOS tints
    /// them for light/dark menu bars and the highlighted state); badges need
    /// color, so those images draw the silhouette in the label color of the
    /// appearance they are drawn in.
    static func image(status: MacOnlineStatus, needsYou: Bool) -> NSImage {
        let base = NSImage(named: "MenuBarKraki") ?? NSImage(size: size)
        let alpha = alpha(for: status)
        let badge = badge(for: status, needsYou: needsYou)
        let image = NSImage(size: size, flipped: false) { rect in
            draw(base: base, in: rect, alpha: alpha, tinted: badge != .none)
            switch badge {
            case .none: break
            case .attention:
                drawDot(center: NSPoint(x: rect.maxX - 3.2, y: rect.maxY - 3.2), radius: 3.2, color: .systemOrange)
            case .problem:
                drawDot(center: NSPoint(x: rect.maxX - 3.6, y: rect.minY + 3.6), radius: 3.6, color: .systemRed, mark: "!")
            }
            return true
        }
        image.isTemplate = badge == .none
        image.accessibilityDescription = "Kraki – \(status.title)"
        return image
    }

    private static func draw(base: NSImage, in rect: NSRect, alpha: CGFloat, tinted: Bool) {
        guard tinted else {
            base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
            return
        }
        guard let context = NSGraphicsContext.current else { return }
        context.saveGraphicsState()
        // Silhouette as a mask, filled with the current appearance's label color.
        base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
        NSColor.labelColor.withAlphaComponent(1).set()
        rect.fill(using: .sourceIn)
        context.restoreGraphicsState()
    }

    private static func drawDot(center: NSPoint, radius: CGFloat, color: NSColor, mark: String? = nil) {
        // Knock a gap out of the silhouette so the dot reads on top of it.
        let gap = NSBezierPath(ovalIn: NSRect(x: center.x - radius - 1.2, y: center.y - radius - 1.2,
                                              width: (radius + 1.2) * 2, height: (radius + 1.2) * 2))
        NSGraphicsContext.current?.compositingOperation = .clear
        gap.fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius,
                                    width: radius * 2, height: radius * 2)).fill()
        guard let mark else { return }
        let font = NSFont.systemFont(ofSize: radius * 1.7, weight: .heavy)
        let text = NSAttributedString(string: mark, attributes: [.font: font, .foregroundColor: NSColor.white])
        let textSize = text.size()
        text.draw(at: NSPoint(x: center.x - textSize.width / 2, y: center.y - textSize.height / 2 + 0.3))
    }
}

// MARK: - Controller

@MainActor
final class MacPresenceController {
    static let shared = MacPresenceController()

    weak var tentacle: TentacleCLIManager?

    /// True once the user confirmed "Quit and go offline" and the service is
    /// being stopped; the final terminate must then go through untouched.
    private(set) var isQuittingOffline = false
    /// Launched by macOS at login: stay in the menu bar, no window.
    private(set) var launchedAtLogin = false

    private static let confirmQuitSuppressedKey = "presence.quitConfirmSuppressed"
    private static let closeHintShownKey = "presence.closeHintShown"
    private static let autoLoginItemKey = "presence.autoLoginItem"

    var managesPresence: Bool { tentacle?.managesOnlinePresence ?? false }

    // MARK: Quit

    /// Menu bar "Quit Kraki…", the app menu's quit item, the Dock's Quit.
    /// Returns false when the user cancelled.
    @discardableResult
    func confirmQuitGoingOffline() -> Bool {
        guard managesPresence, let tentacle, tentacle.canGoOffline else { return true }
        if UserDefaults.standard.bool(forKey: Self.confirmQuitSuppressedKey) { return true }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Quit Kraki and take this Mac offline?"
        alert.informativeText = "Your phone and other computers won't be able to use the agents on this Mac until you open Kraki again.\n\nTo keep this Mac online, just close the window. Kraki stays in the menu bar."
        alert.addButton(withTitle: "Quit and Go Offline")
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        let confirmed = alert.runModal() == .alertFirstButtonReturn
        if confirmed, alert.suppressionButton?.state == .on {
            UserDefaults.standard.set(true, forKey: Self.confirmQuitSuppressedKey)
        }
        return confirmed
    }

    func quitGoingOffline() {
        guard managesPresence else { NSApp.terminate(nil); return }
        guard confirmQuitGoingOffline() else { return }
        Task { @MainActor in
            await self.takeOfflineForQuit()
            NSApp.terminate(nil)
        }
    }

    /// Stop the service and drop the login item we added for it.
    func takeOfflineForQuit() async {
        isQuittingOffline = true
        KLog.diag("[Presence] quitting; taking this Mac offline")
        await tentacle?.goOffline()
        if UserDefaults.standard.bool(forKey: Self.autoLoginItemKey) {
            try? await SMAppService.mainApp.unregister()
            UserDefaults.standard.set(false, forKey: Self.autoLoginItemKey)
        }
    }

    /// Set when Sparkle is about to replace the app (MacUpdateController).
    private(set) var isInstallingUpdate = false

    func beginInstallingUpdate() {
        KLog.diag("[Presence] installing an update; quitting without going offline")
        isInstallingUpdate = true
    }

    /// Whether quitting goes through the "take this Mac offline?" question.
    nonisolated static func asksBeforeQuitting(
        quittingOffline: Bool, installingUpdate: Bool, managesPresence: Bool, source: MacQuitSource
    ) -> Bool {
        !quittingOffline && !installingUpdate && managesPresence && source == .user
    }

    /// An update started from another device (Update in the phone's device
    /// details) quits Kraki with an AppleScript `quit` while it swaps the app:
    /// the built-in Kraki keeps `remote-update/plan.json` until it is done.
    /// Recent only: a plan left by an updater that died never silences Quit.
    nonisolated static func remoteUpdateInProgress(
        krakiHome: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".kraki"),
        now: Date = Date()
    ) -> Bool {
        let plan = krakiHome.appendingPathComponent("remote-update/plan.json")
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: plan.path))?[.modificationDate] as? Date
        else { return false }
        return now.timeIntervalSince(modified) < 3600
    }

    /// `applicationShouldTerminate`: route a person's quit (Dock, AppleScript)
    /// through the same confirmation; let everything else through.
    func shouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        guard Self.asksBeforeQuitting(
            quittingOffline: isQuittingOffline,
            installingUpdate: isInstallingUpdate || Self.remoteUpdateInProgress(),
            managesPresence: managesPresence,
            source: MacQuitSource.classify(NSAppleEventManager.shared().currentAppleEvent)
        ) else { return .terminateNow }
        guard confirmQuitGoingOffline() else { return .terminateCancel }
        Task { @MainActor in
            await self.takeOfflineForQuit()
            app.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: Closing the window (⌘Q while online)

    func closeWindowsStayingOnline() {
        for window in Self.appWindows() { window.performClose(nil) }
        // performClose is refused by windows without a close button; make sure.
        for window in Self.appWindows() { window.close() }
    }

    /// Once, the first time the last window goes away while online.
    func lastWindowDidClose() {
        guard managesPresence, tentacle?.onlineStatus.isOnline == true,
              !UserDefaults.standard.bool(forKey: Self.closeHintShownKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.closeHintShownKey)
        MacStayOnlineHint.show()
    }

    // MARK: Windows, Dock icon

    /// Real windows (not the status item, panels, menus or popovers).
    static func appWindows() -> [NSWindow] {
        NSApp.windows.filter { window in
            window.isVisible
                && !(window is NSPanel)
                && window.styleMask.contains(.titled)
                && window.level == .normal
        }
    }

    /// The Dock icon follows the windows: none while Kraki only lives in the
    /// menu bar, back as soon as a window opens.
    func updateActivationPolicy() {
        guard NSApp.activationPolicy() != .prohibited, !settlingLoginLaunch else { return }
        let wanted: NSApplication.ActivationPolicy = Self.appWindows().isEmpty ? .accessory : .regular
        guard NSApp.activationPolicy() != wanted else { return }
        NSApp.setActivationPolicy(wanted)
        if wanted == .regular { NSApp.activate(ignoringOtherApps: true) }
    }

    func showMainWindow() {
        // The user asked for the window: stop hiding it.
        settlingLoginLaunch = false
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let candidates = NSApp.windows.filter {
            !($0 is NSPanel) && $0.styleMask.contains(.titled) && $0.contentView != nil
        }
        let main = candidates.first { $0.identifier?.rawValue.hasPrefix("main") == true }
            ?? candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        main?.makeKeyAndOrderFront(nil)
    }

    // MARK: Login

    static func wasLaunchedAsLoginItem(_ event: NSAppleEventDescriptor?) -> Bool {
        guard let event, event.eventID == AEEventID(kAEOpenApplication) else { return false }
        return event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue
            == OSType(keyAELaunchedAsLogInItem)
    }

    /// Launched at login: keep the window's content alive (it owns startup)
    /// but never show it. The menu bar octopus is the only thing that appears.
    ///
    /// The Dock icon is dropped only once launch has settled. Changing the
    /// activation policy while SwiftUI is still building its scenes re-entered
    /// SwiftUI's scene updates until the main thread's stack overflowed (seen
    /// on a clean VM after a restart), so nothing here touches the policy
    /// during the first seconds, and window notifications are ignored then.
    func beginLoginLaunch() {
        launchedAtLogin = true
        settlingLoginLaunch = true
        hideWindowsDuringLoginLaunch(remaining: 12)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.settlingLoginLaunch else { return }
            self.settlingLoginLaunch = false
            self.updateActivationPolicy()
        }
    }

    /// True during the first seconds of a login launch (see beginLoginLaunch).
    private(set) var settlingLoginLaunch = false

    private func hideWindowsDuringLoginLaunch(remaining: Int) {
        guard settlingLoginLaunch, remaining > 0 else { return }
        for window in Self.appWindows() { window.orderOut(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.hideWindowsDuringLoginLaunch(remaining: remaining - 1)
        }
    }

    /// While this Mac is online, Kraki opens at login so the menu bar shows
    /// it. Only a login item we added is removed again (on quit).
    func syncLoginItem() {
        guard managesPresence else { return }
        let service = SMAppService.mainApp
        guard service.status != .enabled, service.status != .requiresApproval else { return }
        do {
            try service.register()
            UserDefaults.standard.set(true, forKey: Self.autoLoginItemKey)
            KLog.diag("[Presence] registered login item")
        } catch {
            KLog.diag("[Presence] login item registration failed: \(error.localizedDescription)")
        }
    }
}

// MARK: - "Still online" hint

/// A small note under the menu bar octopus, shown once, the first time the
/// window is closed while this Mac is online.
@MainActor
enum MacStayOnlineHint {
    private static var panel: NSPanel?

    static func show() {
        panel?.orderOut(nil)
        let content = NSHostingView(rootView: HintView { dismiss() })
        content.frame.size = content.fittingSize
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: content.fittingSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentView = content
        panel.collectionBehavior = [.canJoinAllSpaces, .transient]
        panel.setFrameOrigin(origin(for: panel.frame.size))
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.18; panel.animator().alphaValue = 1 }
        self.panel = panel
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { dismiss() }
    }

    static func dismiss() {
        guard let panel else { return }
        self.panel = nil
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.18; panel.animator().alphaValue = 0 }) {
            panel.orderOut(nil)
        }
    }

    /// Below Kraki's status item when we can find it, else the top-right corner.
    private static func origin(for size: NSSize) -> NSPoint {
        let statusWindow = NSApp.windows.first {
            NSStringFromClass(type(of: $0)).contains("StatusBarWindow") && $0.isVisible
        }
        if let anchor = statusWindow?.frame, let screen = statusWindow?.screen ?? NSScreen.main {
            let x = min(max(anchor.midX - size.width / 2, screen.visibleFrame.minX + 8),
                        screen.visibleFrame.maxX - size.width - 8)
            return NSPoint(x: x, y: anchor.minY - size.height - 6)
        }
        let frame = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        return NSPoint(x: frame.maxX - size.width - 12, y: frame.maxY - size.height - 6)
    }

    private struct HintView: View {
        let onDismiss: () -> Void

        var body: some View {
            HStack(alignment: .top, spacing: 10) {
                Image(nsImage: MacMenuBarIcon.image(status: .online, needsYou: false))
                    .renderingMode(.template)
                    .foregroundStyle(.primary)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Kraki is still online")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Your phone can keep using this Mac. Open Kraki from here any time; quit it here to take this Mac offline.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(width: 290, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator))
            .contentShape(Rectangle())
            .onTapGesture(perform: onDismiss)
        }
    }
}

#endif
