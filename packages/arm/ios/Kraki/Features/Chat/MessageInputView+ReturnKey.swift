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

    /// The draft a Return typed but did not send, until the field has been
    /// given it. A plain reference rather than @State: the edit sets it and a
    /// view update reads it, outside SwiftUI's state transactions.
    final class UnsentReturnNewline {
        var draft: String?
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
