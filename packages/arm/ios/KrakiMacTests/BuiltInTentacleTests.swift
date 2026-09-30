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

    private func needsChoice(
        preference: String = "",
        builtIn: Bool = true,
        marker: Bool = false,
        cliDaemon: Bool = true,
        cli: Bool = true
    ) -> Bool {
        TentacleMode.needsOwnerChoice(
            preference: preference,
            builtInAvailable: builtIn,
            ownershipMarkerExists: marker,
            cliDaemonInstalled: cliDaemon,
            externalCLIFound: cli
        )
    }

    func testAnExistingCLIDaemonAsksTheUserOnce() {
        XCTAssertTrue(needsChoice())
        // Answered: never again, in either direction.
        XCTAssertFalse(needsChoice(preference: "builtIn"))
        XCTAssertFalse(needsChoice(preference: "external"))
    }

    func testNoQuestionWithoutACompetingCLIDaemon() {
        XCTAssertFalse(needsChoice(cliDaemon: false))          // new user, or CLI tool only
        XCTAssertFalse(needsChoice(cli: false))                // leftover plist, no CLI
        XCTAssertFalse(needsChoice(marker: true))              // Kraki for Mac already owns it
        XCTAssertFalse(needsChoice(builtIn: false))            // build without the helper
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

    func testBrowserSignInEvents() {
        typealias R = TentacleSetupRunner
        let url = #"{"event":"oauth_url","url":"https://github.com/login/oauth/authorize?client_id=c","callbackScheme":"kraki"}"#
        XCTAssertEqual(R.phase(after: .starting, line: url), .waitingForBrowser)
        let request = R.oauthRequest(line: url)
        XCTAssertEqual(request?.0.host, "github.com")
        XCTAssertEqual(request?.1, "kraki")
        // Only GitHub over https may be opened.
        XCTAssertNil(R.oauthRequest(line: #"{"event":"oauth_url","url":"https://evil.test/x","callbackScheme":"kraki"}"#))
        // Older servers: fall back to the device code; other errors don't.
        XCTAssertEqual(R.oauthFallback(line: #"{"event":"error","code":"oauth_unavailable","message":"x"}"#), true)
        XCTAssertEqual(R.oauthFallback(line: #"{"event":"error","code":"denied","message":"x"}"#), false)
        // Closing the sign-in window returns to the Sign in button, not an error.
        XCTAssertEqual(R.phase(after: .waitingForBrowser, line: #"{"event":"error","code":"cancelled","message":"x"}"#), .idle)
    }

    // MARK: Onboarding steps

    private func step(
        install: TentacleCLIManager.InstallState = .available(path: "/k", version: "1"),
        location: AppInstallLocation = .stable,
        configured: Bool = true,
        daemon: TentacleCLIManager.DaemonState = .running(pid: 1),
        role: BuiltInTentacle.ThisMacRole = .runsAgents,
        ownerChoice: Bool = false,
        moved: Bool = false
    ) -> BuiltInSetupView.Step {
        BuiltInSetupView.step(
            installState: install, location: location, configured: configured,
            daemonState: daemon, role: role, ownerChoicePending: ownerChoice, movedFromCLI: moved
        )
    }

    func testAnExistingCLIIsResolvedInSetupFirst() {
        // Signed-in CLI (configured) that runs the daemon: ask before anything else.
        XCTAssertEqual(step(role: .undecided, ownerChoice: true), .chooseOwner)
        // Moved to Kraki for Mac: agents + Full Disk Access, no new sign-in.
        XCTAssertEqual(step(daemon: .running(pid: 1), role: .undecided, moved: true), .thisMac)
        XCTAssertEqual(step(role: .runsAgents, moved: true), .done)
    }

    func testSetupStepsInOrder() {
        XCTAssertEqual(step(install: .unknown), .detecting)
        XCTAssertEqual(step(location: .translocated, configured: false, role: .undecided), .moveToApplications(.translocated))
        // 1. This Mac (agents + Full Disk Access) comes before sign-in.
        XCTAssertEqual(step(configured: false, role: .undecided), .thisMac)
        // 2. Sign-in, whichever way step 1 went.
        XCTAssertEqual(step(configured: false, role: .runsAgents), .signIn)
        XCTAssertEqual(step(configured: false, role: .remoteOnly), .signIn)
        // 3. Background service, only when agents run here.
        XCTAssertEqual(step(daemon: .stopped), .background)
        XCTAssertEqual(step(daemon: .needsApproval), .background)
        XCTAssertEqual(step(), .done)
    }

    func testRemoteOnlyNeverStartsTheBackgroundService() {
        XCTAssertEqual(step(daemon: .stopped, role: .remoteOnly), .done)
    }

    func testInstallsFromBeforeTheStepSkipIt() {
        // Configured by an older build: no role stored, still runs agents.
        XCTAssertEqual(step(daemon: .stopped, role: .undecided), .background)
        XCTAssertEqual(step(role: .undecided), .done)
    }

    func testAgentCheckEventsFillTheRows() {
        typealias C = LocalAgentsCheck
        var agents = C.placeholders
        agents = C.apply(line: #"{"event":"agent","id":"codex","name":"Codex","status":"ready","version":"0.157.1","models":7,"sampleModels":["gpt-6-luna"],"installUrl":"https://x"}"#, to: agents)
        agents = C.apply(line: #"{"event":"agent","id":"claude","name":"Claude Code","status":"needs_login","hint":"Run `claude`","models":0,"installUrl":"https://x"}"#, to: agents)
        agents = C.apply(line: #"{"event":"checking","id":"pi","name":"pi"}"#, to: agents)
        XCTAssertEqual(agents.map(\.id), ["claude", "codex", "copilot", "pi"])
        XCTAssertEqual(agents[1].status, .ready)
        XCTAssertEqual(agents[1].models, 7)
        XCTAssertEqual(agents[0].status, .needsLogin)
        XCTAssertEqual(agents[0].hint, "Run `claude`")
        XCTAssertEqual(agents[3].status, .checking)
    }

    func testContinueNeedsAWorkingAgentAndFullDiskAccess() {
        typealias S = ThisMacSetupStep
        XCTAssertNotNil(S.blockingReason(isChecking: true, readyAgents: 0, hasFullDiskAccess: true))
        XCTAssertNotNil(S.blockingReason(isChecking: false, readyAgents: 0, hasFullDiskAccess: true))
        XCTAssertEqual(S.blockingReason(isChecking: false, readyAgents: 1, hasFullDiskAccess: false), "Allow Full Disk Access to continue.")
        XCTAssertNil(S.blockingReason(isChecking: true, readyAgents: 1, hasFullDiskAccess: true))
    }

    func testAgentsWindowRestartsOnlyWhenTheReadySetChanged() {
        XCTAssertFalse(LocalAgentsWindow.needsRestart(ready: ["codex", "pi"], offered: ["pi", "codex"]))
        XCTAssertTrue(LocalAgentsWindow.needsRestart(ready: ["codex", "pi"], offered: ["codex"]))
        XCTAssertTrue(LocalAgentsWindow.needsRestart(ready: ["codex"], offered: ["codex", "claude"]))
    }
}
