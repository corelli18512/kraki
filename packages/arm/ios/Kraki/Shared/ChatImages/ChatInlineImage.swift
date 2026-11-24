/// Inline (base64) chat images decoded once, with their original bytes.

import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A user's inline image attachment: its bounded decode for display and its
/// original bytes for Save / Share / Copy and GIF animation. Cached by the
/// base64 text, so a message rebuilt for another layout pass reuses both.
final class ChatInlineImage {
    let image: PlatformImage
    let file: ChatImageFile

    init(image: PlatformImage, file: ChatImageFile) {
        self.image = image
        self.file = file
    }

    private static let cache: NSCache<NSString, ChatInlineImage> = {
        let cache = NSCache<NSString, ChatInlineImage>()
        cache.countLimit = 200
        return cache
    }()

    /// The decodable image attachments, in order.
    static func decode(_ attachments: [ImageAttachment]?) -> [ChatInlineImage] {
        guard let attachments else { return [] }
        return attachments.compactMap { attachment in
            guard attachment.type == "image" else { return nil }
            let key = attachment.data as NSString
            if let cached = cache.object(forKey: key) { return cached }
            guard let file = ChatImageFile(inline: attachment, id: "inline-\(UUID().uuidString)"),
                  let image = AttachmentImageCache.decode(file.data) else { return nil }
            let decoded = ChatInlineImage(image: image, file: file)
            cache.setObject(decoded, forKey: key)
            return decoded
        }
    }
}
