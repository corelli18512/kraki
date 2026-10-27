/// Geometry, key, paste and focus probes and regressions for the Mac composer (test hooks).

#if os(macOS)
import AppKit
import SwiftUI

#if DEBUG
/// Passive markers on the actual controls, for geometry and real hit-test
/// regression checks without relying on SwiftUI's lazily-created AX tree.
struct MacComposerControlGeometryProbe: NSViewRepresentable {
    let identifier: String
    final class Probe: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {
        view.identifier = NSUserInterfaceItemIdentifier(identifier)
    }
}

/// Debug-only fixed-height stress probe for the native voice transcript
/// scroll surface (the production composer now grows to a three-line cap). It is intentionally isolated from Relay and AppState.
enum MacComposerVoiceScrollRegression {
    static func run() -> [String: Any] {
        let text = String(repeating: "Long voice transcript keeps appending so the newest words remain visible. ", count: 18)
        let host = NSHostingView(
            rootView: AnyView(
                MacComposerScrollableVoiceTranscript(
                    pieces: [(text: text, opacity: 1)],
                    revision: "long"
                )
                .frame(width: 280, height: MacComposerVoiceTranscriptView.lineHeight * 2)
            )
        )
        let window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 280, height: 44),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        host.frame = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 280, height: 44)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        host.layoutSubtreeIfNeeded()

        func descendants(of view: NSView) -> [NSView] {
            view.subviews.flatMap { [$0] + descendants(of: $0) }
        }
        guard let scrollView = descendants(of: host).compactMap({ $0 as? NSScrollView }).first,
              let documentView = scrollView.documentView as? MacComposerVoiceTranscriptView else {
            return ["passed": false, "scrollView": false]
        }

        let viewportHeight = scrollView.contentView.bounds.height
        let documentHeight = documentView.frame.height
        let maxY = max(0, documentHeight - viewportHeight)
        let tailAttached = abs(scrollView.contentView.bounds.origin.y - maxY) < 1.0
        let measuredHeight = MacComposerVoiceTranscriptView.measure(
            [(text: text, opacity: 1)],
            width: max(1, scrollView.contentView.bounds.width)
        )
        let contentExceedsViewport = documentHeight > viewportHeight + 1.0
        let fixedViewport = abs(viewportHeight - MacComposerVoiceTranscriptView.lineHeight * 2) < 1.0
        let passed = contentExceedsViewport && fixedViewport && tailAttached
        return [
            "passed": passed,
            "scrollView": true,
            "contentExceedsViewport": contentExceedsViewport,
            "fixedViewport": fixedViewport,
            "tailAttached": tailAttached,
            "viewportHeight": viewportHeight,
            "documentHeight": documentHeight,
            "documentLength": documentView.debugAttributedText.length,
            "measuredHeight": measuredHeight,
            "scrollWidth": scrollView.bounds.width,
            "clipWidth": scrollView.contentView.bounds.width,
            "originY": scrollView.contentView.bounds.origin.y,
            "documentRectHeight": scrollView.contentView.documentRect.height,
        ]
    }
}
#endif

struct MacComposerVoiceKeyProbe: NSViewRepresentable {
    let enabled: Bool
    let voiceActive: Bool
    let onToggle: () -> Void
    let onCancel: () -> Void

    func makeNSView(context: Context) -> MacComposerVoiceKeyProbeView {
        let view = MacComposerVoiceKeyProbeView()
        view.enabled = enabled
        view.voiceActive = voiceActive
        view.onToggle = onToggle
        view.onCancel = onCancel
        return view
    }

    func updateNSView(_ nsView: MacComposerVoiceKeyProbeView, context: Context) {
        nsView.enabled = enabled
        nsView.voiceActive = voiceActive
        nsView.onToggle = onToggle
        nsView.onCancel = onCancel
    }
}

final class MacComposerVoiceKeyProbeView: NSView {
    var enabled = false
    var voiceActive = false
    var onToggle: (() -> Void)?
    var onCancel: (() -> Void)?
    private var localMonitor: Any?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isHidden = true
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.enabled, event.window === self.window else { return event }
            switch Self.action(keyCode: event.keyCode, flags: event.modifierFlags,
                               isRepeat: event.isARepeat, voiceActive: self.voiceActive) {
            case .toggle: self.onToggle?()
            case .cancel: self.onCancel?()
            case .swallow: break
            case .pass: return event
            }
            return nil
        }
    }

    enum KeyAction: Equatable { case toggle, cancel, swallow, pass }

    /// Option-Space toggles recording once per press (a held key's repeats are
    /// swallowed, not toggled or typed as NBSP); Esc cancels while recording.
    /// Caps Lock and the keypad/fn state flags do not change the shortcut.
    static func action(keyCode: UInt16, flags: NSEvent.ModifierFlags, isRepeat: Bool,
                       voiceActive: Bool) -> KeyAction {
        let modifiers = flags.shortcutModifiers
        if modifiers == .option, keyCode == 49 { return isRepeat ? .swallow : .toggle }
        if voiceActive, modifiers.isEmpty, keyCode == 53 { return .cancel }
        return .pass
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }
}

/// SwiftUI's `.onPasteCommand` is not reliably reached when the underlying
/// macOS `NSTextField`/field editor consumes Command-V first. This probe uses an
/// app-local event monitor (not a global monitor) and only intercepts paste while
/// this Composer's FocusState is active. Anything `MacComposerPastePolicy` does
/// not take as an image (text, text with a picture of it, other files) is
/// returned untouched to the native responder chain.
struct MacComposerPasteProbe: NSViewRepresentable {
    let enabled: Bool
    let onPasteImage: (NSImage) -> Void

    func makeNSView(context: Context) -> MacComposerPasteProbeView {
        let view = MacComposerPasteProbeView()
        view.enabled = enabled
        view.onPasteImage = onPasteImage
        return view
    }

    func updateNSView(_ nsView: MacComposerPasteProbeView, context: Context) {
        nsView.enabled = enabled
        nsView.onPasteImage = onPasteImage
    }
}

final class MacComposerPasteProbeView: NSView {
    var enabled = false
    var onPasteImage: ((NSImage) -> Void)?
    private var localMonitor: Any?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isHidden = true
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self,
                  self.enabled,
                  event.window === self.window,
                  event.modifierFlags.shortcutModifiers == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v",
                  let image = MacComposerPastePolicy.image(from: .general) else {
                return event
            }
            self.onPasteImage?(image)
            return nil
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }
}


#if DEBUG
@MainActor
private final class MacComposerFocusRegressionState {
    var text = ""
    var focused = true
    var nativeEditorHasText = false
    var focusRequest = 0
}

private final class MacComposerRegressionExternalFocusView: NSView {
    override var acceptsFirstResponder: Bool { true }
}

@MainActor
enum MacComposerPasteFocusRegression {
    static func run(completion: @escaping ([String: Any]) -> Void) {
        let state = MacComposerFocusRegressionState()
        let input = MacComposerScrollableTextInput(
            text: Binding(get: { state.text }, set: { state.text = $0 }),
            focused: Binding(get: { state.focused }, set: { state.focused = $0 }),
            nativeEditorHasText: Binding(
                get: { state.nativeEditorHasText },
                set: { state.nativeEditorHasText = $0 }
            ),
            nativeComposingText: .constant(nil), enabled: true,
            focusRequest: state.focusRequest,
            onRequestFocus: {
                state.focused = true
                state.focusRequest += 1
            },
            onSubmit: {},
            onSelection: { _ in },
            onTakeOver: {}
        )
        let coordinator = MacComposerScrollableTextInput.Coordinator(input)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 90),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 90))
        window.contentView = root

        let original = MacComposerTextView(frame: NSRect(x: 0, y: 40, width: 300, height: 36))
        let replacement = MacComposerTextView(frame: original.frame)
        let external = MacComposerRegressionExternalFocusView(
            frame: NSRect(x: 0, y: 0, width: 160, height: 24)
        )
        root.addSubview(original)
        root.addSubview(external)
        coordinator.textView = original

        // Attachment updates can remove the current NSTextView while AppKit is
        // delivering textDidEndEditing. That teardown must preserve the binding.
        state.focused = true
        coordinator.textDidEndEditing(
            Notification(name: NSText.didEndEditingNotification, object: original)
        )
        original.removeFromSuperview()

        DispatchQueue.main.async {
            let teardownPreserved = state.focused

            // A newly-created Composer text view is an internal handoff, not a
            // genuine focus departure.
            root.addSubview(original)
            root.addSubview(replacement)
            window.makeFirstResponder(replacement)
            state.focused = true
            coordinator.textDidEndEditing(
                Notification(name: NSText.didEndEditingNotification, object: original)
            )

            DispatchQueue.main.async {
                let replacementPreserved = state.focused

                // The paste callback must reassert FocusState so the next
                // SwiftUI update makes the live replacement first responder.
                state.focused = false
                coordinator.textView = replacement
                coordinator.restoreFocusAfterPaste()
                let pasteRestoredBinding = state.focused

                DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                    let replacementBecameFirstResponder = window.firstResponder === replacement

                    // Simulate visible native IME text before it commits. The
                    // persisted draft remains empty, but the placeholder must
                    // already be hidden because the NSTextView is not empty.
                    state.text = ""
                    replacement.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
                                              replacementRange: NSRange(location: NSNotFound, length: 0))
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    let placeholderHiddenForNativeText = state.nativeEditorHasText
                        && !MacComposerPlaceholderPolicy.isVisible(
                            committedText: state.text,
                            nativeEditorHasText: state.nativeEditorHasText
                        )

                    replacement.unmarkText()
                    replacement.string = ""
                    coordinator.wasComposing = false
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    let placeholderRestoredAfterClear = !state.nativeEditorHasText
                        && MacComposerPlaceholderPolicy.isVisible(
                            committedText: state.text,
                            nativeEditorHasText: state.nativeEditorHasText
                        )

                    // Simulate an IME composition committing Chinese text. The
                    // committed draft must publish while retaining the live
                    // native text view as first responder.
                    coordinator.wasComposing = true
                    replacement.string = "\u{4E2D}\u{6587}\u{8F93}\u{5165}"
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    let imeDraftCommitted = state.text == "\u{4E2D}\u{6587}\u{8F93}\u{5165}"
                    let imeRequestedFocus = state.focusRequest > 0

                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                        let imeRetainedFirstResponder = window.firstResponder === replacement

                        // A genuine move outside the Composer must still clear focus.
                        window.makeFirstResponder(external)
                        state.focused = true
                        coordinator.textDidEndEditing(
                            Notification(name: NSText.didEndEditingNotification, object: replacement)
                        )

                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                            // Referencing the coordinator keeps it alive until its
                            // deferred focus decision has run.
                            let externalCleared = !state.focused && coordinator.textView === replacement
                            let passed = teardownPreserved
                                && replacementPreserved
                                && pasteRestoredBinding
                                && replacementBecameFirstResponder
                                && placeholderHiddenForNativeText
                                && placeholderRestoredAfterClear
                                && imeDraftCommitted
                                && imeRequestedFocus
                                && imeRetainedFirstResponder
                                && externalCleared
                            window.close()
                            completion([
                                "passed": passed,
                                "teardownPreserved": teardownPreserved,
                                "replacementPreserved": replacementPreserved,
                                "pasteRestoredBinding": pasteRestoredBinding,
                                "replacementBecameFirstResponder": replacementBecameFirstResponder,
                                "placeholderHiddenForNativeText": placeholderHiddenForNativeText,
                                "placeholderRestoredAfterClear": placeholderRestoredAfterClear,
                                "imeDraftCommitted": imeDraftCommitted,
                                "imeRequestedFocus": imeRequestedFocus,
                                "imeRetainedFirstResponder": imeRetainedFirstResponder,
                                "externalCleared": externalCleared,
                            ])
                        }
                    }
                }
            }
        }
    }
}
#endif

extension NSEvent.ModifierFlags {
    /// The modifiers a keyboard shortcut compares: device-independent, without
    /// the Caps Lock, keypad and fn state flags.
    var shortcutModifiers: NSEvent.ModifierFlags {
        intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
    }
}
#endif
