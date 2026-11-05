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

    /// The CLI's `message` is English terminal text; the Mac shows localized
    /// copy picked from `code`, like Windows (`DesktopSetup.tsx` SIGN_IN_ERRORS).
    func testSetupErrorShowsCopyForTheCodeNotTheCLIMessage() {
        typealias R = TentacleSetupRunner
        func failure(_ code: String, _ message: String) -> R.Phase? {
            R.phase(after: .starting, line: #"{"event":"error","code":"\#(code)","message":"\#(message)"}"#)
        }
        let network = R.Phase.failed(message: "Could not reach Kraki. Check your network connection, then try again.")
        XCTAssertEqual(failure("relay_unreachable", "Cannot reach the Kraki relay (connect ECONNREFUSED 127.0.0.1:443)."), network)
        XCTAssertEqual(failure("network", "Could not reach Kraki (fetch failed)."), network)
        XCTAssertEqual(failure("client_id_unavailable", "x"), network)
        // K-324: GitHub blocked (China) names GitHub, not Kraki or "fetch failed".
        XCTAssertEqual(failure("github_unreachable", "Could not reach github.com (ENOTFOUND)."),
                       .failed(message: "Could not reach GitHub. Check your network connection or proxy, then try again."))
        XCTAssertEqual(failure("expired", "x"), .failed(message: "The GitHub code expired. Try again."))
        XCTAssertEqual(failure("denied", "x"), .failed(message: "GitHub sign-in was cancelled."))
        XCTAssertEqual(failure("bad_callback", "Invalid sign-in callback."), .failed(message: "GitHub sign-in could not be verified. Try again."))
        XCTAssertEqual(failure("token_invalid", "x"), .failed(message: "GitHub sign-in could not be verified. Try again."))
        XCTAssertEqual(failure("oauth_unavailable", "x"), .failed(message: "Browser sign-in is not available yet."))
        XCTAssertEqual(failure("exchange_failed", "GitHub sign-in failed (500)."), .failed(message: "Sign-in did not finish. Try again."))
        XCTAssertEqual(R.phase(after: .starting, line: #"{"event":"error"}"#), .failed(message: "Sign-in did not finish. Try again."))
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
        moved: Bool = false,
        signedOut: Bool = false
    ) -> BuiltInSetupView.Step {
        BuiltInSetupView.step(
            installState: install, location: location, configured: configured,
            daemonState: daemon, role: role, ownerChoicePending: ownerChoice, movedFromCLI: moved,
            signedOutByUser: signedOut
        )
    }

    func testSignedOutOfTheAppAsksToSignInAgain() {
        // The built-in Kraki is configured and running (this Mac stays
        // online), but the app was signed out: sign in, don't skip to done.
        XCTAssertEqual(step(signedOut: true), .signIn)
        XCTAssertEqual(step(role: .remoteOnly, signedOut: true), .signIn)
        XCTAssertEqual(step(signedOut: false), .done)
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
        // A check that misses a working agent must not restart the daemon.
        XCTAssertFalse(LocalAgentsWindow.needsRestart(ready: ["codex"], offered: ["codex", "claude"]))
    }

    func testAgentsTheDaemonServesShowAsReady() {
        typealias C = LocalAgentsCheck
        let agents = [
            C.Agent(id: "copilot", name: "GitHub Copilot CLI", status: .needsLogin, hint: "x"),
            C.Agent(id: "codex", name: "Codex", status: .needsLogin, hint: "y"),
        ]
        let merged = C.merging(agents, running: ["copilot": 1, "codex": 0])
        XCTAssertEqual(merged[0].status, .ready)
        XCTAssertNil(merged[0].hint)
        XCTAssertEqual(merged[1].status, .needsLogin) // served but without models
    }

    // MARK: QA fixes (mac-lifecycle-a)

    /// K-331: only an installed copy may register login items or restart the daemon.
    func testOnlyAnInstalledCopyIsPermanent() {
        XCTAssertTrue(AppInstallLocation.isPermanent(bundlePath: "/Applications/Kraki.app"))
        XCTAssertFalse(AppInstallLocation.isPermanent(bundlePath: "/Volumes/Kraki/Kraki.app"))
        XCTAssertFalse(AppInstallLocation.isPermanent(bundlePath: "/private/var/folders/x/AppTranslocation/ABC/d/Kraki.app"))
        XCTAssertFalse(AppInstallLocation.isPermanent(bundlePath: "/Users/me/.Trash/Kraki.app"))
    }

    /// K-332: after sign-in, setup keeps the window while this Mac is being
    /// brought online and while the Login Items / couldn't-start card shows.
    func testSetupHoldsTheWindowUntilThisMacIsOnlineOrTheUserMovesOn() {
        typealias V = BuiltInSetupView
        func holds(finished: Bool = false, phase: TentacleSetupRunner.Phase = .done(username: "a"),
                   bringingOnline: Bool = false, step: V.Step = .background,
                   daemon: TentacleCLIManager.DaemonState = .needsApproval) -> Bool {
            V.holdsSignIn(finished: finished, runnerPhase: phase, bringingOnline: bringingOnline, step: step, daemonState: daemon)
        }
        XCTAssertTrue(holds(phase: .configuring(username: "a"), step: .signIn, daemon: .stopped))
        XCTAssertTrue(holds(bringingOnline: true, daemon: .starting))
        XCTAssertTrue(holds(daemon: .needsApproval))
        XCTAssertTrue(holds(daemon: .error("boom")))
        // Nothing to act on: the main window may take over.
        XCTAssertFalse(holds(daemon: .stopped))
        XCTAssertFalse(holds(step: .done, daemon: .running(pid: 1)))
        XCTAssertFalse(holds(finished: true))
        XCTAssertFalse(holds(phase: .idle, step: .signIn, daemon: .stopped))
    }

    /// K-355: a Kraki folder the user can't write to says how to fix it.
    func testUnwritableKrakiFolderSaysHowToFixIt() {
        let phase = TentacleSetupRunner.phase(after: .starting, line: #"{"event":"error","code":"home_not_writable","message":"EACCES"}"#)
        guard case .failed(let message)? = phase else { return XCTFail("expected a failure, got \(String(describing: phase))") }
        XCTAssertTrue(message.contains("sudo chown -R"), message)
    }

    /// K-355: a translocated copy may already sit in Applications (moved with `mv`).
    func testTranslocatedCopyDoesNotAssumeItIsInDownloads() {
        let detail = BuiltInSetupView.moveToApplicationsDetail(.translocated)
        XCTAssertFalse(detail.contains("Downloads"), detail)
        XCTAssertTrue(detail.contains("already there"), detail)
    }

    /// K-348: results arriving out of display order are added below the rows
    /// already shown, and Check Again keeps the rows while it runs.
    func testAgentRowsKeepTheirPlaceWhileResultsStreamIn() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("agents-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("kraki")
        try """
        #!/bin/sh
        echo '{"event":"agent","id":"codex","name":"Codex","status":"ready","models":3}'
        sleep 0.3
        echo '{"event":"agent","id":"claude","name":"Claude Code","status":"ready","models":2}'
        echo '{"event":"agent","id":"copilot","name":"GitHub Copilot CLI","status":"not_installed"}'
        echo '{"event":"agent","id":"pi","name":"Pi","status":"not_installed"}'
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let check = LocalAgentsCheck()
        check.run(binaryPath: script.path)
        let deadline = Date().addingTimeInterval(10)
        while check.isRunning, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertEqual(check.installedAgents.map(\.id), ["codex", "claude"])

        check.run(binaryPath: script.path)
        XCTAssertEqual(check.installedAgents.map(\.id), ["codex", "claude"], "Check Again keeps the rows")
        let again = Date().addingTimeInterval(10)
        while check.isRunning, Date() < again { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertEqual(check.installedAgents.map(\.id), ["codex", "claude"])
    }

    // MARK: Daemon left on another version (K-357)

    /// A helper that never reports the shipped version used to be restarted
    /// (killing its running turns) on every app launch: the "already
    /// restarted" mark only lived in memory.
    func testVersionRestartHappensOncePerShippedVersionAcrossLaunches() throws {
        let domain = "chat.kraki.tests.versionrestart"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defaults.removePersistentDomain(forName: domain)
        defer { defaults.removePersistentDomain(forName: domain) }

        XCTAssertFalse(TentacleCLIManager.claimVersionRestart(shipped: "0.2.92", live: "0.2.92", defaults: defaults))
        XCTAssertFalse(TentacleCLIManager.claimVersionRestart(shipped: "0.2.92", live: nil, defaults: defaults))
        XCTAssertTrue(TentacleCLIManager.claimVersionRestart(shipped: "0.2.92", live: "0.2.91", defaults: defaults))
        // The next launch reads the same defaults: no second restart.
        XCTAssertFalse(TentacleCLIManager.claimVersionRestart(shipped: "0.2.92", live: "0.2.91", defaults: defaults))
        // An update ships a new version: restart once for it.
        XCTAssertTrue(TentacleCLIManager.claimVersionRestart(shipped: "0.2.93", live: "0.2.91", defaults: defaults))
        XCTAssertFalse(TentacleCLIManager.claimVersionRestart(shipped: "0.2.93", live: "0.2.91", defaults: defaults))
    }

    // MARK: Built-in job that never starts (K-119)

    /// launchd "spawn failed" (exit 78 after a rename, a move, a legacy
    /// helper path): the job is registered but never runs. Offline while it
    /// may still come up, then a problem the user can act on, not a plain
    /// "offline" forever.
    func testARegisteredJobThatNeverRunsBecomesAProblem() {
        func state(down: TimeInterval, stuck: Bool = false, sinceReRegister: TimeInterval? = 60) -> TentacleCLIManager.DaemonState {
            TentacleCLIManager.registeredButNotRunningState(
                down: down, launchdDomainStuck: stuck, sinceReRegister: sinceReRegister)
        }
        XCTAssertEqual(state(down: 0), .stopped)
        XCTAssertEqual(state(down: 30), .stopped)
        // A healthy start was measured at 74 s: still coming up, not a problem.
        XCTAssertEqual(state(down: 75), .stopped)
        XCTAssertEqual(state(down: 91), .error(TentacleCLIManager.helperDidNotStartMessage))
        // The self-heal re-register just ran: give it time first.
        XCTAssertEqual(state(down: 91, sinceReRegister: 10), .stopped)
        XCTAssertEqual(state(down: 91, sinceReRegister: nil), .error(TentacleCLIManager.helperDidNotStartMessage))
        XCTAssertEqual(state(down: 46, stuck: true), .error(TentacleCLIManager.launchdStuckMessage))
        let status = MacOnlineStatus.resolve(
            installState: .available(path: "/x/kraki", version: "1"),
            daemonState: state(down: 120),
            mode: .builtIn, role: .runsAgents)
        XCTAssertTrue(status.needsFixing, "the menu bar badges it and Bring This Mac Online retries")
        XCTAssertEqual(status.detail, TentacleCLIManager.helperDidNotStartMessage)
    }

    /// The idle pane swaps the composer for the couldn't-run card only for a
    /// real start failure, not for one failed status poll (K-351).
    func testOnlyAStartFailureReplacesTheComposer() {
        XCTAssertNil(TentacleCLIManager.startFailure(in: .error(TentacleCLIManager.statusQueryFailedMessage)))
        XCTAssertNil(TentacleCLIManager.startFailure(in: .stopped))
        XCTAssertEqual(TentacleCLIManager.startFailure(in: .error(TentacleCLIManager.helperDidNotStartMessage)),
                       TentacleCLIManager.helperDidNotStartMessage)
    }
}
