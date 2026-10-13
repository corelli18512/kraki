#if os(iOS)
import Foundation

extension MessageInputView {
    /// The soft keyboard's return key appends exactly one "\n" at the end of
    /// the current text. A paste can also end with a newline but adds more.
    static func isReturnKeySubmit(old: String, new: String) -> Bool {
        new.count == old.count + 1 && new.hasSuffix("\n") && new.hasPrefix(old)
    }
}
#endif
