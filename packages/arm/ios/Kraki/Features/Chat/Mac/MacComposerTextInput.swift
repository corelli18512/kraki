/// The Mac composer's text input: scroll edge fades and the scrollable, growing text view.

#if os(macOS)
import AppKit
import SwiftUI

// MARK: - Scroll edge fade

/// While text is scrolled out of view at the top or bottom of a composer's
/// scroll view, that edge fades out — a hint that there is more.
final class MacScrollEdgeFade {
    static let length: CGFloat = 14
    private weak var scrollView: NSScrollView?
    private let mask = CAGradientLayer()
    private var observers: [NSObjectProtocol] = []
    private(set) var fadesTop = false
    private(set) var fadesBottom = false

    init(_ scrollView: NSScrollView) {
        self.scrollView = scrollView
        scrollView.wantsLayer = true
        scrollView.postsFrameChangedNotifications = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: scrollView.contentView,
                                            queue: .main) { [weak self] _ in self?.scheduleUpdate() })
        observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: scrollView,
                                            queue: .main) { [weak self] _ in self?.scheduleUpdate() })
        if let document = scrollView.documentView {
            // Created after the document view is installed.
            observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: document,
                                                queue: .main) { [weak self] _ in self?.scheduleUpdate() })
        }
    }

    /// Now, and again once the clip view has re-tiled after a resize (a
    /// growing box must not keep a fade from an intermediate frame).
    func scheduleUpdate() {
        update()
        DispatchQueue.main.async { [weak self] in self?.update() }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func update() {
        guard let scrollView, let layer = scrollView.layer else { return }
        let clip = scrollView.contentView.bounds
        let documentHeight = scrollView.documentView?.frame.height ?? 0
        let top = clip.minY > 0.5
        let bottom = clip.maxY < documentHeight - 0.5
        fadesTop = top; fadesBottom = bottom
        guard top || bottom else {
            if layer.mask != nil { layer.mask = nil }
            return
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        mask.frame = layer.bounds
        let f = min(0.45, Self.length / max(1, layer.bounds.height))
        let edge = NSColor.black.withAlphaComponent(0).cgColor, solid = NSColor.black.cgColor
        mask.colors = [top ? edge : solid, solid, solid, bottom ? edge : solid]
        mask.locations = [0, NSNumber(value: Double(f)), NSNumber(value: Double(1 - f)), 1]
        // Unit points: 0 is the visual top in either layer orientation.
        let flipped = layer.contentsAreFlipped()
        mask.startPoint = CGPoint(x: 0.5, y: flipped ? 0 : 1)
        mask.endPoint = CGPoint(x: 0.5, y: flipped ? 1 : 0)
        if layer.mask !== mask { layer.mask = mask }
        CATransaction.commit()
    }
}

/// A composer scroll view that refreshes its edge fade after every tile,
/// layout and scroll — the final geometry, never an intermediate frame.
class MacEdgeFadingScrollView: NSScrollView {
    var edgeFade: MacScrollEdgeFade?
    /// Re-fits the document to a new width before the fade is computed.
    var onTile: (() -> Void)?
    override func tile() { super.tile(); onTile?(); edgeFade?.update() }
    override func layout() { super.layout(); edgeFade?.update() }
    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        edgeFade?.update()
    }
}

// MARK: - Scrollable native Composer text input

final class MacComposerTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onPasteCompleted: (() -> Void)?
    var onTakeOver: (() -> Void)?
    var voicePendingRange: NSRange?

    func refreshVoiceStyling() {
        guard !hasMarkedText(), let storage = textStorage else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            // NSColor.withAlphaComponent resolves dynamic colors. Resolve in
            // THIS window, not the app's possibly opposite system appearance.
            let primary = NSColor.labelColor.usingColorSpace(.deviceRGB) ?? .labelColor
            VoiceDraftStyling.apply(to: storage, pending: voicePendingRange, primaryColor: primary)
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshVoiceStyling()
    }

    override func mouseDown(with event: NSEvent) {
        onTakeOver?()
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        onTakeOver?()
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if (event.keyCode == 36 || event.keyCode == 76),
           !flags.contains(.shift),
           !hasMarkedText() {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        onTakeOver?()
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
    }

    override func paste(_ sender: Any?) {
        onTakeOver?()
        super.paste(sender)
        onPasteCompleted?()
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let window = self.window,
                  window.isKeyWindow,
                  window.firstResponder !== self else { return }
            window.makeFirstResponder(self)
        }
    }
}

struct MacComposerScrollableTextInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    @Binding var nativeEditorHasText: Bool
    let enabled: Bool
    let focusRequest: Int
    var selectionRequest: NSRange? = nil
    var uncorrectedRange: NSRange? = nil
    let onRequestFocus: () -> Void
    let onSubmit: () -> Void
    let onSelection: (NSRange) -> Void
    let onTakeOver: () -> Void
    /// Taller editors (the new-session composer); nil = one Composer row.
    var minLines: CGFloat? = nil
    var maxLines: CGFloat = MacComposerMetrics.maxVisibleTextLines

    private static let font = NSFont.systemFont(ofSize: 15)
    private static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    // One point for the text/caret; the stable visual padding lives outside
    // the scroll view so it remains present at every scroll position.
    private static let verticalPadding: CGFloat = 1

    /// Editor height for `lines` lines of text (without the outer padding).
    static func height(lines: CGFloat) -> CGFloat { lineHeight * lines + verticalPadding * 2 }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacComposerScrollableTextInput
        weak var scrollView: NSScrollView?
        weak var textView: MacComposerTextView?
        var edgeFade: MacScrollEdgeFade?
        var isApplying = false
        var wasComposing = false
        var appliedFocusRequest = -1
        var appliedSelectionRequest: NSRange?

        init(_ parent: MacComposerScrollableTextInput) {
            self.parent = parent
        }

        func reportVisualTextPresence(
            of textView: MacComposerTextView,
            deferred: Bool = false
        ) {
            let apply = { [weak self, weak textView] in
                guard let self,
                      let textView,
                      self.textView === textView else { return }
                let hasText = !textView.string.isEmpty
                if self.parent.nativeEditorHasText != hasText {
                    self.parent.nativeEditorHasText = hasText
                }
            }
            if deferred {
                DispatchQueue.main.async(execute: apply)
            } else {
                apply()
            }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !isApplying, let textView = notification.object as? MacComposerTextView,
                  textView.window?.firstResponder === textView else { return }
            parent.onSelection(textView.selectedRange())
            if textView.selectedRange() != parent.selectionRequest { parent.onTakeOver() }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? MacComposerTextView else { return }
            // Marked IME text intentionally does not round-trip through the
            // persisted draft, but it is still visible native text and must
            // hide the SwiftUI placeholder immediately.
            reportVisualTextPresence(of: textView)
            guard !isApplying else { return }
            textView.scrollRangeToVisible(textView.selectedRange())
            // Do not round-trip marked IME text through SwiftUI. Replacing the
            // backing string while a Chinese/Japanese composition is active
            // commits or discards the input session and can resign first
            // responder. Publish only the committed value.
            if textView.hasMarkedText() {
                wasComposing = true
                return
            }
            let committedComposition = wasComposing
            wasComposing = false
            if parent.text != textView.string {
                parent.text = textView.string
            }
            guard committedComposition else { return }
            // Publishing the committed IME value may make SwiftUI replace the
            // representable. Wait until that transaction settles; request focus
            // only if the live native editor actually lost first responder.
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                if let window = textView.window,
                   window.isKeyWindow,
                   window.firstResponder === textView {
                    return
                }
                self.parent.onRequestFocus()
                self.restoreCurrentTextViewFocus(attemptsRemaining: 4)
            }
        }

        func textDidBeginEditing(_ notification: Notification) {
            if !parent.focused { parent.focused = true }
        }

        func textDidEndEditing(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            // A teardown notification from an obsolete native view must not
            // clear FocusState. A genuine responder move from the current live
            // editor can be decided immediately; a transient nil responder is
            // checked once after AppKit finishes the handoff.
            guard textView === self.textView,
                  let window = textView.window,
                  self.parent.focused else { return }
            if window.firstResponder is MacComposerTextView { return }
            if let externalView = window.firstResponder as? NSView,
               externalView !== textView {
                self.parent.focused = false
                return
            }
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self,
                      let textView,
                      textView === self.textView,
                      let window = textView.window,
                      !(window.firstResponder is MacComposerTextView),
                      self.parent.focused else { return }
                self.parent.focused = false
            }
        }

        func restoreFocusAfterPaste() {
            parent.onRequestFocus()
            restoreCurrentTextViewFocus(attemptsRemaining: 3)
        }

        func restoreCurrentTextViewFocus(attemptsRemaining: Int) {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if let textView = self.textView,
                   let window = textView.window,
                   window.isKeyWindow,
                   self.parent.focused {
                    if window.firstResponder !== textView {
                        window.makeFirstResponder(textView)
                    }
                    if window.firstResponder === textView { return }
                }
                guard attemptsRemaining > 1 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
                    self?.restoreCurrentTextViewFocus(attemptsRemaining: attemptsRemaining - 1)
                }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = MacEdgeFadingScrollView(frame: .zero)
        scrollView.drawsBackground = false
        scrollView.contentView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasHorizontalScroller = false
        scrollView.hasVerticalScroller = false
        scrollView.horizontalScroller = nil
        scrollView.verticalScroller = nil
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .automatic
        scrollView.horizontalScrollElasticity = .none

        let textView = MacComposerTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.onTakeOver = onTakeOver
        textView.onSubmit = onSubmit
        textView.onPasteCompleted = { [weak coordinator = context.coordinator] in
            coordinator?.restoreFocusAfterPaste()
        }
        textView.drawsBackground = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.font = Self.font
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 4, height: Self.verticalPadding)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.textContainer?.lineFragmentPadding = 0
        textView.string = text
        scrollView.documentView = textView
        context.coordinator.scrollView = scrollView
        context.coordinator.textView = textView
        context.coordinator.edgeFade = MacScrollEdgeFade(scrollView)
        scrollView.edgeFade = context.coordinator.edgeFade
        // The width can change after the last update (the clear button moving
        // above the mic): the document must follow, or a stale (narrower,
        // taller) height leaves a phantom scroll range.
        scrollView.onTile = { [weak scrollView, weak textView] in
            guard let scrollView, let textView, !textView.hasMarkedText() else { return }
            let width = max(1, scrollView.contentSize.width)
            let height = max(Self.measuredHeight(textView.string, width: width), scrollView.contentSize.height)
            guard abs(textView.frame.height - height) > 0.5 || abs(textView.frame.width - width) > 0.5 else { return }
            textView.frame = NSRect(x: 0, y: 0, width: width, height: height)
        }
        context.coordinator.reportVisualTextPresence(of: textView, deferred: true)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? MacComposerTextView else { return }
        textView.onTakeOver = onTakeOver
        textView.onSubmit = onSubmit
        textView.onPasteCompleted = { [weak coordinator = context.coordinator] in
            coordinator?.restoreFocusAfterPaste()
        }
        textView.isEditable = enabled
        textView.isSelectable = enabled
        if textView.string != text, !textView.hasMarkedText() {
            context.coordinator.isApplying = true
            let selection = textView.selectedRange()
            textView.string = text
            textView.setSelectedRange(NSRange(location: min(selection.location, textView.string.utf16.count), length: 0))
            context.coordinator.isApplying = false
        }
        if let selectionRequest, context.coordinator.appliedSelectionRequest != selectionRequest,
           !textView.hasMarkedText() {
            context.coordinator.isApplying = true
            let range = IOSVoiceComposer.safeRange(selectionRequest, in: textView.string)
            textView.setSelectedRange(range)
            context.coordinator.appliedSelectionRequest = selectionRequest
            context.coordinator.isApplying = false
            // Keep continuation's insertion range in sync without treating a
            // programmatic selection as the user taking over correction.
            DispatchQueue.main.async { onSelection(range) }
        }
        context.coordinator.isApplying = true
        textView.voicePendingRange = uncorrectedRange
        textView.refreshVoiceStyling()
        if !textView.hasMarkedText() { textView.typingAttributes[.foregroundColor] = NSColor.labelColor }
        context.coordinator.isApplying = false
        context.coordinator.reportVisualTextPresence(of: textView, deferred: true)
        let layoutText = textView.hasMarkedText() ? textView.string : text
        let measuredHeight = Self.measuredHeight(layoutText, width: max(1, scrollView.contentSize.width))
        textView.frame = NSRect(
            x: 0,
            y: 0,
            width: max(1, scrollView.contentSize.width),
            height: max(measuredHeight, scrollView.contentSize.height)
        )
        // Keep the three-line editor internally scrollable without ever
        // exposing an AppKit scrollbar. NSClipView still follows the insertion
        // point; removing the scroller objects prevents system settings from
        // reserving or flashing a track inside the floating Composer.
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil

        let hasExplicitFocusRequest = context.coordinator.appliedFocusRequest != focusRequest
        context.coordinator.appliedFocusRequest = focusRequest
        DispatchQueue.main.async { [weak scrollView, weak textView, weak coordinator = context.coordinator] in
            guard let scrollView, let textView, let window = scrollView.window else { return }
            if focused {
                if window.isKeyWindow, window.firstResponder !== textView {
                    coordinator?.isApplying = true
                    window.makeFirstResponder(textView)
                    coordinator?.isApplying = false
                }
                if hasExplicitFocusRequest, window.firstResponder !== textView {
                    coordinator?.restoreCurrentTextViewFocus(attemptsRemaining: 3)
                }
            } else if window.firstResponder === textView {
                window.makeFirstResponder(nil)
            }
            textView.scrollRangeToVisible(textView.selectedRange())
            coordinator?.edgeFade?.scheduleUpdate()
        }
    }

    /// The editor height this text takes at `width` (what sizeThatFits
    /// returns); composers animate their growth on its changes.
    static func fittedHeight(_ text: String, width: CGFloat,
                             minLines: CGFloat? = nil, maxLines: CGFloat = MacComposerMetrics.maxVisibleTextLines) -> CGFloat {
        guard width > 1 else { return 0 }
        let minHeight = minLines.map(height(lines:)) ?? MacComposerMetrics.minimumTextHeight
        return min(max(measuredHeight(text, width: width), minHeight), max(minHeight, height(lines: maxLines)))
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: NSScrollView,
        context: Context
    ) -> CGSize? {
        let width = max(1, proposal.width ?? nsView.frame.width)
        let measured = Self.measuredHeight(text, width: width)
        let minHeight = minLines.map(Self.height(lines:)) ?? MacComposerMetrics.minimumTextHeight
        let maxHeight = max(minHeight, Self.height(lines: maxLines))
        return CGSize(width: width, height: min(max(measured, minHeight), maxHeight))
    }

    private static func measuredHeight(_ text: String, width: CGFloat) -> CGFloat {
        // Measure with the same TextKit layout as NSTextView, including an
        // empty trailing line. CoreText's extra rounding used to change the
        // apparent padding when the editor grew from one line to two.
        let storage = NSTextStorage(string: text.isEmpty ? " " : text, attributes: [.font: font])
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: max(1, width - 8), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        let height = max(layout.usedRect(for: container).maxY, layout.extraLineFragmentRect.maxY)
        return max(lineHeight, ceil(height)) + verticalPadding * 2
    }
}
#endif
