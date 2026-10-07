import Foundation
#if os(macOS)
import AppKit
typealias VoiceDraftColor = NSColor
#else
import UIKit
import SwiftUI
typealias VoiceDraftColor = UIColor
#endif

/// Native editor decoration only. Drafts stay plain strings; completed words,
/// the existing draft and human-owned text all retain the normal label color.
enum VoiceDraftStyling {
    static let pendingOpacity: CGFloat = 0.5

    static func apply(to text: NSMutableAttributedString, pending: NSRange?, primaryColor: VoiceDraftColor? = nil) {
        #if os(macOS)
        let primary = primaryColor ?? VoiceDraftColor.labelColor
        #else
        let primary = primaryColor ?? VoiceDraftColor.label
        #endif
        let styled = NSMutableAttributedString(attributedString: text)
        styled.addAttribute(.foregroundColor, value: primary, range: NSRange(location: 0, length: text.length))
        if let pending, pending.length > 0, IOSVoiceComposer.safeRange(pending, in: text.string) == pending {
            styled.addAttribute(.foregroundColor, value: primary.withAlphaComponent(pendingOpacity), range: pending)
        }
        // Attribute-only, idempotent changes avoid a native layout feedback loop.
        guard !styled.isEqual(to: text) else { return }
        text.beginEditing()
        styled.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: text.length)) { color, range, _ in
            if let color { text.addAttribute(.foregroundColor, value: color, range: range) }
        }
        text.endEditing()
    }
}

#if os(iOS)
/// Decorates the existing SwiftUI TextField's native input; does not introduce
/// a second editor or replace its keyboard, selection, font or scrolling.
struct IOSVoiceDraftDecoration: UIViewRepresentable {
    let text: String
    let pending: NSRange?
    let onTakeOver: () -> Void

    func makeUIView(context: Context) -> Marker { Marker() }
    func updateUIView(_ view: Marker, context: Context) {
        view.expectedText = text
        view.pending = pending
        view.onTakeOver = onTakeOver
        view.schedule()
    }

    final class Marker: UIView {
        var expectedText = ""
        var pending: NSRange?
        var onTakeOver: (() -> Void)?
        private weak var input: UIView?
        private var hadTint = false
        private var scheduled = false
        private var applying = false
        private var observers: [NSObjectProtocol] = []
        private var storageObserver: NSObjectProtocol?
        #if DEBUG
        var debugTrackedInput: UIView? { input }
        #endif

        init() {
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            for name in [UITextView.textDidChangeNotification, UITextField.textDidChangeNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    MainActor.assumeIsolated {
                        guard let self, !self.applying, let input = self.input,
                              note.object as? UIView === input else { return }
                        // This includes IME marked text, before it is committed
                        // through SwiftUI's String binding.
                        self.onTakeOver?()
                    }
                })
            }
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
            if let storageObserver { NotificationCenter.default.removeObserver(storageObserver) }
        }
        override func didMoveToWindow() { super.didMoveToWindow(); schedule() }
        override func layoutSubviews() { super.layoutSubviews(); schedule() }

        func schedule() {
            guard !scheduled else { return }
            scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                self.applyIfReady()
            }
        }

        /// The text input this marker decorates: the marker is the field's
        /// background, so it is the matching input that overlaps the marker
        /// most, searched from the nearest ancestor outward. Matching on text
        /// alone picked other fields (search, rename) with the same text, or
        /// any empty one.
        private func findInput() -> UIView? {
            let markerFrame = convert(bounds, to: nil)
            guard markerFrame.width > 0, markerFrame.height > 0 else { return nil }
            var root = superview
            while let ancestor = root {
                var best: (view: UIView, area: CGFloat)?
                visitInputs(in: ancestor) { view in
                    let overlap = view.convert(view.bounds, to: nil).intersection(markerFrame)
                    guard !overlap.isNull else { return }
                    let area = overlap.width * overlap.height
                    if area > 0, area > (best?.area ?? 0) { best = (view, area) }
                }
                if let best { return best.view }
                root = ancestor.superview
            }
            return nil
        }

        private func visitInputs(in root: UIView, _ visit: (UIView) -> Void) {
            if let view = root as? UITextView, view.isEditable, view.text == expectedText { visit(view) }
            if let view = root as? UITextField, view.text == expectedText { visit(view) }
            for child in root.subviews { visitInputs(in: child, visit) }
        }

        private func trackInput(_ view: UIView?) {
            if let storageObserver { NotificationCenter.default.removeObserver(storageObserver) }
            storageObserver = nil
            input = view
            guard let view = view as? UITextView else { return }
            // SwiftUI may reset foreground attributes AFTER our layout pass.
            // Observe only this editor's storage, without replacing its delegate.
            // Defer until the native edit ends; our idempotent attribute writes
            // are guarded so they neither loop nor look like human input.
            storageObserver = NotificationCenter.default.addObserver(
                forName: NSTextStorage.didProcessEditingNotification, object: view.textStorage, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.applying, self.pending != nil || self.hadTint else { return }
                    self.schedule()
                }
            }
        }

        private func applyIfReady() {
            guard window != nil else { return }
            if input?.window !== window || input == nil {
                trackInput(findInput())
            }
            guard pending != nil || hadTint else { return }
            applying = true
            defer { applying = false }
            if let view = input as? UITextView {
                guard view.text == expectedText, view.markedTextRange == nil else { return }
                VoiceDraftStyling.apply(to: view.textStorage, pending: pending)
                var typing = view.typingAttributes
                typing[.foregroundColor] = UIColor.label
                view.typingAttributes = typing
            } else if let view = input as? UITextField {
                guard view.text == expectedText, view.markedTextRange == nil else { return }
                let styled = NSMutableAttributedString(attributedString: view.attributedText ?? NSAttributedString(string: expectedText))
                VoiceDraftStyling.apply(to: styled, pending: pending)
                if styled != view.attributedText {
                    let selection = view.selectedTextRange
                    view.attributedText = styled
                    view.selectedTextRange = selection
                }
            } else { return }
            hadTint = pending != nil
        }
    }
}
#endif
