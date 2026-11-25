#if os(macOS)
import SwiftUI

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
                        file: item.file(in: selection.attachmentStore),
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
                    if let file = item.file(in: selection.attachmentStore) {
                        fileButtons(file)
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

    /// Save Image… and Copy Image for the image shown, once its bytes are here.
    @ViewBuilder
    private func fileButtons(_ file: ChatImageFile) -> some View {
        previewButton("square.and.arrow.down", label: String(localized: "Save Image…")) {
            MacChatImageActions.save(file, window: NSApp.keyWindow ?? NSApp.mainWindow)
        }
        previewButton("doc.on.doc", label: String(localized: "Copy Image")) {
            MacChatImageActions.copy(file)
        }
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
    let file: ChatImageFile?
    @Binding var zoom: CGFloat
    let onBackdropClick: () -> Void

    func makeNSView(context: Context) -> MacZoomableImageView {
        let view = MacZoomableImageView()
        view.image = image
        view.player.show(file)
        view.onBackdropClick = onBackdropClick
        view.onZoomChanged = { value in
            if abs(zoom - value) > 0.001 { zoom = value }
        }
        return view
    }

    func updateNSView(_ nsView: MacZoomableImageView, context: Context) {
        nsView.image = image
        nsView.player.show(file)
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
    /// The GIF frame shown, else the still `image`.
    private var frameImage: NSImage?
    /// Plays an animated GIF (paused under Reduce Motion until Play).
    private(set) lazy var player: ChatGIFPlayer = {
        let player = ChatGIFPlayer { [weak self] frame in
            guard let self else { return }
            self.frameImage = frame.map { NSImage(cgImage: $0, size: self.image?.size ?? .zero) }
            self.needsDisplay = true
        }
        player.onPlaybackChange = { [weak self] in self?.updatePlaybackButton() }
        return player
    }()
    /// Ticks the GIF only while on screen.
    private lazy var screenPresence = MacGIFScreenPresence(view: self, player: player)
    /// Play / Pause for an animated GIF, bottom-right of the canvas.
    private(set) lazy var playbackButton: NSButton = {
        let button = NSButton(title: "", target: self, action: #selector(togglePlayback))
        button.bezelStyle = .circular
        button.isBordered = true
        button.imagePosition = .imageOnly
        button.contentTintColor = .white
        button.isHidden = true
        addSubview(button)
        return button
    }()

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

    /// The composer editor that was typing when the preview took focus.
    /// Closing the preview gives focus back to it; paging (a new view per
    /// image) passes it on. Any other previous responder is left alone.
    private(set) weak var composerToRefocus: MacComposerTextView?

    override func viewDidHide() {
        super.viewDidHide()
        screenPresence.update()
    }

    override func viewDidUnhide() {
        super.viewDidUnhide()
        screenPresence.update()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        screenPresence.update()
        guard let window else { return }
        let previous = window.firstResponder
        composerToRefocus = previous as? MacComposerTextView
            ?? (previous as? MacZoomableImageView)?.composerToRefocus
        window.makeFirstResponder(self)
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil, let window, window.firstResponder === self,
           let composer = composerToRefocus, composer.window === window {
            window.makeFirstResponder(composer)
        }
        super.viewWillMove(toWindow: newWindow)
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
        playbackButton.frame = NSRect(x: bounds.maxX - 44, y: bounds.minY + 8, width: 36, height: 36)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image else { return }
        let rect = drawnImageRect(for: image)
        guard rect.width > 0, rect.height > 0 else { return }
        NSGraphicsContext.current?.imageInterpolation = .high
        (frameImage ?? image).draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    }

    /// Right click: Save Image… / Copy Image, once the bytes are here.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard let file = player.file else { return super.menu(for: event) }
        return MacChatImageActions.menu(for: file)
    }

    @objc private func togglePlayback() {
        player.togglePlayback()
    }

    private func updatePlaybackButton() {
        playbackButton.isHidden = !player.isAnimated
        let playing = player.isPlaying
        let label = playing ? String(localized: "Pause Animation") : String(localized: "Play Animation")
        playbackButton.image = NSImage(systemSymbolName: playing ? "pause.fill" : "play.fill", accessibilityDescription: label)
        playbackButton.setAccessibilityLabel(label)
        playbackButton.toolTip = label
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
