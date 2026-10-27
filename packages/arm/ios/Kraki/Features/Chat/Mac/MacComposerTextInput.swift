/// The Mac composer's text input: scroll edge fades and the scrollable, growing text view.

#if os(macOS)
import AppKit
import SwiftUI

// MARK: - Scroll edge fade

/// While text is scrolled out of view at the top or bottom of a composer's
/// scroll view, that edge fades out — a hint that there is more.
final class MacScrollEdgeFade {
    static let length: CGFloat = 14
    /// Overflow up to this is padding, not hidden text. While the composer
    /// animates its height, AppKit (`-[NSTextView _superviewClipViewFrameChanged:]`)
    /// sets the text view's height and minSize to the clip's intermediate
    /// height, while the composer writes the measured one. Whichever write
    /// lands last wins, so a one-line draft could keep a few points of
    /// overflow and a bottom fade over its only line until the next keystroke.
    static let minimumHiddenText: CGFloat = 4
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
        let top = clip.minY > Self.minimumHiddenText
        let bottom = documentHeight - clip.maxY > Self.minimumHiddenText
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
    /// The draft's own undo history, separate from the window's: the app
    /// replaces the whole draft (Send, Clear, voice, Edit) and must be able
    /// to drop the typing records that point into the previous text.
    private let draftUndoManager = UndoManager()
    override var undoManager: UndoManager? { draftUndoManager }

    var onSubmit: (() -> Void)?
    var onPasteCompleted: (() -> Void)?
    var onTakeOver: (() -> Void)?
    /// This editor gained (true) or gave up (false) first responder: a click,
    /// a move to another field, or a programmatic change.
    var onFirstResponderChange: ((Bool) -> Void)?
    /// IME marked text was set or ended. AppKit posts no NSText.didChange
    /// for marked text, so layout learns about a composition here.
    var onMarkedTextChange: (() -> Void)?
    var voicePendingRange: NSRange?

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFirstResponderChange?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFirstResponderChange?(false) }
        return resigned
    }

    // MARK: Undo / Redo
    //
    // Edit ▸ Undo/Redo and ⌘Z/⇧⌘Z send undo:/redo: up the responder chain.
    // NSTextView does not implement them; NSWindow does, with the window's
    // undo manager, which never holds this draft's records. So the editor
    // answers them itself, against `draftUndoManager`. (TextKit 2 does not
    // register typing with the text view or its storage as the undo target,
    // so the window's manager could not be scrubbed per editor instead.)

    @objc func undo(_ sender: Any?) { stepDraftUndo(redo: false) }
    @objc func redo(_ sender: Any?) { stepDraftUndo(redo: true) }

    private func stepDraftUndo(redo: Bool) {
        guard canStepDraftUndo(redo: redo) else { return }
        // Later typing must start a new record, not extend an undone one.
        breakUndoCoalescing()
        if redo { draftUndoManager.redo() } else { draftUndoManager.undo() }
        // TextKit 2 applies the undo without posting NSText.didChange, so
        // the draft (and the next re-render) would keep the old text.
        didChangeText()
    }

    private func canStepDraftUndo(redo: Bool) -> Bool {
        guard isEditable, !hasMarkedText() else { return false }
        return redo ? draftUndoManager.canRedo : draftUndoManager.canUndo
    }

    private func validateDraftUndo(_ item: NSValidatedUserInterfaceItem) -> Bool? {
        switch item.action {
        case #selector(undo(_:)):
            (item as? NSMenuItem)?.title = draftUndoManager.undoMenuItemTitle
            return canStepDraftUndo(redo: false)
        case #selector(redo(_:)):
            (item as? NSMenuItem)?.title = draftUndoManager.redoMenuItemTitle
            return canStepDraftUndo(redo: true)
        default:
            return nil
        }
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        validateDraftUndo(menuItem) ?? super.validateMenuItem(menuItem)
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        validateDraftUndo(item) ?? super.validateUserInterfaceItem(item)
    }

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
        onMarkedTextChange?()
    }

    override func unmarkText() {
        super.unmarkText()
        onMarkedTextChange?()
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
    /// The editor's visible text while an IME composition is marked (nil
    /// otherwise). Layout only: composers size the box from it so a wrapping
    /// composition grows it; marked text never reaches the draft (`text`).
    @Binding var nativeComposingText: String?
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
        /// The draft value the editor last showed (applied from or published
        /// to `text`). A different `text` is an external replacement (Clear,
        /// Send, deny, answer, voice, Edit), not this editor's own publish.
        var syncedText: String
        /// The `focused` value of the last update: only its turning true (or
        /// a new focusRequest) asks the editor to take first responder.
        var appliedFocused = false
        /// A focus intent not applied yet: the editor was not in a key window.
        var pendingFocus = false
        private var keyWindowObserver: NSObjectProtocol?

        init(_ parent: MacComposerScrollableTextInput) {
            self.parent = parent
            self.syncedText = parent.text
        }

        deinit {
            if let keyWindowObserver { NotificationCenter.default.removeObserver(keyWindowObserver) }
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
                let composingText = textView.hasMarkedText() ? textView.string : nil
                if self.parent.nativeComposingText != composingText {
                    self.parent.nativeComposingText = composingText
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
            syncedText = textView.string
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
            clearFocusIfEditorLostFirstResponder(textView)
        }

        /// Keeps `focused` in step with the editor's first responder state, so
        /// a click into it sticks and a move to another field is not undone
        /// by the next update.
        func editorFirstResponderChanged(_ textView: MacComposerTextView, isFirstResponder: Bool) {
            guard textView === self.textView else { return }
            if isFirstResponder {
                pendingFocus = false
                if !parent.focused { parent.focused = true }
            } else {
                clearFocusIfEditorLostFirstResponder(textView)
            }
        }

        /// Decided after AppKit finishes the hand-off: while textDidEndEditing
        /// or resignFirstResponder runs, the window still reports this editor
        /// as first responder. A teardown (the obsolete view left the window)
        /// or a hand-off to a replacement Composer editor keeps the binding.
        private func clearFocusIfEditorLostFirstResponder(_ textView: NSTextView) {
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self,
                      let textView,
                      textView === self.textView,
                      let window = textView.window,
                      !(window.firstResponder is MacComposerTextView),
                      self.parent.focused else { return }
                self.pendingFocus = false
                self.parent.focused = false
            }
        }

        /// Applies a pending focus intent once the editor is in a key window.
        func applyPendingFocus(explicitRequest: Bool) {
            guard pendingFocus else { return }
            guard parent.focused else { pendingFocus = false; return }
            guard let textView, let window = textView.window else { return }
            guard window.isKeyWindow else { applyPendingFocusWhenKey(window); return }
            pendingFocus = false
            if window.firstResponder !== textView {
                isApplying = true
                window.makeFirstResponder(textView)
                isApplying = false
            }
            if explicitRequest, window.firstResponder !== textView {
                restoreCurrentTextViewFocus(attemptsRemaining: 3)
            }
        }

        private func applyPendingFocusWhenKey(_ window: NSWindow) {
            if let keyWindowObserver { NotificationCenter.default.removeObserver(keyWindowObserver) }
            keyWindowObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let observer = self.keyWindowObserver { NotificationCenter.default.removeObserver(observer) }
                    self.keyWindowObserver = nil
                    self.applyPendingFocus(explicitRequest: false)
                }
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
        textView.onFirstResponderChange = { [weak coordinator = context.coordinator, weak textView] isFirstResponder in
            guard let textView else { return }
            coordinator?.editorFirstResponderChanged(textView, isFirstResponder: isFirstResponder)
        }
        textView.onMarkedTextChange = { [weak coordinator = context.coordinator, weak textView] in
            guard let coordinator, let textView else { return }
            // Deferred when the composer itself ends a composition (inside a
            // SwiftUI update); immediate for the user's IME input.
            coordinator.reportVisualTextPresence(of: textView, deferred: coordinator.isApplying)
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

    static func dropUndoHistory(of textView: MacComposerTextView) {
        textView.breakUndoCoalescing()
        textView.undoManager?.removeAllActions()
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
        // While an IME composition is marked the editor intentionally differs
        // from the committed draft; leave it alone. But an external
        // replacement of the draft must win: otherwise the commit republishes
        // the cleared or already sent text.
        let externalReplacement = text != context.coordinator.syncedText
        if textView.string != text, !textView.hasMarkedText() || externalReplacement {
            context.coordinator.isApplying = true
            if textView.hasMarkedText() {
                textView.inputContext?.discardMarkedText()
                textView.unmarkText()
                context.coordinator.wasComposing = false
            }
            let selection = textView.selectedRange()
            textView.string = text
            // Send, Clear, voice and Edit replace the whole draft without an
            // undo record. Older typing records still hold ranges into the
            // previous text: Cmd-Z would delete the wrong characters of the
            // new draft (or raise NSRangeException), so drop them.
            Self.dropUndoHistory(of: textView)
            textView.setSelectedRange(NSRange(location: min(selection.location, textView.string.utf16.count), length: 0))
            context.coordinator.isApplying = false
        }
        context.coordinator.syncedText = text
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

        // Take first responder only on a focus intent: a new focusRequest, or
        // `focused` turning true (session selected, voice ended). Re-asserting
        // it on every update while `focused` was true pulled focus back from
        // other fields (sidebar Search) on any re-render.
        let coordinator = context.coordinator
        let hasExplicitFocusRequest = coordinator.appliedFocusRequest != focusRequest
        coordinator.appliedFocusRequest = focusRequest
        if focused, hasExplicitFocusRequest || !coordinator.appliedFocused { coordinator.pendingFocus = true }
        if !focused { coordinator.pendingFocus = false }
        coordinator.appliedFocused = focused
        DispatchQueue.main.async { [weak scrollView, weak textView, weak coordinator] in
            guard let scrollView, let textView, let coordinator, let window = scrollView.window else { return }
            // The live binding, not this update's: a click since then counts.
            if coordinator.parent.focused {
                coordinator.applyPendingFocus(explicitRequest: hasExplicitFocusRequest)
            } else if window.firstResponder === textView {
                window.makeFirstResponder(nil)
            }
            textView.scrollRangeToVisible(textView.selectedRange())
            coordinator.edgeFade?.scheduleUpdate()
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
        // While composing, size for the visible text, marked part included.
        let editor = nsView.documentView as? NSTextView
        let layoutText = editor?.hasMarkedText() == true ? editor?.string ?? text : text
        let measured = Self.measuredHeight(layoutText, width: width)
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
