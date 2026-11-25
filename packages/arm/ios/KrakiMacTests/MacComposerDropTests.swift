#if os(macOS) && DEBUG
import AppKit
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// K-120: dropping an image on the composer attaches it (the tooltip says
/// "paste or drop one"); it used to insert the file's path as text. The
/// production `MacChatComposer` in a window that is never shown; the drop is
/// handed straight to the editor.
@MainActor
final class MacComposerDropTests: XCTestCase {
    private var window: NSWindow?
    private var files: [URL] = []

    override func tearDown() {
        window?.contentView = nil
        window = nil
        files.forEach { try? FileManager.default.removeItem(at: $0) }
        files.removeAll()
        super.tearDown()
    }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }

    private func composer(busy: Bool) throws -> (AppState, MacComposerTextView) {
        let app = IOSVoiceHoldScenarioFixture.makeAppState(driver: IOSVoiceHoldScenarioDriver(automaticCorrections: false))
        if busy { app.sessionStore.sessions["voice-a"]?.state = .active }
        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 640, height: 220),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        self.window = window
        let host = NSHostingView(rootView: VStack(spacing: 0) {
            Spacer(minLength: 0)
            MacChatComposer(sessionId: "voice-a")
        }.frame(width: 640, height: 220).environment(app))
        host.frame = NSRect(x: 0, y: 0, width: 640, height: 220)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        drain(200)
        let editor = try XCTUnwrap(views(host).compactMap { $0 as? MacComposerTextView }.first)
        return (app, editor)
    }

    private func pngFile() throws -> URL {
        let image = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
            NSColor.systemRed.setFill(); rect.fill(); return true
        }
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("drop-\(UUID().uuidString).png")
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        files.append(url)
        return url
    }

    private func drag(_ urls: [URL]) -> FakeDrag {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("kraki-drop-\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.writeObjects(urls as [NSURL])
        return FakeDrag(pasteboard: pasteboard, window: window)
    }

    func testDroppedImageFileIsAttachedNotTypedAsItsPath() throws {
        let (app, editor) = try composer(busy: false)
        let drag = drag([try pngFile()])
        XCTAssertEqual(editor.draggingEntered(drag), .copy)
        XCTAssertTrue(editor.prepareForDragOperation(drag))
        XCTAssertTrue(editor.performDragOperation(drag))
        editor.concludeDragOperation(drag)
        drain(100)
        XCTAssertEqual(editor.string, "", "the file path must not be inserted")
        XCTAssertNotNil(app.sessionStore.stagedImages["voice-a"], "the dropped image is attached")
    }

    func testImageDroppedWhileTheAgentIsBusyIsRefusedWithoutText() throws {
        let (app, editor) = try composer(busy: true)
        let drag = drag([try pngFile()])
        XCTAssertFalse(editor.performDragOperation(drag))
        drain(100)
        XCTAssertEqual(editor.string, "")
        XCTAssertNil(app.sessionStore.stagedImages["voice-a"])
    }

    func testOtherFilesStillDropAsText() throws {
        let (app, editor) = try composer(busy: false)
        let note = FileManager.default.temporaryDirectory.appendingPathComponent("drop-\(UUID().uuidString).txt")
        try "hello".write(to: note, atomically: true, encoding: .utf8)
        files.append(note)
        let drag = drag([note])
        _ = editor.draggingEntered(drag)
        _ = editor.performDragOperation(drag)
        editor.concludeDragOperation(drag)
        drain(100)
        XCTAssertNil(app.sessionStore.stagedImages["voice-a"], "a text file is not an image")
        XCTAssertTrue(editor.string.contains(note.lastPathComponent),
                      "dropped as text, as before: \(editor.string)")
    }

    /// The attach button says "paste or drop one": the composer box outside
    /// the editor takes image drops with the same rule.
    func testComposerBoxTakesImageDropsOnly() throws {
        var offered: [NSImage] = []
        let image = MacComposerImageDrop(pasteboard: drag([try pngFile()]).draggingPasteboard) { offered.append($0); return true }
        XCTAssertTrue(image.accepts())
        XCTAssertTrue(image.drop())
        XCTAssertEqual(offered.count, 1)

        let note = FileManager.default.temporaryDirectory.appendingPathComponent("drop-\(UUID().uuidString).txt")
        try "hello".write(to: note, atomically: true, encoding: .utf8)
        files.append(note)
        let text = MacComposerImageDrop(pasteboard: drag([note]).draggingPasteboard) { offered.append($0); return true }
        XCTAssertFalse(text.accepts())
        XCTAssertFalse(text.drop())
        XCTAssertEqual(offered.count, 1, "a text file is not offered as an image")

        let refused = MacComposerImageDrop(pasteboard: drag([try pngFile()]).draggingPasteboard) { _ in false }
        XCTAssertFalse(refused.drop(), "a busy composer refuses the drop")
    }
}

/// A drag whose pasteboard the test fills.
private final class FakeDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    init(pasteboard: NSPasteboard, window: NSWindow?) {
        draggingPasteboard = pasteboard
        draggingDestinationWindow = window
    }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { NSPoint(x: 20, y: 20) }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?,
                                classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
#endif
