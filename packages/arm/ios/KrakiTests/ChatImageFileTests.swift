import UniformTypeIdentifiers
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Saving, sharing and copying a chat image hand on its original bytes under
/// a name with the right extension (iOS and Mac; same rule as the Web).
final class ChatImageFileTests: XCTestCase {
    private func file(_ label: String?, _ mimeType: String, data: Data = Data([1, 2, 3])) -> ChatImageFile {
        ChatImageFile(id: "f", data: data, mimeType: mimeType, label: label)
    }

    func testFileNameUsesTheRealTypesExtension() {
        XCTAssertEqual(file(nil, "image/gif").fileName, "kraki-image.gif")
        XCTAssertEqual(file("cat.png", "image/gif").fileName, "cat.gif")
        XCTAssertEqual(file("screenshot.final.JPEG", "image/png").fileName, "screenshot.final.png")
        XCTAssertEqual(file("photo", "image/jpeg").fileName, "photo.jpg")
        XCTAssertEqual(file("chart", "IMAGE/WEBP").fileName, "chart.webp")
        XCTAssertEqual(file(nil, "image/gif").contentType, .gif)
        XCTAssertEqual(file(nil, "image/jpeg").contentType, .jpeg)
    }

    func testFileNameIsReadableButSafe() {
        XCTAssertEqual(file("  ", "image/png").fileName, "kraki-image.png")
        XCTAssertEqual(file("../etc/passwd", "image/png").fileName, "_etc_passwd.png")
        XCTAssertEqual(file("Login page: before/after?", "image/png").fileName, "Login page_ before_after_.png")
        XCTAssertEqual(file("Version 1.2 chart", "image/webp").fileName, "Version 1.2 chart.webp")
        XCTAssertEqual(file("...", "image/png").fileName, "kraki-image.png")
        XCTAssertEqual(file("cafe\u{301}.png", "image/png").fileName, "caf\u{e9}.png", "composed, as macOS needs")
        XCTAssertEqual(file(String(repeating: "x", count: 200), "image/png").fileName, String(repeating: "x", count: 80) + ".png")
    }

    func testTheBytesDecideWhenTheTypeSaysNothing() throws {
        let gif = try ChatGIFFixture.gif(frames: 2)
        XCTAssertEqual(file(nil, "application/octet-stream", data: gif).fileName, "kraki-image.gif")
        XCTAssertTrue(file(nil, "", data: gif).isGIF)
        XCTAssertEqual(ChatImageFile.sniffedMimeType(try ChatGIFFixture.png()), "image/png")
        XCTAssertNil(ChatImageFile.sniffedMimeType(Data("text".utf8)))
    }

    func testAgentImageIsNamedAfterItsNameElseCaption() {
        let ref = ContentRef(type: "content_ref", id: "r1", mimeType: "image/gif", size: 3, caption: "Build status", name: nil, width: nil, height: nil)
        XCTAssertEqual(ChatImageFile(ref: ref, mimeType: "image/gif", data: Data([1])).fileName, "Build status.gif")
        let named = ContentRef(type: "content_ref", id: "r2", mimeType: "image/png", size: 3, caption: "Build status", name: " shot.png ", width: nil, height: nil)
        XCTAssertEqual(ChatImageFile(ref: named, mimeType: "image/png", data: Data([1])).fileName, "shot.png")
        let blankName = ContentRef(type: "content_ref", id: "r3", mimeType: "image/png", size: 3, caption: "Chart", name: "  ", width: nil, height: nil)
        XCTAssertEqual(ChatImageFile(ref: blankName, mimeType: "", data: Data([1])).fileName, "Chart.png", "the ref's type when the store has none")
    }

    func testInlineImageKeepsItsOriginalBytes() throws {
        let gif = try ChatGIFFixture.gif(frames: 3)
        let attachment = ImageAttachment(type: "image", mimeType: "image/gif", data: gif.base64EncodedString())
        let decoded = ChatInlineImage.decode([attachment])
        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded.first?.file.data, gif)
        XCTAssertEqual(decoded.first?.file.fileName, "kraki-image.gif")
        XCTAssertTrue(decoded.first === ChatInlineImage.decode([attachment]).first, "decoded once")
        XCTAssertTrue(ChatInlineImage.decode([ImageAttachment(type: "image", mimeType: "image/png", data: "not base64")]).isEmpty)
    }

    /// The protocol's inline image has an optional name and caption, which
    /// the Web client already saves under: same rule here.
    func testInlineImageIsNamedAfterItsNameElseCaption() throws {
        let gif = try ChatGIFFixture.gif(frames: 2, width: 12).base64EncodedString()
        let png = try ChatGIFFixture.png(width: 12).base64EncodedString()
        let message = ChatMessage(
            type: "user_message", seq: 1, sessionId: "s", deviceId: "d", timestamp: "2026-09-01T00:00:00.000Z",
            payload: ["attachments": AnyCodable([
                ["type": "image", "mimeType": "image/gif", "data": gif, "name": "party.png", "caption": "Party"],
                ["type": "image", "mimeType": "image/png", "data": png, "name": "  ", "caption": "Chart"],
            ])])
        let attachments = try XCTUnwrap(message.attachments)
        XCTAssertEqual(attachments.compactMap { ChatImageFile(inline: $0, id: "x")?.fileName }, ["party.gif", "Chart.png"])
        XCTAssertEqual(ChatInlineImage.decode(attachments).map(\.file.fileName), ["party.gif", "Chart.png"])
        // The same bytes again under another name (decoded once, named anew).
        let renamed = ImageAttachment(type: "image", mimeType: "image/gif", data: gif, name: "again.gif")
        XCTAssertEqual(ChatInlineImage.decode([renamed]).first?.file.fileName, "again.gif")
    }

    /// Share copies go when the share ends, and stale ones at launch; files
    /// outside the share folder are never touched.
    func testTemporaryCopiesAreRemoved() throws {
        let gif = try ChatGIFFixture.gif(frames: 2)
        let first = try file("one", "image/gif", data: gif).writeTemporaryCopy()
        let second = try file("two", "image/gif", data: gif).writeTemporaryCopy()
        ChatImageFile.removeTemporaryCopy(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.deletingLastPathComponent().path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path), "only the shared copy goes")

        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-not-a-share-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        let keep = outside.appendingPathComponent("keep.gif")
        try gif.write(to: keep)
        ChatImageFile.removeTemporaryCopy(keep)
        XCTAssertTrue(FileManager.default.fileExists(atPath: keep.path), "not a share copy: left alone")

        ChatImageFile.removeTemporaryCopies()
        XCTAssertFalse(FileManager.default.fileExists(atPath: ChatImageFile.temporaryCopiesFolder.path))
    }

    func testTemporaryCopyForTheShareSheetIsTheOriginalFile() throws {
        let gif = try ChatGIFFixture.gif(frames: 2)
        let url = try file("party", "image/gif", data: gif).writeTemporaryCopy()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(url.lastPathComponent, "party.gif")
        XCTAssertEqual(try Data(contentsOf: url), gif)
    }
}
