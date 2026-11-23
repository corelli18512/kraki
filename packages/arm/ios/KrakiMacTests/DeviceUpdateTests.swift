import XCTest
@testable import Kraki_Dev

@MainActor
final class DeviceUpdateTests: XCTestCase {
    private func tentacle(_ id: String) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: .tentacle, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: true, lastSeen: nil, createdAt: nil)
    }

    /// Mac can remove an old device (previously the pane was read-only).
    func testDevicesPaneRemovesOfflineOtherDevicesOnly() {
        var old = tentacle("old-pc"); old.online = false
        XCTAssertTrue(DevicesPane.canRemove(old, appDeviceId: "app", thisMacDeviceId: "mac"))
        XCTAssertFalse(DevicesPane.canRemove(tentacle("online-pc"), appDeviceId: "app", thisMacDeviceId: "mac"))
        var me = tentacle("app"); me.online = false
        XCTAssertFalse(DevicesPane.canRemove(me, appDeviceId: "app", thisMacDeviceId: "mac"))
        var mac = tentacle("mac"); mac.online = false
        XCTAssertFalse(DevicesPane.canRemove(mac, appDeviceId: "app", thisMacDeviceId: "mac"))
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

    /// A success report is the new installed version right away: the Version
    /// row and "available" don't wait for a greeting that may not come.
    func testUpdatedStatusRecordsTheInstalledVersion() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["a"] = tentacle("a")
        store.setDeviceVersion("a", version: "0.38.9")
        store.setDeviceUpdate("a", update: DeviceUpdateInfo(installedVia: "binary", current: "0.38.9", latest: "0.38.10", remote: true))
        store.setUpdateProgress("a", DeviceUpdateProgress(phase: .updated, from: "0.38.9", to: "0.38.10"))
        XCTAssertEqual(store.deviceVersions["a"], "0.38.10")
        XCTAssertEqual(store.deviceUpdates["a"]?.current, "0.38.10")
        XCTAssertNil(store.availableUpdate(for: "a"))
    }

    /// Kraki for Mac reports its app version; the CLI version stays as is.
    func testUpdatedMacAppKeepsTheCLIVersion() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["m"] = tentacle("m")
        store.setDeviceVersion("m", version: "0.38.9")
        store.setDeviceUpdate("m", update: DeviceUpdateInfo(installedVia: "mac-app", current: "0.2.88", latest: "0.2.89", remote: true))
        store.setUpdateProgress("m", DeviceUpdateProgress(phase: .updated, from: "0.2.88", to: "0.2.89"))
        XCTAssertEqual(store.deviceUpdates["m"]?.current, "0.2.89")
        XCTAssertEqual(store.deviceVersions["m"], "0.38.9")
    }

    /// Kraki for Windows reports its app version (tentacle 0.39+): name the
    /// app with it; a success keeps the CLI version as is.
    func testWindowsAppNamesTheApp() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["w"] = tentacle("w")
        store.setDeviceVersion("w", version: "0.39.0")
        store.setDeviceUpdate("w", update: DeviceUpdateInfo(installedVia: "windows-app", current: "0.1.11", latest: "0.1.12",
                                                            latestTentacle: "0.39.0", remote: true))
        let u = store.availableUpdate(for: "w")
        XCTAssertEqual(u?.latest, "0.1.12")
        XCTAssertTrue(u?.isWindowsApp == true)
        XCTAssertEqual(u?.productName, String(localized: "Kraki for Windows"))
        XCTAssertEqual(store.displayVersion(for: "w"), "\(String(localized: "Kraki for Windows")) 0.1.11")
        store.setUpdateProgress("w", DeviceUpdateProgress(phase: .updated, from: "0.1.11", to: "0.1.12"))
        XCTAssertEqual(store.deviceUpdates["w"]?.current, "0.1.12")
        XCTAssertEqual(store.deviceVersions["w"], "0.39.0")
    }

    /// Its older built-in tentacles reported their own version: still "Kraki".
    func testOlderWindowsAppTentacleKeepsKrakiVersions() {
        let store = DeviceStore(persistenceEnabled: false)
        store.devices["w"] = tentacle("w")
        store.setDeviceVersion("w", version: "0.38.11")
        store.setDeviceUpdate("w", update: DeviceUpdateInfo(installedVia: "windows-app", current: "0.38.11", latest: "0.39.0",
                                                            latestTentacle: "0.39.0", remote: false))
        let u = store.availableUpdate(for: "w")
        XCTAssertEqual(u?.isWindowsApp, false)
        XCTAssertEqual(u?.productName, "Kraki")
        XCTAssertEqual(u?.howTo, String(localized: "Install the latest Kraki for Windows on that PC. Kraki updates with the app."))
        XCTAssertEqual(store.displayVersion(for: "w"), "Kraki 0.38.11")
    }

    /// Finished outcomes clear themselves, so nothing lingers in an empty
    /// section; a newer status is never cleared by an older timer. Awaits the
    /// scheduled expiries instead of racing a sleep against them.
    func testFinishedOutcomesExpire() async throws {
        let store = DeviceStore(persistenceEnabled: false)
        store.updatedOutcomeLifetime = .zero
        store.problemOutcomeLifetime = .zero
        store.devices["a"] = tentacle("a")
        store.setUpdateProgress("a", DeviceUpdateProgress(phase: .updated, to: "0.38.10"))
        store.setUpdateProgress("b", DeviceUpdateProgress(phase: .failed, error: "x"))
        store.setUpdateProgress("c", DeviceUpdateProgress(phase: .failed, error: "x"))
        store.setUpdateProgress("c", DeviceUpdateProgress(phase: .requested))
        for id in ["a", "b", "c"] {
            let expiry = try XCTUnwrap(store.outcomeExpiry[id])
            await expiry.value
        }
        XCTAssertNil(store.updateProgress["a"])
        XCTAssertNil(store.updateProgress["b"])
        XCTAssertEqual(store.updateProgress["c"]?.phase, .requested, "an active update is not cleared")
    }
}
