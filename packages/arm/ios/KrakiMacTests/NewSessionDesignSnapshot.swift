#if os(macOS) && DEBUG
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Renders the idle pane, empty sidebar and New Session sheet (KRAKI_SNAPSHOT_DIR).
@MainActor
final class NewSessionDesignSnapshot: XCTestCase {
    private var windows: [NSWindow] = []
    override func tearDown() async throws { windows.forEach { $0.close() }; windows.removeAll() }

    private func app(sessions: Int) throws -> AppState {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("design-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceStore.devices["mac"] = DeviceSummary(id: "mac", name: "Alex's MacBook Pro", role: .tentacle, kind: .desktop,
                                                       publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.deviceStore.setDeviceAgents("mac", agents: [
            AgentCapabilities(type: "code", id: "copilot", models: ["auto", "gpt-6-luna", "claude-sonnet-5"], modelDetails: nil),
            AgentCapabilities(type: "code", id: "claude", models: ["claude-opus-5-5", "claude-sonnet-5"], modelDetails: nil),
        ])
        for i in 0..<sessions {
            app.sessionStore.upsertSession(SessionInfo(
                id: "s\(i)", deviceId: "mac", deviceName: "Alex's MacBook Pro", agent: "copilot", model: "auto",
                title: ["Fix the login redirect", "Add dark mode to settings", "Write release notes"][i % 3],
                state: .idle, mode: .auto, lastSeq: 1, readSeq: 1, messageCount: 1,
                createdAt: Date().addingTimeInterval(Double(-3600 * (i + 1))), pinned: false))
        }
        return app
    }

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, to name: String) throws {
        guard let dir = ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] else { throw XCTSkip("set KRAKI_SNAPSHOT_DIR") }
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(origin: CGPoint(x: -4000, y: -4000), size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        window.orderFrontRegardless()
        windows.append(window)
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func testRenderNewSessionDesign() throws {
        for dark in [true, false] {
            let suffix = dark ? "dark" : "light"
            for (label, count) in [("first", 0), ("next", 3)] {
                let a = try app(sessions: count)
                var sel: String?
                let window = HStack(spacing: 0) {
                    SessionsSidebarView(selectedSessionId: Binding(get: { sel }, set: { sel = $0 }))
                        .frame(width: 300)
                    Divider()
                    MacStartSessionView(firstTime: count == 0)
                        .background(Color.surfacePrimary)
                }
                .environment(a).environment(TentacleCLIManager())
                try render(window, size: CGSize(width: 1180, height: 740), dark: dark, to: "window-\(label)-\(suffix)")
            }
            let a = try app(sessions: 3)
            let sheet = NewSessionSheet(isPresented: .constant(true))
                .environment(a).environment(TentacleCLIManager())
            try render(sheet, size: CGSize(width: 620, height: 260), dark: dark, to: "sheet-\(suffix)")
        }
    }
}
#endif
