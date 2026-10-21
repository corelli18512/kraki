/// MacAppDelegate — Bridges the AppKit application lifecycle to our
/// SwiftUI App scene. We use this for a small handful of things SwiftUI
/// doesn't expose directly:
///
///   - Closing the last window should HIDE the app rather than quit it
///     (we have a MenuBarExtra to live in). Use ⌘Q to actually quit.
///   - Catch `applicationWillTerminate` for a final flush (AppState
///     already observes the NotificationCenter event; this is a
///     belt-and-braces redundancy).
///   - Apply a dock badge label when AppState's unread-aggregate changes.

#if os(macOS)
import AppKit
import SwiftUI

@MainActor
final class MacAppDelegate: NSObject, NSApplicationDelegate {

    /// User opted to keep the app running in the menu bar when the
    /// last window closes? Default YES — surfacing it in Preferences
    /// later (m3-mac-prefs-general).
    @AppStorage("mac.keepRunningInMenuBar")
    private var keepRunningInMenuBar: Bool = true

    private(set) var updateController: MacUpdateController?
    private var updateNotificationObserver: NSObjectProtocol?

    override init() {
        updateController = nil
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        if NativeTestRuntime.isHeadlessTestHost {
            // No Dock icon, no activation at launch; offscreen test windows
            // still render.
            NSApp.setActivationPolicy(.accessory)
            return
        }
        #if DEBUG
        if ProcessInfo.processInfo.environment["KRAKI_RELEASE_POLISH_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runReleasePolishRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_HTML_ARTIFACT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runHTMLArtifactRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_IMAGE_PREVIEW_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runImagePreviewRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CORETEXT_SCROLL_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCoreTextScrollBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CORETEXT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCoreTextBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_UNREAD_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runUnreadProjectionRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_QUESTION_HIT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runQuestionHitRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CODE_HIGHLIGHT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCodeHighlightBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_CODE_HIGHLIGHT_UPGRADE_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runCodeHighlightUpgradeBenchmark() }
        } else if ProcessInfo.processInfo.environment["KRAKI_VOICE_TRANSCRIPT_SCROLL_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async {
                let result = MacComposerVoiceScrollRegression.run()
                NSLog("[voice-scroll-regression] passed=%d scrollView=%d exceeds=%d fixedViewport=%d tailAttached=%d viewport=%.1f document=%.1f",
                      result["passed"] as? Bool == true ? 1 : 0,
                      result["scrollView"] as? Bool == true ? 1 : 0,
                      result["contentExceedsViewport"] as? Bool == true ? 1 : 0,
                      result["fixedViewport"] as? Bool == true ? 1 : 0,
                      result["tailAttached"] as? Bool == true ? 1 : 0,
                      result["viewportHeight"] as? CGFloat ?? 0,
                      result["documentHeight"] as? CGFloat ?? 0)
                NSLog("[voice-scroll-regression-content] length=%d",
                      result["documentLength"] as? Int ?? 0)
                NSLog("[voice-scroll-regression-layout] scrollWidth=%.1f clipWidth=%.1f measured=%.1f",
                      result["scrollWidth"] as? CGFloat ?? 0,
                      result["clipWidth"] as? CGFloat ?? 0,
                      result["measuredHeight"] as? CGFloat ?? 0)
                NSLog("[voice-scroll-regression-origin] originY=%.1f documentRect=%.1f",
                      result["originY"] as? CGFloat ?? 0,
                      result["documentRectHeight"] as? CGFloat ?? 0)
                NSApp.terminate(nil)
            }
        } else if ProcessInfo.processInfo.environment["KRAKI_VOICE_TRANSCRIPT_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            DispatchQueue.main.async { [weak self] in self?.runVoiceTranscriptRegression() }
        } else if ProcessInfo.processInfo.environment["KRAKI_MAC_CLI_AUTH_BENCH"] == "1" {
            NSApp.setActivationPolicy(.prohibited)
            Task { @MainActor in
                let found = await AuthManager.loadCLICredentials() != nil
                KLog.diag("Mac CLI credential regression found=\(found ? 1 : 0)")
                NSApp.terminate(nil)
            }
        }
        if ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1",
           ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION_VISIBLE"] != "1" {
            // An ordinary native automation host is a background rendering /
            // control process. Explicit visible validation instead keeps the
            // isolated Debug app regular so a human can watch the same gate.
            NSApp.setActivationPolicy(.prohibited)
        }
        #endif
        // Single-window app: kill window tabbing before any window is
        // created/restored. SwiftUI persists a "Show Tab Bar" toggle
        // (NSWindowTabbingShoudShowTabBarKey-… — Apple's own misspelling)
        // per WindowGroup, which otherwise restores a Safari-style tab bar
        // on launch even with one window and tabbingMode = .disallowed.
        // Clearing it here, before window restoration, prevents that.
        NSWindow.allowsAutomaticWindowTabbing = false
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix("NSWindowTabbingShoudShowTabBarKey") {
            defaults.set(false, forKey: key)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if NativeTestRuntime.isHeadlessTestHost { return }
        if Bundle.main.bundleIdentifier == MacUpdateController.productionBundleIdentifier {
            updateController = MacUpdateController.makeIfProduction()
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                self?.updateController?.start()
            }
        }
        #if DEBUG
        let environmentAutomation = ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1"
        let visibleAutomation = ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION_VISIBLE"] == "1"
        let argumentAutomation = CommandLine.arguments.contains("--kraki-native-automation")
        let nativeAutomation = environmentAutomation || argumentAutomation
        if visibleAutomation || !environmentAutomation {
            // LaunchServices command-line automation keeps a normal app
            // policy so WindowGroup creates its real layout, while `open -g`
            // still prevents activation and focus theft.
            NSApp.setActivationPolicy(.regular)
        }
        #else
        NSApp.setActivationPolicy(.regular)
        #endif
        // After the policy above: a login launch switches back to menu-bar-only.
        installPresenceObservers()

        // Remove the "File" menu. SwiftUI synthesizes it, but this app has
        // no file concept (New Session lives under Session; Close Window is
        // in the Window menu, see MacCommands). SwiftUI builds the main menu
        // during launch, so we strip it on the next runloop tick and again
        // whenever the app reactivates.
        removeUnwantedMenus()
        DispatchQueue.main.async { [weak self] in self?.removeUnwantedMenus() }

        updateNotificationObserver = NotificationCenter.default.addObserver(
            forName: .macCheckForUpdates,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.updateController?.checkForUpdates()
            }
        }

        #if DEBUG
        if nativeAutomation && !visibleAutomation {
            ensureMainWindowLaidOutOffscreen()
        }
        // Headless screenshot affordance (dev-local only). We do NOT try
        // to make ScreenCaptureKit grab a background window — a SwiftUI
        // WindowGroup launched without activation never gets a real
        // window-server surface, so SCK only ever sees a tiny placeholder.
        //
        // Instead we render the window's *view tree* directly into a
        // bitmap via `bitmapImageRepForCachingDisplay(in:)`. That draws
        // the layer hierarchy itself — it works even when the window is
        // off-screen and never activated, and it never touches focus, the
        // Dock, or the foreground app. A lightweight file-watch lets an
        // external tool request a shot by touching a sentinel file.
        let environment = ProcessInfo.processInfo.environment
        let devLocal = environment["KRAKI_DEV_LOCAL"] == "1"
        let headlessShot = environment["KRAKI_HEADLESS_SHOT"] == "1"
        if devLocal {
            // The shot watcher is harmless in normal viewing — it only
            // renders on an explicit file trigger.
            startHeadlessShotWatcher()
        }
        if headlessShot {
            ensureMainWindowLaidOutOffscreen()
        } else {
            let automatedWindowMode = nativeAutomation || [
                "KRAKI_RELEASE_POLISH_BENCH",
                "KRAKI_HTML_ARTIFACT_BENCH",
                "KRAKI_IMAGE_PREVIEW_BENCH",
                "KRAKI_CORETEXT_SCROLL_BENCH",
                "KRAKI_CORETEXT_BENCH",
                "KRAKI_CODE_HIGHLIGHT_BENCH",
                "KRAKI_CODE_HIGHLIGHT_UPGRADE_BENCH",
                "KRAKI_VOICE_TRANSCRIPT_BENCH",
                "KRAKI_MAC_CLI_AUTH_BENCH",
                "KRAKI_RENDER_BUBBLE_TEST",
                "KRAKI_RENDER_CHAT_TEST",
                "KRAKI_RENDER_COMPOSER_TEST",
                "KRAKI_E2E_SELFTEST",
                "KRAKI_MAC_CHAT_SNAPSHOT_TEST",
                "KRAKI_MAC_CHAT_PERF_PAGE",
                "KRAKI_MAC_CHAT_SCENARIO_PAGE",
            ].contains { environment[$0] == "1" }
            if visibleAutomation {
                // Human-observed validation uses the same isolated fixture and
                // semantic automation socket, but intentionally centers and
                // activates the Debug window instead of parking it off-screen.
                inflateAndCenterMainWindowOnce()
            } else if !automatedWindowMode {
                // Any ordinary foreground Debug launch may start with the
                // tiny SwiftUI placeholder surface. Inflate only when needed;
                // this covers both production-relay Dev and local-relay Dev.
                inflateAndCenterMainWindowOnce()
            }
        }

        #if DEBUG
        scheduleMenuDumpsIfRequested()
        #endif

        if ProcessInfo.processInfo.environment["KRAKI_RENDER_BUBBLE_TEST"] == "1" {
            renderBubbleTestToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_RENDER_CHAT_TEST"] == "1" {
            renderChatListToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_RENDER_COMPOSER_TEST"] == "1" {
            renderComposerStatesToPNG()
        } else if ProcessInfo.processInfo.environment["KRAKI_E2E_SELFTEST"] == "1" {
            renderE2ESelfTestToPNG()
        }
        #endif
    }

    #if DEBUG
    let headlessShotRequestPath = "/tmp/kraki-shot-request"
    #endif

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // false → keep the app alive in the menu bar after the user
        // hits red-circle close on the main window. While Kraki runs this
        // Mac's agents it always stays: online must stay visible
        // (MacPresence.swift). Quit from the MenuBarExtra menu.
        if MacPresenceController.shared.managesPresence { return false }
        // A headless test host closes its own offscreen windows: stay alive.
        if NativeTestRuntime.isHeadlessTestHost { return false }
        return !keepRunningInMenuBar
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A person quitting (Dock, AppleScript) takes this Mac offline after
        // confirming; logout, restart and updates pass straight through.
        MacPresenceController.shared.shouldTerminate(sender)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Opening Kraki again (Finder, Spotlight, Dock) while it only lives in
        // the menu bar shows its window, including the one hidden at login.
        if !flag { MacPresenceController.shared.showMainWindow() }
        return true
    }

    // MARK: - Presence (menu bar, Dock icon, login launch)

    private var presenceObservers: [NSObjectProtocol] = []

    private func installPresenceObservers() {
        #if DEBUG
        if NativeTestRuntime.isRunningTests || NSApp.activationPolicy() == .prohibited { return }
        let automation = ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1"
            || CommandLine.arguments.contains("--kraki-native-automation")
        if automation { return }
        #endif
        let presence = MacPresenceController.shared
        if MacPresenceController.wasLaunchedAsLoginItem(NSAppleEventManager.shared().currentAppleEvent) {
            KLog.diag("[Presence] launched at login; menu bar only")
            presence.beginLoginLaunch()
        }
        let center = NotificationCenter.default
        presenceObservers.append(center.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { presence.updateActivationPolicy() }
        })
        presenceObservers.append(center.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { note in
            guard let window = note.object as? NSWindow,
                  !(window is NSPanel), window.styleMask.contains(.titled) else { return }
            // The closing window still counts as visible until this returns.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard MacPresenceController.appWindows().isEmpty else { return }
                    presence.updateActivationPolicy()
                    presence.lastWindowDidClose()
                }
            }
        })
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // SwiftUI can rebuild the main menu on reactivation — re-strip
        // the File menu so it never reappears.
        removeUnwantedMenus()
    }

    #if DEBUG
    /// KRAKI_MENUBAR_DUMP_AFTER / KRAKI_MAINMENU_DUMP_AFTER=<seconds>: log the
    /// menu bar menu / the whole main menu, for checks without opening them
    /// or needing Accessibility access.
    private func scheduleMenuDumpsIfRequested() {
        if let delay = ProcessInfo.processInfo.environment["KRAKI_MENUBAR_DUMP_AFTER"].flatMap(Double.init) {
            // Check of the menu bar menu without opening it (no focus steal):
            // log every item SwiftUI builds for it.
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                let button = NSApp.windows
                    .filter { NSStringFromClass(type(of: $0)).contains("StatusBarWindow") }
                    .compactMap { $0.contentView?.firstDescendant(ofType: NSStatusBarButton.self) }
                    .first
                // SwiftUI keeps the menu on its NSStatusItem, not on the button.
                guard let menu = (button?.value(forKey: "_statusItem") as? NSStatusItem)?.menu else {
                    NSLog("[menubar-dump] no menu")
                    return
                }
                NSLog("[menubar-dump] icon template=%d size=%@", button?.image?.isTemplate == true ? 1 : 0,
                      NSStringFromSize(button?.image?.size ?? .zero))
                menu.delegate?.menuNeedsUpdate?(menu)
                menu.update()
                for item in menu.items {
                    NSLog("[menubar-dump] %@", item.isSeparatorItem ? "----" : [
                        item.isSectionHeader ? "[header]" : nil,
                        item.title,
                        item.subtitle.map { "· \($0)" },
                        item.image == nil ? nil : "(image)",
                        item.keyEquivalent.isEmpty ? nil : "⌘\(item.keyEquivalent)",
                        item.isEnabled ? nil : "(disabled)",
                    ].compactMap { $0 }.joined(separator: " "))
                }
            }
        }
        if let delay = ProcessInfo.processInfo.environment["KRAKI_MAINMENU_DUMP_AFTER"].flatMap(Double.init) {
            // Check of the main menu bar without opening it: log every menu,
            // item and shortcut as built (after SwiftUI and removeUnwantedMenus).
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                func keys(_ item: NSMenuItem) -> String? {
                    guard !item.keyEquivalent.isEmpty else { return nil }
                    let m = item.keyEquivalentModifierMask
                    let names: [UInt16: String] = [0xF700: "↑", 0xF701: "↓", 0x08: "⌫", 0x7F: "⌫"]
                    let key = item.keyEquivalent.utf16.first.flatMap { names[$0] } ?? item.keyEquivalent.uppercased()
                    return (m.contains(.control) ? "⌃" : "") + (m.contains(.option) ? "⌥" : "")
                        + (m.contains(.shift) ? "⇧" : "") + (m.contains(.command) ? "⌘" : "") + key
                }
                for top in NSApp.mainMenu?.items ?? [] {
                    guard let menu = top.submenu else { continue }
                    menu.update()
                    NSLog("[mainmenu-dump] == %@", menu.title)
                    for item in menu.items where !item.isHidden {
                        NSLog("[mainmenu-dump] %@", item.isSeparatorItem ? "  ----" : "  " + [
                            item.title, keys(item), item.isEnabled ? nil : "(disabled)",
                        ].compactMap { $0 }.joined(separator: "  "))
                    }
                }
            }
        }
    }
    #endif

    /// Removes the synthesized "File" menu from the menu bar. The Window
    /// menu stays (trimmed in MacCommands): it carries ⌘W and ⌘M.
    private func removeUnwantedMenus() {
        guard let mainMenu = NSApp.mainMenu else { return }
        // AppKit supplies this title; recognize both supported UI languages.
        for item in mainMenu.items where ["File", "文件"].contains(item.submenu?.title ?? "") {
            mainMenu.removeItem(item)
        }
    }

    deinit {
        if let updateNotificationObserver {
            NotificationCenter.default.removeObserver(updateNotificationObserver)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // AppState already registered for NSApplication.willTerminate
        // and flushes its stores. Nothing extra to do here yet.
    }
}

#if DEBUG
private extension NSView {
    func firstDescendant<T: NSView>(ofType type: T.Type) -> T? {
        if let match = self as? T { return match }
        for child in subviews {
            if let match = child.firstDescendant(ofType: type) { return match }
        }
        return nil
    }
}
#endif

#endif
