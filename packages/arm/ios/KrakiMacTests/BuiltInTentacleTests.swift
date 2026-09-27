import XCTest
@testable import Kraki_Dev

/// Decision logic of the built-in tentacle. No SMAppService registration and
/// no ~/.kraki access: everything here is pure.
@MainActor
final class BuiltInTentacleTests: XCTestCase {

    // MARK: Install location

    func testTranslocatedAndDiskImagePathsAreNotStable() {
        XCTAssertEqual(
            AppInstallLocation.classify(bundlePath: "/private/var/folders/x/T/AppTranslocation/1234/d/Kraki.app"),
            .translocated
        )
        XCTAssertEqual(AppInstallLocation.classify(bundlePath: "/Volumes/Kraki/Kraki.app"), .diskImage)
        XCTAssertEqual(AppInstallLocation.classify(bundlePath: "/Applications/Kraki.app"), .stable)
        XCTAssertEqual(AppInstallLocation.classify(bundlePath: "/Users/me/Applications/Kraki.app"), .stable)
    }

    // MARK: Mode

    private func resolve(
        preference: String = "",
        builtIn: Bool = true,
        marker: Bool = false,
        cliDaemon: Bool = false,
        cli: Bool = false
    ) -> TentacleMode {
        TentacleMode.resolve(
            preference: preference,
            builtInAvailable: builtIn,
            ownershipMarkerExists: marker,
            cliDaemonInstalled: cliDaemon,
            externalCLIFound: cli
        )
    }

    func testNewUserGetsTheBuiltInTentacleWithoutAnyCLI() {
        XCTAssertEqual(resolve(), .builtIn)
    }

    func testExistingCLIDaemonKeepsWorkingUntilTheUserOptsIn() {
        XCTAssertEqual(resolve(cliDaemon: true, cli: true), .external)
        XCTAssertEqual(resolve(preference: "builtIn", cliDaemon: true, cli: true), .builtIn)
    }

    func testOwnershipMarkerWinsOverAnInstalledCLI() {
        XCTAssertEqual(resolve(marker: true, cliDaemon: true, cli: true), .builtIn)
    }

    func testExternalPreferenceNeedsAnExternalCLI() {
        XCTAssertEqual(resolve(preference: "external", cli: true), .external)
        XCTAssertEqual(resolve(preference: "external", cli: false), .builtIn)
    }

    func testBuildsWithoutHelperAlwaysUseTheExternalCLI() {
        XCTAssertEqual(resolve(preference: "builtIn", builtIn: false, marker: true), .external)
    }

    func testCLIWithoutItsDaemonDoesNotBlockTheBuiltInTentacle() {
        XCTAssertEqual(resolve(cliDaemon: false, cli: true), .builtIn)
    }

    // MARK: Ownership marker (contract with packages/tentacle/src/managed.ts)

    func testOwnershipMarkerMatchesTheCLIContract() throws {
        let data = try BuiltInTentacle.ownershipMarkerData(
            label: "chat.kraki.mac.tentacle",
            appPath: "/Applications/Kraki.app",
            appVersion: "0.3.0",
            now: Date(timeIntervalSince1970: 0)
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["by"] as? String, "kraki-mac")
        XCTAssertEqual(json["label"] as? String, "chat.kraki.mac.tentacle")
        XCTAssertEqual(json["appPath"] as? String, "/Applications/Kraki.app")
        XCTAssertEqual(json["appVersion"] as? String, "0.3.0")
        XCTAssertEqual(json["updatedAt"] as? String, "1970-01-01T00:00:00Z")
    }

    func testOwnershipMarkerRoundTripInAnIsolatedHome() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-marker-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let tentacle = BuiltInTentacle(appBundle: .main, krakiHome: home)
        XCTAssertFalse(tentacle.ownershipMarkerExists)
        try tentacle.writeOwnershipMarker()
        XCTAssertTrue(tentacle.ownershipMarkerExists)
        let mode = try FileManager.default.attributesOfItem(atPath: tentacle.ownershipMarkerURL.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        tentacle.clearOwnershipMarker()
        XCTAssertFalse(tentacle.ownershipMarkerExists)
    }

    // MARK: Setup events (contract with packages/tentacle/src/setup-json.ts)

    func testSetupEventsDriveThePhases() {
        typealias R = TentacleSetupRunner
        var phase: R.Phase = .idle
        let lines = [
            #"{"event":"start","version":"0.34.0"}"#,
            #"{"event":"device_code","userCode":"ABCD-1234","verificationUri":"https://github.com/login/device","expiresIn":899}"#,
            #"{"event":"authenticated","username":"octocat","source":"device_flow"}"#,
            #"{"event":"relay","relay":"wss://r","region":"us","fallback":false}"#,
            #"{"event":"done","configPath":"/x","relay":"wss://r","username":"octocat","deviceName":"Mac"}"#,
        ]
        var seen: [R.Phase] = []
        for line in lines {
            if let next = R.phase(after: phase, line: line) { phase = next; seen.append(next) }
        }
        XCTAssertEqual(seen, [
            .starting,
            .waitingForGitHub(userCode: "ABCD-1234", verificationURL: URL(string: "https://github.com/login/device")!),
            .configuring(username: "octocat"),
            .configuring(username: "octocat"),
            .done(username: "octocat"),
        ])
        XCTAssertEqual(
            R.phase(after: .starting, line: #"{"event":"error","code":"denied","message":"GitHub sign-in was cancelled."}"#),
            .failed(message: "GitHub sign-in was cancelled.")
        )
        XCTAssertNil(R.phase(after: .starting, line: "not json"))
    }

    // MARK: Onboarding steps

    private func step(
        install: TentacleCLIManager.InstallState = .available(path: "/k", version: "1"),
        location: AppInstallLocation = .stable,
        configured: Bool = true,
        daemon: TentacleCLIManager.DaemonState = .running(pid: 1),
        fda: String? = "granted",
        skipped: Bool = false
    ) -> BuiltInSetupView.Step {
        BuiltInSetupView.step(
            installState: install, location: location, configured: configured,
            daemonState: daemon, fdaStatus: fda, fdaSkipped: skipped
        )
    }

    func testSetupStepsInOrder() {
        XCTAssertEqual(step(install: .unknown), .detecting)
        XCTAssertEqual(step(location: .translocated, configured: false), .moveToApplications(.translocated))
        XCTAssertEqual(step(configured: false), .signIn)
        XCTAssertEqual(step(daemon: .stopped), .background)
        XCTAssertEqual(step(daemon: .needsApproval), .background)
        XCTAssertEqual(step(fda: "denied"), .fullDiskAccess)
        XCTAssertEqual(step(fda: "denied", skipped: true), .done)
        XCTAssertEqual(step(), .done)
    }

    func testSetupWaitsForTheDaemonsOwnFullDiskAccessReport() {
        XCTAssertEqual(step(fda: nil), .background)
        // No protected path exists on this account: nothing to ask for.
        XCTAssertEqual(step(fda: "missing"), .done)
    }
}
