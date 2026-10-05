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
        for (id, name) in [("pc", "WindowsPC"), ("ubuntu", "office-ubuntu")] {
            app.deviceStore.devices[id] = DeviceSummary(id: id, name: name, role: .tentacle, kind: .desktop,
                                                        publicKey: nil, encryptionKey: nil, online: false, lastSeen: nil, createdAt: nil)
        }
        app.deviceStore.devices["mac"] = DeviceSummary(id: "mac", name: "Alex's MacBook Pro", role: .tentacle, kind: .desktop,
                                                       publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.deviceStore.setDeviceAgents("mac", agents: [
            AgentCapabilities(type: "code", id: "copilot", models: ["auto", "gpt-6-luna", "claude-sonnet-5"], modelDetails: [
                ModelDetail(id: "auto", name: "Auto", supportsReasoningEffort: false),
                ModelDetail(id: "gpt-6-luna", name: "GPT-6 Luna", supportsReasoningEffort: true, supportedReasoningEfforts: [.low, .medium, .high], defaultReasoningEffort: .medium),
                ModelDetail(id: "claude-sonnet-5", name: "Claude Sonnet 5", supportsReasoningEffort: false),
            ]),
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
            do {
                let a = try app(sessions: 3)
                let online = a.deviceStore.tentacleDevices.filter(\.online)
                let offline = a.deviceStore.tentacleDevices.filter { !$0.online }
                let agents = a.deviceStore.agents(for: "mac")
                func pop<V: View>(_ v: V) -> some View {
                    v.frame(width: 280).background(RoundedRectangle(cornerRadius: 12).fill(Color.surfaceSecondary))
                        .padding(10).environment(a)
                }
                try render(pop(DeviceChoiceList(online: online, offline: offline, localId: "mac", selected: "mac") { _ in }),
                           size: CGSize(width: 300, height: 260), dark: dark, to: "menu-device-\(suffix)")
                try render(pop(AgentChoiceList(agents: agents, selected: "copilot") { _ in }),
                           size: CGSize(width: 300, height: 130), dark: dark, to: "menu-agent-\(suffix)")
                try render(pop(ModelChoiceList(models: ["auto", "gpt-6-luna", "claude-sonnet-5"],
                                               name: { ["auto": "Auto", "gpt-6-luna": "GPT-6 Luna", "claude-sonnet-5": "Claude Sonnet 5"][$0] ?? $0 },
                                               selected: "gpt-6-luna") { _ in }),
                           size: CGSize(width: 300, height: 170), dark: dark, to: "menu-model-\(suffix)")
                try render(pop(EffortChoiceList(efforts: [.low, .medium, .high], selected: .medium) { _ in }),
                           size: CGSize(width: 300, height: 170), dark: dark, to: "menu-effort-\(suffix)")
                let pairing = PairingSheet(preview: .init(url: "https://app.kraki.chat?relay=wss%3A%2F%2Fcn.relay.kraki.chat&token=pt_8f2c1d9a4b7e6f30a5c2",
                                                          token: "t", relay: "r", expiresAt: Date().addingTimeInterval(272)))
                    .environment(a).environment(TentacleCLIManager())
                    .padding(30).background(LinearGradient(colors: [Color(hex: 0x1E3A5F), Color(hex: 0x0B1220)], startPoint: .top, endPoint: .bottom))
                try render(pairing, size: CGSize(width: 400, height: 520), dark: dark, to: "pairing-\(suffix)")
                let phone = DeviceSummary(id: "iph", name: "Alex’s iPhone", role: .app, kind: .ios, publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
                let done = PairingSheet(preview: .init(url: "x", token: "t", relay: "r", expiresAt: Date()), connected: phone)
                    .environment(a).environment(TentacleCLIManager())
                    .padding(30).background(LinearGradient(colors: [Color(hex: 0x1E3A5F), Color(hex: 0x0B1220)], startPoint: .top, endPoint: .bottom))
                try render(done, size: CGSize(width: 400, height: 420), dark: dark, to: "pairing-done-\(suffix)")
            }
            let a = try app(sessions: 3)
            a.deviceStore.setDeviceVersion("pc", version: "0.35.9")
            a.deviceStore.setDeviceVersion("mac", version: "0.35.12")
            a.deviceStore.setDeviceUpdate("mac", update: DeviceUpdateInfo(installedVia: "mac-app", current: "0.2.68", latest: "0.2.70", latestTentacle: "0.36.0"))
            try render(DevicesPane().environment(a).environment(TentacleCLIManager()),
                       size: CGSize(width: 560, height: 520), dark: dark, to: "prefs-devices-\(suffix)")
            try render(HStack(spacing: 18) {
                ForEach(["copilot", "claude", "codex", "pi"], id: \.self) { id in
                    PillLabel(text: AgentInfo.from(id).label, agent: id)
                }
            }.padding(14), size: CGSize(width: 440, height: 60), dark: dark, to: "agent-pills-\(suffix)")
        }
    }
}
#endif
