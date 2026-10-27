/// The Mac composer's text input: scroll edge fades and the scrollable, growing text view.

#if os(macOS)
import AppKit
import SwiftUI

// MARK: - Scroll edge fade

/// While text is scrolled out of view at the top or bottom of a composer's
/// scroll view, that edge fades out — a hint that there is more.
final class MacScrollEdgeFade {
    static let length: CGFloat = 14
    /// Overflow up to this is padding, not hidden text. A defense only: the
    /// composer editor is sized by one writer and settles with no overflow
    /// (`MacComposerTextView.sizesDocumentToText`).
    static let minimumHiddenText: CGFloat = 4
    /// True while all of the text will be visible once the box settles: any
    /// overflow then is the box still growing, not text scrolled out of view.
    var textFitsSettledBox: (() -> Bool)?
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
        let hidesText = textFitsSettledBox?() != true
        let top = hidesText && clip.minY > Self.minimumHiddenText
        let bottom = hidesText && documentHeight - clip.maxY > Self.minimumHiddenText
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
    /// Re-fits the document to the new clip size before the fade is computed.
    var onTile: (() -> Void)?
    override func tile() { super.tile(); onTile?(); edgeFade?.update() }
    override func layout() { super.layout(); edgeFade?.update() }
    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        edgeFade?.update()
    }
}

// MARK: - Text layout and height

/// How the composer editor lays out its text, and the height a text takes.
/// The editor is TextKit 1 with exactly this configuration, so the box's
/// height (measured here) and the editor's own layout agree to the point.
@MainActor
enum MacComposerTextLayout {
    static let font = NSFont.systemFont(ofSize: 15)
    static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    /// One point for the text/caret; the stable visual padding lives outside
    /// the scroll view so it remains present at every scroll position.
    static let verticalPadding: CGFloat = 1
    static let horizontalInset: CGFloat = 4

    /// Editor height (insets included) for a laid-out text height.
    static func editorHeight(usedHeight: CGFloat) -> CGFloat {
        max(lineHeight, ceil(usedHeight)) + verticalPadding * 2
    }

    /// The laid-out text height, including an empty trailing line.
    static func usedHeight(_ layoutManager: NSLayoutManager, in container: NSTextContainer) -> CGFloat {
        max(layoutManager.usedRect(for: container).maxY, layoutManager.extraLineFragmentRect.maxY)
    }

    private struct Measurement {
        let text: String
        let width: CGFloat
        let limit: CGFloat
        let height: CGFloat
    }

    /// Recent measurements: one SwiftUI pass asks for the same text and width
    /// several times (body, layout, sizeThatFits); the text changes per key.
    private static var recent: [Measurement] = []
    private static let recentCapacity = 8

    /// Editor height of `text` in an editor `width` wide. Exact up to
    /// `limit` (the box's cap); a taller text reports more than `limit`
    /// without laying out the rest.
    static func height(_ text: String, width: CGFloat, limit: CGFloat) -> CGFloat {
        if let index = recent.firstIndex(where: {
            abs($0.width - width) < 0.01 && $0.limit == limit && $0.text == text
        }) {
            let hit = recent.remove(at: index)
            recent.insert(hit, at: 0)
            return hit.height
        }
        let height = measure(text, width: width, limit: limit)
        recent.insert(Measurement(text: text, width: width, limit: limit, height: height), at: 0)
        if recent.count > recentCapacity { recent.removeLast() }
        return height
    }

    private static func measure(_ text: String, width: CGFloat, limit: CGFloat) -> CGFloat {
        let storage = NSTextStorage(string: text.isEmpty ? " " : text, attributes: [.font: font])
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: max(1, width - horizontalInset * 2),
                                                     height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(forBoundingRect: NSRect(x: 0, y: 0, width: container.size.width,
                                                           height: max(1, limit - verticalPadding * 2)),
                                   in: container)
        let height = editorHeight(usedHeight: usedHeight(layoutManager, in: container))
        let complete = layoutManager.firstUnlaidCharacterIndex() >= storage.length
        return complete ? height : max(height, limit + 1)
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

    // MARK: Document size
    //
    // Several writers used to set this view's height: the composer's updates
    // and re-tiles, NSTextView sizing itself to its text, and AppKit following
    // the clip view (`-[NSTextView _superviewClipViewFrameChanged:]` sets the
    // height and minSize to the clip's height, intermediate ones included
    // while the box animates). Whichever wrote last won: a few points of
    // overflow and edge fades over text that fits. Now every write resolves
    // to one height: the text's own (from this editor's layout manager), or
    // the clip's when that is taller.

    /// Set by the composer, which owns this editor's height.
    var sizesDocumentToText = false
    /// The box's cap: a taller text scrolls inside it.
    var maximumVisibleHeight: CGFloat = .greatestFiniteMagnitude
    /// The text's height (insets included) from this editor's own layout.
    private(set) var textHeight = MacComposerTextLayout.editorHeight(usedHeight: 0)
    private var textHeightWidth: CGFloat = -1
    private var isFittingDocument = false

    /// All of the text is visible once the box has settled.
    var textFitsVisibleHeight: Bool { textHeight <= maximumVisibleHeight + 0.5 }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard sizesDocumentToText, !isFittingDocument else { return }
        // Re-measure only for a new width: NSTextView also resizes itself from
        // inside its own layout pass, where laying out again is not safe.
        fitDocumentToText(remeasure: abs(newSize.width - textHeightWidth) > 0.01)
    }

    /// Sizes the document to the clip's width and the text's height (at
    /// least the clip's), measuring the text with this editor's layout.
    func fitDocumentToText(remeasure: Bool = true) {
        guard sizesDocumentToText, let clip = superview as? NSClipView else { return }
        isFittingDocument = true
        defer { isFittingDocument = false }
        let width = max(1, clip.bounds.width)
        if abs(frame.width - width) > 0.01 { super.setFrameSize(NSSize(width: width, height: frame.height)) }
        if remeasure || abs(textHeightWidth - width) > 0.01 { measureTextHeight() }
        let height = max(textHeight, clip.bounds.height)
        if abs(frame.height - height) > 0.01 { super.setFrameSize(NSSize(width: width, height: height)) }
    }

    private func measureTextHeight() {
        guard textLayoutManager == nil, let layoutManager, let textContainer else { return }
        layoutManager.ensureLayout(for: textContainer)
        textHeight = MacComposerTextLayout.editorHeight(usedHeight: MacComposerTextLayout.usedHeight(layoutManager, in: textContainer))
        textHeightWidth = frame.width
    }

    override func didChangeText() {
        // Before the delegate hears of the change and scrolls to the caret.
        fitDocumentToText()
        super.didChangeText()
    }

    /// Scrolls the caret into view, then snaps the clip to the document's
    /// edges (see `snapClipToDocumentEdges`).
    func scrollCaretToVisible() {
        scrollRangeToVisible(selectedRange())
        snapClipToDocumentEdges()
    }

    /// Keeps the clip inside the document, and takes the 1 pt text inset
    /// above the first or below the last line along with its line:
    /// scrolling to a caret on the last line stopped 1 pt short of the
    /// bottom, which read as hidden text.
    func snapClipToDocumentEdges() {
        guard let scrollView = enclosingScrollView else { return }
        let clip = scrollView.contentView
        let maxY = max(0, frame.height - clip.bounds.height)
        let inset = textContainerInset.height + 0.5
        var target = min(max(clip.bounds.minY, 0), maxY)
        if target < inset { target = 0 } else if maxY - target < inset { target = maxY }
        guard abs(clip.bounds.minY - target) > 0.001 else { return }
        clip.scroll(to: NSPoint(x: clip.bounds.minX, y: target))
        scrollView.reflectScrolledClipView(clip)
    }

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

    /// The click that activates an inactive window lands in the composer
    /// (NSTextView ignores it by default). The composer used to take focus
    /// back on the activation re-render instead, from whichever field had it.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

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
        fitDocumentToText()
        onMarkedTextChange?()
    }

    override func unmarkText() {
        super.unmarkText()
        fitDocumentToText()
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

    /// Editor height for `lines` lines of text (without the outer padding).
    static func height(lines: CGFloat) -> CGFloat {
        MacComposerTextLayout.lineHeight * lines + MacComposerTextLayout.verticalPadding * 2
    }

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
        #if DEBUG
        var waitsForKeyWindow: Bool { keyWindowObserver != nil }
        #endif

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
            // Deferred while the composer itself edits (inside a SwiftUI
            // update, e.g. discarding a composition): no state writes there.
            reportVisualTextPresence(of: textView, deferred: isApplying)
            guard !isApplying else { return }
            textView.scrollCaretToVisible()
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

        // TextKit 1: its full, contiguous layout is the height the box is
        // measured with. TextKit 2 laid long drafts out lazily with estimated
        // positions, so the document height and caret scrolling disagreed
        // with the measured height (blank rows, the caret out of view).
        let textView = MacComposerTextView(usingTextLayoutManager: false)
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
        textView.font = MacComposerTextLayout.font
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: MacComposerTextLayout.horizontalInset,
                                             height: MacComposerTextLayout.verticalPadding)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.textContainer?.lineFragmentPadding = 0
        textView.string = text
        scrollView.documentView = textView
        textView.sizesDocumentToText = true
        textView.maximumVisibleHeight = maximumHeight
        context.coordinator.scrollView = scrollView
        context.coordinator.textView = textView
        let edgeFade = MacScrollEdgeFade(scrollView)
        edgeFade.textFitsSettledBox = { [weak textView] in textView?.textFitsVisibleHeight ?? false }
        context.coordinator.edgeFade = edgeFade
        scrollView.edgeFade = edgeFade
        // The clip changes size without an update (the box animating, the
        // clear button moving above the mic): the document follows it at once.
        scrollView.onTile = { [weak textView] in
            guard let textView else { return }
            textView.fitDocumentToText()
            textView.snapClipToDocumentEdges()
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
        textView.maximumVisibleHeight = maximumHeight
        textView.fitDocumentToText()
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
            textView.scrollCaretToVisible()
            coordinator.edgeFade?.scheduleUpdate()
        }
    }

    private var minimumHeight: CGFloat { minLines.map(Self.height(lines:)) ?? MacComposerMetrics.minimumTextHeight }
    private var maximumHeight: CGFloat { max(minimumHeight, Self.height(lines: maxLines)) }

    /// The editor height this text takes at `width` (what sizeThatFits
    /// returns); composers animate their growth on its changes.
    static func fittedHeight(_ text: String, width: CGFloat,
                             minLines: CGFloat? = nil, maxLines: CGFloat = MacComposerMetrics.maxVisibleTextLines) -> CGFloat {
        guard width > 1 else { return 0 }
        let minHeight = minLines.map(height(lines:)) ?? MacComposerMetrics.minimumTextHeight
        let maxHeight = max(minHeight, height(lines: maxLines))
        return min(max(MacComposerTextLayout.height(text, width: width, limit: maxHeight), minHeight), maxHeight)
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
        let measured = MacComposerTextLayout.height(layoutText, width: width, limit: maximumHeight)
        return CGSize(width: width, height: min(max(measured, minimumHeight), maximumHeight))
    }
}
#endif
