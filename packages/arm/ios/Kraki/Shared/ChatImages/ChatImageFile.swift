/// The original bytes of a chat image, for Save to Photos, Share, Save Image…
/// and Copy Image on iOS and Mac.

import Foundation
import UniformTypeIdentifiers

/// A chat image exactly as it arrived (a user's attachment or an image an
/// agent showed). Saving, sharing and copying hand these bytes on as they
/// are, never re-encoded, so an animated GIF stays an animated GIF.
struct ChatImageFile {
    /// Stable while the image is on screen: the attachment id of an agent
    /// image, a generated id for an inline one. Keys its decoded animation.
    let id: String
    let data: Data
    let mimeType: String
    /// The image's file name or caption, when it has one.
    let label: String?

    /// Name used when the image has neither a file name nor a caption.
    static let defaultBaseName = "kraki-image"

    /// Same table as the Web client's `imageExtension` (a JPEG is `.jpg`).
    private static let extensions: [String: String] = [
        "image/gif": "gif",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif",
        "image/avif": "avif",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/svg+xml": "svg",
    ]

    private static let replacedExtension = try? NSRegularExpression(
        pattern: "\\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$",
        options: [.caseInsensitive]
    )

    /// The type of the bytes: the MIME type, or (when it says nothing about
    /// an image) the GIF / PNG / JPEG / WebP signature at the start.
    var normalizedMimeType: String {
        let declared = mimeType.lowercased()
            .split(separator: ";").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        if declared.hasPrefix("image/") { return declared }
        return Self.sniffedMimeType(data) ?? declared
    }

    var isGIF: Bool { normalizedMimeType == "image/gif" }

    var contentType: UTType {
        UTType(mimeType: normalizedMimeType) ?? .image
    }

    var fileExtension: String {
        let type = normalizedMimeType
        if let known = Self.extensions[type] { return known }
        return UTType(mimeType: type)?.preferredFilenameExtension ?? "bin"
    }

    /// The name to save under: the file name or caption (composed, path and
    /// other reserved characters replaced, its old image extension dropped,
    /// at most 80 characters), then the extension of the real type. Same
    /// rule as the Web client's `imageFileName`.
    var fileName: String {
        var base = (label ?? "").precomposedStringWithCanonicalMapping
        base = String(base.unicodeScalars.map { scalar -> Character in
            let reserved = scalar.value < 0x20 || scalar.value == 0x7F || "<>:\"/\\|?*".unicodeScalars.contains(scalar)
            return reserved ? "_" : Character(scalar)
        })
        if let pattern = Self.replacedExtension {
            base = pattern.stringByReplacingMatches(
                in: base, range: NSRange(base.startIndex..., in: base), withTemplate: "")
        }
        base = String(base.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        base = base.trimmingCharacters(in: CharacterSet(charactersIn: ".").union(.whitespacesAndNewlines))
        return "\(base.isEmpty ? Self.defaultBaseName : base).\(fileExtension)"
    }

    /// GIF, PNG, JPEG or WebP from the first bytes, else nil.
    static func sniffedMimeType(_ data: Data) -> String? {
        let head = [UInt8](data.prefix(12))
        if head.count >= 6, head.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if head.count >= 12, head.starts(with: Array("RIFF".utf8)), Array(head[8..<12]) == Array("WEBP".utf8) {
            return "image/webp"
        }
        return nil
    }

    /// Writes the bytes to `<tmp>/kraki-images/<uuid>/<fileName>` for the
    /// share sheet, which then offers the file with its real name and type.
    func writeTemporaryCopy() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-images", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(fileName)
        try data.write(to: url, options: .atomic)
        return url
    }
}

extension ChatImageFile {
    /// The original bytes of an inline (base64) image attachment.
    init?(inline attachment: ImageAttachment, id: String) {
        guard let data = Data(base64Encoded: attachment.data) else { return nil }
        self.init(id: id, data: data, mimeType: attachment.mimeType, label: nil)
    }

    /// An agent image whose bytes have arrived. The label is the name, else
    /// the caption (the Web client's rule).
    init(ref: ContentRef, mimeType: String, data: Data) {
        let label = [ref.name, ref.caption]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        self.init(id: ref.id, data: data, mimeType: mimeType.isEmpty ? ref.mimeType : mimeType, label: label)
    }

    /// The bytes of an agent image from the attachment store, once ready.
    static func ref(_ ref: ContentRef, in store: AttachmentStore?) -> ChatImageFile? {
        guard case .ready(let mimeType, let data) = store?.state(for: ref.id) else { return nil }
        return ChatImageFile(ref: ref, mimeType: mimeType, data: data)
    }
}
