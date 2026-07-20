#if os(iOS)
import SwiftUI
import UIKit

/// SwiftUI grid of lazy image refs rendered INSIDE a `TKBubbleCell` for
/// `kraki-show_image`-produced attachments (`content_ref` entries with an
/// image MIME type). Reuses `LazyImageView` so images hydrate through the
/// same `AttachmentStore` chunk pipeline as the rest of the app. Mirrors the
/// web `ImageAttachments` component: inline images + content-ref images share
/// the same stacked gallery inside the bubble.
struct BubbleImageGrid: View {
    let attachmentStore: AttachmentStore
    let refs: [ContentRef]
    let sessionId: String

    var body: some View {
        VStack(spacing: 6) {
            ForEach(refs, id: \.id) { ref in
                LazyImageView(attachmentStore: attachmentStore, ref: ref, sessionId: sessionId)
            }
        }
    }
}

/// UIKit wrapper that hosts `BubbleImageGrid` as a subview of `TKBubbleCell`.
/// Self-sizing like `BubbleActionHostView`: the cell sets its width, this view
/// reports its height via the callback and re-reports when an image finishes
/// loading (so the list invalidates the cached height and the bubble grows to
/// fit the freshly-hydrated image).
final class BubbleImageHostView: UIView {
    var onHeightChange: ((CGFloat) -> Void)?
    var hostingController: UIHostingController<BubbleImageGrid?>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
    }
    required init?(coder: NSCoder) { fatalError() }

    func configure(refs: [ContentRef], sessionId: String, attachmentStore: AttachmentStore?) {
        let grid = attachmentStore.map { BubbleImageGrid(attachmentStore: $0, refs: refs, sessionId: sessionId) }
        if let existing = hostingController {
            existing.rootView = refs.isEmpty ? nil : grid
            existing.view.invalidateIntrinsicContentSize()
        } else if !refs.isEmpty, let grid {
            let host = UIHostingController(rootView: Optional(grid))
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            host.view.frame = bounds
            addSubview(host.view)
            hostingController = host
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let hv = hostingController?.view else { return }
        hv.frame = bounds
        let target = CGSize(width: bounds.width, height: UIView.layoutFittingCompressedSize.height)
        let fit = hv.systemLayoutSizeFitting(target,
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        if abs(fit.height - lastReportedHeight) > 0.5 {
            lastReportedHeight = fit.height
            onHeightChange?(fit.height)
        }
    }

    private var lastReportedHeight: CGFloat = 0

    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        guard let hv = hostingController?.view else { return 0 }
        hv.frame = CGRect(x: 0, y: 0, width: width, height: 1)
        let fit = hv.systemLayoutSizeFitting(CGSize(width: width, height: .greatestFiniteMagnitude),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        return fit.height
    }
}

/// Pure geometry oracle for lazy content-ref placeholders. Measurement must not
/// construct `LazyImageView`: its live host owns AttachmentStore observation and
/// request side effects, while sizing only needs the protocol width/height hints.
enum TKImageMeasure {
    static func height(refs: [ContentRef], sessionId: String, width: CGFloat) -> CGFloat {
        guard !refs.isEmpty, width > 0 else { return 0 }
        return refs.enumerated().reduce(0) { total, pair in
            let ref = pair.element
            let ratio: CGFloat
            if let w = ref.width, let h = ref.height, w > 0, h > 0 {
                ratio = CGFloat(w) / CGFloat(h)
            } else {
                ratio = 1
            }
            let imageHeight = min(192, width / max(ratio, 0.01))
            return total + (pair.offset == 0 ? 0 : 6) + imageHeight
        }
    }
}
#endif
