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
        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
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

        private func findInput(in root: UIView) -> UIView? {
            if let view = root as? UITextView, view.isEditable, view.text == expectedText { return view }
            if let view = root as? UITextField, view.text == expectedText { return view }
            for child in root.subviews {
                if let found = findInput(in: child) { return found }
            }
            return nil
        }

        private func applyIfReady() {
            guard window != nil else { return }
            if input?.window !== window || input == nil {
                var root = superview
                while let candidate = root {
                    if let found = findInput(in: candidate) { input = found; break }
                    root = candidate.superview
                }
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
