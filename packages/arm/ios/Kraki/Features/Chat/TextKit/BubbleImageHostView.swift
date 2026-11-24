#if os(iOS)
import SwiftUI
import UIKit

/// One page of the preview. An attachment that is still loading opens too:
/// its page shows progress and swaps in the image when the bytes arrive.
struct IOSImagePreviewItem: Identifiable {
    let id: String
    let image: UIImage?
    let title: String
    /// Set for an attachment ref; the page resolves it from the store.
    var attachmentID: String?
    /// The original bytes of an inline image (Save to Photos / Share).
    var file: ChatImageFile?
    /// The attachment ref, for its file once loaded.
    var ref: ContentRef?

    init(id: String, image: UIImage, title: String, file: ChatImageFile? = nil) {
        self.id = id
        self.image = image
        self.title = title
        self.file = file
    }

    init(attachmentID: String, title: String, ref: ContentRef? = nil) {
        self.id = attachmentID
        self.image = nil
        self.title = title
        self.attachmentID = attachmentID
        self.ref = ref
    }

    /// The original bytes to save or share, once they are here.
    func file(in store: AttachmentStore?) -> ChatImageFile? {
        if let file { return file }
        return ref.flatMap { ChatImageFile.ref($0, in: store) }
    }
}

struct IOSImagePreviewSelection: Identifiable {
    let id = UUID()
    let items: [IOSImagePreviewItem]
    let initialIndex: Int
    /// Where pages that are still loading get their bytes.
    var attachmentStore: AttachmentStore?
    var sessionId = ""

    init(items: [IOSImagePreviewItem], initialIndex: Int = 0,
         attachmentStore: AttachmentStore? = nil, sessionId: String = "") {
        self.items = items
        self.initialIndex = min(max(initialIndex, 0), max(items.count - 1, 0))
        self.attachmentStore = attachmentStore
        self.sessionId = sessionId
    }
}

enum IOSImageGalleryLayout {
    static let multiCardHeight: CGFloat = 184
    static let multiStackOffset: CGFloat = 8
    static let attachmentSpacing: CGFloat = 12
    static let outerVerticalPadding: CGFloat = 12
    static let maximumStackDepth = 3
    static let singleImageMaxHeight: CGFloat = 240
    static let refPlaceholderMaxHeight: CGFloat = 192

    static func height(images: [UIImage], refs: [ContentRef], maxWidth: CGFloat) -> CGFloat {
        let count = images.count + refs.count
        guard count > 0, maxWidth > 0 else { return 0 }
        if count > 1 {
            let depth = min(count, maximumStackDepth)
            return multiCardHeight + CGFloat(depth - 1) * multiStackOffset
        }
        if let image = images.first {
            return displaySize(
                source: image.size,
                maxWidth: maxWidth,
                maxHeight: singleImageMaxHeight
            ).height
        }
        guard let ref = refs.first else { return 0 }
        return displaySize(
            source: sourceSize(for: ref, fallbackWidth: maxWidth),
            maxWidth: maxWidth,
            maxHeight: refPlaceholderMaxHeight
        ).height
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

    /// Width of each card in the offset stack. Never force a minimum wider
    /// than the host: iPad split view / Stage Manager and narrow test windows
    /// can make the bubble less than 120pt wide.
    static func stackedCardWidth(maxWidth: CGFloat, visibleCount: Int) -> CGFloat {
        let count = max(1, min(visibleCount, maximumStackDepth))
        let offsets = CGFloat(count - 1) * multiStackOffset
        return max(1, min(maxWidth - offsets, 360))
    }

    static func sourceSize(for ref: ContentRef, fallbackWidth: CGFloat) -> CGSize {
        if let width = ref.width, let height = ref.height, width > 0, height > 0 {
            return CGSize(width: width, height: height)
        }
        return CGSize(width: fallbackWidth, height: fallbackWidth)
    }
}

/// A fixed-geometry, message-level image attachment area. It is hosted as a
/// sibling of the text bubble so image hydration can replace pixels without
/// changing the cell height or covering text.
struct BubbleImageGallery: View {
    private enum Entry: Identifiable {
        case image(id: String, UIImage, ChatImageFile?)
        case ref(ContentRef)

        var id: String {
            switch self {
            case .image(let id, _, _): return id
            case .ref(let ref): return ref.id
            }
        }
    }

    let images: [UIImage]
    /// The original bytes of `images`, in the same order.
    var imageFiles: [ChatImageFile] = []
    let refs: [ContentRef]
    let sessionId: String
    let maxWidth: CGFloat
    let alignment: Alignment
    let attachmentStore: AttachmentStore?
    let onOpenImage: (IOSImagePreviewSelection) -> Void

    private var boundedMaxWidth: CGFloat { max(1, maxWidth) }

    private var entries: [Entry] {
        images.enumerated().map { index, image in
            .image(id: "inline-\(index)", image, imageFiles.indices.contains(index) ? imageFiles[index] : nil)
        } + refs.map(Entry.ref)
    }

    /// Every image of the message, loaded or not: the viewer opens on any
    /// of them and swipes through all (loading pages show progress).
    private var previewItems: [(entryID: String, item: IOSImagePreviewItem)] {
        entries.map { entry in
            switch entry {
            case .image(let id, let image, let file):
                return (id, IOSImagePreviewItem(id: id, image: image, title: String(localized: "Image"), file: file))
            case .ref(let ref):
                return (ref.id, IOSImagePreviewItem(attachmentID: ref.id, title: ref.caption ?? ref.name ?? String(localized: "Image"), ref: ref))
            }
        }
    }

    private func open(_ entryID: String) {
        let items = previewItems
        guard !items.isEmpty else { return }
        onOpenImage(IOSImagePreviewSelection(
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
        .frame(width: boundedMaxWidth, alignment: alignment)
        .clipped()
        .requestsAttachments(refs.map(\.id), sessionId: sessionId, store: attachmentStore)
    }

    @ViewBuilder
    private func single(_ entry: Entry) -> some View {
        switch entry {
        case .image(let id, let image, let file):
            let size = IOSImageGalleryLayout.displaySize(
                source: image.size,
                maxWidth: maxWidth,
                maxHeight: IOSImageGalleryLayout.singleImageMaxHeight
            )
            imageButton(image: image, file: file, entryID: id, cornerRadius: 12)
                .frame(width: size.width, height: size.height)
        case .ref(let ref):
            let size = placeholderSize(ref)
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    imageButton(image: image, file: ChatImageFile.ref(ref, in: attachmentStore), entryID: ref.id, cornerRadius: 12)
                        .frame(width: size.width, height: size.height)
                } else {
                    errorPlaceholder(ref, label: String(localized: "Invalid image"), size: size)
                }
            case .error(let reason):
                errorPlaceholder(
                    ref,
                    label: reason.isEmpty ? String(localized: "Couldn't load image") : reason,
                    size: size
                )
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder(size: size, cornerRadius: 12, entryID: ref.id)
            }
        }
    }

    private var stackedGallery: some View {
        let visible = Array(entries.prefix(IOSImageGalleryLayout.maximumStackDepth))
        let offsets = CGFloat(max(0, visible.count - 1)) * IOSImageGalleryLayout.multiStackOffset
        let cardWidth = IOSImageGalleryLayout.stackedCardWidth(
            maxWidth: boundedMaxWidth,
            visibleCount: visible.count
        )
        return ZStack(alignment: .topLeading) {
            ForEach(Array(visible.indices.reversed()), id: \.self) { index in
                stackedCard(visible[index], width: cardWidth)
                    .offset(
                        x: CGFloat(index) * IOSImageGalleryLayout.multiStackOffset,
                        y: CGFloat(visible.count - 1 - index) * IOSImageGalleryLayout.multiStackOffset
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
            height: IOSImageGalleryLayout.multiCardHeight + offsets,
            alignment: .topLeading
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open \(entries.count) images")
    }

    @ViewBuilder
    private func stackedCard(_ entry: Entry, width: CGFloat) -> some View {
        switch entry {
        case .image(let id, let image, let file):
            imageButton(image: image, file: file, entryID: id, cornerRadius: 12)
                .frame(width: width, height: IOSImageGalleryLayout.multiCardHeight)
                .overlay(cardBorder)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    imageButton(image: image, file: ChatImageFile.ref(ref, in: attachmentStore), entryID: ref.id, cornerRadius: 12)
                        .frame(width: width, height: IOSImageGalleryLayout.multiCardHeight)
                        .overlay(cardBorder)
                } else {
                    stackedError(ref, label: String(localized: "Invalid image"), width: width)
                }
            case .error(let reason):
                stackedError(
                    ref,
                    label: reason.isEmpty ? String(localized: "Couldn't load image") : reason,
                    width: width
                )
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder(
                    size: CGSize(width: width, height: IOSImageGalleryLayout.multiCardHeight),
                    cornerRadius: 12,
                    entryID: ref.id
                )
                .overlay(cardBorder)
            }
        }
    }

    private var cardBorder: some View {
        RoundedRectangle(cornerRadius: 12)
            .stroke(Color.primary.opacity(0.16), lineWidth: 1)
            .allowsHitTesting(false)
    }

    private func imageButton(image: UIImage, file: ChatImageFile?, entryID: String, cornerRadius: CGFloat) -> some View {
        Button {
            open(entryID)
        } label: {
            // The fill image is an overlay so it never sizes the button: a
            // `scaledToFill` child made the frame (tap / VoiceOver target) the
            // overflow size, covering neighbouring bubbles. A UIKit image view
            // so an animated GIF plays (SwiftUI's Image shows one frame).
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    ChatImageSurface(image: image, file: file)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(ChatImageContextMenu(file: file))
        .accessibilityLabel(entries.count > 1 ? String(localized: "Open image gallery") : String(localized: "Open image preview"))
    }

    private func placeholderSize(_ ref: ContentRef) -> CGSize {
        IOSImageGalleryLayout.displaySize(
            source: IOSImageGalleryLayout.sourceSize(for: ref, fallbackWidth: maxWidth),
            maxWidth: maxWidth,
            maxHeight: IOSImageGalleryLayout.refPlaceholderMaxHeight
        )
    }

    /// Still loading, but already opens the viewer (which keeps loading).
    private func loadingPlaceholder(size: CGSize, cornerRadius: CGFloat, entryID: String) -> some View {
        Button {
            open(entryID)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius).fill(.quaternary)
                ProgressView().controlSize(.small)
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(entries.count > 1 ? String(localized: "Open image gallery") : String(localized: "Open image preview"))
    }

    private func errorPlaceholder(_ ref: ContentRef, label: String, size: CGSize) -> some View {
        Button {
            attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId, priority: .userOpened)
        } label: {
            errorContent(label)
                .frame(width: size.width, height: size.height)
        }
        .buttonStyle(.plain)
    }

    private func stackedError(_ ref: ContentRef, label: String, width: CGFloat) -> some View {
        errorPlaceholder(
            ref,
            label: label,
            size: CGSize(width: width, height: IOSImageGalleryLayout.multiCardHeight)
        )
        .overlay(cardBorder)
    }

    private func errorContent(_ label: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color.red.opacity(0.08))
            VStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.red.opacity(0.8))
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Text("Tap to retry")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(6)
        }
    }
}

final class BubbleImageHostView: UIView {
    private var hostingController: UIHostingController<BubbleImageGallery?>?
    /// False while the chat list is not displaying this cell (scrolled off
    /// screen, kept for reuse): its GIFs stop ticking until displayed again.
    var imagesDisplayed = true {
        didSet {
            guard imagesDisplayed != oldValue else { return }
            Self.animatedImageViews(in: self).forEach { $0.updatePlayerVisibility() }
        }
    }

    /// The chat list started (true) or stopped displaying `cell`.
    static func setImagesDisplayed(_ displayed: Bool, in cell: UIView) {
        if let host = cell as? BubbleImageHostView {
            host.imagesDisplayed = displayed
            return
        }
        cell.subviews.forEach { setImagesDisplayed(displayed, in: $0) }
    }

    static func animatedImageViews(in view: UIView) -> [ChatAnimatedImageView] {
        view.subviews.flatMap { subview -> [ChatAnimatedImageView] in
            if let image = subview as? ChatAnimatedImageView { return [image] }
            return animatedImageViews(in: subview)
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(
        images: [UIImage],
        imageFiles: [ChatImageFile] = [],
        refs: [ContentRef],
        sessionId: String,
        maxWidth: CGFloat,
        alignment: Alignment,
        attachmentStore: AttachmentStore?,
        onOpenImage: @escaping (IOSImagePreviewSelection) -> Void
    ) {
        let hasImages = !images.isEmpty || !refs.isEmpty
        let gallery = hasImages ? BubbleImageGallery(
            images: images,
            imageFiles: imageFiles,
            refs: refs,
            sessionId: sessionId,
            maxWidth: maxWidth,
            alignment: alignment,
            attachmentStore: attachmentStore,
            onOpenImage: onOpenImage
        ) : nil
        if let hostingController {
            hostingController.rootView = gallery
        } else if let gallery {
            let host = UIHostingController(rootView: Optional(gallery))
            host.view.backgroundColor = .clear
            host.view.clipsToBounds = true
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            host.view.frame = bounds
            addSubview(host.view)
            hostingController = host
        }
        isHidden = !hasImages
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        hostingController?.view.frame = bounds
        hostingController?.view.setNeedsLayout()
    }
}
#endif
