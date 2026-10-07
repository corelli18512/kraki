import XCTest
@testable import Kraki_Dev

@MainActor
final class DeviceUpdateTests: XCTestCase {
    private func tentacle(_ id: String) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: true, lastSeen: nil, createdAt: nil)
    }

    func testVersionCompare() {
        XCTAssertTrue(KrakiVersion.isNewer("0.36.0", than: "0.35.12"))
        XCTAssertTrue(KrakiVersion.isNewer("0.35.12", than: "0.35.10-poc"))
        XCTAssertFalse(KrakiVersion.isNewer("0.35.12", than: "0.35.12"))
        XCTAssertFalse(KrakiVersion.isNewer("0.2.9", than: "0.2.10"))
        // Pre-releases order below their release and among themselves.
        XCTAssertTrue(KrakiVersion.isNewer("1.2.0", than: "1.2.0-beta.1"))
        XCTAssertFalse(KrakiVersion.isNewer("1.2.0-beta.1", than: "1.2.0"))
        XCTAssertTrue(KrakiVersion.isNewer("1.2.0-beta.2", than: "1.2.0-beta.1"))
        XCTAssertTrue(KrakiVersion.isNewer("1.2.0-beta.10", than: "1.2.0-beta.9"))
        XCTAssertTrue(KrakiVersion.isNewer("1.2.0-rc.1", than: "1.2.0-beta.3"))
        XCTAssertFalse(KrakiVersion.isNewer("1.2.0-beta", than: "1.2.0-beta"))
    }

    func testReportedUpdate() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["a"] = tentacle("a")
        store.setDeviceUpdate("a", update: DeviceUpdateInfo(installedVia: "binary", current: "0.35.12", latest: "0.36.0", latestTentacle: "0.36.0"))
        XCTAssertEqual(store.availableUpdate(for: "a"), AvailableUpdate(latest: "0.36.0", installedVia: "binary", remote: false))
        store.setDeviceUpdate("a", update: DeviceUpdateInfo(installedVia: "binary", current: "0.36.0", latestTentacle: "0.36.0"))
        XCTAssertNil(store.availableUpdate(for: "a"))
    }

    func testMacAppComparesAppVersions() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["mac"] = tentacle("mac")
        store.setDeviceVersion("mac", version: "0.35.12")
        store.setDeviceUpdate("mac", update: DeviceUpdateInfo(installedVia: "mac-app", current: "0.2.68", latest: "0.2.70", latestTentacle: "0.36.0"))
        XCTAssertEqual(store.availableUpdate(for: "mac")?.latest, "0.2.70")
        XCTAssertTrue(store.availableUpdate(for: "mac")?.isMacApp == true)
    }

    func testOlderComputerInferredFromTheNewestSeenTentacle() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["new"] = tentacle("new")
        store.devices["old"] = tentacle("old")
        store.setDeviceVersion("old", version: "0.35.9")
        XCTAssertNil(store.availableUpdate(for: "old"), "nothing known yet")
        store.setDeviceUpdate("new", update: DeviceUpdateInfo(installedVia: "npm", current: "0.36.0", latestTentacle: "0.36.0"))
        XCTAssertEqual(store.availableUpdate(for: "old"), AvailableUpdate(latest: "0.36.0", installedVia: "legacy", remote: false))
        store.setDeviceVersion("old", version: "0.36.0")
        XCTAssertNil(store.availableUpdate(for: "old"))
    }

    func testGreetingJSONParses() {
        let info = DeviceUpdateInfo(json: ["installedVia": "app-bundle", "current": "0.35.12", "latest": "0.36.0", "remote": false])
        XCTAssertEqual(info?.installedVia, "app-bundle")
        XCTAssertEqual(info?.latest, "0.36.0")
        XCTAssertNil(DeviceUpdateInfo(json: ["current": "1"]))
    }

    func testNewVersionGreetingCompletesTheUpdate() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["a"] = tentacle("a")
        store.setUpdateProgress("a", DeviceUpdateProgress(phase: .installing, from: "0.35.12", to: "0.36.0"))
        store.setDeviceUpdate("a", update: DeviceUpdateInfo(installedVia: "binary", current: "0.35.12", latest: "0.36.0"))
        XCTAssertEqual(store.updateProgress["a"]?.phase, .installing, "still the old version")
        store.setDeviceUpdate("a", update: DeviceUpdateInfo(installedVia: "binary", current: "0.36.0"))
        XCTAssertEqual(store.updateProgress["a"]?.phase, .updated)
    }

    func testRemoteFieldsParse() {
        let info = DeviceUpdateInfo(json: ["installedVia": "npm", "current": "1", "remote": false, "remoteBlock": "not_writable"])
        XCTAssertEqual(info?.remoteBlock, "not_writable")
        XCTAssertEqual(info?.remote, false)
    }
}
