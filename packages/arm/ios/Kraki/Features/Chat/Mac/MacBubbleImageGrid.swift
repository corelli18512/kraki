#if os(macOS)
import SwiftUI

/// One page of the preview. An attachment that is still loading opens too:
/// its page shows progress and swaps in the image when the bytes arrive.
struct MacImagePreviewItem: Identifiable {
    let id = UUID()
    let image: NSImage?
    let title: String
    /// Set for an attachment ref; the page resolves it from the store.
    var attachmentID: String?

    init(image: NSImage, title: String) {
        self.image = image
        self.title = title
    }

    init(attachmentID: String, title: String) {
        self.image = nil
        self.title = title
        self.attachmentID = attachmentID
    }
}

struct MacImagePreviewSelection: Identifiable {
    let id = UUID()
    let items: [MacImagePreviewItem]
    let initialIndex: Int
    /// Where pages that are still loading get their bytes.
    var attachmentStore: AttachmentStore?
    var sessionId = ""

    init(items: [MacImagePreviewItem], initialIndex: Int = 0,
         attachmentStore: AttachmentStore? = nil, sessionId: String = "") {
        self.items = items
        self.initialIndex = min(max(initialIndex, 0), max(items.count - 1, 0))
        self.attachmentStore = attachmentStore
        self.sessionId = sessionId
    }

    init(image: NSImage, title: String) {
        self.init(items: [MacImagePreviewItem(image: image, title: title)])
    }
}

enum MacImageGalleryLayout {
    static let multiCardHeight: CGFloat = 184
    static let multiStackOffset: CGFloat = 8
    static let maximumStackDepth = 3

    static func height(inlineImages: [NSImage], refs: [ContentRef], maxWidth: CGFloat) -> CGFloat {
        let count = inlineImages.count + refs.count
        guard count > 0, maxWidth > 0 else { return 0 }
        if count > 1 {
            let depth = min(count, maximumStackDepth)
            return multiCardHeight + CGFloat(depth - 1) * multiStackOffset
        }
        if let image = inlineImages.first {
            return displaySize(source: image.size, maxWidth: maxWidth, maxHeight: 240).height
        }
        guard let ref = refs.first else { return 0 }
        let source: CGSize
        if let width = ref.width, let height = ref.height, width > 0, height > 0 {
            source = CGSize(width: width, height: height)
        } else {
            source = CGSize(width: maxWidth, height: maxWidth)
        }
        return displaySize(source: source, maxWidth: maxWidth, maxHeight: 192).height
    }

    static func displaySize(source: CGSize, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
        guard source.width > 0, source.height > 0, maxWidth > 0 else { return .zero }
        var width = min(source.width, maxWidth)
        var height = width * source.height / source.width
        if height > maxHeight {
            height = maxHeight
            width = height * source.width / source.height
        }
        return CGSize(width: width, height: height)
    }
}

/// A message-level attachment gallery that lives outside the text bubble.
/// One image is shown directly; multiple images use one compact stacked card
/// and expand into the Session-owned preview gallery when clicked.
struct MacBubbleImageGrid: View {
    private enum Entry: Identifiable {
        case image(id: String, item: MacImagePreviewItem)
        case ref(ContentRef)

        var id: String {
            switch self {
            case .image(let id, _): return id
            case .ref(let ref): return ref.id
            }
        }
    }

    let inlineImages: [NSImage]
    let refs: [ContentRef]
    let sessionId: String
    let maxWidth: CGFloat
    let alignment: Alignment
    let attachmentStore: AttachmentStore?
    var onOpenImage: (MacImagePreviewSelection) -> Void = { _ in }

    private var entries: [Entry] {
        let inline = inlineImages.enumerated().map { index, image in
            Entry.image(
                id: "inline-\(index)",
                item: MacImagePreviewItem(image: image, title: String(localized: "Image \(index + 1)"))
            )
        }
        return inline + refs.map(Entry.ref)
    }

    /// Every image of the message, loaded or not: the viewer opens on any
    /// of them and pages through all (loading pages show progress).
    private var previewItems: [(entryID: String, item: MacImagePreviewItem)] {
        entries.map { entry in
            switch entry {
            case .image(let id, let item):
                return (id, item)
            case .ref(let ref):
                return (ref.id, MacImagePreviewItem(attachmentID: ref.id, title: ref.caption ?? ref.name ?? String(localized: "Image")))
            }
        }
    }

    private func open(_ entryID: String) {
        let items = previewItems
        guard !items.isEmpty else { return }
        onOpenImage(MacImagePreviewSelection(
            items: items.map(\.item),
            initialIndex: items.firstIndex(where: { $0.entryID == entryID }) ?? 0,
            attachmentStore: attachmentStore,
            sessionId: sessionId
        ))
    }

    var body: some View {
        Group {
            if entries.count == 1, let entry = entries.first {
                single(entry)
            } else if !entries.isEmpty {
                stackedGallery
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment)
        .requestsAttachments(refs.map(\.id), sessionId: sessionId, store: attachmentStore)
    }

    @ViewBuilder
    private func single(_ entry: Entry) -> some View {
        switch entry {
        case .image(let entryID, let item):
            let size = MacImageGalleryLayout.displaySize(
                source: item.image?.size ?? .zero,
                maxWidth: maxWidth,
                maxHeight: 240
            )
            previewButton(image: item.image, entryID: entryID, cornerRadius: 12)
                .frame(width: size.width, height: size.height)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    let size = placeholderSize(ref)
                    previewButton(image: image, entryID: ref.id, cornerRadius: 10)
                        .frame(width: size.width, height: size.height)
                } else {
                    errorPlaceholder(ref, label: String(localized: "Invalid image"))
                }
            case .error(let reason):
                errorPlaceholder(ref, label: reason.isEmpty ? String(localized: "Couldn't load image") : reason)
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder(ref)
            }
        }
    }

    private var stackedGallery: some View {
        let visible = Array(entries.prefix(MacImageGalleryLayout.maximumStackDepth))
        let offsets = CGFloat(max(0, visible.count - 1)) * MacImageGalleryLayout.multiStackOffset
        let cardWidth = max(120, min(maxWidth - offsets, 360))
        return ZStack(alignment: .topLeading) {
            ForEach(Array(visible.indices.reversed()), id: \.self) { index in
                let entry = visible[index]
                stackedCard(entry, cardWidth: cardWidth)
                    .offset(
                        x: CGFloat(index) * MacImageGalleryLayout.multiStackOffset,
                        // Keep the primary image in front at the lower-left;
                        // background cards fan toward the upper-right.
                        y: CGFloat(visible.count - 1 - index) * MacImageGalleryLayout.multiStackOffset
                    )
                    .zIndex(Double(visible.count - index))
            }
            Text(verbatim: "\(entries.count)")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(.black.opacity(0.72), in: Capsule())
                .padding(9)
                .offset(x: cardWidth - 46, y: offsets)
                .zIndex(Double(visible.count + 1))
                .allowsHitTesting(false)
        }
        .frame(
            width: cardWidth + offsets,
            height: MacImageGalleryLayout.multiCardHeight + offsets,
            alignment: .topLeading
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open \(entries.count) images")
    }

    @ViewBuilder
    private func stackedCard(_ entry: Entry, cardWidth: CGFloat) -> some View {
        switch entry {
        case .image(let entryID, let item):
            previewButton(image: item.image, entryID: entryID, cornerRadius: 12)
                .frame(width: cardWidth, height: MacImageGalleryLayout.multiCardHeight)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(cardBorder)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    previewButton(image: image, entryID: ref.id, cornerRadius: 12)
                        .frame(width: cardWidth, height: MacImageGalleryLayout.multiCardHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(cardBorder)
                } else {
                    stackedErrorCard(ref, label: String(localized: "Invalid image"), width: cardWidth)
                }
            case .error(let reason):
                stackedErrorCard(ref, label: reason.isEmpty ? String(localized: "Couldn't load image") : reason, width: cardWidth)
            case .awaitingChunks, .fetching, .none:
                Button { open(ref.id) } label: {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12).fill(Color.surfaceSecondary)
                        ProgressView().controlSize(.small)
                    }
                    .frame(width: cardWidth, height: MacImageGalleryLayout.multiCardHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(openLabel)
                .accessibilityLabel(openLabel)
                .overlay(cardBorder)
            }
        }
    }

    private var cardBorder: some View {
        RoundedRectangle(cornerRadius: 12)
            .stroke(Color.borderPrimary.opacity(0.85), lineWidth: 1)
            .allowsHitTesting(false)
    }

    private var openLabel: String { entries.count > 1 ? String(localized: "Open image gallery") : String(localized: "Open image preview") }

    private func previewButton(
        image: NSImage?,
        entryID: String,
        cornerRadius: CGFloat
    ) -> some View {
        MacPreviewImageButton(
            image: image ?? NSImage(),
            cornerRadius: cornerRadius,
            accessibilityLabel: openLabel
        ) {
            open(entryID)
        }
        .help(openLabel)
    }

    private func placeholderSize(_ ref: ContentRef) -> CGSize {
        let source: CGSize
        if let width = ref.width, let height = ref.height, width > 0, height > 0 {
            source = CGSize(width: width, height: height)
        } else {
            source = CGSize(width: maxWidth, height: maxWidth)
        }
        return MacImageGalleryLayout.displaySize(source: source, maxWidth: maxWidth, maxHeight: 192)
    }

    /// Still loading, but already opens the viewer (which keeps loading).
    private func loadingPlaceholder(_ ref: ContentRef) -> some View {
        let size = placeholderSize(ref)
        return Button { open(ref.id) } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(.quaternary)
                ProgressView().controlSize(.small)
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(openLabel)
        .accessibilityLabel(openLabel)
    }

    private func errorPlaceholder(_ ref: ContentRef, label: String) -> some View {
        let size = placeholderSize(ref)
        return Button {
            attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId, priority: .userOpened)
        } label: {
            errorContent(label)
                .frame(width: size.width, height: size.height)
        }
        .buttonStyle(.plain)
    }

    private func stackedErrorCard(_ ref: ContentRef, label: String, width: CGFloat) -> some View {
        Button {
            attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId, priority: .userOpened)
        } label: {
            errorContent(label)
                .frame(width: width, height: MacImageGalleryLayout.multiCardHeight)
        }
        .buttonStyle(.plain)
        .overlay(cardBorder)
    }

    private func errorContent(_ label: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.red.opacity(0.08))
            VStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.red.opacity(0.8))
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Text("Click to retry")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(6)
        }
    }
}

private struct MacPreviewImageButton: NSViewRepresentable {
    let image: NSImage
    let cornerRadius: CGFloat
    let accessibilityLabel: String
    let onOpen: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpen: onOpen)
    }

    func makeNSView(context: Context) -> MacPreviewImageNativeButton {
        let button = MacPreviewImageNativeButton()
        button.isBordered = false
        button.imagePosition = .noImage
        button.focusRingType = .none
        button.target = context.coordinator
        button.action = #selector(Coordinator.open)
        button.wantsLayer = true
        button.layer?.masksToBounds = true
        button.setAccessibilityRole(.button)
        update(button, coordinator: context.coordinator)
        return button
    }

    func updateNSView(_ nsView: MacPreviewImageNativeButton, context: Context) {
        update(nsView, coordinator: context.coordinator)
    }

    private func update(_ button: MacPreviewImageNativeButton, coordinator: Coordinator) {
        coordinator.onOpen = onOpen
        button.previewImage = image
        button.previewCornerRadius = cornerRadius
        button.needsDisplay = true
        button.setAccessibilityLabel(accessibilityLabel)
        button.toolTip = accessibilityLabel
    }

    final class Coordinator: NSObject {
        var onOpen: () -> Void

        init(onOpen: @escaping () -> Void) {
            self.onOpen = onOpen
        }

        @objc func open() {
            onOpen()
        }
    }
}

private final class MacPreviewImageNativeButton: NSButton {
    var previewImage: NSImage?
    var previewCornerRadius: CGFloat = 10

    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let previewImage,
              bounds.width > 0,
              bounds.height > 0,
              previewImage.size.width > 0,
              previewImage.size.height > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: bounds, xRadius: previewCornerRadius, yRadius: previewCornerRadius).addClip()
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()

        let destinationRatio = bounds.width / bounds.height
        let sourceRatio = previewImage.size.width / previewImage.size.height
        let sourceRect: NSRect
        if sourceRatio > destinationRatio {
            let sourceWidth = previewImage.size.height * destinationRatio
            sourceRect = NSRect(
                x: (previewImage.size.width - sourceWidth) / 2,
                y: 0,
                width: sourceWidth,
                height: previewImage.size.height
            )
        } else {
            let sourceHeight = previewImage.size.width / destinationRatio
            sourceRect = NSRect(
                x: 0,
                y: (previewImage.size.height - sourceHeight) / 2,
                width: previewImage.size.width,
                height: sourceHeight
            )
        }
        NSGraphicsContext.current?.imageInterpolation = .high
        previewImage.draw(
            in: bounds,
            from: sourceRect,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: true,
            hints: nil
        )
        NSGraphicsContext.restoreGraphicsState()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        event?.type == .leftMouseDown
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

struct MacImagePreviewOverlay: View {
    let selection: MacImagePreviewSelection
    let onClose: () -> Void

    @State private var zoom: CGFloat = 1
    @State private var index: Int

    init(selection: MacImagePreviewSelection, onClose: @escaping () -> Void) {
        self.selection = selection
        self.onClose = onClose
        _index = State(initialValue: selection.initialIndex)
    }

    private var item: MacImagePreviewItem {
        selection.items[min(max(index, 0), max(selection.items.count - 1, 0))]
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.94)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)
                .accessibilityHidden(true)

            Group {
                if let image = resolvedImage(item) {
                    MacZoomableImageCanvas(
                        image: image,
                        zoom: $zoom,
                        onBackdropClick: onClose
                    )
                } else {
                    pendingPage(item)
                }
            }
                .id(item.id)
                .padding(.top, 52)
                .padding(18)

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(item.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if selection.items.count > 1 {
                        Text(verbatim: "\(index + 1) / \(selection.items.count)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    Spacer()
                    if selection.items.count > 1 {
                        previewButton("chevron.left", label: String(localized: "Previous image")) {
                            show(index - 1)
                        }
                        .disabled(index == 0)
                        previewButton("chevron.right", label: String(localized: "Next image")) {
                            show(index + 1)
                        }
                        .disabled(index == selection.items.count - 1)
                    }
                    previewButton("minus.magnifyingglass", label: String(localized: "Zoom out")) {
                        zoom = Self.clamp(zoom / 1.25)
                    }
                    Text(verbatim: "\(Double(zoom).formatted(.number.precision(.fractionLength(1))))×")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.72))
                        .frame(width: 48)
                    previewButton("plus.magnifyingglass", label: String(localized: "Zoom in")) {
                        zoom = Self.clamp(zoom * 1.25)
                    }
                    previewButton("arrow.down.right.and.arrow.up.left", label: String(localized: "Fit to window")) {
                        zoom = 1
                    }
                    previewButton("xmark", label: String(localized: "Close image preview")) {
                        onClose()
                    }
                    .keyboardShortcut(.cancelAction)
                }
                .padding(.horizontal, 14)
                .frame(height: 52)
                .background(.ultraThinMaterial.opacity(0.9))
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onExitCommand(perform: onClose)
        .onKeyPress(.leftArrow) {
            guard index > 0 else { return .ignored }
            show(index - 1)
            return .handled
        }
        .onKeyPress(.rightArrow) {
            guard index + 1 < selection.items.count else { return .ignored }
            show(index + 1)
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Image preview")
        // Opened: every image of the message loads at user priority, so the
        // neighbours are ready by the time the user pages to them.
        .onAppear { holdAttachments(true) }
        .onDisappear { holdAttachments(false) }
    }

    private func holdAttachments(_ hold: Bool) {
        guard let store = selection.attachmentStore else { return }
        let ids = selection.items.enumerated()
            .sorted { abs($0.offset - selection.initialIndex) < abs($1.offset - selection.initialIndex) }
            .compactMap(\.element.attachmentID)
        for id in ids {
            if hold {
                store.requestIfNeeded(id: id, sessionId: selection.sessionId, priority: .userOpened)
            } else {
                store.release(id: id, priority: .userOpened)
            }
        }
    }

    private func resolvedImage(_ item: MacImagePreviewItem) -> NSImage? {
        if let image = item.image { return image }
        guard let id = item.attachmentID,
              case .ready(_, let data) = selection.attachmentStore?.state(for: id) else { return nil }
        return AttachmentImageCache.image(id: id, data: data)
    }

    @ViewBuilder
    private func pendingPage(_ item: MacImagePreviewItem) -> some View {
        let state = item.attachmentID.flatMap { selection.attachmentStore?.state(for: $0) }
        VStack(spacing: 10) {
            switch state {
            case .error(let reason):
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Text(reason.isEmpty ? String(localized: "Couldn't load image") : reason)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.75))
                Button("Retry") {
                    guard let id = item.attachmentID, let store = selection.attachmentStore else { return }
                    store.requestIfNeeded(id: id, sessionId: selection.sessionId, priority: .userOpened)
                    store.release(id: id, priority: .userOpened)
                }
            case .ready:
                Text("Invalid image")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.75))
            case .awaitingChunks(let received, let total?) where total > 1:
                ProgressView(value: Double(received) / Double(total))
                    .progressViewStyle(.circular)
                Text(verbatim: (Double(received * 100 / total) / 100).formatted(.percent.precision(.fractionLength(0))))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
            default:
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Loading image")
    }

    private func show(_ nextIndex: Int) {
        guard selection.items.indices.contains(nextIndex) else { return }
        index = nextIndex
        zoom = 1
    }

    private func previewButton(
        _ systemName: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
        .help(label)
        .accessibilityLabel(label)
    }

    static func clamp(_ value: CGFloat) -> CGFloat {
        min(max(value, 1), 8)
    }
}

private struct MacZoomableImageCanvas: NSViewRepresentable {
    let image: NSImage
    @Binding var zoom: CGFloat
    let onBackdropClick: () -> Void

    func makeNSView(context: Context) -> MacZoomableImageView {
        let view = MacZoomableImageView()
        view.image = image
        view.onBackdropClick = onBackdropClick
        view.onZoomChanged = { value in
            if abs(zoom - value) > 0.001 { zoom = value }
        }
        return view
    }

    func updateNSView(_ nsView: MacZoomableImageView, context: Context) {
        nsView.image = image
        nsView.setZoom(zoom)
        nsView.onBackdropClick = onBackdropClick
        nsView.onZoomChanged = { value in
            if abs(zoom - value) > 0.001 { zoom = value }
        }
    }
}

final class MacZoomableImageView: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var onBackdropClick: (() -> Void)?
    var onZoomChanged: ((CGFloat) -> Void)?

    private var zoom: CGFloat = 1
    private var pan = CGPoint.zero
    private var dragOrigin: CGPoint?
    private var panAtDragStart = CGPoint.zero

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { false }

    #if DEBUG
    var zoomForRegression: CGFloat { zoom }
    var panForRegression: CGPoint { pan }

    @discardableResult
    func clickBackdropForRegression(at point: CGPoint) -> Bool {
        closeIfBackdrop(at: point)
    }
    #endif

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
    }

    func setZoom(_ value: CGFloat) {
        let clamped = MacImagePreviewOverlay.clamp(value)
        guard abs(zoom - clamped) > 0.001 else { return }
        zoom = clamped
        if zoom <= 1.001 { pan = .zero }
        clampPan()
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        clampPan()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image else { return }
        let rect = drawnImageRect(for: image)
        guard rect.width > 0, rect.height > 0 else { return }
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    }

    override func magnify(with event: NSEvent) {
        guard event.phase != .ended && event.phase != .cancelled else { return }
        updateZoom(zoom * (1 + event.magnification))
    }

    override func scrollWheel(with event: NSEvent) {
        let zoomModifier = event.modifierFlags.intersection([.command, .option]).isEmpty == false
        if !event.hasPreciseScrollingDeltas || zoomModifier {
            let delta = max(-4, min(4, event.scrollingDeltaY))
            guard abs(delta) > 0.001 else { return }
            updateZoom(zoom * pow(1.12, delta))
            return
        }
        guard zoom > 1.001 else { return }
        pan.x -= event.scrollingDeltaX
        pan.y += event.scrollingDeltaY
        clampPan()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard !closeIfBackdrop(at: point) else { return }
        if event.clickCount == 2 {
            updateZoom(zoom > 1.001 ? 1 : 2)
            return
        }
        dragOrigin = point
        panAtDragStart = pan
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragOrigin else { return }
        let point = convert(event.locationInWindow, from: nil)
        pan = CGPoint(
            x: panAtDragStart.x + point.x - dragOrigin.x,
            y: panAtDragStart.y + point.y - dragOrigin.y
        )
        clampPan()
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        dragOrigin = nil
    }

    override func keyDown(with event: NSEvent) {
        switch event.charactersIgnoringModifiers {
        case "+", "=": updateZoom(zoom * 1.25)
        case "-": updateZoom(zoom / 1.25)
        case "0": updateZoom(1)
        default: super.keyDown(with: event)
        }
    }

    private func updateZoom(_ value: CGFloat) {
        setZoom(value)
        onZoomChanged?(zoom)
    }

    private func drawnImageRect(for image: NSImage) -> CGRect {
        guard image.size.width > 0, image.size.height > 0 else { return .zero }
        let fitted = fittedSize(for: image.size)
        let drawn = CGSize(width: fitted.width * zoom, height: fitted.height * zoom)
        return CGRect(
            x: bounds.midX - drawn.width / 2 + pan.x,
            y: bounds.midY - drawn.height / 2 + pan.y,
            width: drawn.width,
            height: drawn.height
        )
    }

    @discardableResult
    private func closeIfBackdrop(at point: CGPoint) -> Bool {
        guard let image, !drawnImageRect(for: image).contains(point) else { return false }
        onBackdropClick?()
        return true
    }

    private func fittedSize(for imageSize: CGSize) -> CGSize {
        guard bounds.width > 0, bounds.height > 0 else { return .zero }
        let ratio = min(bounds.width / imageSize.width, bounds.height / imageSize.height, 1)
        return CGSize(width: imageSize.width * ratio, height: imageSize.height * ratio)
    }

    private func clampPan() {
        guard let image, image.size.width > 0, image.size.height > 0 else {
            pan = .zero
            return
        }
        let fitted = fittedSize(for: image.size)
        let maxX = max(0, (fitted.width * zoom - bounds.width) / 2)
        let maxY = max(0, (fitted.height * zoom - bounds.height) / 2)
        pan.x = min(max(pan.x, -maxX), maxX)
        pan.y = min(max(pan.y, -maxY), maxY)
    }
}
#endif
