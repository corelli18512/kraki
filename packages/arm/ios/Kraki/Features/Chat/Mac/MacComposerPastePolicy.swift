#if os(macOS)
import AppKit
import UniformTypeIdentifiers

/// Whether ⌘V in the Mac composer attaches an image or pastes into the text.
///
/// The rule, in order:
/// 1. File URLs decide alone: a copied image file is attached; any other file
///    pastes as usual (Finder's file-name text, never the file's icon). If no
///    image file can be read, the clipboard's own image data is attached.
/// 2. Text wins over an image: spreadsheet, Office and Keynote copies carry
///    the text and a picture of it. The plain string decides; RTF counts only
///    without one. Attachment placeholders (U+FFFC, a rich-text editor's
///    image-only copy) are not text. A string that is only one web address
///    (http, https or data, no whitespace) is the image's own source from a
///    browser's Copy Image, so the image is attached. HTML alone is not text
///    (browser image copies carry `<img>`).
/// 3. Otherwise image data (PNG, TIFF, JPEG, PDF…) is attached.
enum MacComposerPastePolicy {
    static func attachesImage(_ pasteboard: NSPasteboard) -> Bool {
        let files = fileURLs(pasteboard)
        if !files.isEmpty { return files.contains(where: isImageFile) }
        if hasText(pasteboard) { return false }
        return imageDataType(pasteboard) != nil
    }

    /// The image ⌘V attaches, or nil when the text view should paste.
    static func image(from pasteboard: NSPasteboard) -> NSImage? {
        guard attachesImage(pasteboard) else { return nil }
        let files = fileURLs(pasteboard)
        if let image = files.lazy.filter(isImageFile).compactMap({ NSImage(contentsOf: $0) }).first {
            return image
        }
        // Only reached for image files that cannot be read (attachesImage is
        // false for other files, so Finder's icon of a document never comes here).
        guard let type = imageDataType(pasteboard), let data = pasteboard.data(forType: type) else { return nil }
        return NSImage(data: data)
    }

    private static func fileURLs(_ pasteboard: NSPasteboard) -> [URL] {
        let urls = pasteboard.readObjects(forClasses: [NSURL.self],
                                          options: [.urlReadingFileURLsOnly: true]) as? [URL]
        return (urls ?? []).filter(\.isFileURL)
    }

    private static func isImageFile(_ url: URL) -> Bool {
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            ?? UTType(filenameExtension: url.pathExtension)
        return type?.conforms(to: .image) == true
    }

    private static func hasText(_ pasteboard: NSPasteboard) -> Bool {
        guard let raw = pasteboard.string(forType: .string) else {
            return pasteboard.availableType(from: [.rtf]) != nil
        }
        let string = raw.replacingOccurrences(of: "\u{FFFC}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return !string.isEmpty && !isSingleWebAddress(string)
    }

    private static func isSingleWebAddress(_ string: String) -> Bool {
        guard string.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let scheme = URL(string: string)?.scheme?.lowercased() else { return false }
        return ["http", "https", "data"].contains(scheme)
    }

    /// PNG first, then TIFF, then any other format NSImage reads.
    private static func imageDataType(_ pasteboard: NSPasteboard) -> NSPasteboard.PasteboardType? {
        let preferred: [NSPasteboard.PasteboardType] = [NSPasteboard.PasteboardType(UTType.png.identifier), .tiff]
        let others = NSImage.imageTypes
            .map { NSPasteboard.PasteboardType($0) }
            .filter { !preferred.contains($0) }
        return pasteboard.availableType(from: preferred + others)
    }
}
#endif
