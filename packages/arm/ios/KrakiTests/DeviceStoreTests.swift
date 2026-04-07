import XCTest
@testable import Kraki

final class DeviceStoreTests: XCTestCase {

    private var store: DeviceStore!

    override func setUp() {
        super.setUp()
        store = DeviceStore()
    }

    // MARK: - Helpers

    private func makeDevice(
        id: String = "dev-1",
        name: String = "MacBook",
        role: DeviceRole = .tentacle,
        kind: DeviceKind? = .desktop,
        publicKey: String? = "pk-123",
        encryptionKey: String? = nil,
        online: Bool = true
    ) -> DeviceSummary {
        DeviceSummary(
            id: id, name: name, role: role, kind: kind,
            publicKey: publicKey, encryptionKey: encryptionKey,
            online: online, lastSeen: nil, createdAt: nil
        )
    }

    // MARK: - Set Devices

    func testSetDevices() {
        let devices = [
            makeDevice(id: "dev-1", name: "MacBook"),
            makeDevice(id: "dev-2", name: "iPhone", role: .app, kind: .ios),
        ]
        store.setDevices(devices)
        XCTAssertEqual(store.devices.count, 2)
        XCTAssertEqual(store.devices["dev-1"]?.name, "MacBook")
        XCTAssertEqual(store.devices["dev-2"]?.name, "iPhone")
    }

    // MARK: - Add / Remove

    func testAddDevice() {
        store.addDevice(makeDevice(id: "dev-1"))
        XCTAssertEqual(store.devices.count, 1)
        XCTAssertNotNil(store.devices["dev-1"])
    }

    func testRemoveDevice() {
        store.addDevice(makeDevice(id: "dev-1"))
        store.deviceModels["dev-1"] = ["claude-3"]
        store.deviceVersions["dev-1"] = "1.0"

        store.removeDevice("dev-1")

        XCTAssertNil(store.devices["dev-1"])
        XCTAssertNil(store.deviceModels["dev-1"])
        XCTAssertNil(store.deviceVersions["dev-1"])
    }

    // MARK: - Online Status

    func testSetOnline() {
        store.addDevice(makeDevice(id: "dev-1", online: true))
        XCTAssertEqual(store.devices["dev-1"]?.online, true)

        store.setOnline("dev-1", false)
        XCTAssertEqual(store.devices["dev-1"]?.online, false)

        store.setOnline("dev-1", true)
        XCTAssertEqual(store.devices["dev-1"]?.online, true)
    }

    // MARK: - Tentacle Devices

    func testTentacleDevices() {
        store.setDevices([
            makeDevice(id: "dev-1", role: .tentacle),
            makeDevice(id: "dev-2", role: .app),
            makeDevice(id: "dev-3", role: .tentacle),
        ])
        let tentacles = store.tentacleDevices
        XCTAssertEqual(tentacles.count, 2)
        XCTAssertTrue(tentacles.allSatisfy { $0.role == .tentacle })
    }

    // MARK: - Encryption Key

    func testEncryptionKeyForWithEncryptionKey() {
        store.addDevice(makeDevice(id: "dev-1", publicKey: "pk", encryptionKey: "ek"))
        XCTAssertEqual(store.encryptionKeyFor("dev-1"), "ek")
    }

    func testEncryptionKeyForFallsBackToPublicKey() {
        store.addDevice(makeDevice(id: "dev-1", publicKey: "pk", encryptionKey: nil))
        XCTAssertEqual(store.encryptionKeyFor("dev-1"), "pk")
    }

    func testEncryptionKeyForUnknownDevice() {
        XCTAssertNil(store.encryptionKeyFor("unknown"))
    }

    // MARK: - All Models

    func testAllModels() {
        store.deviceModels["dev-1"] = ["claude-3", "gpt-4"]
        store.deviceModels["dev-2"] = ["gpt-4", "gemini"]
        let models = store.allModels
        XCTAssertEqual(Set(models), Set(["claude-3", "gpt-4", "gemini"]))
        // Sorted
        XCTAssertEqual(models, models.sorted())
    }

    // MARK: - Greeting

    func testSetGreeting() {
        store.addDevice(makeDevice(id: "dev-1", name: "Old Name"))
        store.setGreeting("dev-1", name: "New Name", models: ["claude-3"], modelDetails: nil, version: "2.0")

        XCTAssertEqual(store.devices["dev-1"]?.name, "New Name")
        XCTAssertEqual(store.deviceModels["dev-1"], ["claude-3"])
        XCTAssertEqual(store.deviceVersions["dev-1"], "2.0")
    }

    // MARK: - Reset

    func testReset() {
        store.addDevice(makeDevice(id: "dev-1"))
        store.deviceModels["dev-1"] = ["claude-3"]
        store.deviceVersions["dev-1"] = "1.0"

        store.reset()

        XCTAssertTrue(store.devices.isEmpty)
        XCTAssertTrue(store.deviceModels.isEmpty)
        XCTAssertTrue(store.deviceVersions.isEmpty)
    }

    // MARK: - Convenience

    func testDeviceForSession() {
        store.addDevice(makeDevice(id: "dev-1"))
        let sessions: [String: SessionInfo] = [
            "sess-1": SessionInfo(
                id: "sess-1", deviceId: "dev-1", deviceName: "MB",
                agent: "claude", state: .active, mode: .execute,
                lastSeq: 0, readSeq: 0, messageCount: 0,
                createdAt: Date(), pinned: false
            )
        ]
        let device = store.deviceForSession("sess-1", sessions: sessions)
        XCTAssertEqual(device?.id, "dev-1")
    }

    func testDeviceForSessionNotFound() {
        let device = store.deviceForSession("sess-1", sessions: [:])
        XCTAssertNil(device)
    }
}
