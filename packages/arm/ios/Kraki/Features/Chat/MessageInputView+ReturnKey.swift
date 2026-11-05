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
}
#endif
