/// The iOS chat bubble cell and its private subviews (rounded background, pill label, HTML artifact cards).

import UIKit
import SwiftUI

private final class TKRoundedView: UIView {
    /// The bubble fill is applied immediately and WITHOUT the standalone
    /// shape layer's implicit 0.25 s animation. Implicit animation made every
    /// new or reused cell fade from black / clear / the previous bubble's color
    /// into its Session theme color — a visible color flash on Session entry
    /// and whenever the list reloaded (e.g. after sending).
    var fillColor: UIColor = .clear {
        didSet {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            shape.fillColor = fillColor.resolvedColor(with: traitCollection).cgColor
            CATransaction.commit()
        }
    }
    /// (topLeading, topTrailing, bottomLeading, bottomTrailing)
    var radii: (CGFloat, CGFloat, CGFloat, CGFloat) = (16, 16, 16, 16) {
        didSet { setNeedsLayout() }
    }
    private let shape = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(shape)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let (tl, tr, bl, br) = radii
        let path = UIBezierPath()
        let r = bounds
        path.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        path.addArc(withCenter: CGPoint(x: r.maxX - tr, y: r.minY + tr),
                    radius: tr, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        path.addArc(withCenter: CGPoint(x: r.maxX - br, y: r.maxY - br),
                    radius: br, startAngle: 0, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        path.addArc(withCenter: CGPoint(x: r.minX + bl, y: r.maxY - bl),
                    radius: bl, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        path.addArc(withCenter: CGPoint(x: r.minX + tl, y: r.minY + tl),
                    radius: tl, startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: true)
        path.close()
        let newPath = path.cgPath
        let oldPath = shape.presentation()?.path ?? shape.path
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.path = newPath
        shape.fillColor = fillColor.resolvedColor(with: traitCollection).cgColor
        CATransaction.commit()
        // Follow an enclosing UIView animation (streaming height growth) so the
        // background grows with its cell; never morph implicitly otherwise
        // (a reused cell must not animate from the previous bubble's shape).
        let duration = UIView.inheritedAnimationDuration
        if duration > 0, let oldPath, oldPath != newPath {
            let animation = CABasicAnimation(keyPath: "path")
            animation.fromValue = oldPath
            animation.toValue = newPath
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            shape.add(animation, forKey: "path")
        } else {
            shape.removeAnimation(forKey: "path")
        }
    }
}

// MARK: - The TextKit2 bubble cell

/// A UILabel with text insets — the tool-name pill chip.
private final class TKPillLabel: UILabel {
    var insets = UIEdgeInsets(top: 1, left: 5, bottom: 1, right: 5)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right,
                      height: s.height + insets.top + insets.bottom)
    }
}

private final class TKHTMLArtifactButton: UIControl {
    private let iconBackground = UIView()
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let openIcon = UIImageView()
    private var artifact: ContentRef?
    private var onOpen: ((ContentRef) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 8
        layer.borderWidth = 0.5
        backgroundColor = .secondarySystemBackground
        layer.borderColor = UIColor.separator.withAlphaComponent(0.55).cgColor

        iconBackground.backgroundColor = UIColor.tintColor.withAlphaComponent(0.12)
        iconBackground.layer.cornerRadius = 7
        iconBackground.isUserInteractionEnabled = false
        addSubview(iconBackground)

        iconView.image = UIImage(systemName: "doc.richtext")
        iconView.tintColor = .tintColor
        iconView.contentMode = .scaleAspectFit
        iconBackground.addSubview(iconView)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .label
        titleLabel.lineBreakMode = .byTruncatingTail
        addSubview(titleLabel)

        detailLabel.font = .systemFont(ofSize: 10)
        detailLabel.textColor = .secondaryLabel
        detailLabel.lineBreakMode = .byTruncatingTail
        addSubview(detailLabel)

        openIcon.image = UIImage(systemName: "chevron.right")
        openIcon.tintColor = .tertiaryLabel
        openIcon.contentMode = .scaleAspectFit
        addSubview(openIcon)

        addTarget(self, action: #selector(openArtifact), for: .touchUpInside)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(artifact: ContentRef, onOpen: @escaping (ContentRef) -> Void) {
        self.artifact = artifact
        self.onOpen = onOpen
        let caption = artifact.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = artifact.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = caption?.isEmpty == false
            ? caption!
            : (name?.isEmpty == false ? name! : "Report")
        titleLabel.text = title
        detailLabel.text = "Report · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))"
        accessibilityLabel = title
        accessibilityValue = detailLabel.text
        accessibilityHint = "Opens report preview"
    }

    func reset() {
        artifact = nil
        onOpen = nil
        titleLabel.text = nil
        detailLabel.text = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconBackground.frame = CGRect(x: 10, y: 10, width: 34, height: 34)
        iconView.frame = iconBackground.bounds.insetBy(dx: 8, dy: 8)
        openIcon.frame = CGRect(x: bounds.width - 25, y: 20, width: 10, height: 14)
        let textX: CGFloat = 54
        let textWidth = max(1, bounds.width - textX - 36)
        titleLabel.frame = CGRect(x: textX, y: 9, width: textWidth, height: 18)
        detailLabel.frame = CGRect(x: textX, y: 29, width: textWidth, height: 14)
    }

    @objc private func openArtifact() {
        guard let artifact else { return }
        onOpen?(artifact)
    }
}

final class TKHTMLArtifactCardsView: UIView {
    static let cardHeight: CGFloat = 54
    static let spacing: CGFloat = 6
    private var buttons: [TKHTMLArtifactButton] = []

    static func height(for count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return CGFloat(count) * cardHeight + CGFloat(count - 1) * spacing
    }

    func configure(artifacts: [ContentRef], onOpen: @escaping (ContentRef) -> Void) {
        while buttons.count < artifacts.count {
            let button = TKHTMLArtifactButton(frame: .zero)
            addSubview(button)
            buttons.append(button)
        }
        for (index, button) in buttons.enumerated() {
            if index < artifacts.count {
                button.isHidden = false
                button.configure(artifact: artifacts[index], onOpen: onOpen)
            } else {
                button.isHidden = true
                button.reset()
            }
        }
        isHidden = artifacts.isEmpty
        setNeedsLayout()
    }

    func reset() {
        buttons.forEach {
            $0.reset()
            $0.isHidden = true
        }
        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var y: CGFloat = 0
        for button in buttons where !button.isHidden {
            button.frame = CGRect(x: 0, y: y, width: bounds.width, height: Self.cardHeight)
            y += Self.cardHeight + Self.spacing
        }
    }
}

/// Flat, single-message TextKit cell used by the production chat list.
final class TKBubbleCell: UICollectionViewCell, UIContextMenuInteractionDelegate {
    static let reuseID = "TKBubbleCell"

    var onOpenSteps: ((ChatMessage) -> Void)?
    var onResolvePermission: ((String, String?, String) -> Void)?
    var onAnswerQuestion: ((String, String) -> Void)?
    var onOpenImage: ((IOSImagePreviewSelection) -> Void)?
    var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    var attachmentStore: AttachmentStore?
    var sessionMode: SessionMode = .auto
    var onActionHeightChange: (() -> Void)?
    var onShowTable: ((TKTableLayout) -> Void)?
    /// A message the user sent is never edited afterwards: an unsent or
    /// undelivered one can only be sent (again) or deleted.
    enum PendingAction { case retry, delete }
    /// Retry / edit / delete an unconfirmed optimistic input (by clientId).
    var onPendingAction: ((String, PendingAction) -> Void)?
    private let deliveryStatus = UIButton(type: .system)
    private(set) var sessionId: String = ""
    var contentSnapshot: TKBubbleContent? { content }
    var hasProvisionalCodeHighlight: Bool {
        content?.hasProvisionalCodeHighlight == true
    }

    #if DEBUG
    var imageFrameForRegression: CGRect { imageHost.frame }
    var actionFrameForRegression: CGRect { actionHost.frame }
    var bubbleFrameForRegression: CGRect { bubbleBG.frame }
    var bubbleHiddenForRegression: Bool { bubbleBG.isHidden }
    /// Pending CA animations on the bubble background (must be none after a
    /// configure outside a UIView animation — no color/shape morph).
    var bubbleBackgroundAnimationKeysForRegression: [String] {
        (bubbleBG.layer.sublayers ?? []).flatMap { $0.animationKeys() ?? [] }
    }
    var bubbleFillForRegression: CGColor? {
        (bubbleBG.layer.sublayers?.first as? CAShapeLayer)?.fillColor
    }
    var deliveryStatusForRegression: String? {
        deliveryStatus.isHidden ? nil : deliveryStatus.accessibilityLabel
    }
    var deliveryStatusFrameForRegression: CGRect { deliveryStatus.frame }
    /// Target opacity of the text bubble and image (the "not delivered yet" dim).
    /// On-screen opacity of the text bubble and the image.
    /// Control only timer delivery in functional tests; production delay is unchanged.
    static var pendingDimSchedulerForTesting: ((TimeInterval, DispatchWorkItem) -> Void)?
    var pendingDimForRegression: (text: CGFloat, image: CGFloat) {
        (CGFloat(renderClipView.layer.presentation()?.opacity ?? Float(renderClipView.alpha)),
         CGFloat(imageHost.layer.presentation()?.opacity ?? Float(imageHost.alpha)))
    }
    #endif

    private let renderClipView = UIView()
    private let bubbleBG = TKRoundedView()
    private let bodyView: TKBodyTextView
    /// bodyViews[0] == bodyView; long bodies add paragraph-aligned chunk views.
    private var bodyViews: [TKBodyTextView] = []
    /// The attributed chunk currently assigned to each body view, so an
    /// unchanged chunk is never re-assigned (no TextKit relayout).
    private var bodyChunkStrings: [NSAttributedString?] = []
    private var bodyChunkRanges: [NSRange] = []
    private var bodyChunkHasTable: [Bool] = []
    private var assignedLive: (body: TKLiveBody, revision: Int)?
    private let moreButton = UIButton(type: .system)
    private let actionHost = BubbleActionHostView()
    private let imageHost = BubbleImageHostView()
    private let artifactCardsView = TKHTMLArtifactCardsView()
    private var tableViews: [TKTableScrollView] = []
    private var tableAttachmentIDs: [ObjectIdentifier] = []
    private var bodyHasLinks = false
    private var content: TKBubbleContent?
    /// Action SwiftUI can finish a layout pass while UIKit is laying out the
    /// reusable cell. Defer the collection-view invalidation to the next main
    /// run-loop turn and fence it by reuse generation so a stale callback can
    /// never resize a different bubble.
    private var actionHeightNotificationScheduled = false
    private var reuseGeneration = 0

    override init(frame: CGRect) {
        bodyView = Self.makeBodyView()
        super.init(frame: frame)
        contentView.clipsToBounds = false
        renderClipView.clipsToBounds = true
        contentView.addSubview(renderClipView)
        renderClipView.addSubview(bubbleBG)
        renderClipView.addSubview(bodyView)
        bodyViews = [bodyView]
        bodyChunkStrings = [nil]
        bodyChunkRanges = [NSRange(location: NSNotFound, length: 0)]
        bodyChunkHasTable = [false]

        // Historical bubble affordance (786cbdf3): a compact "···" capsule
        // floating over the bubble's top-left edge. For traceable messages it
        // opens Steps directly; the full action menu is available by long-press.
        var configuration = UIButton.Configuration.gray()
        configuration.title = "···"
        configuration.baseForegroundColor = .secondaryLabel
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 7, bottom: 2, trailing: 7)
        configuration.background.cornerRadius = 10
        moreButton.configuration = configuration
        moreButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        moreButton.addTarget(self, action: #selector(openSteps), for: .touchUpInside)
        moreButton.accessibilityLabel = "Show steps"
        contentView.addSubview(moreButton)
        deliveryStatus.isHidden = true
        deliveryStatus.addTarget(self, action: #selector(deliveryStatusTapped), for: .touchUpInside)
        contentView.addSubview(deliveryStatus)
        contentView.addInteraction(UIContextMenuInteraction(delegate: self))

        // Action slot for streaming / frozen bubbles. Hidden on plain
        // completed bubbles (no action). Same cell as every other message.
        actionHost.backgroundColor = .clear
        actionHost.clipsToBounds = true
        actionHost.translatesAutoresizingMaskIntoConstraints = false
        actionHost.onHeightChange = { [weak self] _ in self?.scheduleActionHeightNotification() }
        renderClipView.addSubview(actionHost)

        imageHost.backgroundColor = .clear
        imageHost.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageHost)
        renderClipView.addSubview(artifactCardsView)

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (cell: TKBubbleCell, _: UITraitCollection) in
            cell.refreshBubbleAppearance()
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    private static func makeBodyView() -> TKBodyTextView {
        let view = TKBodyTextView(usingTextLayoutManager: true)
        view.isEditable = false
        view.isScrollEnabled = false
        view.isSelectable = true
        view.isUserInteractionEnabled = false
        view.isOpaque = false
        view.tintColor = .clear
        view.backgroundColor = .clear
        view.subviews.forEach {
            $0.isOpaque = false
            $0.backgroundColor = .clear
        }
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        // The cell sets each body frame from an exact measured height. If the
        // container tracked that height, every growth would resize it and
        // invalidate TextKit layout for the whole chunk. Only width tracks.
        view.textContainer.heightTracksTextView = false
        view.textContainer.size = CGSize(width: view.textContainer.size.width,
                                         height: CGFloat.greatestFiniteMagnitude)
        view.adjustsFontForContentSizeCategory = true
        view.dataDetectorTypes = []
        view.linkTextAttributes = [.foregroundColor: IOSMarkdownPalette.link]
        return view
    }

    /// Assign `body` across chunk views, touching only chunks whose content
    /// changed. While an answer streams, that is just the last chunk.
    private func assignBody(_ content: TKBubbleContent, cellWidth: CGFloat) {
        guard let body = content.body, body.length > 0 else {
            for (index, view) in bodyViews.enumerated() {
                if bodyChunkStrings[index] != nil { view.attributedText = nil }
                bodyChunkStrings[index] = nil
                bodyChunkRanges[index] = NSRange(location: NSNotFound, length: 0)
                bodyChunkHasTable[index] = false
                view.isHidden = true
            }
            assignedLive = nil
            return
        }
        // Streaming revisions report the first changed character; chunks that
        // end before it are unchanged and are not even compared.
        var unchangedPrefix = 0
        if let live = content.liveBody, content.liveRevision == live.revision,
           let assigned = assignedLive, assigned.body === live {
            unchangedPrefix = live.changedFrom(since: assigned.revision) ?? 0
        }
        let chunks = content.bodyChunks(cellWidth: cellWidth)
        while bodyViews.count < chunks.count {
            let view = Self.makeBodyView()
            renderClipView.insertSubview(view, aboveSubview: bodyViews.last ?? bubbleBG)
            bodyViews.append(view)
            bodyChunkStrings.append(nil)
            bodyChunkRanges.append(NSRange(location: NSNotFound, length: 0))
            bodyChunkHasTable.append(false)
        }
        for (index, view) in bodyViews.enumerated() {
            guard index < chunks.count else {
                if bodyChunkStrings[index] != nil { view.attributedText = nil }
                bodyChunkStrings[index] = nil
                bodyChunkRanges[index] = NSRange(location: NSNotFound, length: 0)
                bodyChunkHasTable[index] = false
                view.isHidden = true
                continue
            }
            let range = chunks[index].range
            if bodyChunkStrings[index] != nil, bodyChunkRanges[index] == range,
               NSMaxRange(range) <= unchangedPrefix {
                view.isHidden = false
                continue
            }
            let piece = range.length == body.length ? body : body.attributedSubstring(from: range)
            if let current = bodyChunkStrings[index], current.isEqual(to: piece) {
                bodyChunkRanges[index] = range
                view.isHidden = false
                continue
            }
            view.attributedText = piece
            bodyChunkStrings[index] = piece
            bodyChunkRanges[index] = range
            var hasTable = false
            piece.enumerateAttribute(.attachment, in: NSRange(location: 0, length: piece.length)) { value, _, stop in
                if value is TKTableAttachment { hasTable = true; stop.pointee = true }
            }
            bodyChunkHasTable[index] = hasTable
            view.selectedRange = NSRange(location: 0, length: 0)
            view.setNeedsDisplay()
            view.isHidden = false
            if index > 0 {
                // The cell / first chunk carries the semantic label.
                view.isAccessibilityElement = false
                view.accessibilityElementsHidden = true
            }
        }
        assignedLive = content.liveBody.map { ($0, content.liveRevision) }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A representable can configure cells before it inherits the window's
        // final forced color scheme. Re-resolve the bubble on attachment so an
        // entering Session never paints one light/dark frame before settling.
        refreshBubbleAppearance()
    }

    private func refreshBubbleAppearance() {
        guard let content else { return }
        let dark = traitCollection.userInterfaceStyle == .dark
        bubbleBG.fillColor = content.bubbleColor(dark: dark)
        bubbleBG.setNeedsDisplay()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        endTextSelection()
        reuseGeneration &+= 1
        actionHeightNotificationScheduled = false
        content = nil
        onOpenSteps = nil
        onResolvePermission = nil
        onAnswerQuestion = nil
        onOpenImage = nil
        onOpenHTMLArtifact = nil
        attachmentStore = nil
        for (index, view) in bodyViews.enumerated() {
            view.attributedText = nil
            view.isHidden = true
            bodyChunkStrings[index] = nil
            bodyChunkRanges[index] = NSRange(location: NSNotFound, length: 0)
            bodyChunkHasTable[index] = false
        }
        assignedLive = nil
        imageHost.configure(
            images: [],
            refs: [],
            sessionId: sessionId,
            maxWidth: 0,
            alignment: .leading,
            attachmentStore: nil,
            onOpenImage: { _ in }
        )
        imageHost.frame = .zero
        imageHost.isHidden = true
        artifactCardsView.reset()
        actionHost.configure(action: nil, sessionMode: sessionMode)
        actionHost.isHidden = true
        tableViews.forEach { $0.removeFromSuperview() }
        tableViews.removeAll(keepingCapacity: true)
        tableAttachmentIDs.removeAll(keepingCapacity: true)
        moreButton.isHidden = true
        onPendingAction = nil
        deliveryStatus.layer.removeAllAnimations()
        deliveryStatus.isHidden = true
        deliveryStatus.menu = nil
        deliveryStatus.showsMenuAsPrimaryAction = false
        deliveryStatusKey = nil
        dimmedMessageID = nil
        pendingDimWork?.cancel(); pendingDimWork = nil
        renderClipView.layer.removeAllAnimations()
        imageHost.layer.removeAllAnimations()
        renderClipView.alpha = 1
        imageHost.alpha = 1
        bubbleBG.fillColor = .clear
        bubbleBG.frame = .zero
    }

    private var pendingClientID: String? {
        content?.message.payload["clientId"]?.stringValue
    }

    @objc private func deliveryStatusTapped() {
        guard ["failed", "unconfirmed"].contains(content?.pendingDeliveryState ?? ""), let clientID = pendingClientID else { return }
        onPendingAction?(clientID, .retry)
    }

    private static let pendingAlpha: CGFloat = 0.6
    /// Identity + state the status indicator was last set up for. Pending rows
    /// are reconfigured on every outbox change; an unchanged status must not
    /// restart its delayed fade (which would flicker).
    private var deliveryStatusKey: String?
    /// Message whose text bubble and image are dimmed as "not delivered yet".
    private var dimmedMessageID: String?
    private var pendingDimWork: DispatchWorkItem?

    /// Sent but not delivered yet: the whole message — text bubble and its
    /// image — dims after the same short delay as the clock, so a fast
    /// confirmation never flashes. A correcting voice message is not dimmed:
    /// its uncorrected words are light and corrected words solid instead.
    /// Delivered and failed messages are shown normally (failed has its "!").
    private func applyPendingDim(_ content: TKBubbleContent) {
        let state = content.pendingDeliveryState
        let targets: [UIView] = [renderClipView, imageHost]
        if state == "sending" {
            let id = content.message.id
            guard dimmedMessageID != id else { return }
            dimmedMessageID = id
            targets.forEach { $0.layer.removeAllAnimations() }
            pendingDimWork?.cancel()
            targets.forEach { $0.alpha = 1 }
            // A real timer: a delayed UIView animation is skipped when the
            // cell is configured before it is in a window.
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.dimmedMessageID == id else { return }
                UIView.animate(withDuration: 0.25, delay: 0, options: [.allowUserInteraction]) {
                    targets.forEach { $0.alpha = Self.pendingAlpha }
                }
            }
            pendingDimWork = work
            #if DEBUG
            if let schedule = Self.pendingDimSchedulerForTesting {
                schedule(0.8, work)
                return
            }
            #endif
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
        } else {
            let wasDimmed = dimmedMessageID != nil
            dimmedMessageID = nil
            pendingDimWork?.cancel(); pendingDimWork = nil
            targets.forEach { $0.layer.removeAllAnimations() }
            if wasDimmed {
                UIView.animate(withDuration: 0.15, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    targets.forEach { $0.alpha = 1 }
                }
            } else {
                targets.forEach { $0.alpha = 1 }
            }
        }
    }

    /// Delivery indicator beside an optimistic bubble. "Sending" appears only
    /// after a short delay so fast confirmations never flash an icon.
    private func configureDeliveryStatus(_ content: TKBubbleContent) {
        applyPendingDim(content)
        let key = "\(content.message.id)#\(content.pendingDeliveryState ?? "")"
        guard key != deliveryStatusKey else { return }
        deliveryStatusKey = key
        deliveryStatus.menu = nil
        deliveryStatus.showsMenuAsPrimaryAction = false
        deliveryStatus.imageView?.removeAllSymbolEffects()
        guard let state = content.pendingDeliveryState else {
            deliveryStatus.layer.removeAllAnimations()
            deliveryStatus.isHidden = true
            return
        }
        let symbol = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        deliveryStatus.isHidden = false
        deliveryStatus.layer.removeAllAnimations()
        if state == "correcting" {
            deliveryStatus.setImage(UIImage(systemName: "waveform", withConfiguration: symbol), for: .normal)
            deliveryStatus.tintColor = .secondaryLabel
            deliveryStatus.isUserInteractionEnabled = true
            deliveryStatus.alpha = 1
            deliveryStatus.accessibilityLabel = "Correcting transcript before sending"
            deliveryStatus.imageView?.addSymbolEffect(.variableColor.iterative, options: .repeating)
            if let clientID = pendingClientID {
                deliveryStatus.menu = UIMenu(children: correctingActions(clientID))
                deliveryStatus.showsMenuAsPrimaryAction = true
            }
            return
        }
        if state == "unconfirmed" {
            deliveryStatus.setImage(UIImage(systemName: "questionmark.circle", withConfiguration: symbol), for: .normal)
            deliveryStatus.tintColor = .systemOrange
            deliveryStatus.isUserInteractionEnabled = true
            deliveryStatus.alpha = 1
            deliveryStatus.accessibilityLabel = "Awaiting confirmation. Tap to retry"
        } else if state == "failed" {
            deliveryStatus.setImage(UIImage(systemName: "exclamationmark.circle.fill", withConfiguration: symbol), for: .normal)
            deliveryStatus.tintColor = .systemRed
            deliveryStatus.isUserInteractionEnabled = true
            deliveryStatus.alpha = 1
            deliveryStatus.accessibilityLabel = "Not delivered. Tap to retry"
        } else {
            deliveryStatus.setImage(UIImage(systemName: "clock", withConfiguration: symbol), for: .normal)
            deliveryStatus.tintColor = .tertiaryLabel
            deliveryStatus.isUserInteractionEnabled = false
            deliveryStatus.accessibilityLabel = "Sending"
            deliveryStatus.alpha = 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self, self.deliveryStatusKey == key else { return }
                UIView.animate(withDuration: 0.25, delay: 0, options: [.allowUserInteraction]) {
                    self.deliveryStatus.alpha = 1
                }
            }
        }
    }

    private func scheduleActionHeightNotification() {
        guard !actionHeightNotificationScheduled else { return }
        actionHeightNotificationScheduled = true
        let generation = reuseGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.reuseGeneration == generation else { return }
            self.actionHeightNotificationScheduled = false
            self.onActionHeightChange?()
        }
    }

    func setBodyInteractive(_ enabled: Bool) {
        if isSelectingText { return }
        // Plain text never needs UITextView selection: whole-message Copy and
        // Steps are provided by the cell context menu. Only link-bearing text
        // receives UITextView touches, which prevents iOS selection highlights
        // from leaving black rectangles behind ordinary user/agent text.
        let textInteractive = enabled && bodyHasLinks
        for view in bodyViews {
            if view.isSelectable != textInteractive { view.isSelectable = textInteractive }
            if view.isUserInteractionEnabled != textInteractive {
                view.isUserInteractionEnabled = textInteractive
            }
            if textInteractive { view.disableDoubleTapSelection() }
        }
        for tableView in tableViews where tableView.isUserInteractionEnabled != enabled {
            tableView.isUserInteractionEnabled = enabled
        }
    }

    func configure(_ content: TKBubbleContent, cellWidth: CGFloat) {
        #if KRAKI_DIAG
        let diagWork = KrakiDiag.beginWork()
        defer { KrakiDiag.endWork(diagWork, source: "ios.cell_configure", session: content.message.sessionId, seq: content.message.seq) }
        #endif
        let previous = self.content
        self.content = content
        if content.liveBody != nil, previous?.liveBody === content.liveBody {
            // Next revision of the same streaming bubble: only the changed
            // (last) chunk is re-assigned; skip whole-body scans.
            assignBody(content, cellWidth: cellWidth)
            configureLiveFastPath(content, cellWidth: cellWidth)
            return
        }
        endTextSelection()
        bodyViews.forEach { $0.resignFirstResponder() }
        bodyHasLinks = false
        if let body = content.body, body.length > 0 {
            body.enumerateAttribute(.link,
                                    in: NSRange(location: 0, length: body.length)) { value, _, stop in
                if value != nil {
                    bodyHasLinks = true
                    stop.pointee = true
                }
            }
        }
        for view in bodyViews {
            view.isSelectable = false
            view.isUserInteractionEnabled = false
        }
        assignBody(content, cellWidth: cellWidth)
        refreshBubbleAppearance()
        switch content.kind {
        case .agent: bubbleBG.radii = (4, 16, 16, 16)
        case .user: bubbleBG.radii = (16, 4, 16, 16)
        case .error, .system: bubbleBG.radii = (12, 12, 12, 12)
        }

        // Inline and ContentRef images share one fixed-geometry attachment
        // gallery outside the text bubble. Hydration replaces pixels only;
        // the message height is stable from the first frame.
        sessionId = content.message.sessionId ?? sessionId
        let hasImages = !content.images.isEmpty || !content.imageRefs.isEmpty
        let galleryAlignment: Alignment = content.kind == .user ? .trailing : .leading
        imageHost.configure(
            images: content.images,
            refs: content.imageRefs,
            sessionId: sessionId,
            maxWidth: content.attachmentWidth(cellWidth: cellWidth),
            alignment: galleryAlignment,
            attachmentStore: attachmentStore,
            onOpenImage: { [weak self] selection in
                self?.onOpenImage?(selection)
            }
        )
        imageHost.isHidden = !hasImages

        moreButton.isHidden = !content.canShowSteps
        configureDeliveryStatus(content)
        artifactCardsView.configure(artifacts: content.htmlArtifacts) { [weak self] artifact in
            self?.onOpenHTMLArtifact?(artifact)
        }

        // Action slot (streaming / frozen turns). Hosts the SwiftUI action UI
        // inside this UIKit cell — same component as a completed bubble.
        if let action = content.action {
            actionHost.onResolvePermission = onResolvePermission
            actionHost.onAnswerQuestion = onAnswerQuestion
            actionHost.configure(action: action, sessionMode: sessionMode)
            actionHost.isHidden = false
        } else {
            actionHost.isHidden = true
            actionHost.configure(action: nil, sessionMode: sessionMode)
        }

        let exposesInteractiveAction = content.action != nil
        var exposesInteractiveTable = false
        if let body = content.body {
            body.enumerateAttribute(.attachment,
                                    in: NSRange(location: 0, length: body.length)) { value, _, stop in
                if value is TKTableAttachment {
                    exposesInteractiveTable = true
                    stop.pointee = true
                }
            }
        }
        let exposesInteractiveContent = exposesInteractiveAction
            || exposesInteractiveTable
            || !content.images.isEmpty
            || !content.imageRefs.isEmpty
            || !content.htmlArtifacts.isEmpty
        let semanticText = content.isLive ? content.message.content : TKMarkdown.plainText(content.body)
        isAccessibilityElement = !exposesInteractiveContent
        accessibilityLabel = exposesInteractiveContent ? nil : semanticText
        accessibilityTraits = content.kind == .error ? [.staticText, .notEnabled] : .staticText
        bodyView.isAccessibilityElement = exposesInteractiveContent && !(semanticText?.isEmpty ?? true)
        bodyView.accessibilityLabel = semanticText
        actionHost.isAccessibilityElement = false
        actionHost.accessibilityElementsHidden = false
        setNeedsLayout()
    }

    /// Streaming revision of the same live bubble: the body was edited in
    /// place; refresh only the cheap, revision-dependent chrome.
    private func configureLiveFastPath(_ content: TKBubbleContent, cellWidth: CGFloat) {
        if let action = content.action {
            actionHost.onResolvePermission = onResolvePermission
            actionHost.onAnswerQuestion = onAnswerQuestion
            actionHost.configure(action: action, sessionMode: sessionMode)
            actionHost.isHidden = false
        } else if !actionHost.isHidden {
            actionHost.isHidden = true
            actionHost.configure(action: nil, sessionMode: sessionMode)
        }
        moreButton.isHidden = !content.canShowSteps
        accessibilityLabel = content.action == nil ? content.message.content : nil
        bodyView.accessibilityLabel = content.message.content
        setNeedsLayout()
    }

    /// Opaque surface behind a table's pinned column (the bubble fill).
    private var tableSurfaceColor: UIColor {
        let fill = bubbleBG.fillColor
        return fill == .clear ? .systemBackground : fill
    }

    private func syncTableViews() {
        var placements: [TKBodyTextView.TablePlacement] = []
        for (index, view) in bodyViews.enumerated() where !view.isHidden && bodyChunkHasTable[index] {
            for placement in view.tablePlacements() {
                var frame = placement.frame
                frame.origin.x += view.frame.minX
                frame.origin.y += view.frame.minY
                placements.append(.init(attachment: placement.attachment, frame: frame))
            }
        }
        let desiredIDs = placements.map { ObjectIdentifier($0.attachment) }
        if desiredIDs != tableAttachmentIDs {
            let oldViews = tableViews
            tableViews = []
            tableAttachmentIDs = []
            oldViews.forEach { $0.removeFromSuperview() }
            tableAttachmentIDs = desiredIDs
            tableViews = placements.map { placement in
                let view = TKTableScrollView(layout: placement.attachment.tableLayout)
                view.onShowAll = { [weak self] in
                    self?.onShowTable?(placement.attachment.tableLayout)
                }
                view.isUserInteractionEnabled = bodyView.isUserInteractionEnabled
                renderClipView.addSubview(view)
                return view
            }
        }
        for (index, placement) in placements.enumerated() where index < tableViews.count {
            let frame = placement.frame
            let view = tableViews[index]
            view.frame = frame
            view.surfaceColor = tableSurfaceColor
            renderClipView.bringSubviewToFront(view)
        }
    }

    /// The Steps "···" chip straddles the cell's top edge. For a steps-only
    /// row (no bubble) most of the chip lies outside the cell, where UIKit
    /// never delivers touches, so tapping it did nothing. Route any touch on
    /// the visible chip to it, inside or outside the cell bounds.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if !moreButton.isHidden, moreButton.alpha > 0.01, isUserInteractionEnabled {
            let local = convert(point, to: moreButton)
            if moreButton.bounds.insetBy(dx: -6, dy: -6).contains(local) { return moreButton }
        }
        return super.hitTest(point, with: event)
    }

    @objc private func openSteps() {
        guard let content, content.canShowSteps else { return }
        onOpenSteps?(content.message)
    }

    func messageActions() -> [UIAction] {
        guard let content else { return [] }
        var actions: [UIAction] = []
        if let text = TKMarkdown.plainText(content.body), !text.isEmpty {
            actions.append(UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in
                UIPasteboard.general.string = text
            })
            if content.liveBody == nil {
                actions.append(UIAction(title: "Select Text", image: UIImage(systemName: "selection.pin.in.out")) { [weak self] _ in
                    // After the context menu finishes dismissing.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.beginTextSelection() }
                })
            }
        }
        if content.canShowSteps {
            actions.append(UIAction(title: "Show Steps", image: UIImage(systemName: "list.bullet.indent")) { [weak self] _ in
                self?.openSteps()
            })
        }
        if content.pendingDeliveryState == "correcting", let clientID = pendingClientID {
            actions.append(contentsOf: correctingActions(clientID))
        }
        if ["failed", "unconfirmed"].contains(content.pendingDeliveryState ?? ""), let clientID = pendingClientID {
            actions.insert(UIAction(title: "Retry", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in
                self?.onPendingAction?(clientID, .retry)
            }, at: 0)
            actions.append(UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.onPendingAction?(clientID, .delete)
            })
        }
        return actions
    }

    // MARK: In-bubble text selection

    /// The bubble whose text is being selected (at most one).
    private static weak var activeSelection: TKBubbleCell?
    private var lastMenuLocation: CGPoint?
    private(set) var isSelectingText = false

    /// Select the pressed paragraph block (whole message for most replies)
    /// in place, with standard handles and the system Copy menu.
    func beginTextSelection() {
        guard content != nil, content?.liveBody == nil else { return }
        if let other = Self.activeSelection, other !== self { other.endTextSelection() }
        let point = lastMenuLocation ?? bubbleBG.frame.origin
        let target = bodyViews.first { !$0.isHidden && $0.frame.contains(point) }
            ?? bodyViews.first { !$0.isHidden && ($0.attributedText?.length ?? 0) > 0 }
        guard let target, let length = target.attributedText?.length, length > 0 else { return }
        isSelectingText = true
        Self.activeSelection = self
        for view in bodyViews {
            view.selectionModeEnabled = view === target
            view.isSelectable = view === target || bodyHasLinks
            view.isUserInteractionEnabled = view === target || bodyHasLinks
        }
        target.tintColor = content?.kind == .user ? .white : .systemBlue
        target.onResignSelection = { [weak self] in self?.endTextSelection() }
        guard target.becomeFirstResponder() else { endTextSelection(); return }
        target.selectedRange = NSRange(location: 0, length: length)
        presentEditMenu(for: target)
    }

    private func presentEditMenu(for view: TKBodyTextView) {
        // UITextView's own edit menu (Copy · Look Up · Translate · Share),
        // shown once the selection is on screen.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak view] in
            guard let self, let view, self.isSelectingText, view.isFirstResponder else { return }
            let rect = view.selectedTextRange.map { view.firstRect(for: $0) } ?? view.bounds
            UIMenuController.shared.showMenu(from: view, rect: rect.intersection(view.bounds))
        }
    }

    func endTextSelection() {
        guard isSelectingText else { return }
        isSelectingText = false
        if Self.activeSelection === self { Self.activeSelection = nil }
        for view in bodyViews where view.selectionModeEnabled {
            view.onResignSelection = nil
            view.selectionModeEnabled = false
            view.selectedRange = NSRange(location: 0, length: 0)
            _ = view.resignFirstResponder()
            view.tintColor = .clear
            view.setNeedsDisplay()
        }
        setBodyInteractive(true)
    }

    /// End any in-bubble selection unless `point` (window space) is inside it.
    static func endActiveTextSelection(unlessAt point: CGPoint? = nil) {
        guard let cell = activeSelection else { return }
        if let point, let view = cell.bodyViews.first(where: \.selectionModeEnabled),
           view.bounds.contains(view.convert(point, from: nil)) { return }
        cell.endTextSelection()
    }

    /// Voice input still being corrected: don't wait (send the original
    /// transcript), or drop it.
    private func correctingActions(_ clientID: String) -> [UIAction] {
        [
            UIAction(title: "Send Original", image: UIImage(systemName: "paperplane")) { [weak self] _ in
                self?.onPendingAction?(clientID, .retry)
            },
            UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.onPendingAction?(clientID, .delete)
            },
        ]
    }

    func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard bubbleBG.frame.contains(location), !messageActions().isEmpty else { return nil }
        lastMenuLocation = location
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(children: self?.messageActions() ?? [])
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        renderClipView.frame = contentView.bounds
        guard let content else { return }
        let cellWidth = bounds.width
        let bubbleWidth = content.bubbleWidth(cellWidth: cellWidth)
        let x: CGFloat
        switch content.kind {
        case .agent: x = TKMetrics.outerH
        case .user: x = cellWidth - TKMetrics.outerH - bubbleWidth
        case .error, .system: x = (cellWidth - bubbleWidth) / 2
        }
        let y = TKMetrics.outerV
        let innerX = x + TKMetrics.msgPadH
        let innerWidth = content.bodyTextWidth(cellWidth: cellWidth)
        var cursorY = y + TKMetrics.msgPadV
        let textHeight = content.bodyTextHeight(cellWidth: cellWidth)
        if textHeight > 0 {
            let chunks = content.bodyChunks(cellWidth: cellWidth)
            for (index, chunk) in chunks.enumerated() where index < bodyViews.count {
                let frame = CGRect(x: innerX, y: cursorY + chunk.y, width: innerWidth, height: chunk.height)
                if bodyViews[index].frame != frame { bodyViews[index].frame = frame }
            }
            cursorY += textHeight
        }
        syncTableViews()
        let actionWidth = bubbleWidth - TKMetrics.msgPadH * 2
        let artifactHeight = TKHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if cursorY > y + TKMetrics.msgPadV { cursorY += TKMetrics.imageSpacing }
            artifactCardsView.frame = CGRect(x: innerX, y: cursorY, width: actionWidth, height: artifactHeight)
            cursorY += artifactHeight
        } else {
            artifactCardsView.frame = .zero
        }
        // Action slot (streaming / frozen).
        if !actionHost.isHidden {
            if cursorY > y + TKMetrics.msgPadV { cursorY += 8 }
            actionHost.frame = CGRect(x: innerX, y: cursorY, width: max(1, actionWidth), height: 1)
            actionHost.setNeedsLayout()
            actionHost.layoutIfNeeded()
            let fit = actionHost.measuredHeight(forWidth: actionWidth)
            actionHost.frame.size.height = max(1, fit)
            cursorY += actionHost.frame.height
        }
        cursorY += TKMetrics.msgPadV
        let bubbleHeight: CGFloat
        if content.hasBubbleContent {
            bubbleHeight = max(cursorY - y, 1)
            bubbleBG.isHidden = false
            bubbleBG.frame = CGRect(x: x, y: y, width: bubbleWidth, height: bubbleHeight)
        } else {
            bubbleHeight = 0
            bubbleBG.isHidden = true
            bubbleBG.frame = .zero
        }

        let attachmentWidth = content.attachmentWidth(cellWidth: cellWidth)
        let imageHeight = content.imagesHeight(cellWidth: cellWidth)
        if imageHeight > 0 {
            let imageY = content.hasBubbleContent
                ? y + bubbleHeight + TKMetrics.attachmentSpacing
                : y
            let imageX: CGFloat
            switch content.kind {
            case .agent:
                imageX = TKMetrics.outerH
            case .user:
                imageX = cellWidth - TKMetrics.outerH - attachmentWidth
            case .error, .system:
                imageX = (cellWidth - attachmentWidth) / 2
            }
            imageHost.frame = CGRect(
                x: imageX,
                y: imageY,
                width: attachmentWidth,
                height: imageHeight
            )
            imageHost.setNeedsLayout()
        } else {
            imageHost.frame = .zero
        }

        if !deliveryStatus.isHidden {
            // The status belongs to the whole message: beside its last block
            // (the image when there is one, so an image-only message has it
            // next to the image rather than above it).
            let anchor = imageHeight > 0 ? imageHost.frame
                : CGRect(x: x, y: y, width: bubbleWidth, height: max(bubbleHeight, 1))
            deliveryStatus.frame = CGRect(x: anchor.minX - 28, y: anchor.maxY - 24, width: 24, height: 24)
        }
        let buttonSize = moreButton.sizeThatFits(CGSize(width: 80, height: 30))
        // Steps "···" rides the bubble's top-LEADING edge.
        moreButton.frame = CGRect(
            x: x + 8,
            y: y - buttonSize.height / 2,
            width: buttonSize.width, height: buttonSize.height)
    }
}
