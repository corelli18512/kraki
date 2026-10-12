#if os(macOS)
import AppKit
import CoreText
import SwiftUI

/// One virtualized chat bubble. Layout constants and view hierarchy mirror
/// iOS `TKBubbleCell`: no Mac-only avatar column, one bubble background, body,
/// inline/lazy images, in-bubble action slot, and a floating Steps capsule.
enum MacBubbleKind: Equatable { case agent, user, error, system }

private final class MacFlippedContentClipView: NSView {
    override var isFlipped: Bool { true }
}

struct MacQuestionChoiceHitTarget: Equatable {
    let questionId: String
    let answer: String
}

struct MacPermissionButtonHitTarget: Equatable {
    let permissionId: String
    let toolName: String?
    let decision: String
}

enum MacBubbleActionHitTarget: Equatable {
    case question(MacQuestionChoiceHitTarget)
    case permission(MacPermissionButtonHitTarget)
}

enum MacBubbleActionCapture: Equatable {
    case question(String)
    case permission(String)
}

struct MacBubbleActionCaptureContext {
    let capture: MacBubbleActionCapture
    let actionPoint: NSPoint
}

final class MacChatBubbleCell: NSView {
    private var accessibilityBody: NSAttributedString? {
        didSet { if accessibilityBody !== oldValue { accessibilityBodyText = nil } }
    }
    private var accessibilityBodyText: String?
    override func accessibilityLabel() -> String? {
        guard let body = accessibilityBody else { return super.accessibilityLabel() }
        if let cached = accessibilityBodyText { return cached }
        let text = MacMarkdown.plainText(body) ?? ""
        accessibilityBodyText = text
        return text
    }
    override var isFlipped: Bool { true }
    private let contentClipView = MacFlippedContentClipView()
    private let bubbleBG = MacRoundedView()
    private let coreTextBodyView = MacCoreTextBodyView()
    private let bodyView = MacBubbleTextView()
    private let stepsMaterial = NSView()
    private let stepsButton = NSButton()
    private let deliveryStatus = NSButton()
    private var deliveryStatusRevealWork: DispatchWorkItem?
    private lazy var actionHost = NSHostingView(rootView: Optional<MacBubbleActionSlot>.none)
    private lazy var imageHost = NSHostingView(rootView: Optional<MacBubbleImageGrid>.none)
    private let artifactCardsView = MacHTMLArtifactCardsView()
    private var tableViews: [MacTableScrollView] = []
    private var tableContentKeys: [String] = []

    private(set) var bubbleSeq = 0
    private(set) var canShowStepsFlag = false
    private(set) var isLiveFlag = false
    private(set) var isPlaceholderFlag = false
    private(set) var usesCoreTextBodyFlag = false
    private(set) var renderRevision = ""
    var documentWidthVar: CGFloat = 0

    private(set) var content: MacChatBubbleContent?
    private var sessionMode: SessionMode = .auto
    private var onTapSteps: ((MacChatBubbleCell) -> Void)?
    private var onResolvePermission: ((String, String?, String) -> Void)?
    private var onAnswerQuestion: ((String, String) -> Void)?
    private var onOpenImage: ((MacImagePreviewSelection) -> Void)?
    private var onOpenHTMLArtifact: ((ContentRef) -> Void)?
    private var onHeightInvalidated: (() -> Void)?
    private var bodyHasLinks = false
    private var bodyHasTables = false
    private var measuredBodyHeight: CGFloat = 0
    private var measuredActionHeight: CGFloat = 0
    private var usesCoreTextBody = false
    private var questionChoiceFrames: [MacQuestionChoiceFrame] = []
    private var permissionButtonFrames: [MacPermissionButtonFrame] = []

    #if DEBUG
    var bodyFrameForRegression: NSRect {
        usesCoreTextBody ? coreTextBodyView.frame : bodyView.frame
    }
    var actionFrameForRegression: NSRect { actionHost.frame }
    var imageFrameForRegression: NSRect { imageHost.frame }
    var bubbleFrameForRegression: NSRect { bubbleBG.frame }

    func selectBodyTextForRegression(_ range: NSRange) -> (text: String?, rectCount: Int) {
        guard usesCoreTextBody else { return (nil, 0) }
        return coreTextBodyView.selectForRegression(range)
    }

    func dragSelectBodyTextForRegression(
        _ range: NSRange,
        windowNumber: Int
    ) -> (text: String?, rectCount: Int, hitTested: Bool) {
        guard usesCoreTextBody,
              let artifact = coreTextBodyView.artifact,
              let start = artifact.point(forStringIndex: range.location),
              let end = artifact.point(forStringIndex: NSMaxRange(range)) else {
            return (nil, 0, false)
        }
        let startInCell = coreTextBodyView.convert(start, to: self)
        let hit = hitTest(startInCell)
        let hitTested = hit === coreTextBodyView || hit?.isDescendant(of: coreTextBodyView) == true
        let startInWindow = coreTextBodyView.convert(start, to: nil)
        let endInWindow = coreTextBodyView.convert(end, to: nil)
        let timestamp = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: startInWindow,
            modifierFlags: [],
            timestamp: timestamp,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        ), let drag = NSEvent.mouseEvent(
            with: .leftMouseDragged,
            location: endInWindow,
            modifierFlags: [],
            timestamp: timestamp + 0.01,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 2,
            clickCount: 1,
            pressure: 1
        ), let up = NSEvent.mouseEvent(
            with: .leftMouseUp,
            location: endInWindow,
            modifierFlags: [],
            timestamp: timestamp + 0.02,
            windowNumber: windowNumber,
            context: nil,
            eventNumber: 3,
            clickCount: 1,
            pressure: 0
        ) else {
            return (nil, 0, hitTested)
        }
        coreTextBodyView.mouseDown(with: down)
        coreTextBodyView.mouseDragged(with: drag)
        coreTextBodyView.mouseUp(with: up)
        let rectCount = coreTextBodyView.artifact?.selectionRects(for: range).count ?? 0
        return (coreTextBodyView.selectedText, rectCount, hitTested)
    }
    var bubbleHiddenForRegression: Bool { bubbleBG.isHidden }
    var contentClipIsFlippedForRegression: Bool { contentClipView.isFlipped }

    func clearActionHitFramesForRegression() {
        questionChoiceFrames.removeAll(keepingCapacity: true)
        permissionButtonFrames.removeAll(keepingCapacity: true)
    }

    func offsetActionHostForRegression(y: CGFloat) {
        actionHost.frame.origin.y += y
    }

    func openFirstImageForRegression() -> (found: Bool, hitTested: Bool) {
        imageHost.layoutSubtreeIfNeeded()
        func collectButtons(in view: NSView, into result: inout [NSButton]) {
            if let button = view as? NSButton,
               ["Open image preview", "Open image gallery"].contains(button.accessibilityLabel()) {
                result.append(button)
            }
            for child in view.subviews {
                collectButtons(in: child, into: &result)
            }
        }
        var buttons: [NSButton] = []
        collectButtons(in: imageHost, into: &buttons)
        guard !buttons.isEmpty else { return (false, false) }
        let visibleButton = buttons.first { button in
            let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: self)
            let hit = hitTest(center)
            return hit === button || hit?.isDescendant(of: button) == true
        }
        guard let visibleButton else { return (true, false) }
        visibleButton.performClick(nil)
        return (true, true)
    }
    #endif

    func actionHitTarget(atWindowPoint point: NSPoint) -> MacBubbleActionHitTarget? {
        guard let context = actionCaptureContext(atWindowPoint: point) else { return nil }
        return actionHitTarget(
            for: context.capture,
            atActionPoint: context.actionPoint
        )
    }

    func actionCapture(atWindowPoint point: NSPoint) -> MacBubbleActionCapture? {
        actionCaptureContext(atWindowPoint: point)?.capture
    }

    #if DEBUG
    /// Window point at the center of an open question's choice (for driving
    /// the real hit-test path in automation).
    func automationChoiceWindowPoint(_ answer: String) -> NSPoint? {
        guard !actionHost.isHidden,
              let frame = questionChoiceFrames.last(where: { $0.answer == answer }) else { return nil }
        let y = actionHost.isFlipped ? frame.rect.midY : actionHost.bounds.height - frame.rect.midY
        return actionHost.convert(NSPoint(x: frame.rect.midX, y: y), to: nil)
    }
    #endif

    func actionCaptureContext(
        atWindowPoint point: NSPoint
    ) -> MacBubbleActionCaptureContext? {
        guard let capture = actionCaptureIdentity,
              !actionHost.isHidden else { return nil }
        let local = actionHost.convert(point, from: nil)
        guard actionHost.bounds.contains(local) else { return nil }
        return MacBubbleActionCaptureContext(
            capture: capture,
            actionPoint: NSPoint(
                x: local.x,
                y: actionHost.isFlipped ? local.y : actionHost.bounds.height - local.y
            )
        )
    }

    func actionHitTarget(
        for capture: MacBubbleActionCapture,
        atActionPoint point: NSPoint
    ) -> MacBubbleActionHitTarget? {
        guard capture == actionCaptureIdentity,
              let action = content?.action else { return nil }
        switch capture {
        case .question(let questionId):
            // A question action exists only while the question is open.
            guard action.type == "question",
                  action.questionId == questionId,
                  let frame = questionChoiceFrames.last(where: { $0.rect.contains(point) }) else {
                return nil
            }
            return .question(MacQuestionChoiceHitTarget(
                questionId: questionId,
                answer: frame.answer
            ))
        case .permission(let permissionId):
            guard action.type == "permission",
                  action.payload["decision"]?.stringValue == nil,
                  action.permissionId == permissionId,
                  let frame = permissionButtonFrames.last(where: { $0.rect.contains(point) }) else {
                return nil
            }
            return .permission(MacPermissionButtonHitTarget(
                permissionId: permissionId,
                toolName: action.toolName,
                decision: frame.decision
            ))
        }
    }

    func questionChoiceHitTarget(
        atWindowPoint point: NSPoint
    ) -> MacQuestionChoiceHitTarget? {
        guard case .question(let target)? = actionHitTarget(atWindowPoint: point) else { return nil }
        return target
    }

    func permissionButtonHitTarget(
        atWindowPoint point: NSPoint
    ) -> MacPermissionButtonHitTarget? {
        guard case .permission(let target)? = actionHitTarget(atWindowPoint: point) else { return nil }
        return target
    }

    private var actionCaptureIdentity: MacBubbleActionCapture? {
        guard let action = content?.action else { return nil }
        switch action.type {
        case "question":
            guard !(action.choices?.isEmpty ?? true),
                  let questionId = action.questionId else { return nil }
            return .question(questionId)
        case "permission":
            guard action.payload["decision"]?.stringValue == nil,
                  let permissionId = action.permissionId else { return nil }
            return .permission(permissionId)
        default:
            return nil
        }
    }

    var htmlArtifactCount: Int { content?.htmlArtifacts.count ?? 0 }
    var hasProvisionalCodeHighlight: Bool {
        guard let body = content?.body else { return false }
        var found = false
        body.enumerateAttribute(
            .tkCodeHighlightProvisional,
            in: NSRange(location: 0, length: body.length)
        ) { value, _, stop in
            if value != nil {
                found = true
                stop.pointee = true
            }
        }
        return found
    }
    var htmlArtifactIDs: [String] { content?.htmlArtifacts.map(\.id) ?? [] }

    var htmlArtifactFrameInSuperview: NSRect? {
        guard htmlArtifactCount > 0, !artifactCardsView.isHidden, artifactCardsView.frame.height > 0 else {
            return nil
        }
        return artifactCardsView.frame.offsetBy(dx: frame.minX, dy: frame.minY)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        contentClipView.clipsToBounds = true
        addSubview(contentClipView)
        contentClipView.addSubview(bubbleBG)
        contentClipView.addSubview(coreTextBodyView)
        contentClipView.addSubview(bodyView)
        contentClipView.addSubview(imageHost)
        contentClipView.addSubview(artifactCardsView)
        contentClipView.addSubview(actionHost)
        addSubview(stepsMaterial)
        addSubview(stepsButton)

        bodyView.isEditable = false
        bodyView.isSelectable = false
        bodyView.isRichText = true
        bodyView.drawsBackground = false
        bodyView.backgroundColor = .clear
        bodyView.textContainerInset = .zero
        bodyView.textContainer?.lineFragmentPadding = 0

        actionHost.wantsLayer = true
        actionHost.layer?.backgroundColor = NSColor.clear.cgColor
        imageHost.wantsLayer = true
        imageHost.layer?.backgroundColor = NSColor.clear.cgColor

        stepsMaterial.wantsLayer = true
        stepsMaterial.layer?.cornerRadius = 10
        stepsMaterial.layer?.masksToBounds = true
        stepsMaterial.layer?.backgroundColor = NSColor.tertiarySystemFill.cgColor
        stepsMaterial.isHidden = true

        stepsButton.title = "···"
        stepsButton.isBordered = false
        stepsButton.font = .systemFont(ofSize: 14, weight: .bold)
        stepsButton.contentTintColor = .secondaryLabelColor
        stepsButton.target = self
        stepsButton.action = #selector(stepsTapped)
        stepsButton.isHidden = true
        stepsButton.setAccessibilityLabel("Show steps")

        deliveryStatus.isBordered = false
        deliveryStatus.imagePosition = .imageOnly
        deliveryStatus.target = self
        deliveryStatus.action = #selector(deliveryStatusClicked(_:))
        deliveryStatus.isHidden = true
        addSubview(deliveryStatus)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func prepareForReuse() {
        super.prepareForReuse()
        deliveryStatusRevealWork?.cancel()
        deliveryStatus.isHidden = true
        if dimmedMessageID != nil { pendingContentViews.forEach { $0.alphaValue = 1 } }
        dimmedMessageID = nil
        onPendingAction = nil
        content = nil
        bubbleSeq = 0
        canShowStepsFlag = false
        isLiveFlag = false
        isPlaceholderFlag = false
        usesCoreTextBodyFlag = false
        renderRevision = ""
        onTapSteps = nil
        onResolvePermission = nil
        onAnswerQuestion = nil
        onOpenImage = nil
        onOpenHTMLArtifact = nil
        onHeightInvalidated = nil
        bodyHasLinks = false
        bodyHasTables = false
        usesCoreTextBody = false
        measuredBodyHeight = 0
        measuredActionHeight = 0
        questionChoiceFrames.removeAll(keepingCapacity: true)
        permissionButtonFrames.removeAll(keepingCapacity: true)
        coreTextBodyView.configure(nil)
        coreTextBodyView.isHidden = true
        bodyView.textStorage?.setAttributedString(NSAttributedString())
        bodyView.isHidden = true
        bodyView.isSelectable = false
        imageHost.rootView = nil
        artifactCardsView.reset()
        actionHost.rootView = nil
        tableViews.forEach { $0.removeFromSuperview() }
        tableViews.removeAll(keepingCapacity: true)
        tableContentKeys.removeAll(keepingCapacity: true)
        stepsButton.isHidden = true
        stepsMaterial.isHidden = true
        bubbleBG.fillColor = .clear
        bubbleBG.frame = .zero
    }

    /// Show estimated geometry without touching TextKit. Cold rows use this
    /// while a scroll gesture outruns attributed-content warming, so the
    /// viewport never collapses to a blank page. Real content replaces it one
    /// cell per frame after the gesture settles.
    func configurePlaceholder(documentWidth: CGFloat, estimatedHeight: CGFloat) {
        content = nil
        bubbleSeq = 0
        canShowStepsFlag = false
        isLiveFlag = false
        isPlaceholderFlag = true
        usesCoreTextBodyFlag = false
        renderRevision = "placeholder"
        documentWidthVar = documentWidth
        measuredBodyHeight = 0
        measuredActionHeight = 0
        usesCoreTextBody = false
        questionChoiceFrames.removeAll(keepingCapacity: true)
        permissionButtonFrames.removeAll(keepingCapacity: true)
        coreTextBodyView.configure(nil)
        coreTextBodyView.isHidden = true
        bodyView.isHidden = true
        imageHost.isHidden = true
        artifactCardsView.isHidden = true
        actionHost.isHidden = true
        stepsButton.isHidden = true
        stepsMaterial.isHidden = true
        deliveryStatusRevealWork?.cancel()
        deliveryStatus.isHidden = true
        tableViews.forEach { $0.isHidden = true }

        let width = max(120, documentWidth * 0.72)
        let height = max(44, estimatedHeight - MacChatBubbleLayout.outerV * 2)
        bubbleBG.fillColor = NSColor.tertiarySystemFill
        bubbleBG.radii = (12, 12, 12, 12)
        bubbleBG.frame = NSRect(
            x: MacChatBubbleLayout.outerH,
            y: MacChatBubbleLayout.outerV,
            width: width,
            height: height
        )
        bubbleBG.needsLayout = true
    }

    func configure(
        content: MacChatBubbleContent,
        renderKey: String,
        documentWidth: CGFloat,
        sessionMode: SessionMode,
        attachmentStore: AttachmentStore? = nil,
        onTapSteps: @escaping (MacChatBubbleCell) -> Void,
        onResolvePermission: @escaping (String, String?, String) -> Void,
        onAnswerQuestion: @escaping (String, String) -> Void,
        onOpenImage: @escaping (MacImagePreviewSelection) -> Void,
        onOpenHTMLArtifact: @escaping (ContentRef) -> Void,
        onHeightInvalidated: @escaping () -> Void
    ) {
        #if KRAKI_DIAG
        let diagWork = KrakiDiag.beginWork()
        defer { KrakiDiag.endWork(diagWork, source: "mac.cell_configure", seq: content.seq) }
        #endif
        self.content = content
        renderRevision = renderKey
        isPlaceholderFlag = false
        bubbleSeq = content.seq
        canShowStepsFlag = content.canShowSteps
        isLiveFlag = content.isLive
        documentWidthVar = documentWidth
        self.sessionMode = sessionMode
        self.onTapSteps = onTapSteps
        self.onResolvePermission = onResolvePermission
        self.onAnswerQuestion = onAnswerQuestion
        self.onOpenImage = onOpenImage
        self.onOpenHTMLArtifact = onOpenHTMLArtifact
        self.onHeightInvalidated = onHeightInvalidated

        bodyHasLinks = false
        bodyHasTables = false
        content.body?.enumerateAttributes(
            in: NSRange(location: 0, length: content.body?.length ?? 0)
        ) { attributes, _, stop in
            if attributes[.link] != nil { bodyHasLinks = true }
            if attributes[.attachment] is MacTableAttachment { bodyHasTables = true }
            if bodyHasLinks && bodyHasTables { stop.pointee = true }
        }
        let coreTextArtifact = content.body.flatMap {
            MacCoreTextLayoutArtifact.cached(
                attributed: $0,
                width: content.bodyTextWidth,
                key: renderKey
            )
        }
        usesCoreTextBody = coreTextArtifact != nil
        usesCoreTextBodyFlag = usesCoreTextBody
        if let coreTextArtifact {
            coreTextBodyView.configure(coreTextArtifact)
            coreTextBodyView.isHidden = false
            measuredBodyHeight = coreTextArtifact.height
            bodyView.textStorage?.setAttributedString(NSAttributedString())
            bodyView.isHidden = true
            bodyView.isSelectable = false
            bodyView.setAccessibilityElement(false)
        } else {
            coreTextBodyView.configure(nil)
            coreTextBodyView.isHidden = true
            bodyView.textStorage?.setAttributedString(content.body ?? NSAttributedString())
            bodyView.isSelectable = bodyHasLinks
            bodyView.setAccessibilityElement(bodyHasLinks)
            bodyView.lazyAccessibilityBody = content.body ?? NSAttributedString()
            bodyView.setTableViewportWidth(content.bodyTextWidth)
            bodyView.textContainer?.size = NSSize(
                width: content.bodyTextWidth,
                height: CGFloat.greatestFiniteMagnitude
            )
            if let container = bodyView.textContainer,
               let layoutManager = bodyView.layoutManager {
                layoutManager.ensureLayout(for: container)
                measuredBodyHeight = content.body == nil
                    ? 0
                    : max(ceil(layoutManager.usedRect(for: container).height), 1)
            } else {
                measuredBodyHeight = 0
            }
            bodyView.isHidden = content.body == nil
        }
        imageHost.isHidden = false
        artifactCardsView.isHidden = content.htmlArtifacts.isEmpty
        actionHost.isHidden = false
        tableViews.forEach { $0.isHidden = false }

        bubbleBG.fillColor = content.bubbleColor
        bubbleBG.radii = content.cornerRadii

        stepsButton.isHidden = !content.canShowSteps
        stepsMaterial.isHidden = !content.canShowSteps
        configureDeliveryStatus(content)

        imageHost.rootView = (content.inlineImages.isEmpty && content.imageRefs.isEmpty)
            ? nil
            : MacBubbleImageGrid(
                inlineImages: content.inlineImages,
                refs: content.imageRefs,
                sessionId: content.sessionId,
                maxWidth: content.attachmentWidth,
                alignment: content.kind == .user ? .trailing : .leading,
                attachmentStore: attachmentStore,
                onOpenImage: { [weak self] selection in self?.onOpenImage?(selection) }
            )

        artifactCardsView.configure(artifacts: content.htmlArtifacts) { [weak self] artifact in
            self?.onOpenHTMLArtifact?(artifact)
        }

        questionChoiceFrames.removeAll(keepingCapacity: true)
        permissionButtonFrames.removeAll(keepingCapacity: true)
        actionHost.rootView = content.action.map { action in
            MacBubbleActionSlot(
                action: action,
                layoutWidth: content.bodyTextWidth,
                sessionMode: sessionMode,
                onResolvePermission: { [weak self] id, tool, decision in
                    self?.onResolvePermission?(id, tool, decision)
                },
                onAnswerQuestion: { [weak self] id, answer in
                    self?.onAnswerQuestion?(id, answer)
                },
                onQuestionChoiceFramesChanged: { [weak self] frames in
                    guard self?.content?.action?.questionId == action.questionId else { return }
                    self?.questionChoiceFrames = frames
                },
                onPermissionButtonFramesChanged: { [weak self] frames in
                    guard self?.content?.action?.permissionId == action.permissionId else { return }
                    self?.permissionButtonFrames = frames
                }
            )
        }
        if content.action != nil {
            actionHost.frame = NSRect(x: 0, y: 0, width: content.bodyTextWidth, height: 1)
            actionHost.layoutSubtreeIfNeeded()
            measuredActionHeight = max(ceil(actionHost.fittingSize.height), 1)
        } else {
            measuredActionHeight = 0
        }

        let configuredRenderKey = renderRevision
        DispatchQueue.main.async { [weak self] in
            guard let self, self.renderRevision == configuredRenderKey else { return }
            self.validateDeferredActionHeight(renderKey: configuredRenderKey)
        }

        let exposesInteractiveContent = content.action != nil
            || bodyHasTables
            || !content.inlineImages.isEmpty
            || !content.imageRefs.isEmpty
            || !content.htmlArtifacts.isEmpty
        setAccessibilityElement(!exposesInteractiveContent)
        setAccessibilityRole(.group)
        // Plain text is produced lazily in accessibilityLabel(): converting
        // the whole body here ran on every streaming delta.
        accessibilityBody = exposesInteractiveContent ? nil : (content.body ?? NSAttributedString())
        needsLayout = true
    }

    /// Exact height after `configure` has already installed and laid out the
    /// TextKit body. This reuses that live layout instead of running the
    /// separate offscreen MacTextMeasure path a second time.
    func configuredHeight() -> CGFloat {
        guard let content else { return 1 }
        _ = refreshActionHeightFromHost()
        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        var bubbleInnerHeight = measuredBodyHeight
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += MacChatBubbleLayout.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        if measuredActionHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += measuredActionHeight
        }
        let hasBubbleContent = bubbleInnerHeight > 0
        let bubbleCellHeight = hasBubbleContent
            ? bubbleInnerHeight + MacChatBubbleLayout.msgPadV * 2 + MacChatBubbleLayout.outerV * 2
            : 0
        let imageHeight = Self.imagesHeight(content: content, width: content.attachmentWidth)
        guard imageHeight > 0 else { return max(bubbleCellHeight, 1) }
        if hasBubbleContent {
            return bubbleCellHeight + MacChatBubbleLayout.attachmentSpacing + imageHeight
        }
        return imageHeight + MacChatBubbleLayout.outerV * 2
    }

    @discardableResult
    func captureHTMLArtifactCard(to path: String) -> Bool {
        guard htmlArtifactCount > 0, !artifactCardsView.isHidden else { return false }
        artifactCardsView.layoutSubtreeIfNeeded()
        let bounds = artifactCardsView.bounds
        guard bounds.width > 1, bounds.height > 1,
              let bitmap = artifactCardsView.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        artifactCardsView.cacheDisplay(in: bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [.compressionFactor: 1]) else {
            return false
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    func openHTMLArtifact(id: String? = nil) -> Bool {
        artifactCardsView.openArtifact(id: id)
    }

    @objc private func stepsTapped() { onTapSteps?(self) }

    @discardableResult
    private func refreshActionHeightFromHost() -> Bool {
        guard content?.action != nil else { return false }
        actionHost.layoutSubtreeIfNeeded()
        let nextHeight = max(ceil(actionHost.fittingSize.height), 1)
        guard abs(measuredActionHeight - nextHeight) > 0.5 else { return false }
        measuredActionHeight = nextHeight
        needsLayout = true
        return true
    }

    private func validateDeferredActionHeight(renderKey: String) {
        guard renderRevision == renderKey else { return }
        if refreshActionHeightFromHost() {
            onHeightInvalidated?()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { [weak self] in
            guard let self, self.renderRevision == renderKey else { return }
            if self.refreshActionHeightFromHost() {
                self.onHeightInvalidated?()
            }
        }
    }

    override func layout() {
        MacChatCost.measure("cell.layout") { layoutBody() }
    }

    private func layoutBody() {
        super.layout()
        contentClipView.frame = bounds
        guard let content else { return }
        let cellWidth = documentWidthVar > 0 ? documentWidthVar : bounds.width
        let bubbleWidth = content.bubbleWidth
        let x: CGFloat
        switch content.kind {
        case .agent:
            x = MacChatBubbleLayout.outerH
        case .user:
            x = cellWidth - MacChatBubbleLayout.outerH - bubbleWidth
        case .error, .system:
            x = (cellWidth - bubbleWidth) / 2
        }
        let y = MacChatBubbleLayout.outerV
        let innerX = x + MacChatBubbleLayout.msgPadH
        let innerWidth = content.bodyTextWidth
        var cursorY = y + MacChatBubbleLayout.msgPadV

        let bodyHeight = measuredBodyHeight
        if bodyHeight > 0 {
            let bodyFrame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: bodyHeight)
            if usesCoreTextBody {
                coreTextBodyView.frame = bodyFrame
                bodyView.frame = .zero
                syncTableViews(bodyOrigin: coreTextBodyView.frame.origin)
            } else {
                coreTextBodyView.frame = .zero
                bodyView.frame = bodyFrame
                syncTableViews(bodyOrigin: bodyView.frame.origin)
            }
            cursorY += bodyHeight
        } else {
            coreTextBodyView.frame = .zero
            bodyView.frame = .zero
            syncTableViews(bodyOrigin: .zero)
        }

        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if cursorY > y + MacChatBubbleLayout.msgPadV { cursorY += MacChatBubbleLayout.imageSpacing }
            artifactCardsView.frame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: artifactHeight)
            cursorY += artifactHeight
        } else {
            artifactCardsView.frame = .zero
        }

        let actionHeight = measuredActionHeight
        if actionHeight > 0 {
            if cursorY > y + MacChatBubbleLayout.msgPadV { cursorY += 8 }
            actionHost.frame = NSRect(x: innerX, y: cursorY, width: innerWidth, height: actionHeight)
            cursorY += actionHeight
        } else {
            actionHost.frame = .zero
        }

        let hasBubbleContent = measuredBodyHeight > 0 || artifactHeight > 0 || actionHeight > 0
        let bubbleHeight: CGFloat
        if hasBubbleContent {
            cursorY += MacChatBubbleLayout.msgPadV
            bubbleHeight = max(cursorY - y, 1)
            bubbleBG.isHidden = false
            bubbleBG.frame = NSRect(x: x, y: y, width: bubbleWidth, height: bubbleHeight)
        } else {
            bubbleHeight = 0
            bubbleBG.isHidden = true
            bubbleBG.frame = .zero
        }

        let attachmentWidth = content.attachmentWidth
        let imageHeight = Self.imagesHeight(content: content, width: attachmentWidth)
        if imageHeight > 0 {
            let imageY = hasBubbleContent
                ? y + bubbleHeight + MacChatBubbleLayout.attachmentSpacing
                : y
            let imageX: CGFloat
            switch content.kind {
            case .agent:
                imageX = MacChatBubbleLayout.outerH
            case .user:
                imageX = cellWidth - MacChatBubbleLayout.outerH - attachmentWidth
            case .error, .system:
                imageX = (cellWidth - attachmentWidth) / 2
            }
            imageHost.frame = NSRect(
                x: imageX,
                y: imageY,
                width: attachmentWidth,
                height: imageHeight
            )
        } else {
            imageHost.frame = .zero
        }

        if !deliveryStatus.isHidden {
            // Beside the message's last block (the image when present).
            let anchor = imageHeight > 0 ? imageHost.frame
                : NSRect(x: x, y: y, width: bubbleWidth, height: max(bubbleHeight, 1))
            deliveryStatus.frame = NSRect(x: anchor.minX - 26, y: anchor.maxY - 22, width: 22, height: 22)
        }

        if !stepsButton.isHidden {
            // Steps "···" rides the bubble's top-LEADING edge (as on iOS).
            let size = NSSize(width: 34, height: 20)
            let frame = NSRect(
                x: x + 8,
                y: y - size.height / 2,
                width: size.width,
                height: size.height
            )
            stepsMaterial.frame = frame
            stepsButton.frame = frame
        }
    }

    private func syncTableViews(bodyOrigin: NSPoint) {
        let placements: [(layout: MacTableLayout, frame: NSRect)]
        let anchor: NSView
        if usesCoreTextBody, let artifact = coreTextBodyView.artifact {
            placements = artifact.tables.map { ($0.attachment.tableLayout, $0.frame) }
            anchor = coreTextBodyView
        } else {
            placements = bodyView.tablePlacements().map { ($0.attachment.tableLayout, $0.frame) }
            anchor = bodyView
        }
        reconcileTableViews(placements.map(\.layout), above: anchor)
        let surface = content.map { $0.bubbleColor == .clear ? NSColor.windowBackgroundColor : $0.bubbleColor }
            ?? .windowBackgroundColor
        for (index, placement) in placements.enumerated() where index < tableViews.count {
            if tableViews[index].surfaceColor != surface { tableViews[index].surfaceColor = surface }
            var frame = placement.frame
            frame.origin.x += bodyOrigin.x
            frame.origin.y += bodyOrigin.y
            if tableViews[index].frame != frame {
                tableViews[index].frame = frame
            }
        }
    }

    /// Streaming re-parses the body on every revision, producing new table
    /// attachment objects each time. Match table views by *content* so only a
    /// table that actually changed (the one still receiving rows) is rebuilt;
    /// re-inserting NSScrollViews on every token was the dominant main-thread
    /// cost of long streaming answers.
    private func reconcileTableViews(_ layouts: [MacTableLayout], above anchor: NSView) {
        let keys = layouts.map(\.contentKey)
        guard keys != tableContentKeys else { return }
        var reusable: [String: [MacTableScrollView]] = [:]
        for (key, view) in zip(tableContentKeys, tableViews) { reusable[key, default: []].append(view) }
        var next: [MacTableScrollView] = []
        next.reserveCapacity(layouts.count)
        for (key, layout) in zip(keys, layouts) {
            if var pool = reusable[key], !pool.isEmpty {
                next.append(pool.removeFirst())
                reusable[key] = pool
            } else {
                let table = MacTableScrollView(layout: layout)
                contentClipView.addSubview(table, positioned: .above, relativeTo: anchor)
                next.append(table)
            }
        }
        reusable.values.joined().forEach { $0.removeFromSuperview() }
        tableViews = next
        tableContentKeys = keys
    }

    static func height(
        for content: MacChatBubbleContent,
        bodyHeight: CGFloat,
        actionHeight: CGFloat = 0
    ) -> CGFloat {
        var bubbleInnerHeight = bodyHeight
        let artifactHeight = MacHTMLArtifactCardsView.height(for: content.htmlArtifacts.count)
        if artifactHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += MacChatBubbleLayout.imageSpacing }
            bubbleInnerHeight += artifactHeight
        }
        if actionHeight > 0 {
            if bubbleInnerHeight > 0 { bubbleInnerHeight += 8 }
            bubbleInnerHeight += actionHeight
        }
        let hasBubbleContent = bubbleInnerHeight > 0
        let bubbleCellHeight = hasBubbleContent
            ? bubbleInnerHeight + MacChatBubbleLayout.msgPadV * 2 + MacChatBubbleLayout.outerV * 2
            : 0
        let imageHeight = imagesHeight(content: content, width: content.attachmentWidth)
        guard imageHeight > 0 else { return max(bubbleCellHeight, 1) }
        if hasBubbleContent {
            return bubbleCellHeight + MacChatBubbleLayout.attachmentSpacing + imageHeight
        }
        return imageHeight + MacChatBubbleLayout.outerV * 2
    }

    static func height(
        for content: MacChatBubbleContent,
        documentWidth: CGFloat,
        sessionMode: SessionMode
    ) -> CGFloat {
        let bodyHeight = bodyHeight(content)
        let actionHeight = actionHeight(
            content.action,
            width: content.bodyTextWidth,
            sessionMode: sessionMode,
            onResolvePermission: nil,
            onAnswerQuestion: nil
        )
        return height(for: content, bodyHeight: bodyHeight, actionHeight: actionHeight)
    }

    private static func bodyHeight(_ content: MacChatBubbleContent) -> CGFloat {
        content.body.map {
            MacTextMeasure.height($0, width: content.bodyTextWidth)
        } ?? 0
    }

    private static func imagesHeight(content: MacChatBubbleContent, width: CGFloat) -> CGFloat {
        MacImageGalleryLayout.height(
            inlineImages: content.inlineImages,
            refs: content.imageRefs,
            maxWidth: width
        )
    }

    private static func inlineImageHeight(_ image: NSImage, maxWidth: CGFloat) -> CGFloat {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return 0 }
        var height = min(size.width, maxWidth) * size.height / size.width
        if height > MacChatBubbleLayout.imageMaxHeight { height = MacChatBubbleLayout.imageMaxHeight }
        return height
    }

    private static func actionHeight(
        _ action: ChatMessage?,
        width: CGFloat,
        sessionMode: SessionMode,
        onResolvePermission: ((String, String?, String) -> Void)?,
        onAnswerQuestion: ((String, String) -> Void)?
    ) -> CGFloat {
        guard let action, action.type != "compaction" else { return 0 }
        let host = NSHostingView(rootView: MacBubbleActionSlot(
            action: action,
            layoutWidth: width,
            sessionMode: sessionMode,
            onResolvePermission: onResolvePermission ?? { _, _, _ in },
            onAnswerQuestion: onAnswerQuestion ?? { _, _ in }
        ))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        return max(ceil(host.fittingSize.height), 1)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        guard let content else { return nil }
        let menu = NSMenu()
        if coreTextBodyView.hasSelection {
            let copy = NSMenuItem(
                title: "Copy Selection",
                action: #selector(MacCoreTextBodyView.copySelection(_:)),
                keyEquivalent: ""
            )
            copy.target = coreTextBodyView
            menu.addItem(copy)
        } else if let text = MacMarkdown.plainText(content.body), !text.isEmpty {
            let copy = NSMenuItem(title: "Copy", action: #selector(copyMessage), keyEquivalent: "")
            copy.target = self
            menu.addItem(copy)
        }
        if content.canShowSteps {
            let steps = NSMenuItem(title: "Show Steps", action: #selector(stepsTapped), keyEquivalent: "")
            steps.target = self
            menu.addItem(steps)
        }
        if ["failed", "correcting", "unconfirmed"].contains(content.pendingDeliveryState ?? "") {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            pendingActionItems().forEach { menu.addItem($0) }
        }
        return menu.items.isEmpty ? nil : menu
    }

    // MARK: Optimistic delivery state

    var onPendingAction: ((String, MacPendingAction) -> Void)?

    #if DEBUG
    var deliveryStatusForRegression: String? {
        deliveryStatus.isHidden ? nil : deliveryStatus.accessibilityLabel()
    }
    #endif

    private func pendingActionItems() -> [NSMenuItem] {
        let actions: [(String, MacPendingAction)] = content?.pendingDeliveryState == "correcting"
            ? [("Send Original", .sendOriginal), ("Edit", .edit), ("Delete", .delete)]
            : [("Retry", .retry), ("Delete", .delete)]
        return actions.map { title, action in
            let item = NSMenuItem(title: title, action: #selector(pendingMenuAction(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = action
            return item
        }
    }

    @objc private func pendingMenuAction(_ sender: NSMenuItem) {
        guard let clientId = content?.pendingClientId,
              let action = sender.representedObject as? MacPendingAction else { return }
        onPendingAction?(clientId, action)
    }

    @objc private func deliveryStatusClicked(_ sender: NSButton) {
        guard ["failed", "correcting", "unconfirmed"].contains(content?.pendingDeliveryState ?? "") else { return }
        let menu = NSMenu()
        pendingActionItems().forEach { menu.addItem($0) }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
    }

    /// Beside an optimistic bubble: "sending" appears only after a short
    /// delay so fast confirmations never flash an icon; "failed" is a red
    /// mark whose click offers Retry / Delete. Sent but not delivered dims the
    /// whole message (text bubble and image) after the same delay.
    private var pendingContentViews: [NSView] {
        [bubbleBG, bodyView, coreTextBodyView, imageHost, artifactCardsView] + tableViews
    }
    private var dimmedMessageID: String?

    private func applyPendingDim(_ content: MacChatBubbleContent) {
        // Most rows are never pending: touch no view properties for them.
        guard content.pendingDeliveryState != nil || dimmedMessageID != nil else { return }
        if content.pendingDeliveryState == "sending" {
            let id = content.pendingClientId ?? "\(content.sessionId):\(content.seq)"
            guard dimmedMessageID != id else { return }
            dimmedMessageID = id
            pendingContentViews.forEach { $0.alphaValue = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self, self.dimmedMessageID == id else { return }
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.25
                    self.pendingContentViews.forEach { $0.animator().alphaValue = 0.6 }
                }
            }
        } else {
            let wasDimmed = dimmedMessageID != nil
            dimmedMessageID = nil
            if wasDimmed {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.15
                    self.pendingContentViews.forEach { $0.animator().alphaValue = 1 }
                }
            }
        }
    }

    private func configureDeliveryStatus(_ content: MacChatBubbleContent) {
        deliveryStatusRevealWork?.cancel()
        applyPendingDim(content)
        guard let state = content.pendingDeliveryState else {
            deliveryStatus.isHidden = true
            return
        }
        deliveryStatus.isHidden = false
        let symbol = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        if state == "correcting" {
            deliveryStatus.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Correcting voice input")?.withSymbolConfiguration(symbol)
            deliveryStatus.contentTintColor = .secondaryLabelColor
            deliveryStatus.isEnabled = true
            deliveryStatus.alphaValue = 1
            deliveryStatus.setAccessibilityLabel("Correcting voice input. Click for options")
            deliveryStatus.toolTip = "Correcting voice input"
        } else if state == "unconfirmed" {
            deliveryStatus.image = NSImage(systemSymbolName: "questionmark.circle",
                accessibilityDescription: "Awaiting confirmation")?.withSymbolConfiguration(symbol)
            deliveryStatus.contentTintColor = .systemOrange
            deliveryStatus.isEnabled = true
            deliveryStatus.alphaValue = 1
            deliveryStatus.setAccessibilityLabel("Awaiting confirmation. Click to retry or delete")
            deliveryStatus.toolTip = "Delivery not confirmed yet. Retry uses the same message ID."
        } else if state == "failed" {
            deliveryStatus.image = NSImage(systemSymbolName: "exclamationmark.circle.fill",
                                           accessibilityDescription: "Not delivered")?.withSymbolConfiguration(symbol)
            deliveryStatus.contentTintColor = .systemRed
            deliveryStatus.isEnabled = true
            deliveryStatus.alphaValue = 1
            deliveryStatus.setAccessibilityLabel("Not delivered. Click to retry or delete")
            deliveryStatus.toolTip = "Not delivered"
        } else {
            deliveryStatus.image = NSImage(systemSymbolName: "clock",
                                           accessibilityDescription: "Sending")?.withSymbolConfiguration(symbol)
            deliveryStatus.contentTintColor = .tertiaryLabelColor
            deliveryStatus.isEnabled = false
            deliveryStatus.setAccessibilityLabel("Sending")
            deliveryStatus.toolTip = nil
            deliveryStatus.alphaValue = 0
            let work = DispatchWorkItem { [weak self] in
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.25
                    self?.deliveryStatus.animator().alphaValue = 1
                }
            }
            deliveryStatusRevealWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
        }
    }

    @objc private func copyMessage() {
        guard let text = MacMarkdown.plainText(content?.body), !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Rounded background supporting four independent corner radii, matching the
/// iOS `TKRoundedView` path exactly.
final class MacRoundedView: NSView {
    override var isFlipped: Bool { true }
    var fillColor: NSColor = .clear { didSet { needsLayout = true } }
    var radii: (CGFloat, CGFloat, CGFloat, CGFloat) = (16, 16, 16, 16) {
        didSet { needsLayout = true }
    }
    private let shape = CAShapeLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.addSublayer(shape)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let (tl, tr, bl, br) = radii
        let r = bounds
        let path = CGMutablePath()
        path.move(to: CGPoint(x: r.minX + tl, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - tr, y: r.minY))
        path.addArc(center: CGPoint(x: r.maxX - tr, y: r.minY + tr), radius: tr,
                    startAngle: -.pi / 2, endAngle: 0, clockwise: false)
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - br))
        path.addArc(center: CGPoint(x: r.maxX - br, y: r.maxY - br), radius: br,
                    startAngle: 0, endAngle: .pi / 2, clockwise: false)
        path.addLine(to: CGPoint(x: r.minX + bl, y: r.maxY))
        path.addArc(center: CGPoint(x: r.minX + bl, y: r.maxY - bl), radius: bl,
                    startAngle: .pi / 2, endAngle: .pi, clockwise: false)
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + tl))
        path.addArc(center: CGPoint(x: r.minX + tl, y: r.minY + tl), radius: tl,
                    startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: false)
        path.closeSubpath()

        var resolvedFill = fillColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            resolvedFill = fillColor.usingColorSpace(.deviceRGB) ?? fillColor
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.frame = bounds
        shape.path = path
        shape.fillColor = resolvedFill.cgColor
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }
}

#endif
