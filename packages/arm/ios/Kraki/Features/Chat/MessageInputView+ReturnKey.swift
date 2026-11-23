#if os(iOS)
import SwiftUI

extension MessageInputView {
    /// The soft keyboard's return key appends exactly one "\n" at the end of
    /// the current text. A paste can also end with a newline but adds more.
    /// `literalNewline`: the newline came from a hardware Shift-, Option- or
    /// Control-Return, which types a newline instead of sending.
    static func isReturnKeySubmit(old: String, new: String, literalNewline: Bool = false) -> Bool {
        !literalNewline && new.count == old.count + 1 && new.hasSuffix("\n") && new.hasPrefix(old)
    }

    /// A hardware Return with Shift, Option or Control types a newline.
    static func isLiteralNewlineKey(_ modifiers: EventModifiers) -> Bool {
        !modifiers.isDisjoint(with: [.shift, .option, .control])
    }

    /// How long after a Shift/Option/Control-Return its newline still counts
    /// as typed text. A time window, not the next run-loop turn, because the
    /// text system may apply the newline after the key event returns.
    static let literalNewlineWindow: TimeInterval = 0.25

    static func isLiteralNewlineFresh(_ keyAt: Date?, now: Date) -> Bool {
        guard let keyAt else { return false }
        let age = now.timeIntervalSince(keyAt)
        return age >= 0 && age < literalNewlineWindow
    }

    /// A Return that typed a newline but sent nothing. A plain reference
    /// rather than @State: the edit sets it and a view update reads it,
    /// outside SwiftUI's state transactions.
    final class UnsentReturnNewline {
        /// The typed draft, until the field has been given it.
        var draft: String?
        /// The latest typed draft whose newline is still to be removed, and
        /// the text before the earliest of the Returns that led to it: two
        /// quick Returns on an empty draft go back to empty, not to "\n".
        private var pending: (typed: String, base: String)?

        /// A Return turned `old` into `typed` and sent nothing.
        func returnTyped(old: String, typed: String) {
            let base = pending.flatMap { $0.typed == old ? $0.base : nil } ?? old
            pending = (typed, base)
            draft = typed
        }

        /// The draft was sent or edited: no newline to remove.
        func clear() {
            draft = nil
            pending = nil
        }

        /// The text to restore once the field shows `typed`; nil if a later
        /// edit took over.
        func takeBase(showing typed: String) -> String? {
            guard let pending, pending.typed == typed else { return nil }
            self.pending = nil
            return pending.base
        }
    }

    /// Reports each draft SwiftUI applies to the native views, from the same
    /// platform-view update that gives the text field its text.
    struct ComposerTextApplied: UIViewRepresentable {
        let text: String
        let applied: (String) -> Void

        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            return view
        }

        func updateUIView(_ view: UIView, context: Context) { applied(text) }
    }
}
#endif
