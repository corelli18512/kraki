/// What an iOS bubble shows and how big it is: content building and height measurement.

import UIKit
import SwiftUI

enum TKMeasure {
    static func naturalWidth(_ attr: NSAttributedString) -> CGFloat {
        guard attr.length > 0 else { return 0 }
        let rect = attr.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude,
                         height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        return ceil(rect.width)
    }

    /// Lay out `attr` in a TextKit2 stack at `width` and return the used
    /// height. Matches a `UITextView(usingTextLayoutManager: true)` with
    /// `textContainerInset = .zero` and `lineFragmentPadding = 0`.
    static func height(_ attr: NSAttributedString, width: CGFloat) -> CGFloat {
        guard width > 0, attr.length > 0 else { return 0 }
        let content = NSTextContentStorage()
        content.attributedString = attr
        let layout = NSTextLayoutManager()
        let container = NSTextContainer(size: CGSize(width: width,
                                                     height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.textContainer = container
        content.addTextLayoutManager(layout)
        layout.ensureLayout(for: layout.documentRange)
        var maxY: CGFloat = 0
        layout.enumerateTextLayoutFragments(from: nil, options: [.ensuresLayout]) { frag in
            maxY = max(maxY, frag.layoutFragmentFrame.maxY)
            return true
        }
        return ceil(maxY)
    }
}

// MARK: - Flat bubble content model

/// Immutable TextKit description of one persisted spine message. Tool and
/// narration history intentionally do not live here; they are fetched through
/// the TRACE axis and shown by the Steps sheet.
final class TKBubbleContent {
    enum Kind: Equatable { case agent, user, error, system }

    let message: ChatMessage
    let kind: Kind
    let hueSeed: String
    let body: NSAttributedString?
    let images: [UIImage]
    /// Lazy image references (tool-produced images via `kraki-show_image`).
    /// Surfaced through the `AttachmentStore` chunk pipeline; rendered as a
    /// SwiftUI grid inside the cell. Mirrors web `content_ref` handling.
    let imageRefs: [ContentRef]
    /// Fixed-geometry HTML report metadata cards. The report WebView is owned
    /// by ChatView, never by a reusable bubble cell.
    let htmlArtifacts: [ContentRef]
    /// Optional action slot for a streaming / frozen turn: tool_start /
    /// tool_complete / tool_batch / permission / question / user_abort /
    /// failed. nil on ordinary completed bubbles. Replaces the old
    /// LiveAgentBubbleView action section — same bubble, same path.
    let action: ChatMessage?
    /// Streaming tail card (live draft). Drives the footer rule below.
    let isLive: Bool
    /// Frozen terminal card (turn_status / interrupted_turn). Real timestamp.
    let isFrozen: Bool
    let frozenTimestamp: String?
    /// Incremental streaming body (live, non-frozen cards only) and the
    /// revision this content snapshot represents.
    let liveBody: TKLiveBody?
    let liveRevision: Int

    private var heightCache: [CGFloat: CGFloat] = [:]
    private var bubbleWidthCache: [CGFloat: CGFloat] = [:]
    private var bodyTextHeightCache: [CGFloat: CGFloat] = [:]

    init(message: ChatMessage, kind: Kind, hueSeed: String,
         body: NSAttributedString?, images: [UIImage] = [],
         imageRefs: [ContentRef] = [], htmlArtifacts: [ContentRef] = [],
         action: ChatMessage? = nil, isLive: Bool = false,
         isFrozen: Bool = false, frozenTimestamp: String? = nil,
         liveBody: TKLiveBody? = nil) {
        self.message = message
        self.kind = kind
        self.hueSeed = hueSeed
        self.body = body
        self.images = images
        self.imageRefs = imageRefs
        self.htmlArtifacts = htmlArtifacts
        self.action = action
        self.isLive = isLive
        self.isFrozen = isFrozen
        self.frozenTimestamp = frozenTimestamp
        self.liveBody = liveBody
        self.liveRevision = liveBody?.revision ?? 0
    }

    /// Optimistic input delivery state ("sending" | "failed" | "correcting"), nil otherwise.
    var pendingDeliveryState: String? {
        guard message.type == "pending_input" else { return nil }
        return message.payload["localState"]?.stringValue ?? "sending"
    }

    var canShowSteps: Bool {
        (kind == .agent || kind == .system) && (message.steps ?? 0) > 0
    }

    var hasProvisionalCodeHighlight: Bool {
        guard let body else { return false }
        var provisional = false
        body.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: body.length)
        ) { value, _, stop in
            if value != nil {
                provisional = true
                stop.pointee = true
            }
        }
        return provisional
    }

    /// Build a live/frozen bubble content from a streaming `SessionCard` (or a
    /// frozen terminal card rebuilt from a persisted message). Mirrors the old
    /// LiveAgentBubbleView: the draft becomes the body, the card.action becomes
    /// the action slot. The host TKBubbleCell renders both through the same
    /// TextKit path as a completed bubble.
    static func live(card: MessageStore.SessionCard, agent: String, sessionId: String,
                     steps: Int, isFrozen: Bool = false,
                     frozenTimestamp: String? = nil,
                     attachments: [ContentRef] = []) -> TKBubbleContent {
        let draft = card.text
        var payload: [String: AnyCodable] = [:]
        if !draft.isEmpty { payload["content"] = AnyCodable(draft) }
        if steps > 0 { payload["steps"] = AnyCodable(steps) }
        let msg = ChatMessage(type: "agent_message", seq: 0,
                              sessionId: sessionId, deviceId: nil,
                              timestamp: frozenTimestamp, payload: payload)
        let liveBody: TKLiveBody?
        let body: NSAttributedString?
        if isFrozen {
            liveBody = nil
            body = draft.isEmpty ? nil
                : TKMarkdown.attributed(
                    draft,
                    cacheKey: "\(sessionId):live:\(draft.count)",
                    allowHighlighting: true
                )
        } else {
            // Streaming: incremental parse/measure keyed to the Session so each
            // chunk costs O(changed tail), not O(whole answer).
            let incremental = TKLiveBody.forSession(sessionId)
            incremental.update(draft)
            liveBody = incremental
            body = incremental.body
        }
        return TKBubbleContent(message: msg, kind: .agent, hueSeed: sessionId,
                               body: body, images: [],
                               imageRefs: uniqueRefs(attachments).filter { $0.mimeType.hasPrefix("image/") },
                               htmlArtifacts: uniqueRefs(attachments).filter { $0.mimeType == "text/html" },
                               action: card.action,
                               isLive: !isFrozen, isFrozen: isFrozen,
                               frozenTimestamp: frozenTimestamp,
                               liveBody: liveBody)
    }

    func bubbleWidth(cellWidth: CGFloat) -> CGFloat {
        if let cached = bubbleWidthCache[cellWidth] { return cached }
        let maximum = maximumBubbleWidth(cellWidth: cellWidth)
        let width: CGFloat
        switch kind {
        case .agent, .user:
            // Match Web's max-width flex bubble: short body/action content hugs
            // its natural width while long content wraps at the established
            // maximum. Attachments remain an independent sibling. Natural width
            // is expensive CoreText work, so cache it for every immutable content
            // object instead of repeating it from each layoutSubviews pass.
            if htmlArtifacts.isEmpty {
                // Once a body is this long it will fill the bubble in ordinary
                // prose/code/table history. Avoid shaping the entire attributed
                // string at infinite width just to rediscover that it exceeds
                // the cap; short messages still keep the exact hug-content look.
                let bodyNatural: CGFloat
                if let body, body.length > 160 {
                    bodyNatural = maximum
                } else {
                    bodyNatural = body.map(TKMeasure.naturalWidth) ?? 0
                }
                let natural = max(bodyNatural, naturalActionWidth())
                let fitted = ceil(natural) + TKMetrics.msgPadH * 2
                width = min(maximum, max(fitted, TKMetrics.msgPadH * 2 + 1))
            } else {
                width = maximum
            }
        case .error, .system:
            width = maximum
        }
        bubbleWidthCache[cellWidth] = width
        return width
    }

    func attachmentWidth(cellWidth: CGFloat) -> CGFloat {
        maximumBubbleWidth(cellWidth: cellWidth)
    }

    private func naturalActionWidth() -> CGFloat {
        guard let action else { return 0 }
        func textWidth(_ text: String, font: UIFont) -> CGFloat {
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
            let descriptionWidth = textWidth(PermissionPromptCopy.title(action),
                                             font: .systemFont(ofSize: 15, weight: .semibold)) + 24
            let argsWidth = action.args?.values.compactMap(\.stringValue).map {
                textWidth($0, font: .monospacedSystemFont(ofSize: 11, weight: .regular))
            }.max() ?? 0
            return max(380, max(descriptionWidth, argsWidth))
        case "question":
            // An open question's choices; the question itself is body text,
            // so the bubble is as wide open as once answered unless a choice
            // is wider.
            return BubbleActionMetrics.choicesWidth(action.choices ?? [])
        case "failed", "user_abort":
            return BubbleActionMetrics.outcomeWidth(failed: action.type == "failed",
                                                    detail: action.payload["message"]?.stringValue)
        default:
            return 0
        }
    }

    private func maximumBubbleWidth(cellWidth: CGFloat) -> CGFloat {
        let usable = cellWidth - TKMetrics.outerH * 2
        switch kind {
        case .agent:
            return usable - cellWidth * TKMetrics.trailingGapFraction
        case .user:
            return usable - cellWidth * TKMetrics.userLeadingGapFraction
        case .error, .system:
            return usable - cellWidth * 0.10
        }
    }

    func bodyTextWidth(cellWidth: CGFloat) -> CGFloat {
        bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
    }

    private var bodyChunkCache: [CGFloat: [TKBodyChunks.Placed]] = [:]

    /// Paragraph-aligned body chunks with exact per-chunk geometry. Short
    /// bodies are a single chunk (identical to one text view).
    func bodyChunks(cellWidth: CGFloat) -> [TKBodyChunks.Placed] {
        guard let body, body.length > 0 else { return [] }
        let width = bodyTextWidth(cellWidth: cellWidth)
        if let cached = bodyChunkCache[width] { return cached }
        let placed: [TKBodyChunks.Placed]
        if let liveBody, liveBody.revision == liveRevision {
            placed = liveBody.chunkLayout(width: width)
        } else {
            placed = TKBodyChunks.layout(body, width: width)
        }
        bodyChunkCache[width] = placed
        return placed
    }

    func bodyTextHeight(cellWidth: CGFloat) -> CGFloat {
        guard let body, body.length > 0 else { return 0 }
        let width = bodyTextWidth(cellWidth: cellWidth)
        if let cached = bodyTextHeightCache[width] { return cached }
        let chunks = bodyChunks(cellWidth: cellWidth)
        let height = chunks.last.map { ceil($0.y + $0.height) } ?? 0
        bodyTextHeightCache[width] = height
        return height
    }

    func imageDisplaySize(_ image: UIImage, maxWidth: CGFloat) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return .zero }
        var width = min(size.width, maxWidth)
        var height = width * size.height / size.width
        if height > TKMetrics.imageMaxHeight {
            height = TKMetrics.imageMaxHeight
            width = height * size.width / size.height
        }
        return CGSize(width: width, height: height)
    }

    var hasBubbleContent: Bool {
        (body?.length ?? 0) > 0 || !htmlArtifacts.isEmpty || action != nil
    }

    func imagesHeight(cellWidth: CGFloat) -> CGFloat {
        IOSImageGalleryLayout.height(
            images: images,
            refs: imageRefs,
            maxWidth: attachmentWidth(cellWidth: cellWidth)
        )
    }

    var footerDate: Date? { nil }

    func cellHeight(cellWidth: CGFloat) -> CGFloat {
        if let cached = heightCache[cellWidth] { return cached }
        var bubbleInnerHeight = bodyTextHeight(cellWidth: cellWidth)
        let artifactHeight = TKHTMLArtifactCardsView.height(for: htmlArtifacts.count)
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += TKMetrics.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        // Action slot (streaming / frozen): measured synchronously via the same
        // SwiftUI host the cell uses, so cellHeight matches what configure lays
        // out. The list re-measures on action transitions via onActionHeightChange.
        if let action {
            let actionWidth = bubbleWidth(cellWidth: cellWidth) - TKMetrics.msgPadH * 2
            let actionHeight = TKActionMeasure.height(action: action, width: actionWidth)
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += actionHeight
        }
        let bubbleCellHeight = hasBubbleContent
            ? max(bubbleInnerHeight + TKMetrics.msgPadV * 2, 1) + TKMetrics.outerV * 2
            : 0
        let imageHeight = imagesHeight(cellWidth: cellWidth)
        let height: CGFloat
        if imageHeight > 0 {
            height = hasBubbleContent
                ? bubbleCellHeight + TKMetrics.attachmentSpacing + imageHeight
                : imageHeight + IOSImageGalleryLayout.outerVerticalPadding
        } else {
            height = max(bubbleCellHeight, 1)
        }
        heightCache[cellWidth] = height
        return height
    }

    /// A steps-only turn (system_message kind `no_reply`, no text or media):
    /// rendered as just its Steps affordance — no bubble, no invented text.
    var isStepsOnly: Bool {
        kind == .system && message.systemKind == "no_reply"
            && body == nil && images.isEmpty && imageRefs.isEmpty && htmlArtifacts.isEmpty
    }

    func bubbleColor(dark: Bool) -> UIColor {
        if isStepsOnly { return .clear }
        let hue = stringToHue(hueSeed) / 360
        switch kind {
        case .agent:
            let (h, s, b) = hslToHSB(h: hue, s: dark ? 0.35 : 0.40, l: dark ? 0.18 : 0.93)
            return UIColor(hue: h, saturation: s, brightness: b, alpha: 1)
        case .user:
            return UIColor(Color.krakiPrimary)
        case .error:
            return UIColor.systemRed.withAlphaComponent(dark ? 0.20 : 0.12)
        case .system:
            return dark ? UIColor.tertiarySystemFill : UIColor.secondarySystemBackground
        }
    }

    private static let cache: NSCache<NSString, TKBubbleContent> = {
        let cache = NSCache<NSString, TKBubbleContent>()
        cache.countLimit = 600
        return cache
    }()
    nonisolated(unsafe) private static var cacheKeysByMessageID: [String: NSString] = [:]

    static func make(message: ChatMessage, sessionId: String, agent: String) -> TKBubbleContent {
        let key = visualCacheKey(message)
        if let previous = cacheKeysByMessageID[message.id], previous != key {
            cache.removeObject(forKey: previous)
        }
        cacheKeysByMessageID[message.id] = key
        if let cached = cache.object(forKey: key) { return cached }
        let built = build(message: message, sessionId: sessionId, agent: agent)
        if !built.hasProvisionalCodeHighlight {
            cache.setObject(built, forKey: key)
        }
        return built
    }

    static func bust(_ id: String) {
        guard let key = cacheKeysByMessageID.removeValue(forKey: id) else { return }
        cache.removeObject(forKey: key)
    }

    private static func visualCacheKey(_ message: ChatMessage) -> NSString {
        var hasher = Hasher()
        hasher.combine(message.id)
        let text = message.content ?? message.result ?? ""
        hasher.combine(text.utf8.count)
        hasher.combine(Data(text.utf8.suffix(512)))
        hasher.combine(message.attachments?.count ?? 0)
        hasher.combine(message.steps ?? 0)
        hasher.combine(message.payload["localState"]?.stringValue ?? "")
        hasher.combine(message.payload["uncorrected"]?.description ?? "")
        for ref in message.contentRefAttachments {
            hasher.combine(ref.id)
            hasher.combine(ref.mimeType)
            hasher.combine(ref.size)
            hasher.combine(ref.width ?? 0)
            hasher.combine(ref.height ?? 0)
        }
        return "\(message.id)\u{1F}\(hasher.finalize())" as NSString
    }

    private static func build(message: ChatMessage, sessionId: String, agent: String) -> TKBubbleContent {
        let isUser = ["user_message", "send_input", "pending_input"].contains(message.type)
        let kind: Kind
        switch message.type {
        case "error": kind = .error
        case "system_message": kind = .system
        default: kind = isUser ? .user : .agent
        }
        // `interrupted_turn` / `turn_status` are excluded from the bubble list
        // in ChatViewModel — they render via the frozen LiveAgentBubble path.
        let source = message.imageUnavailable ? ChatMessage.imageUnavailableText : message.content
        let rawBody = source.flatMap { text -> NSAttributedString? in
            guard !text.isEmpty, text != "[image]" else { return nil }
            return TKMarkdown.attributed(text, cacheKey: "\(message.id):body:\(text.count)")
        }
        // One bubble implementation: every renderable message uses the same
        // path — agent/user/system/error recolor of its body text.
        let body: NSAttributedString?
        switch kind {
        case .user:
            body = rawBody.map { rendered in
                let solid = TKMarkdown.recolored(rendered, color: .white)
                return Self.lighteningUncorrected(solid, message: message) ?? solid
            }
        case .error:
            body = TKMarkdown.recolored(
                rawBody ?? NSAttributedString(string: message.result ?? "Error"),
                color: .systemRed)
        case .system, .agent:
            body = rawBody
        }
        let refs = uniqueRefs(message.contentRefAttachments)
        return TKBubbleContent(
            message: message, kind: kind, hueSeed: sessionId.isEmpty ? agent : sessionId,
            body: body, images: decodeImages(message.attachments),
            imageRefs: refs.filter { $0.mimeType.hasPrefix("image/") },
            htmlArtifacts: refs.filter { $0.mimeType == "text/html" })
    }

    /// A voice message being corrected: the part the correction has not
    /// reached yet is light; corrected text is solid (like the old composer).
    private static func lighteningUncorrected(_ body: NSAttributedString, message: ChatMessage) -> NSAttributedString? {
        guard message.payload["localState"]?.stringValue == "correcting",
              let fade = message.payload["uncorrected"]?.arrayValue?.compactMap(\.intValue), fade.count == 2,
              let source = message.content else { return nil }
        let sourceRange = NSRange(location: fade[0], length: fade[1])
        guard NSMaxRange(sourceRange) <= (source as NSString).length else { return nil }
        let faded = (source as NSString).substring(with: sourceRange)
        let rendered = body.string as NSString
        // Plain transcripts render 1:1; otherwise locate the same tail text.
        let target = rendered.length >= NSMaxRange(sourceRange)
            && rendered.substring(with: sourceRange) == faded
            ? sourceRange
            : rendered.range(of: faded, options: .backwards)
        guard target.location != NSNotFound, target.length > 0 else { return nil }
        let result = NSMutableAttributedString(attributedString: body)
        result.addAttribute(.foregroundColor, value: UIColor.white.withAlphaComponent(0.5), range: target)
        return result
    }

    private static func uniqueRefs(_ refs: [ContentRef]) -> [ContentRef] {
        var seen = Set<String>()
        return refs.filter { seen.insert($0.id).inserted }
    }

    private static let imageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    private static func decodeImages(_ attachments: [ImageAttachment]?) -> [UIImage] {
        guard let attachments else { return [] }
        return attachments.compactMap { attachment in
            guard attachment.type == "image" else { return nil }
            let key = attachment.data as NSString
            if let cached = imageCache.object(forKey: key) { return cached }
            guard let data = Data(base64Encoded: attachment.data),
                  let image = AttachmentImageCache.decode(data) else { return nil }
            imageCache.setObject(image, forKey: key)
            return image
        }
    }
}

// MARK: - Rounded bubble background view (per-corner radii)
