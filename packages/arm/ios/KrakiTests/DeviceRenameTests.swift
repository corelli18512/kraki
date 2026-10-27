import XCTest
import SwiftUI
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Renaming a device (`rename_device` → `device_renamed`), the native side:
/// name rules shared with the relay, applying the relay's broadcast to the
/// device list and its sessions, and the `@head` wrapper accepting it.
final class DeviceRenameTests: XCTestCase {
    private var root: URL!
    private var app: AppState!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-rename-\(UUID().uuidString)")
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
    }

    override func tearDown() {
        app = nil
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private func session(_ id: String, on deviceId: String, named name: String) -> SessionInfo {
        SessionInfo(id: id, deviceId: deviceId, deviceName: name, agent: "copilot", state: .idle, mode: .auto,
                    lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: Date(), pinned: false)
    }

    func testNamesAreNormalisedLikeTheRelay() {
        XCTAssertEqual(DeviceName.normalize("  Work \n\t laptop "), "Work laptop")
        XCTAssertEqual(DeviceName.normalize("a\u{0007}b\u{2028}c"), "a b c")
        XCTAssertEqual(DeviceName.normalize("   "), "")
        XCTAssertEqual(DeviceName.normalize(String(repeating: "😀", count: 64))?.unicodeScalars.count, 64)
        XCTAssertNil(DeviceName.normalize(String(repeating: "x", count: 65)))
    }

    /// The relay's vectors (head/src/__tests__/device-rename.test.ts,
    /// "normalizeDeviceName vectors"): keep both lists identical.
    func testNormaliseMatchesTheRelayVectors() throws {
        let becomesSpace: [UInt32] = [0x00, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1F, 0x20, 0x7F, 0x85, 0x9F, 0xA0, 0x1680,
                                      0x2000, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
        let kept: [UInt32] = [0x180E, 0x200B, 0x200C, 0x200D, 0x2060, 0xFFFE]
        func around(_ cp: UInt32) throws -> String { "a" + String(Character(try XCTUnwrap(Unicode.Scalar(cp)))) + "b" }
        for cp in becomesSpace { XCTAssertEqual(DeviceName.normalize(try around(cp)), "a b", String(cp, radix: 16)) }
        for cp in kept { XCTAssertEqual(DeviceName.normalize(try around(cp)), try around(cp), String(cp, radix: 16)) }
        XCTAssertEqual(DeviceName.normalize("  Work \n\t laptop "), "Work laptop")
        XCTAssertEqual(DeviceName.normalize("\u{FEFF}\u{3000}"), "")
    }

    func testRenameValue() {
        let laptop = DeviceSummary(id: "t", name: "corelli-mbp", role: .tentacle, online: true)
        let renamed = DeviceSummary(id: "t", name: "Work laptop", role: .tentacle, online: true, defaultName: "corelli-mbp")
        XCTAssertEqual(DeviceName.renameValue(draft: " Work  laptop ", for: laptop), "Work laptop")
        XCTAssertNil(DeviceName.renameValue(draft: "corelli-mbp", for: laptop), "unchanged")
        XCTAssertNil(DeviceName.renameValue(draft: "", for: laptop), "already its own name")
        XCTAssertEqual(DeviceName.renameValue(draft: "", for: renamed), "", "clears the custom name")
        XCTAssertEqual(DeviceName.renameValue(draft: "corelli-mbp", for: renamed), "", "its own name clears too")
        XCTAssertNil(DeviceName.renameValue(draft: "Work laptop", for: renamed), "unchanged")
        XCTAssertNil(DeviceName.renameValue(draft: String(repeating: "x", count: 65), for: laptop), "too long")
    }

    func testDeviceRenamedUpdatesDevicesAndSessions() throws {
        app.deviceStore.setDevices([
            DeviceSummary(id: "t", name: "corelli-mbp", role: .tentacle, online: true),
            DeviceSummary(id: "o", name: "other", role: .tentacle, online: true),
        ])
        app.sessionStore.sessions = ["s1": session("s1", on: "t", named: "corelli-mbp"),
                                     "s2": session("s2", on: "o", named: "other")]

        // Arrives wrapped as {from:"@head", msg}; the wrapper must accept it.
        let wrapped: [String: Any] = ["from": "@head", "msg": ["type": "device_renamed", "deviceId": "t", "name": "Work laptop", "defaultName": "corelli-mbp"]]
        let inner = try XCTUnwrap(AppState.headControlMessage(in: wrapped))
        app.messageRouter?.handleRawMessage(try json(inner))

        XCTAssertEqual(app.deviceStore.devices["t"]?.name, "Work laptop")
        XCTAssertEqual(app.deviceStore.devices["t"]?.defaultName, "corelli-mbp")
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.deviceName, "Work laptop")
        XCTAssertEqual(app.sessionStore.sessions["s2"]?.deviceName, "other")

        app.messageRouter?.handleRawMessage(try json(["type": "device_renamed", "deviceId": "t", "name": "corelli-mbp"]))
        XCTAssertEqual(app.deviceStore.devices["t"]?.name, "corelli-mbp")
        XCTAssertNil(app.deviceStore.devices["t"]?.defaultName)
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.deviceName, "corelli-mbp")
    }

    /// Renamed while this app was away: the device list it gets on its next
    /// sign-in relabels its sessions, and a card shows the live name.
    func testSignInRelabelsSessionsAndCardsPreferTheLiveName() throws {
        app.sessionStore.sessions = ["s1": session("s1", on: "t", named: "corelli-mbp")]
        let renamed = DeviceSummary(id: "t", name: "Work laptop", role: .tentacle, online: true, defaultName: "corelli-mbp")
        app.onAuthenticated(deviceId: "me", user: nil, devices: [renamed], githubClientId: nil, relayVersion: nil)
        XCTAssertEqual(app.sessionStore.sessions["s1"]?.deviceName, "Work laptop")

        let stale = session("s2", on: "t", named: "corelli-mbp")
        XCTAssertEqual(SessionCardProjection.make(session: stale, device: renamed, preview: nil, draft: nil).machineName, "Work laptop")
        XCTAssertEqual(SessionCardProjection.make(session: stale, device: nil, preview: nil, draft: nil).machineName, "corelli-mbp")
    }

    /// A computer's trusted-devices list names an app as it was at pairing;
    /// the row shows the account's current name once the app is renamed.
    func testTrustedDevicesShowTheAppsCurrentName() throws {
        let paired = TrustedDeviceEntry(id: "phone", name: "Kraki iOS", via: "qr", pairedAt: "")
        let gone = TrustedDeviceEntry(id: "gone", name: "Old iPad", via: "qr", pairedAt: "")
        app.deviceStore.setDevices([DeviceSummary(id: "phone", name: "Kraki iOS", role: .app, online: true)])
        XCTAssertEqual(app.trustedDeviceName(paired), "Kraki iOS")

        app.messageRouter?.handleRawMessage(try json(["type": "device_renamed", "deviceId": "phone", "name": "Corelli's iPhone", "defaultName": "Kraki iOS"]))
        XCTAssertEqual(app.trustedDeviceName(paired), "Corelli's iPhone")
        XCTAssertEqual(app.trustedDeviceName(gone), "Old iPad", "not on the account: the computer's name")
    }

    #if os(iOS)
    /// Over the limit nothing is cut while typing (end of the name, IME
    /// composition); Save brings the alert back with the text as typed and
    /// the limit in the message instead of silently dropping the rename.
    @MainActor
    func testRenameAlertKeepsAnOverLimitNameAndExplainsTheLimit() async throws {
        try requireForegroundUITests()
        struct Host: View {
            let device: DeviceSummary
            let onSave: (String) -> Void
            @State private var shown = true
            @State private var draft = "corelli-mbp"
            var body: some View {
                Color.clear.modifier(DeviceRenameAlert(title: Text(verbatim: "Rename"), device: device,
                                                       isPresented: $shown, draft: $draft, onSave: onSave))
            }
        }
        var saved: [String] = []
        let device = DeviceSummary(id: "t", name: "corelli-mbp", role: .tentacle, online: true)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: Host(device: device) { saved.append($0) })
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        func presented(after previous: UIAlertController? = nil) async throws -> UIAlertController {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                if let alert = host.presentedViewController as? UIAlertController, alert !== previous, !alert.isBeingDismissed { return alert }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            return try XCTUnwrap(nil as UIAlertController?, "no new alert presented")
        }
        /// Types over the whole field, as the keyboard does.
        func type(_ text: String, into alert: UIAlertController) async throws {
            let field = try XCTUnwrap(alert.textFields?.first)
            _ = field.becomeFirstResponder()
            field.selectedTextRange = field.textRange(from: field.beginningOfDocument, to: field.endOfDocument)
            field.insertText(text)
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        func tapSave(_ alert: UIAlertController) throws {
            let save = try XCTUnwrap(alert.actions.first { $0.title == "Save" })
            let handler = unsafeBitCast(try XCTUnwrap(save.value(forKey: "handler") as AnyObject?), to: Handler.self)
            // As a tap does: the alert closes, then the action runs.
            alert.dismiss(animated: false) { handler(save) }
        }

        let first = try await presented()
        let long = String(repeating: "x", count: DeviceName.maxLength) + "é"
        try await type(long, into: first)
        XCTAssertEqual(first.textFields?.first?.text, long, "the end of an over-limit name is never cut")
        try tapSave(first)

        let again = try await presented(after: first)
        XCTAssertEqual(again.textFields?.first?.text, long, "the text comes back as typed")
        XCTAssertTrue(again.message?.contains("\(DeviceName.maxLength)") == true, again.message ?? "")
        XCTAssertTrue(saved.isEmpty)

        try await type("Work laptop", into: again)
        try tapSave(again)
        let deadline = Date().addingTimeInterval(5)
        while saved.isEmpty, Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(saved, ["Work laptop"])
    }
    #endif

    func testDeviceListCarriesTheDevicesOwnName() throws {
        let parsed = try XCTUnwrap(DeviceSummary(json: ["id": "t", "name": "Work laptop", "defaultName": "corelli-mbp", "role": "tentacle", "online": false]))
        XCTAssertEqual(parsed.name, "Work laptop")
        XCTAssertEqual(parsed.ownName, "corelli-mbp")
        // Device rows cached by an older build decode without the new field.
        let old = try JSONDecoder().decode(DeviceSummary.self, from: try json(["id": "t", "name": "corelli-mbp", "role": "tentacle", "online": false]))
        XCTAssertNil(old.defaultName)
    }
}
