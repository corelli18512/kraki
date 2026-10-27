import XCTest
import AppKit
import UniformTypeIdentifiers
@testable import Kraki_Dev

/// Mac input audit finding 6: ⌘V in the composer attaches an image only for an
/// image-only clipboard or a copied image file. A clipboard with text and a
/// picture of it (Numbers/Excel/Keynote cells) pastes the text.
/// Private pasteboards only: the general pasteboard is never touched.
final class MacComposerPastePolicyTests: XCTestCase {
    private var pasteboard: NSPasteboard!
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        pasteboard.clearContents()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("mac-paste-policy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        pasteboard?.releaseGlobally()
        pasteboard = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    private let png = NSPasteboard.PasteboardType(UTType.png.identifier)

    /// 6×4 unless sized: the stand-in for Finder's icon and clipboard data.
    private func tiffData(_ size: NSSize = NSSize(width: 6, height: 4)) throws -> Data {
        try XCTUnwrap(NSImage(size: size, flipped: false) { rect in
            NSColor.systemRed.setFill(); rect.fill(); return true
        }.tiffRepresentation)
    }

    private func pngData(_ size: NSSize = NSSize(width: 6, height: 4)) throws -> Data {
        try XCTUnwrap(NSBitmapImageRep(data: try tiffData(size))?.representation(using: .png, properties: [:]))
    }

    /// The copied file's own size, distinct from the icon's 6×4.
    private let fileSize = NSSize(width: 10, height: 10)

    /// One pasteboard item carrying every given representation, as an app's copy does.
    private func put(_ representations: [NSPasteboard.PasteboardType: Data]) {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        for (type, data) in representations { item.setData(data, forType: type) }
        XCTAssertTrue(pasteboard.writeObjects([item]))
    }

    private func file(_ name: String, _ data: Data) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    private func fileItem(_ url: URL, name: String? = nil, icon: Data? = nil) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        item.setString(url.absoluteString, forType: .fileURL)
        if let name { item.setString(name, forType: .string) }
        if let icon { item.setData(icon, forType: .tiff) }
        return item
    }

    private func assertPastesText(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(MacComposerPastePolicy.attachesImage(pasteboard), message, file: file, line: line)
        XCTAssertNil(MacComposerPastePolicy.image(from: pasteboard), message, file: file, line: line)
    }

    private func assertAttachesImage(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(MacComposerPastePolicy.attachesImage(pasteboard), message, file: file, line: line)
        XCTAssertNotNil(MacComposerPastePolicy.image(from: pasteboard), message, file: file, line: line)
    }

    func testEmptyClipboardPastesNothingAsImage() {
        assertPastesText("empty clipboard")
    }

    func testStringOnlyPastesText() {
        put([.string: Data("plain words".utf8)])
        assertPastesText("text only")
    }

    func testPNGOnlyAttachesImage() throws {
        put([png: try pngData()])
        assertAttachesImage("PNG only")
    }

    func testTIFFOnlyAttachesImage() throws {
        put([.tiff: try tiffData()])
        assertAttachesImage("TIFF only (screenshots)")
    }

    func testSpreadsheetCellsWithPictureAndTextPasteText() throws {
        put([.string: Data("A1\tB1\nA2\tB2".utf8), png: try pngData()])
        assertPastesText("Numbers/Excel cells: string + PNG")
        put([.string: Data("A1\tB1\nA2\tB2".utf8), .tiff: try tiffData()])
        assertPastesText("string + TIFF")
    }

    func testMultiWordStringWithImagePastesText() throws {
        put([.string: Data("Quarterly revenue chart".utf8), .tiff: try tiffData()])
        assertPastesText("a multi-word string is text, not an image's address")
    }

    func testRichTextWithImagePastesText() throws {
        let rtf = try XCTUnwrap(NSAttributedString(string: "Slide title").rtf(
            from: NSRange(location: 0, length: 11), documentAttributes: [:]))
        put([.rtf: rtf, .tiff: try tiffData()])
        assertPastesText("RTF + image (Keynote/Office)")
        put([.rtf: rtf, .string: Data("Slide title".utf8), png: try pngData()])
        assertPastesText("RTF + string + image")
    }

    func testImageWithItsSingleWebAddressAttachesImage() throws {
        for address in ["https://example.com/photo.png", "http://example.com/a.jpg",
                        "  https://example.com/photo.png\n", "data:image/png;base64,iVBORw0KGgo="] {
            put([.string: Data(address.utf8), .tiff: try tiffData()])
            assertAttachesImage("browser Copy Image (image + its address): \(address)")
        }
    }

    func testSingleWebAddressAloneStillPastesText() {
        put([.string: Data("https://example.com/photo.png".utf8)])
        assertPastesText("a link without an image is text")
    }

    func testHTMLWithImageAttachesImage() throws {
        put([.html: Data("<img src=\"https://example.com/a.png\">".utf8), .tiff: try tiffData()])
        assertAttachesImage("HTML alone is not text (browser image copies carry <img>)")
    }

    func testImageFileURLAttachesImage() throws {
        let url = try file("shot.png", try pngData(fileSize))
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.writeObjects([fileItem(url, name: "shot.png", icon: try tiffData())]))
        assertAttachesImage("Finder copy of an image file (URL + file name + icon)")
        XCTAssertEqual(MacComposerPastePolicy.image(from: pasteboard)?.size, fileSize, "the file, not Finder's icon")
    }

    func testSeveralFileURLsAttachTheFirstImageFile() throws {
        let text = try file("notes.txt", Data("hello".utf8))
        let image = try file("photo.png", try pngData(fileSize))
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.writeObjects([fileItem(text, name: "notes.txt", icon: try tiffData()),
                                               fileItem(image, name: "photo.png", icon: try tiffData())]))
        assertAttachesImage("text file + image file")
        XCTAssertEqual(MacComposerPastePolicy.image(from: pasteboard)?.size, fileSize, "the image file, not an icon")
    }

    func testUnreadableImageFileFallsBackToClipboardImageData() throws {
        let missing = directory.appendingPathComponent("gone.png")
        pasteboard.clearContents()
        let item = fileItem(missing)
        item.setData(try pngData(), forType: png)
        XCTAssertTrue(pasteboard.writeObjects([item]))
        assertAttachesImage("an unreadable image file URL still attaches the image data beside it")
        XCTAssertEqual(MacComposerPastePolicy.image(from: pasteboard)?.size, NSSize(width: 6, height: 4))
    }

    func testRichTextImageOnlyCopyAttachesImage() throws {
        let rtf = try XCTUnwrap(NSAttributedString(string: "\u{FFFC}").rtf(
            from: NSRange(location: 0, length: 1), documentAttributes: [:]))
        put([.rtf: rtf, .string: Data("\u{FFFC}".utf8), .tiff: try tiffData()])
        assertAttachesImage("TextEdit/Notes image-only copy: the string is only the attachment placeholder")
        put([.rtf: rtf, .string: Data(" \u{FFFC}\n".utf8), png: try pngData()])
        assertAttachesImage("placeholder with whitespace")
    }

    func testNonImageFileURLPastesNormally() throws {
        let url = try file("notes.txt", Data("hello".utf8))
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.writeObjects([fileItem(url, name: "notes.txt", icon: try tiffData())]))
        assertPastesText("a non-image file never attaches its Finder icon")
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.writeObjects([fileItem(url)]))
        assertPastesText("a bare non-image file URL")
    }
}
