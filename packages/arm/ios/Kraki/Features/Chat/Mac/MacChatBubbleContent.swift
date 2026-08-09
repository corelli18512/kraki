#if os(macOS)
import AppKit
import SwiftUI

/// Data rendered by one Mac TextKit bubble. Geometry and palette intentionally
/// mirror iOS `TKBubbleContent` rather than introducing Mac-only styling.
struct MacChatBubbleContent {
    let seq: Int
    let sessionId: String
    let kind: MacBubbleKind
    let body: NSAttributedString?
    let inlineImages: [NSImage]
    let imageRefs: [ContentRef]
    let htmlArtifacts: [ContentRef]
    let action: ChatMessage?
    let isLive: Bool
    let canShowSteps: Bool
    let bubbleColor: NSColor
    /// (topLeading, topTrailing, bottomLeading, bottomTrailing)
    let cornerRadii: (CGFloat, CGFloat, CGFloat, CGFloat)
    /// Width of the colored text/action bubble. Text-only agent messages hug
    /// their natural CoreText width and clamp here at the conversation maximum.
    let bubbleWidth: CGFloat
    /// Attachments are siblings of the colored bubble and keep independent,
    /// stable geometry when a short text bubble hugs its content.
    let attachmentWidth: CGFloat

    var bodyTextWidth: CGFloat { bubbleWidth - MacChatBubbleLayout.msgPadH * 2 }
}

enum MacChatBubbleLayout {
    static let outerH: CGFloat = 12
    static let outerV: CGFloat = 6
    static let trailingGapFraction: CGFloat = 0.05
    static let userLeadingGapFraction: CGFloat = 0.18
    static let msgPadH: CGFloat = 14
    static let msgPadV: CGFloat = 10
    static let imageSpacing: CGFloat = 6
    static let attachmentSpacing: CGFloat = 12
    static let imageMaxHeight: CGFloat = 240
    static let imageCorner: CGFloat = 12
}

enum MacChatBubbleContentBuilder {
    static func make(
        message: ChatMessage,
        sessionId: String,
        agent: String,
        documentWidth: CGFloat
    ) -> MacChatBubbleContent {
        let isUser = ["user_message", "send_input", "pending_input"].contains(message.type)
        let kind: MacBubbleKind
        switch message.type {
        case "error": kind = .error
        case "system_message": kind = .system
        default: kind = isUser ? .user : .agent
        }

        let rawBody = message.content.flatMap { text -> NSAttributedString? in
            guard !text.isEmpty, text != "[image]" else { return nil }
            return MacMarkdown.attributed(text, cacheKey: "\(message.id):body:\(text.count)")
        }
        let body: NSAttributedString?
        switch kind {
        case .user:
            body = rawBody.map { recolored($0, color: .white) }
        case .error:
            body = recolored(rawBody ?? NSAttributedString(string: message.result ?? "Error"), color: .systemRed)
        case .agent, .system:
            body = rawBody
        }
        let images = decodeImages(message.attachments)
        let contentRefs = uniqueRefs(message.contentRefAttachments)
        let imageRefs = contentRefs.filter { $0.mimeType.hasPrefix("image/") }
        let htmlArtifacts = contentRefs.filter { $0.mimeType == "text/html" }
        let attachmentWidth = maximumBubbleWidth(kind: kind, documentWidth: documentWidth)
        let width = bubbleWidth(
            kind: kind,
            body: body,
            hasArtifacts: !htmlArtifacts.isEmpty,
            action: nil,
            documentWidth: documentWidth
        )
        return MacChatBubbleContent(
            seq: message.seq,
            sessionId: sessionId,
            kind: kind,
            body: body,
            inlineImages: images,
            imageRefs: imageRefs,
            htmlArtifacts: htmlArtifacts,
            action: nil,
            isLive: false,
            canShowSteps: (kind == .agent || kind == .system) && (message.steps ?? 0) > 0,
            bubbleColor: palette(for: kind, hueSeed: sessionId.isEmpty ? agent : sessionId),
            cornerRadii: cornerRadii(for: kind),
            bubbleWidth: width,
            attachmentWidth: attachmentWidth
        )
    }

    /// Streaming and frozen terminal turns use the same bubble path as iOS.
    static func live(
        card: MessageStore.SessionCard,
        sessionId: String,
        agent: String,
        documentWidth: CGFloat,
        traceSeq: Int,
        steps: Int,
        frozen: Bool = false,
        attachments: [ContentRef] = []
    ) -> MacChatBubbleContent {
        let body = card.text.isEmpty ? nil
            : MacMarkdown.attributed(
                card.text,
                cacheKey: "\(sessionId):live:\(card.text.count)",
                // A live revision is replaced again within milliseconds. Never
                // spend Highlightr/HTML-conversion work on an artifact that
                // cannot be final; the persisted terminal bubble gets syntax
                // highlighting through `make(message:)` after streaming ends.
                allowSyntaxHighlighting: frozen
            )
        let attachments = uniqueRefs(attachments)
        let imageRefs = attachments.filter { $0.mimeType.hasPrefix("image/") }
        let htmlArtifacts = attachments.filter { $0.mimeType == "text/html" }
        let attachmentWidth = maximumBubbleWidth(kind: .agent, documentWidth: documentWidth)
        let width = bubbleWidth(
            kind: .agent,
            body: body,
            hasArtifacts: !htmlArtifacts.isEmpty,
            action: card.action,
            documentWidth: documentWidth
        )
        return MacChatBubbleContent(
            seq: traceSeq,
            sessionId: sessionId,
            kind: .agent,
            body: body,
            inlineImages: [],
            imageRefs: imageRefs,
            htmlArtifacts: htmlArtifacts,
            action: card.action,
            isLive: !frozen,
            canShowSteps: steps > 0,
            bubbleColor: palette(for: .agent, hueSeed: sessionId.isEmpty ? agent : sessionId),
            cornerRadii: cornerRadii(for: .agent),
            bubbleWidth: width,
            attachmentWidth: attachmentWidth
        )
    }

    private static func bubbleWidth(
        kind: MacBubbleKind,
        body: NSAttributedString?,
        hasArtifacts: Bool,
        action: ChatMessage?,
        documentWidth: CGFloat
    ) -> CGFloat {
        let maximum = maximumBubbleWidth(kind: kind, documentWidth: documentWidth)
        switch kind {
        case .agent, .user:
            // Match Web's max-width flex item: body and action content both
            // contribute a natural width, then clamp at the conversation max.
            // HTML report cards intentionally retain the roomy maximum.
            guard !hasArtifacts else { return maximum }
            let bodyNatural = body.map(MacTextMeasure.naturalWidth) ?? 0
            let natural = max(bodyNatural, naturalActionWidth(action))
            let fitted = ceil(natural) + MacChatBubbleLayout.msgPadH * 2
            return min(maximum, max(fitted, MacChatBubbleLayout.msgPadH * 2 + 1))
        case .error, .system:
            return maximum
        }
    }

    private static func naturalActionWidth(_ action: ChatMessage?) -> CGFloat {
        guard let action else { return 0 }
        func textWidth(_ text: String, font: NSFont) -> CGFloat {
            guard !text.isEmpty else { return 0 }
            return ceil((text as NSString).size(withAttributes: [.font: font]).width)
        }
        switch action.type {
        case "tool_batch":
            let running = action.payload["running"]?.intValue ?? 0
            let label = running == 1
                ? "1 tool running in parallel…"
                : "\(running) tools running in parallel…"
            return textWidth(label, font: .systemFont(ofSize: 13)) + 24
        case "tool_start", "tool_complete":
            let label = [action.toolName, action.headline]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: "  ")
            return textWidth(label, font: .monospacedSystemFont(ofSize: 12, weight: .regular)) + 30
        case "permission":
            let description = action.toolDescription ?? "Run \(action.toolName ?? "tool")"
            let descriptionWidth = textWidth(description, font: .systemFont(ofSize: 14)) + 24
            let argsWidth = action.args?.values.compactMap(\.stringValue).map {
                textWidth($0, font: .monospacedSystemFont(ofSize: 11, weight: .regular))
            }.max() ?? 0
            // Three equal Web-aligned buttons, including “Switch to Execute”.
            return max(380, max(descriptionWidth, argsWidth))
        case "question":
            let questionWidth = textWidth(action.question ?? "", font: .systemFont(ofSize: 14)) + 24
            let choicesWidth = action.choices?.map {
                textWidth($0, font: .systemFont(ofSize: 13)) + 24
            }.max() ?? 0
            return max(280, max(questionWidth, choicesWidth))
        case "failed", "user_abort":
            let label = action.type == "failed" ? "Turn failed" : "User aborted"
            let detail = action.payload["message"]?.stringValue ?? ""
            return textWidth("\(label)  \(detail)", font: .systemFont(ofSize: 13)) + 24
        default:
            return 0
        }
    }

    private static func maximumBubbleWidth(
        kind: MacBubbleKind,
        documentWidth: CGFloat
    ) -> CGFloat {
        let usable = documentWidth - MacChatBubbleLayout.outerH * 2
        switch kind {
        case .agent:
            return usable - documentWidth * MacChatBubbleLayout.trailingGapFraction
        case .user:
            return usable - documentWidth * MacChatBubbleLayout.userLeadingGapFraction
        case .error, .system:
            return usable - documentWidth * 0.10
        }
    }

    private static func uniqueRefs(_ refs: [ContentRef]) -> [ContentRef] {
        var seen: Set<String> = []
        return refs.filter { seen.insert($0.id).inserted }
    }

    private static func cornerRadii(for kind: MacBubbleKind) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
        switch kind {
        case .agent: return (4, 16, 16, 16)
        case .user: return (16, 4, 16, 16)
        case .error, .system: return (12, 12, 12, 12)
        }
    }

    private static func palette(for kind: MacBubbleKind, hueSeed: String) -> NSColor {
        switch kind {
        case .agent:
            let hue = stringToHue(hueSeed) / 360
            return NSColor(name: nil) { appearance in
                let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                let hsl = hslToHSB(h: hue, s: dark ? 0.35 : 0.40, l: dark ? 0.18 : 0.93)
                return NSColor(calibratedHue: hsl.0, saturation: hsl.1, brightness: hsl.2, alpha: 1)
            }
        case .user:
            return NSColor(Color.krakiPrimary)
        case .error:
            return NSColor(name: nil) { appearance in
                let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                return NSColor.systemRed.withAlphaComponent(dark ? 0.20 : 0.12)
            }
        case .system:
            return NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? NSColor.tertiarySystemFill
                    : NSColor.controlBackgroundColor
            }
        }
    }

    private static func recolored(_ attributed: NSAttributedString, color: NSColor) -> NSAttributedString {
        let copy = NSMutableAttributedString(attributedString: attributed)
        let range = NSRange(location: 0, length: copy.length)
        copy.enumerateAttribute(.tkBlockKind, in: range) { value, subrange, _ in
            if value as? String != TKBlockKind.code.rawValue {
                copy.addAttribute(.foregroundColor, value: color, range: subrange)
            }
        }
        return copy
    }

    private static let imageCache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 200
        return cache
    }()

    private static func decodeImages(_ attachments: [ImageAttachment]?) -> [NSImage] {
        guard let attachments else { return [] }
        return attachments.compactMap { attachment in
            guard attachment.type == "image" else { return nil }
            let key = attachment.data as NSString
            if let cached = imageCache.object(forKey: key) { return cached }
            guard let data = Data(base64Encoded: attachment.data), let image = NSImage(data: data) else { return nil }
            imageCache.setObject(image, forKey: key)
            return image
        }
    }
}
#endif
