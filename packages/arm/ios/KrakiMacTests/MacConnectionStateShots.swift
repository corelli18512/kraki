#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Screenshots of the main window's sidebar through a cold start, light and
/// dark: signed in before but not connected yet (bottom notice), this Mac's
/// own sessions while its service comes online, and settled online/offline.
/// Borderless window far off-screen, captured with cacheDisplay; nothing is
/// shown or activated. Local only: TEST_RUNNER_KRAKI_CONNSTATE_SHOTS=1
/// (PNGs in TEST_RUNNER_KRAKI_SNAPSHOT_DIR, default /tmp/kraki-connstate-shots).
@MainActor
final class MacConnectionStateShots: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private var dir: URL { URL(fileURLWithPath: env["KRAKI_SNAPSHOT_DIR"] ?? "/tmp/kraki-connstate-shots") }
    private var root: URL!
    private var windows: [NSWindow] = []

    override func setUpWithError() throws {
        guard env["KRAKI_CONNSTATE_SHOTS"] == "1" else { throw XCTSkip("screenshots: TEST_RUNNER_KRAKI_CONNSTATE_SHOTS=1") }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-connstate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // This Mac's own computer is "macbook" (its files, as device trust reads them).
        try "macbook\n".write(to: root.appendingPathComponent("device-id"), atomically: true, encoding: .utf8)
        DeviceTrustTesting.localKrakiHome = root
    }

    override func tearDown() {
        DeviceTrustTesting.localKrakiHome = nil
        windows.forEach { $0.contentView = nil }
        windows = []
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    private func drain(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    private func device(_ id: String, _ name: String, online: Bool) -> DeviceSummary {
        DeviceSummary(id: id, name: name, role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: nil)
    }

    /// Two sessions on this Mac ("Macbook"), one on Studio Mac, one on Build Box.
    private func makeApp(macOnline: Bool, buildBoxOnline: Bool) throws -> AppState {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("\(UUID()).sqlite")))
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(device("macbook", "Macbook", online: macOnline))
        app.deviceStore.addDevice(device("studio", "Studio Mac", online: true))
        app.deviceStore.addDevice(device("build", "Build Box", online: buildBoxOnline))
        let rows: [(String, String, String, String)] = [
            ("s1", "macbook", "Release train", "Working on Release train."),
            ("s2", "macbook", "Fix flaky iOS tests", "Working on Fix flaky iOS tests."),
            ("s3", "studio", "Docs pass", "Updated the setup guide."),
            ("s4", "build", "Windows settings polish", "Working on Windows settings polish."),
        ]
        let now = Date()
        for (i, row) in rows.enumerated() {
            let created = now.addingTimeInterval(Double(-600 * (i + 1)))
            app.sessionStore.sessions[row.0] = SessionInfo(
                id: row.0, deviceId: row.1, deviceName: app.deviceStore.devices[row.1]?.name ?? "", agent: "claude",
                model: "claude-opus", title: row.2, state: .idle, mode: .auto, lastSeq: 3, readSeq: 3,
                messageCount: 3, createdAt: created, pinned: false)
            app.sessionStore.sessionPreviews[row.0] = SessionPreview(
                text: row.3, type: "agent", timestamp: ISO8601.withFractional.string(from: created))
        }
        return app
    }

    private func shot(_ app: AppState, _ name: String) throws {
        for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let main = MainWindowView(initialSelectedSessionId: nil, selectionNotificationScope: "mac-connstate-shots")
                .environment(app).environment(TentacleCLIManager())
            let host = NSHostingView(rootView: main)
            let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 820, height: 420),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = host
            windows.append(window)
            host.layoutSubtreeIfNeeded()
            drain(1.0)
            XCTAssertFalse(window.isVisible, "never on screen")
            let view = try XCTUnwrap(window.contentView)
            view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: dir.appendingPathComponent("\(name)-\(suffix).png"))
        }
    }

    /// Cold start of a Mac that signed in before: the sign-in has not finished
    /// after the 2 s debounce. Presence is not known yet (nothing offline).
    func testShot1ColdStartBeforeSignIn() throws {
        let app = try makeApp(macOnline: false, buildBoxOnline: false)
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = false
        app.connectionStatus = .connecting
        drain(AppState.reconnectingIndicatorDelay + 0.4)
        XCTAssertNotNil(app.connectionNotice)
        try shot(app, "mac-1-cold-start-before-sign-in")
    }

    /// Signed in; this Mac's computer is still offline while Kraki for Mac
    /// brings it online (the launch check). Build Box is really offline.
    func testShot2ThisMacComingOnline() throws {
        let app = try makeApp(macOnline: false, buildBoxOnline: false)
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = true
        app.connectionStatus = .connected
        try shot(app, "mac-2-this-mac-coming-online")
    }

    /// Settled: this Mac online, Build Box offline.
    func testShot3Settled() throws {
        let app = try makeApp(macOnline: true, buildBoxOnline: false)
        app.hasStoredCredentials = true
        app.hasCompletedInitialConnect = true
        app.connectionStatus = .connected
        try shot(app, "mac-3-settled-online-offline")
    }
}
#endif
