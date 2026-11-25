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
    /// The original bytes of an inline image (Save Image…, Copy Image).
    var file: ChatImageFile?
    /// The attachment ref, for its file once loaded.
    var ref: ContentRef?

    init(image: NSImage, title: String, file: ChatImageFile? = nil) {
        self.image = image
        self.title = title
        self.file = file
    }

    init(attachmentID: String, title: String, ref: ContentRef? = nil) {
        self.image = nil
        self.title = title
        self.attachmentID = attachmentID
        self.ref = ref
    }

    /// The original bytes to save or copy, once they are here.
    func file(in store: AttachmentStore?) -> ChatImageFile? {
        if let file { return file }
        return ref.flatMap { ChatImageFile.ref($0, in: store) }
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

    /// Smallest side of a displayed image: a tiny image (1×1) still gets a
    /// visible, tappable card (the image fills and crops into it).
    static let minimumSide: CGFloat = 44

    static func displaySize(source: CGSize, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
        guard source.width > 0, source.height > 0, maxWidth > 0 else { return .zero }
        var width = min(source.width, maxWidth)
        var height = width * source.height / source.width
        if height > maxHeight {
            height = maxHeight
            width = height * source.width / source.height
        }
        let floor = min(minimumSide, maxWidth, maxHeight)
        return CGSize(width: max(width, floor), height: max(height, floor))
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
    /// The original bytes of `inlineImages`, in the same order.
    var inlineImageFiles: [ChatImageFile] = []
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
                item: MacImagePreviewItem(
                    image: image,
                    title: String(localized: "Image \(index + 1)"),
                    file: inlineImageFiles.indices.contains(index) ? inlineImageFiles[index] : nil
                )
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
                return (ref.id, MacImagePreviewItem(attachmentID: ref.id, title: ref.caption ?? ref.name ?? String(localized: "Image"), ref: ref))
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
            previewButton(image: item.image, file: item.file, entryID: entryID, cornerRadius: 12)
                .frame(width: size.width, height: size.height)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    let size = placeholderSize(ref)
                    previewButton(image: image, file: ChatImageFile.ref(ref, in: attachmentStore), entryID: ref.id, cornerRadius: 10)
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
            previewButton(image: item.image, file: item.file, entryID: entryID, cornerRadius: 12)
                .frame(width: cardWidth, height: MacImageGalleryLayout.multiCardHeight)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(cardBorder)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    previewButton(image: image, file: ChatImageFile.ref(ref, in: attachmentStore), entryID: ref.id, cornerRadius: 12)
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
        file: ChatImageFile?,
        entryID: String,
        cornerRadius: CGFloat
    ) -> some View {
        MacPreviewImageButton(
            image: image ?? NSImage(),
            file: file,
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
    /// Animated when a GIF; Save Image… / Copy Image on a right click.
    let file: ChatImageFile?
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
        button.player.show(file)
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

final class MacPreviewImageNativeButton: NSButton {
    var previewImage: NSImage?
    var previewCornerRadius: CGFloat = 10
    /// The GIF frame shown, else the still `previewImage`.
    private var frameImage: NSImage?
    private(set) lazy var player: ChatGIFPlayer = {
        let player = ChatGIFPlayer { [weak self] frame in
            guard let self else { return }
            self.frameImage = frame.map { NSImage(cgImage: $0, size: self.previewImage?.size ?? .zero) }
            self.needsDisplay = true
        }
        player.onPlaybackChange = { [weak self] in self?.needsDisplay = true }
        return player
    }()
    /// Ticks the GIF only while on screen (not in a hidden, pooled cell).
    private lazy var screenPresence = MacGIFScreenPresence(view: self, player: player)

    override var isOpaque: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        screenPresence.update()
    }

    override func viewDidHide() {
        super.viewDidHide()
        screenPresence.update()
    }

    override func viewDidUnhide() {
        super.viewDidUnhide()
        screenPresence.update()
    }

    /// Right click: Save Image… / Copy Image, once the bytes are here.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard let file = player.file else { return super.menu(for: event) }
        return MacChatImageActions.menu(for: file)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let previewImage = frameImage ?? previewImage,
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
        if player.isAnimated, !player.isPlaying { drawPausedBadge() }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// A GIF that is not playing (Reduce Motion): a play badge in the corner.
    private func drawPausedBadge() {
        let configuration = NSImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
            .applying(.init(paletteColors: [.white, NSColor.black.withAlphaComponent(0.55)]))
        guard let badge = NSImage(systemSymbolName: "play.circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) else { return }
        let size = badge.size
        let y = isFlipped ? bounds.maxY - size.height - 8 : bounds.minY + 8
        badge.draw(in: NSRect(x: bounds.maxX - size.width - 8, y: y, width: size.width, height: size.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        event?.type == .leftMouseDown
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
#endif
