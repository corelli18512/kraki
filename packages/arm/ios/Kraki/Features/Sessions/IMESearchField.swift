#if os(iOS)
import SwiftUI
import UIKit

/// Search text field that is safe for composing input methods (Chinese
/// pinyin, Japanese, Korean…). SwiftUI's `TextField` publishes the IME's
/// uncommitted marked text ("zh", "zho") as the bound value, so live search
/// filtered by raw letters and rebuilt the list under the user's fingers.
/// Here the binding only changes when no text is being composed; committed
/// characters and ordinary typing still update it live.
struct IMESearchField: UIViewRepresentable {
    let placeholder: String
    @Binding var text: String
    /// Become first responder once, when the field first appears.
    var focusOnAppear = true
    var accessibilityIdentifier: String?

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = placeholder
        field.text = text
        field.font = .systemFont(ofSize: 17)
        field.returnKeyType = .search
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.clearButtonMode = .never
        field.accessibilityIdentifier = accessibilityIdentifier
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.edited(_:)), for: .editingChanged)
        // Also covers text inserted through UITextInput (dictation, paste, IME
        // commits) that does not always arrive as an editing-changed action.
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.changed(_:)),
                                               name: UITextField.textDidChangeNotification, object: field)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if focusOnAppear {
            DispatchQueue.main.async { [weak field] in field?.becomeFirstResponder() }
        }
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.text = $text
        // Never overwrite the field while the IME is composing: that cancels
        // the composition. External changes (Clear button) apply otherwise.
        if field.markedTextRange == nil, field.text != text { field.text = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }

        @objc func edited(_ field: UITextField) { publish(field) }
        @objc func changed(_ note: Notification) { (note.object as? UITextField).map(publish) }

        func publish(_ field: UITextField) {
            guard field.markedTextRange == nil else { return }
            let value = field.text ?? ""
            if text.wrappedValue != value { text.wrappedValue = value }
        }

        func textFieldDidEndEditing(_ field: UITextField) { publish(field) }

        /// Choosing a candidate ends composition; publish even if the IME
        /// did not report it as an edit.
        func textFieldDidChangeSelection(_ field: UITextField) { publish(field) }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return true
        }
    }
}
#endif
