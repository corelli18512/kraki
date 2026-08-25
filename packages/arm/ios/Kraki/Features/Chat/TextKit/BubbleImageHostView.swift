#if os(iOS)
import SwiftUI
import UIKit

struct IOSImagePreviewItem: Identifiable {
    let id: String
    let image: UIImage
    let title: String
}

struct IOSImagePreviewSelection: Identifiable {
    let id = UUID()
    let items: [IOSImagePreviewItem]
    let initialIndex: Int

    init(items: [IOSImagePreviewItem], initialIndex: Int = 0) {
        self.items = items
        self.initialIndex = min(max(initialIndex, 0), max(items.count - 1, 0))
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
        case image(id: String, UIImage)
        case ref(ContentRef)

        var id: String {
            switch self {
            case .image(let id, _): return id
            case .ref(let ref): return ref.id
            }
        }
    }

    let images: [UIImage]
    let refs: [ContentRef]
    let sessionId: String
    let maxWidth: CGFloat
    let alignment: Alignment
    let attachmentStore: AttachmentStore?
    let onOpenImage: (IOSImagePreviewSelection) -> Void

    private var boundedMaxWidth: CGFloat { max(1, maxWidth) }

    private var entries: [Entry] {
        images.enumerated().map { .image(id: "inline-\($0.offset)", $0.element) }
            + refs.map(Entry.ref)
    }

    private var resolvedItems: [(entryID: String, item: IOSImagePreviewItem)] {
        entries.compactMap { entry in
            switch entry {
            case .image(let id, let image):
                return (id, IOSImagePreviewItem(id: id, image: image, title: "Image"))
            case .ref(let ref):
                guard case .ready(_, let data) = attachmentStore?.state(for: ref.id),
                      let image = UIImage(data: data) else { return nil }
                return (
                    ref.id,
                    IOSImagePreviewItem(
                        id: ref.id,
                        image: image,
                        title: ref.caption ?? ref.name ?? "Image"
                    )
                )
            }
        }
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
        .onAppear {
            for ref in refs {
                attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId)
            }
        }
    }

    @ViewBuilder
    private func single(_ entry: Entry) -> some View {
        switch entry {
        case .image(let id, let image):
            let size = IOSImageGalleryLayout.displaySize(
                source: image.size,
                maxWidth: maxWidth,
                maxHeight: IOSImageGalleryLayout.singleImageMaxHeight
            )
            imageButton(image: image, entryID: id, cornerRadius: 12)
                .frame(width: size.width, height: size.height)
        case .ref(let ref):
            let size = placeholderSize(ref)
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = UIImage(data: data) {
                    imageButton(image: image, entryID: ref.id, cornerRadius: 12)
                        .frame(width: size.width, height: size.height)
                } else {
                    errorPlaceholder(ref, label: "Invalid image", size: size)
                }
            case .error(let reason):
                errorPlaceholder(
                    ref,
                    label: reason.isEmpty ? "Couldn't load image" : reason,
                    size: size
                )
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder(size: size, cornerRadius: 12)
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
            Text("\(entries.count)")
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
        case .image(let id, let image):
            imageButton(image: image, entryID: id, cornerRadius: 12)
                .frame(width: width, height: IOSImageGalleryLayout.multiCardHeight)
                .overlay(cardBorder)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = UIImage(data: data) {
                    imageButton(image: image, entryID: ref.id, cornerRadius: 12)
                        .frame(width: width, height: IOSImageGalleryLayout.multiCardHeight)
                        .overlay(cardBorder)
                } else {
                    stackedError(ref, label: "Invalid image", width: width)
                }
            case .error(let reason):
                stackedError(
                    ref,
                    label: reason.isEmpty ? "Couldn't load image" : reason,
                    width: width
                )
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder(
                    size: CGSize(width: width, height: IOSImageGalleryLayout.multiCardHeight),
                    cornerRadius: 12
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

    private func imageButton(image: UIImage, entryID: String, cornerRadius: CGFloat) -> some View {
        Button {
            let resolved = resolvedItems
            guard !resolved.isEmpty else { return }
            let selected = resolved.firstIndex(where: { $0.entryID == entryID }) ?? 0
            onOpenImage(
                IOSImagePreviewSelection(
                    items: resolved.map(\.item),
                    initialIndex: selected
                )
            )
        } label: {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(resolvedItems.count > 1 ? "Open image gallery" : "Open image preview")
    }

    private func placeholderSize(_ ref: ContentRef) -> CGSize {
        IOSImageGalleryLayout.displaySize(
            source: IOSImageGalleryLayout.sourceSize(for: ref, fallbackWidth: maxWidth),
            maxWidth: maxWidth,
            maxHeight: IOSImageGalleryLayout.refPlaceholderMaxHeight
        )
    }

    private func loadingPlaceholder(size: CGSize, cornerRadius: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius).fill(.quaternary)
            ProgressView().controlSize(.small)
        }
        .frame(width: size.width, height: size.height)
    }

    private func errorPlaceholder(_ ref: ContentRef, label: String, size: CGSize) -> some View {
        Button {
            attachmentStore?.requestIfNeeded(id: ref.id, sessionId: sessionId)
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

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(
        images: [UIImage],
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

struct IOSImagePreviewGallery: View {
    let selection: IOSImagePreviewSelection
    @Environment(\.dismiss) private var dismiss
    @State private var index: Int

    init(selection: IOSImagePreviewSelection) {
        self.selection = selection
        _index = State(initialValue: selection.initialIndex)
    }

    private var item: IOSImagePreviewItem {
        selection.items[min(max(index, 0), max(selection.items.count - 1, 0))]
    }

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { dismiss() }

            IOSZoomableImageCanvas(image: item.image, onBackdropTap: { dismiss() })
                .id(item.id)
                .padding(.top, 52)
                .padding(.bottom, selection.items.count > 1 ? 54 : 18)
                .padding(.horizontal, 12)

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text(item.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if selection.items.count > 1 {
                        Text("\(index + 1) / \(selection.items.count)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    Spacer(minLength: 0)
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(.white.opacity(0.12), in: Circle())
                    }
                    .accessibilityLabel("Close image preview")
                }
                .padding(.horizontal, 14)
                .frame(height: 52)
                Spacer()
                if selection.items.count > 1 {
                    HStack(spacing: 22) {
                        navigationButton("chevron.left", label: "Previous image") {
                            show(index - 1)
                        }
                        .disabled(index == 0)
                        Text("\(index + 1) of \(selection.items.count)")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.76))
                            .frame(minWidth: 64)
                        navigationButton("chevron.right", label: "Next image") {
                            show(index + 1)
                        }
                        .disabled(index == selection.items.count - 1)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 50)
                    .background(.ultraThinMaterial.opacity(0.6), in: Capsule())
                    .padding(.bottom, 12)
                }
            }
        }
        .statusBarHidden(true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Image preview")
    }

    private func show(_ nextIndex: Int) {
        guard selection.items.indices.contains(nextIndex) else { return }
        index = nextIndex
    }

    private func navigationButton(
        _ systemName: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct IOSZoomableImageCanvas: UIViewRepresentable {
    let image: UIImage
    let onBackdropTap: () -> Void

    func makeUIView(context: Context) -> IOSZoomableImageView {
        let view = IOSZoomableImageView()
        view.onBackdropTap = onBackdropTap
        view.image = image
        return view
    }

    func updateUIView(_ uiView: IOSZoomableImageView, context: Context) {
        uiView.onBackdropTap = onBackdropTap
        uiView.image = image
    }
}

final class IOSZoomableImageView: UIView, UIScrollViewDelegate {
    var onBackdropTap: (() -> Void)?
    var image: UIImage? {
        didSet {
            guard oldValue !== image else { return }
            imageView.image = image
            needsBaseLayout = true
            setNeedsLayout()
        }
    }

    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private var needsBaseLayout = true

    #if DEBUG
    var maximumZoomScaleForRegression: CGFloat { scrollView.maximumZoomScale }

    @discardableResult
    func tapForRegression(at point: CGPoint) -> Bool {
        closeIfBackdrop(at: point)
    }
    #endif

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        scrollView.backgroundColor = .clear
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 8
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast
        addSubview(scrollView)

        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = false
        scrollView.addSubview(imageView)

        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
        singleTap.cancelsTouchesInView = false
        addGestureRecognizer(singleTap)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.cancelsTouchesInView = false
        addGestureRecognizer(doubleTap)
        singleTap.require(toFail: doubleTap)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        guard needsBaseLayout, let image, image.size.width > 0, image.size.height > 0 else {
            centerImage()
            return
        }
        needsBaseLayout = false
        scrollView.setZoomScale(1, animated: false)
        let ratio = min(
            bounds.width / image.size.width,
            bounds.height / image.size.height,
            1
        )
        let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
        imageView.frame = CGRect(origin: .zero, size: size)
        scrollView.contentSize = size
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        imageView
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerImage()
    }

    @objc private func handleSingleTap(_ recognizer: UITapGestureRecognizer) {
        _ = closeIfBackdrop(at: recognizer.location(in: self))
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        let pointInImage = recognizer.location(in: imageView)
        guard imageView.bounds.contains(pointInImage) else { return }
        if scrollView.zoomScale > 1.01 {
            scrollView.setZoomScale(1, animated: true)
            return
        }
        let target: CGFloat = 2
        let point = recognizer.location(in: scrollView)
        let width = scrollView.bounds.width / target
        let height = scrollView.bounds.height / target
        scrollView.zoom(
            to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height),
            animated: true
        )
    }

    @discardableResult
    private func closeIfBackdrop(at point: CGPoint) -> Bool {
        let imagePoint = imageView.convert(point, from: self)
        guard !imageView.bounds.contains(imagePoint) else { return false }
        onBackdropTap?()
        return true
    }

    private func centerImage() {
        let horizontal = max(0, (scrollView.bounds.width - imageView.frame.width) / 2)
        let vertical = max(0, (scrollView.bounds.height - imageView.frame.height) / 2)
        scrollView.contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
    }
}
#endif
