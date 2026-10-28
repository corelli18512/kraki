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

    init(id: String, image: UIImage, title: String) {
        self.id = id
        self.image = image
        self.title = title
    }

    init(attachmentID: String, title: String) {
        self.id = attachmentID
        self.image = nil
        self.title = title
        self.attachmentID = attachmentID
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

    /// Every image of the message, loaded or not: the viewer opens on any
    /// of them and swipes through all (loading pages show progress).
    private var previewItems: [(entryID: String, item: IOSImagePreviewItem)] {
        entries.map { entry in
            switch entry {
            case .image(let id, let image):
                return (id, IOSImagePreviewItem(id: id, image: image, title: String(localized: "Image")))
            case .ref(let ref):
                return (ref.id, IOSImagePreviewItem(attachmentID: ref.id, title: ref.caption ?? ref.name ?? String(localized: "Image")))
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
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    imageButton(image: image, entryID: ref.id, cornerRadius: 12)
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
        case .image(let id, let image):
            imageButton(image: image, entryID: id, cornerRadius: 12)
                .frame(width: width, height: IOSImageGalleryLayout.multiCardHeight)
                .overlay(cardBorder)
        case .ref(let ref):
            switch attachmentStore?.state(for: ref.id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: ref.id, data: data) {
                    imageButton(image: image, entryID: ref.id, cornerRadius: 12)
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

    private func imageButton(image: UIImage, entryID: String, cornerRadius: CGFloat) -> some View {
        Button {
            open(entryID)
        } label: {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

/// The image viewer pager's horizontal offset and page width.
struct IOSImagePreviewPagerGeometry: Equatable {
    let offset: CGFloat
    let width: CGFloat
    var page: Int { Int((offset / max(width, 1)).rounded()) }
}

struct IOSImagePreviewGallery: View {
    let selection: IOSImagePreviewSelection
    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    /// A page to scroll to (Previous/Next buttons).
    @State private var target: Int?

    init(selection: IOSImagePreviewSelection) {
        self.selection = selection
        _index = State(initialValue: selection.initialIndex)
    }

    /// The tapped image as the scroll view's initial offset: part of its first
    /// layout. A `scrollTo` from `onAppear` stayed pending when that layout ran
    /// long and was applied again on the next update, pulling a swipe made in
    /// the meantime back to the tapped image (and first reported page 1).
    private var initialPageAnchor: UnitPoint {
        UnitPoint(x: CGFloat(selection.initialIndex) / CGFloat(max(selection.items.count - 1, 1)), y: 0)
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

            // Swipe between images like Photos; each page zooms on its own
            // (a zoomed image pans first, then the page turns at its edge).
            // A paging scroll view sized to the full window, not TabView's
            // page style: on iPhone Duo the status bar is on the right edge,
            // and TabView's pager inherited that inset, so pages opened
            // offset by half of it and swipes landed between images.
            GeometryReader { geometry in
              ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    // All pages exist up front (a message has few images, and
                    // they are all loaded on open): a lazy stack could re-anchor
                    // the scroll position as late pages appear.
                    HStack(spacing: 0) {
                        ForEach(Array(selection.items.enumerated()), id: \.offset) { offset, item in
                            IOSImagePreviewPage(item: item, selection: selection, onBackdropTap: { dismiss() })
                                .padding(.top, 52)
                                .padding(.bottom, selection.items.count > 1 ? 54 : 18)
                                .padding(.horizontal, 12)
                                .frame(width: geometry.size.width, height: geometry.size.height)
                                .id(offset)
                                .accessibilityLabel(item.title)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .defaultScrollAnchor(initialPageAnchor, for: .initialOffset)
                .scrollIndicators(.hidden)
                .contentMargins(0, for: .scrollContent)
                // The page shown is derived from the actual offset, so it
                // follows drags, programmatic scrolls and re-renders alike;
                // nothing re-applies a stale page while content loads.
                .onScrollGeometryChange(for: IOSImagePreviewPagerGeometry.self) { scroll in
                    IOSImagePreviewPagerGeometry(offset: scroll.contentOffset.x, width: scroll.containerSize.width)
                } action: { old, now in
                    // A resize (fold/unfold, rotation) keeps the old absolute
                    // offset, which now sits between pages: put the page that
                    // was shown back instead of reading a page from it.
                    if old.width != now.width, old.width > 0 {
                        proxy.scrollTo(index, anchor: .leading)
                        return
                    }
                    let page = min(max(now.page, 0), max(selection.items.count - 1, 0))
                    if page != index { index = page }
                }
                .onChange(of: target) { _, page in
                    guard let page else { return }
                    withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(page, anchor: .leading) }
                    target = nil
                }
              }
            }
            .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack(spacing: 10) {
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
                        navigationButton("chevron.left", label: String(localized: "Previous image")) {
                            show(index - 1)
                        }
                        .disabled(index == 0)
                        Text("\(index + 1) of \(selection.items.count)")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.76))
                            .frame(minWidth: 64)
                        navigationButton("chevron.right", label: String(localized: "Next image")) {
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
        // Opened: every image of the message loads at user priority, so the
        // neighbours are ready by the time the user swipes to them.
        .onAppear { holdAttachments(true) }
        .onDisappear { holdAttachments(false) }
    }

    private func holdAttachments(_ hold: Bool) {
        guard let store = selection.attachmentStore else { return }
        // The page being looked at first, then its neighbours in order.
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

    private func show(_ nextIndex: Int) {
        guard selection.items.indices.contains(nextIndex) else { return }
        target = nextIndex
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

/// One preview page: the image, or — while its attachment is still on the
/// way — progress that turns into the image without leaving the viewer.
private struct IOSImagePreviewPage: View {
    let item: IOSImagePreviewItem
    let selection: IOSImagePreviewSelection
    let onBackdropTap: () -> Void

    var body: some View {
        if let image = item.image {
            IOSZoomableImageCanvas(image: image, onBackdropTap: onBackdropTap)
        } else if let id = item.attachmentID {
            switch selection.attachmentStore?.state(for: id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: id, data: data) {
                    IOSZoomableImageCanvas(image: image, onBackdropTap: onBackdropTap)
                } else {
                    message(String(localized: "Invalid image"), retry: false)
                }
            case .error(let reason):
                message(reason.isEmpty ? String(localized: "Couldn't load image") : reason, retry: true)
            case .awaitingChunks(let received, let total?) where total > 1:
                loading(fraction: Double(received) / Double(total))
            default:
                loading(fraction: nil)
            }
        }
    }

    private func loading(fraction: Double?) -> some View {
        VStack(spacing: 12) {
            if let fraction {
                ProgressView(value: fraction)
                    .progressViewStyle(.circular)
                    .tint(.white)
                Text(verbatim: (Double(Int(fraction * 100)) / 100).formatted(.percent.precision(.fractionLength(0))))
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: onBackdropTap)
        .accessibilityLabel("Loading image")
    }

    private func message(_ text: String, retry: Bool) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
            Text(text)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
            if retry, let id = item.attachmentID, let store = selection.attachmentStore {
                Button("Retry") {
                    // A retry after an error starts over; the extra hold is
                    // matched so the gallery's release still balances.
                    store.requestIfNeeded(id: id, sessionId: selection.sessionId, priority: .userOpened)
                    store.release(id: id, priority: .userOpened)
                }
                .buttonStyle(.bordered)
                .tint(.white)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
