import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Chat cells are reused: the image grid's hosting view gets a new root view
/// for a different message. The new message's images must still be requested
/// (and the previous ones released), otherwise a reused cell shows a loading
/// placeholder forever even when the bytes are cached on disk.
@MainActor
final class MacImageGridReuseTests: XCTestCase {
    private func ref(_ id: String) -> ContentRef {
        ContentRef(type: "content_ref", id: id, mimeType: "image/png", size: 10, caption: nil, name: nil, width: 10, height: 10)
    }

    private func grid(_ refs: [ContentRef], _ store: AttachmentStore) -> MacBubbleImageGrid {
        MacBubbleImageGrid(inlineImages: [], refs: refs, sessionId: "s", maxWidth: 300, alignment: .leading, attachmentStore: store)
    }

    private func pump(_ host: NSView) async {
        for _ in 0..<5 {
            host.layoutSubtreeIfNeeded()
            host.display()
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
    }

    func testReusedCellRequestsTheNewMessagesImages() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-reuse-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        var requested: [String] = []
        let store = AttachmentStore(cacheDirectory: dir, visibleDwell: 0) { id, _, _ in requested.append(id); return true }
        store.setTransportReady(true)

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSHostingView(rootView: Optional(grid([ref("first")], store)))
        host.frame = window.contentLayoutRect
        window.contentView = host
        await pump(host)
        XCTAssertEqual(requested, ["first"])

        // What MacChatBubbleCell does on reuse: clear, then configure anew.
        host.rootView = nil
        host.rootView = grid([ref("second")], store)
        await pump(host)
        // "first" finishes (it was in flight); the queue must move on to "second".
        store.ingestChunk(id: "first", index: 0, total: 1, mimeType: "image/png", data: "AA==", error: nil, paced: true)
        await pump(host)
        XCTAssertTrue(requested.contains("second"), "the reused cell never requested its new image: \(requested)")
    }
}
