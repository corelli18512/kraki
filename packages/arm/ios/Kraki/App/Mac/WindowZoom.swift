/// WindowZoom — app-wide UI zoom for the mac target.
///
/// macOS native apps don't ship with a browser-style ⌘+/⌘- zoom out
/// of the box. We add one ourselves by wrapping the window's content
/// in a `.scaleEffect()` and giving the inner content the *inverse*
/// frame so layout still computes against the full window size.
///
/// Pattern:
///
///     GeometryReader { geo in
///         content
///             .frame(
///                 width:  geo.size.width  / zoom,
///                 height: geo.size.height / zoom
///             )
///             .scaleEffect(zoom, anchor: .topLeading)
///     }
///
/// This makes SwiftUI lay the content out as if the window were
/// `1/zoom` of its real size, then visually scales it back up. Hit
/// testing is mapped through the scale by SwiftUI automatically, so
/// clicks land on the right spot.
///
/// Zoom level is persisted in the shared machine-local `mac-local.json`
/// and driven by ⌘+ / ⌘- / ⌘0 from the View menu (see `MacCommands`).

#if os(macOS)
import AppKit
import Darwin
import Foundation
import SwiftUI

struct MacLocalConfig: Codable, Equatable {
    struct Window: Codable, Equatable {
        var mainWidth: Double
        var mainHeight: Double
    }

    struct Display: Codable, Equatable {
        var uiZoom: Double
    }

    var schemaVersion: Int
    var window: Window
    var display: Display

    static let defaults = MacLocalConfig(
        schemaVersion: 1,
        window: Window(mainWidth: 1100, mainHeight: 720),
        display: Display(uiZoom: 1)
    )
}

/// Shared machine-local UI configuration for the Prod and Dev Mac apps.
/// Authentication, permissions, Session state, and caches remain per bundle.
final class MacLocalConfigStore {
    enum Change: String {
        case window
        case display
    }

    static let shared = MacLocalConfigStore()
    static let localChangeNotification = Notification.Name("chat.kraki.mac.local-config.changed")
    static let distributedChangeNotification = Notification.Name("chat.kraki.mac.local-config.distributed")

    static let configURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base
            .appendingPathComponent("Kraki", isDirectory: true)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("mac-local.json", isDirectory: false)
    }()

    private static let disabledEnvironmentKeys = [
        "KRAKI_NATIVE_AUTOMATION",
        "KRAKI_HEADLESS_SHOT",
        "KRAKI_HTML_ARTIFACT_BENCH",
        "KRAKI_IMAGE_PREVIEW_BENCH",
        "KRAKI_CORETEXT_SCROLL_BENCH",
        "KRAKI_CORETEXT_BENCH",
        "KRAKI_QUESTION_HIT_BENCH",
        "KRAKI_CODE_HIGHLIGHT_BENCH",
        "KRAKI_CODE_HIGHLIGHT_UPGRADE_BENCH",
        "KRAKI_VOICE_TRANSCRIPT_BENCH",
        "KRAKI_RENDER_BUBBLE_TEST",
        "KRAKI_RENDER_CHAT_TEST",
        "KRAKI_RENDER_COMPOSER_TEST",
        "KRAKI_E2E_SELFTEST",
        "KRAKI_MAC_CHAT_SNAPSHOT_TEST",
        "KRAKI_MAC_CHAT_PERF_PAGE",
        "KRAKI_MAC_CHAT_SCENARIO_PAGE",
        "KRAKI_MAC_MOCK",
    ]

    private let lockURL = configURL
        .deletingLastPathComponent()
        .appendingPathComponent(".mac-local.lock", isDirectory: false)
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()
    private var distributedObserver: NSObjectProtocol?

    var isEnabled: Bool {
        let environment = ProcessInfo.processInfo.environment
        return !Self.disabledEnvironmentKeys.contains { environment[$0] == "1" }
    }

    private init() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        self.encoder = encoder
        distributedObserver = DistributedNotificationCenter.default().addObserver(
            forName: Self.distributedChangeNotification,
            object: nil,
            queue: .main
        ) { notification in
            NotificationCenter.default.post(
                name: Self.localChangeNotification,
                object: nil,
                userInfo: notification.userInfo
            )
        }
    }

    deinit {
        if let distributedObserver {
            DistributedNotificationCenter.default().removeObserver(distributedObserver)
        }
    }

    var config: MacLocalConfig {
        guard isEnabled else { return .defaults }
        return (try? withExclusiveLock { try loadLocked() }) ?? .defaults
    }

    var uiZoom: Double { config.display.uiZoom }

    var mainWindowSize: NSSize {
        let window = config.window
        return NSSize(width: window.mainWidth, height: window.mainHeight)
    }

    func constrainedMainWindowSize(to visibleSize: NSSize) -> NSSize {
        let stored = mainWindowSize
        return NSSize(
            width: min(max(800, stored.width), max(1, visibleSize.width)),
            height: min(max(600, stored.height), max(1, visibleSize.height))
        )
    }

    func updateUIZoom(_ value: Double) {
        guard isEnabled else { return }
        let zoom = WindowZoom.snap(min(WindowZoom.maxZoom, max(WindowZoom.minZoom, value)))
        let changed = (try? withExclusiveLock {
            var config = try loadLocked()
            guard abs(config.display.uiZoom - zoom) > 0.0001 else { return false }
            config.display.uiZoom = zoom
            try writeLocked(config)
            return true
        }) ?? false
        if changed { postChange(.display) }
    }

    func updateMainWindowSize(_ size: NSSize) {
        guard isEnabled, size.width >= 800, size.height >= 600 else { return }
        let width = min(10_000, size.width)
        let height = min(10_000, size.height)
        let changed = (try? withExclusiveLock {
            var config = try loadLocked()
            guard abs(config.window.mainWidth - width) > 0.5
                    || abs(config.window.mainHeight - height) > 0.5 else {
                return false
            }
            config.window.mainWidth = width
            config.window.mainHeight = height
            try writeLocked(config)
            return true
        }) ?? false
        if changed { postChange(.window) }
    }

    private func postChange(_ change: Change) {
        let userInfo = ["kind": change.rawValue]
        NotificationCenter.default.post(
            name: Self.localChangeNotification,
            object: nil,
            userInfo: userInfo
        )
        DistributedNotificationCenter.default().postNotificationName(
            Self.distributedChangeNotification,
            object: nil,
            userInfo: userInfo,
            deliverImmediately: true
        )
    }

    private func withExclusiveLock<T>(_ body: () throws -> T) throws -> T {
        try ensureDirectory()
        let fm = FileManager.default
        if !fm.fileExists(atPath: lockURL.path) {
            fm.createFile(
                atPath: lockURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }
        let handle = try FileHandle(forUpdating: lockURL)
        guard flock(handle.fileDescriptor, LOCK_EX) == 0 else {
            handle.closeFile()
            throw CocoaError(.fileWriteUnknown)
        }
        defer {
            flock(handle.fileDescriptor, LOCK_UN)
            handle.closeFile()
        }
        return try body()
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(
            at: Self.configURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    private func loadLocked() throws -> MacLocalConfig {
        if let data = try? Data(contentsOf: Self.configURL),
           let decoded = try? decoder.decode(MacLocalConfig.self, from: data),
           decoded.schemaVersion == 1 {
            return validated(decoded)
        }
        let migrated = migratedFromProdDefaults()
        try writeLocked(migrated)
        return migrated
    }

    private func writeLocked(_ config: MacLocalConfig) throws {
        var data = try encoder.encode(validated(config))
        data.append(0x0A)
        try data.write(to: Self.configURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: Self.configURL.path
        )
    }

    private func validated(_ value: MacLocalConfig) -> MacLocalConfig {
        var value = value
        value.schemaVersion = 1
        value.window.mainWidth = min(10_000, max(800, value.window.mainWidth))
        value.window.mainHeight = min(10_000, max(600, value.window.mainHeight))
        value.display.uiZoom = WindowZoom.snap(
            min(WindowZoom.maxZoom, max(WindowZoom.minZoom, value.display.uiZoom))
        )
        return value
    }

    private func migratedFromProdDefaults() -> MacLocalConfig {
        var config = MacLocalConfig.defaults
        let prod = UserDefaults.standard.persistentDomain(forName: "chat.kraki.mac") ?? [:]

        if let number = prod["mac.uiZoom"] as? NSNumber {
            config.display.uiZoom = number.doubleValue
        } else if let string = prod["mac.uiZoom"] as? String,
                  let value = Double(string) {
            config.display.uiZoom = value
        }

        if let frame = prod["NSWindow Frame main-AppWindow-1"] as? String {
            let values = frame.split(whereSeparator: { $0.isWhitespace }).compactMap { Double($0) }
            if values.count >= 4, values[2] >= 800, values[3] >= 600 {
                config.window.mainWidth = values[2]
                config.window.mainHeight = values[3]
            }
        }
        return validated(config)
    }
}

enum WindowZoom {
    /// Allowed zoom steps. Symmetric around 1.0, biased toward
    /// finer-grained adjustments near the default.
    static let steps: [Double] = [
        0.75, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20, 1.30, 1.45, 1.60
    ]

    static let minZoom: Double = steps.first!
    static let maxZoom: Double = steps.last!
    static let defaultZoom: Double = 1.0

    /// Round `value` to the closest entry in `steps`.
    static func snap(_ value: Double) -> Double {
        steps.min(by: { abs($0 - value) < abs($1 - value) }) ?? defaultZoom
    }

    /// Next step strictly larger than `current`, clamped to maxZoom.
    static func stepUp(from current: Double) -> Double {
        let snapped = snap(current)
        if let next = steps.first(where: { $0 > snapped + 0.001 }) {
            return next
        }
        return maxZoom
    }

    /// Next step strictly smaller than `current`, clamped to minZoom.
    static func stepDown(from current: Double) -> Double {
        let snapped = snap(current)
        if let prev = steps.last(where: { $0 < snapped - 0.001 }) {
            return prev
        }
        return minZoom
    }
}

extension Notification.Name {
    static let macZoomIn    = Notification.Name("mac.zoomIn")
    static let macZoomOut   = Notification.Name("mac.zoomOut")
    static let macZoomReset = Notification.Name("mac.zoomReset")
}

/// A view modifier that applies a window-wide zoom by wrapping the
/// content in a GeometryReader + inverse-frame + scaleEffect. Attach
/// this to the root content view in MainWindowView (and any other
/// top-level scene that should obey the zoom).
struct WindowZoomModifier: ViewModifier {
    @State private var zoom = MacLocalConfigStore.shared.uiZoom

    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .frame(
                    width:  max(1, geo.size.width  / zoom),
                    height: max(1, geo.size.height / zoom)
                )
                .scaleEffect(zoom, anchor: .topLeading)
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomIn)) { _ in
            setZoom(WindowZoom.stepUp(from: zoom))
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomOut)) { _ in
            setZoom(WindowZoom.stepDown(from: zoom))
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomReset)) { _ in
            setZoom(WindowZoom.defaultZoom)
        }
        .onReceive(NotificationCenter.default.publisher(
            for: MacLocalConfigStore.localChangeNotification
        )) { notification in
            guard notification.userInfo?["kind"] as? String
                    == MacLocalConfigStore.Change.display.rawValue else { return }
            let sharedZoom = MacLocalConfigStore.shared.uiZoom
            if abs(sharedZoom - zoom) > 0.0001 { zoom = sharedZoom }
        }
    }

    private func setZoom(_ value: Double) {
        let value = WindowZoom.snap(value)
        if abs(value - zoom) > 0.0001 { zoom = value }
        MacLocalConfigStore.shared.updateUIZoom(value)
    }
}

@MainActor
final class MacWindowGeometryCoordinator {
    private weak var window: NSWindow?
    private var observers: [NSObjectProtocol] = []
    private var persistWorkItem: DispatchWorkItem?
    private var isApplyingSharedSize = false
    private var hasAppliedInitialSize = false

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        invalidate()
        self.window = window
        guard MacLocalConfigStore.shared.isEnabled else { return }

        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: NSWindow.didResizeNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.schedulePersist()
            }
        })
        observers.append(center.addObserver(
            forName: NSWindow.didEndLiveResizeNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.persistWindowSize()
            }
        })
        observers.append(center.addObserver(
            forName: NSWindow.didExitFullScreenNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.applySharedSize()
            }
        })
        observers.append(center.addObserver(
            forName: MacLocalConfigStore.localChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard notification.userInfo?["kind"] as? String
                    == MacLocalConfigStore.Change.window.rawValue else { return }
            Task { @MainActor [weak self] in
                self?.applySharedSize()
            }
        })

        DispatchQueue.main.async { [weak self] in
            self?.applySharedSize()
        }
    }

    func invalidate() {
        persistWorkItem?.cancel()
        persistWorkItem = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        window = nil
        hasAppliedInitialSize = false
        isApplyingSharedSize = false
    }

    private func applySharedSize() {
        guard let window,
              !window.styleMask.contains(.fullScreen),
              let screen = window.screen ?? NSScreen.main else { return }

        let size = MacLocalConfigStore.shared.constrainedMainWindowSize(
            to: screen.visibleFrame.size
        )
        hasAppliedInitialSize = true
        guard abs(window.frame.width - size.width) > 0.5
                || abs(window.frame.height - size.height) > 0.5 else { return }

        var frame = window.frame
        let topLeft = NSPoint(x: frame.minX, y: frame.maxY)
        frame.size = size
        frame.origin = NSPoint(x: topLeft.x, y: topLeft.y - size.height)
        frame = window.constrainFrameRect(frame, to: screen)

        isApplyingSharedSize = true
        window.setFrame(frame, display: true, animate: false)
        DispatchQueue.main.async { [weak self] in
            self?.isApplyingSharedSize = false
        }
    }

    private func schedulePersist() {
        guard hasAppliedInitialSize, !isApplyingSharedSize else { return }
        persistWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.persistWindowSize()
        }
        persistWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: item)
    }

    private func persistWindowSize() {
        guard let window,
              hasAppliedInitialSize,
              !isApplyingSharedSize,
              !window.styleMask.contains(.fullScreen) else { return }
        if window.inLiveResize {
            schedulePersist()
            return
        }
        MacLocalConfigStore.shared.updateMainWindowSize(window.frame.size)
    }
}

extension View {
    /// Apply the persistent mac UI zoom. Use exactly once per window
    /// content root.
    func windowZoom() -> some View {
        modifier(WindowZoomModifier())
    }
}

#endif
