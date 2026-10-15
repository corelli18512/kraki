import SwiftUI
import XCTest
#if os(macOS)
import AppKit
@testable import Kraki_Dev
#else
import UIKit
@testable import Kraki
#endif

final class BuildInfoTests: XCTestCase {
    static func fixture(_ overrides: [String: Any] = [:]) throws -> BuildInfo {
        var value: [String: Any] = [
            "schemaVersion": 1, "channel": "release", "repository": "corelli18512/kraki",
            "commit": String(repeating: "a", count: 40), "workflow": ".github/workflows/release.yml",
            "runId": "12345678901", "runAttempt": "1"
        ]
        value.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(BuildInfo.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testBuildLinksArePinnedToThisRunAndSource() throws {
        let info = try Self.fixture(["runAttempt": "2"])
        XCTAssertEqual(info.runURL?.absoluteString, "https://github.com/corelli18512/kraki/actions/runs/12345678901/attempts/2")
        XCTAssertEqual(info.sourceURL?.lastPathComponent, String(repeating: "a", count: 40))
        XCTAssertEqual(info.provenanceURL?.fragment, "summary")
        XCTAssertTrue(info.runLabel.contains("attempt 2"))
    }

    func testLocalAndDryRunDoNotClaimReleaseProvenance() throws {
        XCTAssertNil(BuildInfo.local.runURL)
        XCTAssertNil(BuildInfo.local.provenanceURL)
        let dryRun = try Self.fixture(["channel": "ci"])
        XCTAssertNotNil(dryRun.runURL)
        XCTAssertNil(dryRun.provenanceURL)
    }

    func testInvalidMetadataCannotProduceExternalLinks() throws {
        for override: [String: Any] in [
            ["schemaVersion": 99], ["repository": "attacker/kraki"], ["runId": "../123"],
            ["runId": "0"], ["runAttempt": "https://evil.invalid"], ["commit": "main"],
            ["workflow": ".github/workflows/ci.yml"], ["channel": "verified"]
        ] {
            let info = try Self.fixture(override)
            XCTAssertFalse(info.hasBuildRecord)
            XCTAssertNil(info.runURL)
            XCTAssertNil(info.sourceURL)
            XCTAssertNil(info.provenanceURL)
        }
    }

    func testBundledBuildMetadataIsPresent() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "build-info", withExtension: "json"))
        let info = try JSONDecoder().decode(BuildInfo.self, from: Data(contentsOf: url))
        XCTAssertEqual(info.schemaVersion, 1)
    }

    /// Opt-in renders of the production views with clearly synthetic build data.
    @MainActor
    func testBuildSourceScreenshots() throws {
        guard let dir = ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set TEST_RUNNER_KRAKI_SNAPSHOT_DIR to render build-source views")
        }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for dark in [false, true] {
            let info = try Self.fixture()
            let suffix = dark ? "dark" : "light"
            #if os(macOS)
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("provenance-\(UUID().uuidString)")
            let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
            let view = AboutPane(buildInfo: info).environment(app).environment(TentacleCLIManager())
            let host = NSHostingView(rootView: view.environment(\.colorScheme, dark ? .dark : .light))
            let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 560, height: 560),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            window.orderFrontRegardless()
            defer { window.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            let name = "mac-build-source-\(suffix).png"
            #else
            let view = NavigationStack {
                Form { AboutBuildSection(version: "0.1.34", relayVersion: "0.20.0", buildInfo: info) }
                    .navigationTitle("Settings")
            }
            let host = UIHostingController(rootView: view)
            host.overrideUserInterfaceStyle = dark ? .dark : .light
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 600)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            host.view.frame = window.bounds
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let png = try XCTUnwrap(image.pngData())
            let name = "ios-build-source-\(suffix).png"
            #endif
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
        }
    }
}
