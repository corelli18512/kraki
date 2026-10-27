import AppKit
import XCTest
import Observation
@testable import Kraki_Dev

/// "Is this Mac online" — the one status the menu bar, the menus and Settings
/// show (MacPresence.swift). Pure decisions only: no launchd, no login items.
@MainActor
final class MacPresenceTests: XCTestCase {

    private let installed = TentacleCLIManager.InstallState.available(path: "/x/kraki", version: "1")

    private func status(
        _ daemon: TentacleCLIManager.DaemonState,
        install: TentacleCLIManager.InstallState? = nil,
        mode: TentacleMode = .builtIn,
        role: BuiltInTentacle.ThisMacRole = .runsAgents
    ) -> MacOnlineStatus {
        MacOnlineStatus.resolve(installState: install ?? installed, daemonState: daemon, mode: mode, role: role)
    }

    // MARK: Status

    func testDaemonStatesMapToOnlineWording() {
        XCTAssertEqual(status(.running(pid: 42)), .online)
        XCTAssertEqual(status(.starting), .goingOnline)
        XCTAssertEqual(status(.stopping), .goingOffline)
        XCTAssertEqual(status(.stopped), .offline)
        XCTAssertEqual(status(.needsApproval), .needsLoginItems)
        XCTAssertEqual(status(.error("boom")), .problem("boom"))
        XCTAssertEqual(status(.unknown), .checking)
        XCTAssertEqual(status(.running(pid: 1), install: .unknown), .checking)
    }

    func testRunningButOffTheServerIsNotOnline() {
        // Moved house, Wi-Fi down: the service runs but the phone can't reach it.
        let reconnecting = MacOnlineStatus.resolve(
            installState: installed, daemonState: .running(pid: 42), mode: .builtIn, role: .runsAgents,
            relayReachable: false)
        XCTAssertEqual(reconnecting, .reconnecting)
        XCTAssertFalse(reconnecting.isOnline)
        XCTAssertFalse(reconnecting.needsFixing, "a network blip is not a broken install")
        XCTAssertLessThan(MacMenuBarIcon.alpha(for: .reconnecting), 1)
        // Reachability only matters while the service runs.
        XCTAssertEqual(MacOnlineStatus.resolve(
            installState: installed, daemonState: .stopped, mode: .builtIn, role: .runsAgents,
            relayReachable: false), .offline)
    }

    func testRelayDownNeedsAGracePeriodBeforeItShows() {
        let now = Date()
        XCTAssertTrue(TentacleCLIManager.relayStateIsUp("connected"))
        XCTAssertTrue(TentacleCLIManager.relayStateIsUp(nil), "older daemons don't report it")
        for state in ["connecting", "authenticating", "disconnected"] {
            XCTAssertFalse(TentacleCLIManager.relayStateIsUp(state), state)
        }
        XCTAssertTrue(TentacleCLIManager.relayReachable(downSince: nil, now: now))
        XCTAssertTrue(TentacleCLIManager.relayReachable(downSince: now.addingTimeInterval(-3), now: now),
                      "a relay redeploy or Wi-Fi roam never flashes the menu bar")
        XCTAssertFalse(TentacleCLIManager.relayReachable(
            downSince: now.addingTimeInterval(-(TentacleCLIManager.relayDownGrace + 1)), now: now))
    }

    /// The stored flag flips on the poll after the grace period, so the menu
    /// bar (which observes it) is invalidated without any other state change.
    func testRelayReachableFlipsOnTheFirstPollPastTheGrace() {
        let cli = TentacleCLIManager()
        let t0 = Date()
        cli.applyRelayState("connected", now: t0)
        XCTAssertTrue(cli.relayReachable)
        cli.applyRelayState("connecting", now: t0.addingTimeInterval(1))
        XCTAssertTrue(cli.relayReachable, "within the grace period")
        cli.applyRelayState("connecting", now: t0.addingTimeInterval(4))
        XCTAssertTrue(cli.relayReachable)
        // The menu bar reads onlineStatus; with only identical values written
        // since the first down poll it must still be told when the grace ends.
        var invalidated = false
        withObservationTracking { _ = cli.onlineStatus } onChange: { invalidated = true }
        cli.applyRelayState("connecting", now: t0.addingTimeInterval(12))
        XCTAssertTrue(invalidated, "observers are notified when the grace runs out")
        XCTAssertFalse(cli.relayReachable, "same relayState string, but the grace ran out")
        cli.applyRelayState("connected", now: t0.addingTimeInterval(15))
        XCTAssertTrue(cli.relayReachable)
        XCTAssertNil(cli.relayDownSince)
        cli.applyRelayState(nil, now: t0.addingTimeInterval(40))
        XCTAssertTrue(cli.relayReachable, "older daemons report nothing")
    }

    func testRemoteOnlyMacIsNeverOffline() {
        // Nothing runs here by choice; that is not "offline".
        XCTAssertEqual(status(.stopped, role: .remoteOnly), .controlsOthersOnly)
        XCTAssertEqual(status(.unknown, install: .notFound, mode: .external), .controlsOthersOnly)
        // The remote-only choice belongs to the built-in tentacle only.
        XCTAssertEqual(status(.running(pid: 7), mode: .external, role: .remoteOnly), .online)
    }

    func testOnlyBrokenStatesNeedFixing() {
        XCTAssertTrue(MacOnlineStatus.needsLoginItems.needsFixing)
        XCTAssertTrue(MacOnlineStatus.problem("x").needsFixing)
        for ok: MacOnlineStatus in [.online, .reconnecting, .offline, .goingOnline, .goingOffline, .checking, .controlsOthersOnly] {
            XCTAssertFalse(ok.needsFixing, "\(ok)")
        }
    }

    func testUserFacingWordingNeverMentionsTheService() {
        let all: [MacOnlineStatus] = [.checking, .online, .reconnecting, .goingOnline, .goingOffline, .offline,
                                      .needsLoginItems, .controlsOthersOnly]
        for s in all {
            let text = ([s.title] + [s.detail].compactMap { $0 }).joined(separator: " ").lowercased()
            for word in ["daemon", "tentacle", "background service", "pid"] {
                XCTAssertFalse(text.contains(word), "\(s): \(text)")
            }
        }
    }

    // MARK: Menu bar icon

    func testIconKeepsItsShapeAndDimsWhenOffline() {
        XCTAssertEqual(MacMenuBarIcon.alpha(for: .online), 1)
        XCTAssertLessThan(MacMenuBarIcon.alpha(for: .goingOnline), 1)
        XCTAssertLessThan(MacMenuBarIcon.alpha(for: .offline), MacMenuBarIcon.alpha(for: .goingOnline))
        XCTAssertEqual(MacMenuBarIcon.alpha(for: .problem("x")), 1)
    }

    func testBadgesPreferProblemsOverWaitingSessions() {
        XCTAssertEqual(MacMenuBarIcon.badge(for: .online, needsYou: false), .none)
        XCTAssertEqual(MacMenuBarIcon.badge(for: .online, needsYou: true), .attention)
        XCTAssertEqual(MacMenuBarIcon.badge(for: .needsLoginItems, needsYou: true), .problem)
        XCTAssertEqual(MacMenuBarIcon.badge(for: .problem("x"), needsYou: false), .problem)
    }

    func testPlainIconIsATemplateAndBadgedIconIsNot() {
        let plain = MacMenuBarIcon.image(status: .online, needsYou: false)
        XCTAssertTrue(plain.isTemplate)
        XCTAssertEqual(plain.size, MacMenuBarIcon.size)
        XCTAssertFalse(MacMenuBarIcon.image(status: .online, needsYou: true).isTemplate)
        XCTAssertFalse(MacMenuBarIcon.image(status: .needsLoginItems, needsYou: false).isTemplate)
        XCTAssertNotNil(NSImage(named: "MenuBarKraki"), "logo silhouette asset missing")
    }

    // MARK: Needs you

    func testNeedsYouListsOnlyPermissionsAndQuestionsOfLiveSessions() {
        let previews: [String: SessionPreview] = [
            "a": SessionPreview(text: "rm -rf build", type: "permission", timestamp: "2026-10-07T10:00:00Z"),
            "b": SessionPreview(text: "Which branch?", type: "question", timestamp: "2026-10-07T11:00:00Z"),
            "c": SessionPreview(text: "Done", type: "agent", timestamp: "2026-10-07T12:00:00Z"),
            "gone": SessionPreview(text: "?", type: "question", timestamp: "2026-10-07T13:00:00Z"),
        ]
        let items = MenuBarNeedsYou.items(titles: ["a": "Fix icon", "b": "Usage", "c": "Docs"], previews: previews)
        XCTAssertEqual(items.map(\.id), ["b", "a"], "newest first; finished and unknown sessions skipped")
        XCTAssertEqual(items.first?.title, "Usage")
        XCTAssertEqual(items.first?.reason, "Asked you a question")
        XCTAssertEqual(items.last?.reason, "Waiting for your approval")
    }

    // MARK: Quitting

    func testOnlyAPersonsQuitTakesThisMacOffline() {
        let core = AEEventClass(kCoreEventClass)
        let quit = AEEventID(kAEQuitApplication)
        // Dock › Quit, `osascript -e 'quit app "Kraki"'`.
        XCTAssertEqual(MacQuitSource.classify(eventClass: core, eventID: quit, hasQuitReason: false), .user)
        // Log out / restart / shut down carry a quit reason.
        XCTAssertEqual(MacQuitSource.classify(eventClass: core, eventID: quit, hasQuitReason: true), .system)
        // Sparkle and our own NSApp.terminate calls have no quit event.
        XCTAssertEqual(MacQuitSource.classify(eventClass: nil, eventID: nil, hasQuitReason: false), .system)
        XCTAssertEqual(MacQuitSource.classify(nil), .system)
        XCTAssertEqual(
            MacQuitSource.classify(eventClass: core, eventID: AEEventID(kAEOpenApplication), hasQuitReason: false),
            .system
        )
    }

    /// Sparkle's "Install and Relaunch" quits through a quit Apple event that
    /// looks like a person's quit; it used to ask "take this Mac offline?".
    func testInstallingAnUpdateNeverAsksToGoOffline() {
        XCTAssertTrue(MacPresenceController.asksBeforeQuitting(
            quittingOffline: false, installingUpdate: false, managesPresence: true, source: .user))
        XCTAssertFalse(MacPresenceController.asksBeforeQuitting(
            quittingOffline: false, installingUpdate: true, managesPresence: true, source: .user))
        XCTAssertFalse(MacPresenceController.asksBeforeQuitting(
            quittingOffline: false, installingUpdate: false, managesPresence: true, source: .system))
        XCTAssertFalse(MacPresenceController.asksBeforeQuitting(
            quittingOffline: true, installingUpdate: false, managesPresence: true, source: .user))
        XCTAssertFalse(MacPresenceController.asksBeforeQuitting(
            quittingOffline: false, installingUpdate: false, managesPresence: false, source: .user))
    }

    /// A remote update (from the phone) quits Kraki with an AppleScript quit
    /// that looks like a person's; it used to ask "take this Mac offline?"
    /// and the update waited on the answer.
    func testARemoteUpdateInProgressIsRecognized() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-home-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        XCTAssertFalse(MacPresenceController.remoteUpdateInProgress(krakiHome: home))
        let dir = home.appendingPathComponent("remote-update")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let plan = dir.appendingPathComponent("plan.json")
        try Data("{}".utf8).write(to: plan)
        XCTAssertTrue(MacPresenceController.remoteUpdateInProgress(krakiHome: home))
        // A plan left by an updater that died long ago doesn't count.
        XCTAssertFalse(MacPresenceController.remoteUpdateInProgress(krakiHome: home, now: Date().addingTimeInterval(7200)))
    }

    func testAWindowlessLaunchStartsFromTheMenuBar() {
        XCTAssertTrue(MacLaunchCoordinator.needsWindowlessStart(bootstrapStarted: false, visibleWindows: 0))
        XCTAssertFalse(MacLaunchCoordinator.needsWindowlessStart(bootstrapStarted: true, visibleWindows: 0))
        XCTAssertFalse(MacLaunchCoordinator.needsWindowlessStart(bootstrapStarted: false, visibleWindows: 1))
    }

    func testQuitEventDescriptorsAreClassified() {
        let target = NSAppleEventDescriptor(processIdentifier: ProcessInfo.processInfo.processIdentifier)
        let userQuit = NSAppleEventDescriptor(
            eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEQuitApplication),
            targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID)
        )
        XCTAssertEqual(MacQuitSource.classify(userQuit), .user)

        let logout = userQuit.copy() as! NSAppleEventDescriptor
        logout.setParam(NSAppleEventDescriptor(enumCode: OSType(kAEReallyLogOut)), forKeyword: AEKeyword(kAEQuitReason))
        XCTAssertEqual(MacQuitSource.classify(logout), .system)
    }

    func testLoginLaunchIsRecognisedFromTheOpenEvent() {
        let target = NSAppleEventDescriptor(processIdentifier: ProcessInfo.processInfo.processIdentifier)
        let open = NSAppleEventDescriptor(
            eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenApplication),
            targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID)
        )
        XCTAssertFalse(MacPresenceController.wasLaunchedAsLoginItem(open))
        open.setParam(NSAppleEventDescriptor(enumCode: OSType(keyAELaunchedAsLogInItem)), forKeyword: AEKeyword(keyAEPropData))
        XCTAssertTrue(MacPresenceController.wasLaunchedAsLoginItem(open))
        XCTAssertFalse(MacPresenceController.wasLaunchedAsLoginItem(nil))
    }
}
