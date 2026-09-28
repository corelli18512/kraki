#if os(macOS) && DEBUG
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Renders setup step 1 to PNGs for design review (KRAKI_SNAPSHOT_DIR).
@MainActor
final class ThisMacSetupSnapshot: XCTestCase {
    func testRenderSetupStep() throws {
        guard let dir = ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] else {
            throw XCTSkip("set KRAKI_SNAPSHOT_DIR to render")
        }
        typealias A = LocalAgentsCheck.Agent
        let mixed: [A] = [
            A(id: "claude", name: "Claude Code", status: .needsLogin, version: "2.1.220", hint: "Run `claude` in Terminal and sign in."),
            A(id: "codex", name: "Codex", status: .ready, version: "0.157.1", models: 7),
            A(id: "copilot", name: "GitHub Copilot CLI", status: .notInstalled, installURL: URL(string: "https://github.com/features/copilot/cli")),
            A(id: "pi", name: "pi", status: .ready, version: "0.87.1", models: 6),
        ]
        let checking = LocalAgentsCheck.placeholders
        let none: [A] = mixed.map { var a = $0; a.status = .notInstalled; a.version = nil; return a }
        for (name, agents, fda) in [("mixed", mixed, false), ("checking", checking, false), ("all-granted", mixed, true), ("none", none, false)] {
            let view = ThisMacSetupStep(preview: agents, fullDiskAccess: fda)
                .padding(.horizontal, 22).padding(.vertical, 20)
                .frame(width: 520)
                .background(Color(nsColor: .windowBackgroundColor))
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let rep = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: dir).appendingPathComponent("this-mac-\(name).png"))
        }
    }
}
#endif
