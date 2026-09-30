import SwiftUI
import UIKit
import XCTest
@testable import Kraki

/// A reused chat cell reconfigures its image host for another message; the
/// new message's images must be requested even though SwiftUI does not see
/// the gallery "appear" again.
@MainActor
final class BubbleImageReuseTests: XCTestCase {
    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
    }

    private func ref(_ id: String) -> ContentRef {
        ContentRef(type: "content_ref", id: id, mimeType: "image/png", size: 10, caption: nil, name: nil, width: 10, height: 10)
    }

    private func pump(_ view: UIView) async {
        for _ in 0..<5 {
            view.layoutIfNeeded()
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
    }

    func testReconfiguredHostRequestsTheNewMessagesImages() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-ios-reuse-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        var requested: [String] = []
        let store = AttachmentStore(cacheDirectory: dir, visibleDwell: 0) { id, _, _ in requested.append(id); return true }
        store.setTransportReady(true)

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
        let host = BubbleImageHostView(frame: window.bounds)
        window.addSubview(host)
        window.isHidden = false
        func configure(_ id: String) {
            host.configure(images: [], refs: [ref(id)], sessionId: "s", maxWidth: 300, alignment: .leading,
                           attachmentStore: store, onOpenImage: { _ in })
        }
        configure("first")
        await pump(host)
        XCTAssertEqual(requested, ["first"])
        configure("second")
        await pump(host)
        store.ingestChunk(id: "first", index: 0, total: 1, mimeType: "image/png", data: "AA==", error: nil, paced: true)
        await pump(host)
        XCTAssertTrue(requested.contains("second"), "reused host never requested its new image: \(requested)")
    }
}
