import UIKit
import SwiftUI
import Highlightr

// MARK: - Metrics (mirror the SwiftUI bubble so cached heights line up)

enum TKMetrics {
    /// Hosting cell padding around the bubble (UIHostingConfiguration used
    /// `.padding(.horizontal, 12) / .vertical, 6`).
    static let outerH: CGFloat = 12
    static let outerV: CGFloat = 6
    /// Trailing gap so the agent bubble doesn't reach the screen edge
    /// (SwiftUI: `Spacer(minLength: width * 0.05)`).
    static let trailingGapFraction: CGFloat = 0.05
    /// Leading gap for the right-aligned user bubble.
    static let userLeadingGapFraction: CGFloat = 0.18

    /// Message section padding (`.padding(.horizontal, 14) / .vertical, 10`).
    static let msgPadH: CGFloat = 14
    static let msgPadV: CGFloat = 10
    /// Tool / tinted section padding (`.padding(.horizontal, 16) / .vertical, 12`).
    static let sectionPadH: CGFloat = 16
    static let sectionPadV: CGFloat = 12
    /// Vertical gap between items inside a section (`VStack(spacing: 8)`).
    static let itemSpacing: CGFloat = 8
    /// Tool-row icon dimension (`ToolChipHeader.iconSize`).
    static let toolIcon: CGFloat = 16
    /// Image grid: spacing between stacked images + cap on a single image's
    /// rendered height + corner radius (mirrors `imageGrid`).
    static let imageSpacing: CGFloat = 6
    static let attachmentSpacing = IOSImageGalleryLayout.attachmentSpacing
    static let imageMaxHeight: CGFloat = 240
    static let imageCorner: CGFloat = 12
    /// Nested tool-detail box: inner padding, corner radius, and the gap
    /// between the tool chip row and the revealed detail box.
    static let detailPad: CGFloat = 12
    static let detailCorner: CGFloat = 8
    static let detailGap: CGFloat = 6
}

// MARK: - Markdown → NSAttributedString

func tkContentCacheKey(prefix: String, content: String) -> NSString {
    var hasher = Hasher()
    hasher.combine(content)
    return "\(prefix)\u{1F}\(content.utf8.count)\u{1F}\(hasher.finalize())" as NSString
}

extension Notification.Name {
    static let tkCodeHighlightReady = Notification.Name("chat.kraki.tkCodeHighlightReady")
}

extension NSAttributedString.Key {
    static let tkCodeHighlightProvisional = NSAttributedString.Key("chat.kraki.tkCodeHighlightProvisional")
    static let tkBlockKind = NSAttributedString.Key("chat.kraki.tkBlockKind")
    static let tkBlockID = NSAttributedString.Key("chat.kraki.tkBlockID")
    static let tkBlockLabel = NSAttributedString.Key("chat.kraki.tkBlockLabel")
    static let tkDecorativeSpacer = NSAttributedString.Key("chat.kraki.tkDecorativeSpacer")
    static let tkSemanticText = NSAttributedString.Key("chat.kraki.tkSemanticText")
}

enum TKBlockKind: String {
    case quote, code
}

extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let merged = fontDescriptor.symbolicTraits.union(traits)
        guard let d = fontDescriptor.withSymbolicTraits(merged) else { return self }
        return UIFont(descriptor: d, size: 0)
    }
    var tkBold: UIFont { withTraits(.traitBold) }
    var tkItalic: UIFont { withTraits(.traitItalic) }
}

/// Read-only text view for the bubble body. Whole-message Copy / Steps live on
/// the cell's context menu, so the body must never become first responder: on
/// iOS 26 a focused non-editable UITextView draws an editor surface and caret
/// behind otherwise plain text. Links and embedded tables remain interactive
/// through their existing tap/host paths.
final class TKBodyTextView: UITextView {
    /// In-bubble text selection ("Select Text" in the message menu). Off by
    /// default so ordinary taps, long-press menus and scrolling stay cheap.
    var selectionModeEnabled = false
    var onResignSelection: (() -> Void)?
    override var canBecomeFirstResponder: Bool { selectionModeEnabled }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, selectionModeEnabled { onResignSelection?() }
        return resigned
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        guard selectionModeEnabled else { return super.canPerformAction(action, withSender: sender) }
        // A read-only message: copy, look up, share — never edit.
        return [#selector(copy(_:)), #selector(selectAll(_:)),
                NSSelectorFromString("_lookup:"), NSSelectorFromString("_share:"),
                NSSelectorFromString("_translate:")].contains(action)
            && super.canPerformAction(action, withSender: sender)
    }

    private struct RichBlock {
        let kind: TKBlockKind
        let label: String?
        var rect: CGRect
    }

    struct TablePlacement {
        let attachment: TKTableAttachment
        let frame: CGRect
    }

    func tablePlacements() -> [TablePlacement] {
        guard let textLayoutManager,
              let storage = textLayoutManager.textContentManager as? NSTextContentStorage,
              let attributedText, attributedText.length > 0 else { return [] }
        var placements: [TablePlacement] = []
        attributedText.enumerateAttribute(.attachment,
                                          in: NSRange(location: 0, length: attributedText.length)) { value, range, _ in
            guard let attachment = value as? TKTableAttachment,
                  let location = storage.location(storage.documentRange.location, offsetBy: range.location),
                  let fragment = textLayoutManager.textLayoutFragment(for: location) else { return }
            var frame = fragment.layoutFragmentFrame
            frame.origin.x = 0
            frame.size.width = bounds.width
            frame.size.height = attachment.tableLayout.bubbleHeight(width: bounds.width)
            placements.append(TablePlacement(attachment: attachment, frame: frame))
        }
        return placements
    }

    override func draw(_ rect: CGRect) {
        // This view is transparent over the bubble color. Explicitly clear the
        // dirty region before redrawing: TextKit2 can otherwise preserve pixels
        // drawn by a previous reused message's code surface (#18181B) when the
        // replacement is plain text and invalidates only its glyph bounds.
        UIGraphicsGetCurrentContext()?.clear(rect)
        drawRichBlocks()
        super.draw(rect)
    }

    private func drawRichBlocks() {
        guard let textLayoutManager,
              let storage = textLayoutManager.textContentManager as? NSTextContentStorage,
              let attributedText, attributedText.length > 0,
              let context = UIGraphicsGetCurrentContext() else { return }

        var blocks: [String: RichBlock] = [:]
        textLayoutManager.enumerateTextLayoutFragments(from: nil, options: [.ensuresLayout]) { fragment in
            let start = storage.offset(from: storage.documentRange.location,
                                       to: fragment.rangeInElement.location)
            guard start >= 0, start < attributedText.length,
                  let blockID = attributedText.attribute(.tkBlockID, at: start, effectiveRange: nil) as? String,
                  let rawKind = attributedText.attribute(.tkBlockKind, at: start, effectiveRange: nil) as? String,
                  let kind = TKBlockKind(rawValue: rawKind) else { return true }
            let label = attributedText.attribute(.tkBlockLabel, at: start, effectiveRange: nil) as? String
            var frame = fragment.layoutFragmentFrame
            frame.origin.x = 0
            frame.size.width = bounds.width
            if var current = blocks[blockID] {
                current.rect = current.rect.union(frame)
                blocks[blockID] = current
            } else {
                blocks[blockID] = RichBlock(kind: kind, label: label, rect: frame)
            }
            return true
        }

        context.saveGState()
        defer { context.restoreGState() }
        for block in blocks.values.sorted(by: { $0.rect.minY < $1.rect.minY }) {
            var frame = block.rect.insetBy(dx: 0, dy: -2)
            frame = frame.intersection(bounds.insetBy(dx: 0, dy: -1))
            guard !frame.isNull, frame.height > 0 else { continue }
            switch block.kind {
            case .quote:
                UIColor.secondarySystemFill.setFill()
                UIBezierPath(roundedRect: frame, cornerRadius: 8).fill()
                UIColor.tertiaryLabel.setFill()
                UIBezierPath(roundedRect: CGRect(x: frame.minX, y: frame.minY,
                                                 width: 3, height: frame.height),
                             cornerRadius: 1.5).fill()
            case .code:
                // A code block is its own editor surface. Keep it neutral and
                // stable across differently tinted agent/user bubbles.
                UIColor(red: 0x18/255, green: 0x18/255, blue: 0x1B/255, alpha: 1).setFill()
                UIBezierPath(roundedRect: frame, cornerRadius: 9).fill()
                UIColor(red: 0x52/255, green: 0x52/255, blue: 0x5B/255, alpha: 0.72).setStroke()
                let outline = UIBezierPath(roundedRect: frame.insetBy(dx: 0.25, dy: 0.25), cornerRadius: 9)
                outline.lineWidth = 0.5
                outline.stroke()
                if let label = block.label {
                    let attributes: [NSAttributedString.Key: Any] = [
                        .font: UIFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                        .foregroundColor: UIColor(red: 0xA1/255, green: 0xA1/255, blue: 0xAA/255, alpha: 1),
                    ]
                    label.draw(at: CGPoint(x: frame.minX + 12, y: frame.minY + 5), withAttributes: attributes)
                }
            }
        }
    }

    override func addGestureRecognizer(_ gestureRecognizer: UIGestureRecognizer) {
        if let tap = gestureRecognizer as? UITapGestureRecognizer,
           tap.numberOfTapsRequired >= 2 {
            tap.isEnabled = false
        }
        super.addGestureRecognizer(gestureRecognizer)
    }

    /// Disable the (interaction-managed) double-tap-to-select-word recognizer.
    /// Idempotent; call whenever interaction is (re)enabled.
    func disableDoubleTapSelection() {
        guard let grs = gestureRecognizers else { return }
        for g in grs {
            if let tap = g as? UITapGestureRecognizer, tap.numberOfTapsRequired == 2 {
                tap.isEnabled = false
            }
        }
    }
}

extension UIView {
    var nearestViewController: UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }
}
