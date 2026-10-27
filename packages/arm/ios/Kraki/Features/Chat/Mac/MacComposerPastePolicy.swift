#if os(macOS)
import AppKit
import UniformTypeIdentifiers

/// Whether ⌘V in the Mac composer attaches an image or pastes into the text.
///
/// The rule, in order:
/// 1. File URLs decide alone: a copied image file is attached; any other file
///    pastes as usual (Finder's file-name text, never the file's icon).
/// 2. Text wins over an image: spreadsheet, Office and Keynote copies carry
///    the text and a picture of it. Text is a plain string or RTF. A string
///    that is only one web address (http, https or data, no whitespace) is
///    the image's own source from a browser's Copy Image, so the image is
///    attached. HTML alone is not text (browser image copies carry `<img>`).
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
        if !files.isEmpty {
            return files.lazy.filter(isImageFile).compactMap { NSImage(contentsOf: $0) }.first
        }
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
        if pasteboard.availableType(from: [.rtf]) != nil { return true }
        guard let string = pasteboard.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !string.isEmpty else { return false }
        return !isSingleWebAddress(string)
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
