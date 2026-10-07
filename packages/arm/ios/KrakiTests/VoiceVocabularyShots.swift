import XCTest
import SwiftUI
#if os(macOS)
import AppKit
@testable import Kraki_Dev
#else
import UIKit
@testable import Kraki
#endif

/// Custom Words settings in each sync state, for visual review (no pixel
/// assertions). Opt-in: `mkdir -p /tmp/kraki-words-shots && touch /tmp/kraki-words-shots/enable`.
@MainActor
final class VoiceVocabularyShots: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/kraki-words-shots", isDirectory: true)

    private func app(_ state: String) throws -> AppState {
        let suite = "VoiceVocabularyShots.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        let store = VoiceVocabularyStore(defaults: defaults)
        store.activate(userID: "shots", relay: "wss://relay.example")
        store.syncSupported = true
        let kraki = VoiceTerm(term: "Kraki", heardAs: "cracky, 克拉奇")
        let pg = VoiceTerm(term: "PostgreSQL", heardAs: "post gress")
        store.receive(.init(revision: 2, entries: [kraki, pg].enumerated().map { i, t in
            .init(id: t.id.uuidString.lowercased(), revision: i + 1, term: t.term, heardAs: t.heardAs,
                  deleted: false, changeId: UUID().uuidString.lowercased())
        }))
        switch state {
        case "pending":
            store.upsert(VoiceTerm(term: "Tentacle"))
        case "conflict":
            var edited = kraki; edited.term = "Kraki App"
            store.upsert(edited)
            let sent = store.syncState.pending
            store.receive(store.syncState.snapshot, sent: sent,
                          results: [["changeId": sent[0].changeId, "status": "conflict"]])
        default: break
        }
        let host = AppState.makeUnitTestHost()
        host.setVoiceVocabularyStoreForTesting(store)
        return host
    }

    func testRenderSyncStates() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: dir.appendingPathComponent("enable").path),
                          "visual review only")
        for state in ["synced", "pending", "conflict"] {
            let app = try app(state)
            #if os(macOS)
            let root = VoiceInputPane().environment(app).frame(width: 620, height: 640)
            let host = NSHostingView(rootView: root)
            let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 620, height: 640),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = host
            window.orderFrontRegardless()
            RunLoop.main.run(until: Date().addingTimeInterval(0.8))
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: dir.appendingPathComponent("mac-\(state).png"))
            window.orderOut(nil)
            #else
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
            window.windowLevel = .alert + 1
            window.rootViewController = UIHostingController(rootView: NavigationStack { VoiceVocabularyPage() }.environment(app))
            window.makeKeyAndVisible()
            RunLoop.main.run(until: Date().addingTimeInterval(1.0))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try XCTUnwrap(image.pngData()).write(to: dir.appendingPathComponent("ios-\(state).png"))
            window.isHidden = true
            #endif
        }
    }
}
