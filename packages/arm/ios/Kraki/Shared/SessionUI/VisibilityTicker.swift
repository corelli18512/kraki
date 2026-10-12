import Foundation

/// A view that re-checks whether it is on screen on the shared tick.
@MainActor
protocol VisibilityTickClient: AnyObject {
    func visibilityTick()
}

/// One 4 Hz tick shared by every animating session-list glyph (preview status
/// glyphs on iOS and Mac, the Mac sidebar "working" dots).
///
/// Why poll at all: SwiftUI keeps lazy list rows alive while they are scrolled
/// away, and the system may stop or drop a row's Core Animation timeline there
/// without telling the view when the row comes back. Without a re-check the
/// glyph stays frozen after scrolling (Mac sidebar bug fixed in 211b495b).
/// Each client re-checks its own visibility on the tick and restarts its
/// animation when it is visible again.
///
/// Why shared: a timer per row woke the main thread once per animating row.
/// This is one wake-up however many rows animate, and none when nothing does.
/// Clients are held weakly; a client that goes away without calling `remove`
/// is dropped on the next tick.
@MainActor
final class VisibilityTicker {
    static let shared = VisibilityTicker()
    static let interval: TimeInterval = 0.25

    private let clients = NSHashTable<AnyObject>.weakObjects()
    private var timer: Timer?

    var clientCount: Int { clients.allObjects.count }
    var isRunning: Bool { timer != nil }

    func add(_ client: VisibilityTickClient) {
        clients.add(client)
        guard timer == nil else { return }
        let timer = Timer(timeInterval: Self.interval, repeats: true) { _ in
            MainActor.assumeIsolated { VisibilityTicker.shared.tick() }
        }
        RunLoop.main.add(timer, forMode: .common) // keeps ticking during scroll tracking
        self.timer = timer
    }

    func remove(_ client: VisibilityTickClient) {
        clients.remove(client)
        if clients.allObjects.isEmpty { stop() }
    }

    func tick() {
        let current = clients.allObjects.compactMap { $0 as? VisibilityTickClient }
        if current.isEmpty { stop(); return }
        current.forEach { $0.visibilityTick() }
    }

    private func stop() { timer?.invalidate(); timer = nil }
}
