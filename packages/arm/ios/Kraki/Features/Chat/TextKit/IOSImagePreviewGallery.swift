#if os(iOS)
import SwiftUI
import UIKit

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
                            IOSImagePreviewPage(item: item, selection: selection, isShown: offset == index, onBackdropTap: { dismiss() })
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
                    if let file = item.file(in: selection.attachmentStore) {
                        fileActions(file)
                    }
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

    /// Save to Photos and Share for the image shown, once its bytes are here.
    @ViewBuilder
    private func fileActions(_ file: ChatImageFile) -> some View {
        toolbarButton("square.and.arrow.down", label: String(localized: "Save to Photos")) {
            IOSChatImageActions.saveAndReport(file)
        }
        toolbarButton("square.and.arrow.up", label: String(localized: "Share…")) {
            IOSChatImageActions.share(file)
        }
    }

    private func toolbarButton(_ systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(.white.opacity(0.12), in: Circle())
        }
        .accessibilityLabel(label)
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
    /// The page looked at: only its GIF plays (all pages exist up front).
    let isShown: Bool
    let onBackdropTap: () -> Void

    var body: some View {
        if let image = item.image {
            IOSZoomableImageCanvas(image: image, file: item.file, isShown: isShown, onBackdropTap: onBackdropTap)
        } else if let id = item.attachmentID {
            switch selection.attachmentStore?.state(for: id) {
            case .ready(_, let data):
                if let image = AttachmentImageCache.image(id: id, data: data) {
                    IOSZoomableImageCanvas(image: image, file: item.file(in: selection.attachmentStore), isShown: isShown,
                                           onBackdropTap: onBackdropTap)
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
    let file: ChatImageFile?
    let isShown: Bool
    let onBackdropTap: () -> Void

    func makeUIView(context: Context) -> IOSZoomableImageView {
        let view = IOSZoomableImageView()
        view.onBackdropTap = onBackdropTap
        view.imageView.isDisplayed = isShown
        view.show(image, file: file)
        return view
    }

    func updateUIView(_ uiView: IOSZoomableImageView, context: Context) {
        uiView.onBackdropTap = onBackdropTap
        uiView.imageView.isDisplayed = isShown
        uiView.show(image, file: file)
    }
}

final class IOSZoomableImageView: UIView, UIScrollViewDelegate {
    var onBackdropTap: (() -> Void)?
    var image: UIImage? {
        get { imageView.stillImage }
        set { show(newValue, file: nil) }
    }

    private let scrollView = UIScrollView()
    /// Plays an animated GIF (paused under Reduce Motion until Play).
    let imageView = ChatAnimatedImageView()
    /// Play / Pause for an animated GIF, bottom-right of the page.
    let playbackButton = UIButton(type: .system)
    private var needsBaseLayout = true

    /// Shows `image`, animating `file` if it is an animated GIF.
    func show(_ image: UIImage?, file: ChatImageFile?) {
        let changed = image !== imageView.stillImage
        imageView.show(image, file: file)
        guard changed else { return }
        needsBaseLayout = true
        setNeedsLayout()
    }

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
        imageView.accessibilityIgnoresInvertColors = true
        imageView.onPlaybackChange = { [weak self] in self?.updatePlaybackButton() }
        scrollView.addSubview(imageView)

        var playback = UIButton.Configuration.filled()
        playback.cornerStyle = .capsule
        playback.baseBackgroundColor = UIColor.white.withAlphaComponent(0.16)
        playback.baseForegroundColor = .white
        playback.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        playbackButton.configuration = playback
        playbackButton.addTarget(self, action: #selector(togglePlayback), for: .touchUpInside)
        playbackButton.isHidden = true
        addSubview(playbackButton)

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
        playbackButton.frame = CGRect(x: bounds.maxX - 52, y: bounds.maxY - 52, width: 44, height: 44)
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

    @objc private func togglePlayback() {
        imageView.togglePlayback()
    }

    private func updatePlaybackButton() {
        playbackButton.isHidden = !imageView.isAnimated
        let playing = imageView.isPlaying
        playbackButton.configuration?.image = UIImage(systemName: playing ? "pause.fill" : "play.fill")
        playbackButton.accessibilityLabel = playing ? String(localized: "Pause Animation") : String(localized: "Play Animation")
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
        // The Play / Pause button sits on the backdrop.
        guard playbackButton.isHidden || !playbackButton.frame.contains(point) else { return false }
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
