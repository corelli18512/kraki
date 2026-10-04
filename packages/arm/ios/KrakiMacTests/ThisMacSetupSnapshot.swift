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
            A(id: "pi", name: "Pi", status: .ready, version: "0.87.1", models: 6),
        ]
        let checking = LocalAgentsCheck.placeholders
        let none: [A] = mixed.map { var a = $0; a.status = .notInstalled; a.version = nil; return a }
        let onlyCopilot: [A] = [
            A(id: "claude", name: "Claude Code", status: .notInstalled),
            A(id: "codex", name: "Codex", status: .notInstalled),
            A(id: "copilot", name: "GitHub Copilot CLI", status: .ready, version: "1.0.91", models: 1),
            A(id: "pi", name: "Pi", status: .notInstalled),
        ]
        for (name, agents, fda) in [("mixed", mixed, false), ("checking", checking, false), ("all-granted", mixed, true), ("none", none, false), ("only-copilot", onlyCopilot, true)] {
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
        let sheet = SupportedAgentsSheet(check: LocalAgentsCheck.preview(onlyCopilot), binaryPath: "")
            .background(Color(nsColor: .windowBackgroundColor))
        let r3 = ImageRenderer(content: sheet); r3.scale = 2
        let rep3 = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(XCTUnwrap(r3.nsImage).tiffRepresentation)))
        try XCTUnwrap(rep3.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("supported-agents.png"))
        let choice = VStack(spacing: 14) {
            ExistingCLIChoiceView(embedded: true)
        }
        .padding(.horizontal, 22).padding(.vertical, 20)
        .frame(width: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(TentacleCLIManager())
        let r2 = ImageRenderer(content: choice); r2.scale = 2
        let rep2 = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(XCTUnwrap(r2.nsImage).tiffRepresentation)))
        try XCTUnwrap(rep2.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("choose-owner.png"))
    }
}
#endif
