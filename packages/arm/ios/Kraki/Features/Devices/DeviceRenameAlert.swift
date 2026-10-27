/// The rename alert for a device (iOS device detail, Mac Devices pane).

import SwiftUI

/// Like the web editor, a name over the relay's limit is never cut while
/// typing (that would drop the end or break an IME composition). An alert
/// cannot keep Save disabled live, so Save checks the length: over the limit
/// the alert comes back with the text as typed and the limit in its message.
struct DeviceRenameAlert: ViewModifier {
    let title: Text
    let device: DeviceSummary?
    @Binding var isPresented: Bool
    @Binding var draft: String
    var fieldIdentifier = "device.renameField"
    /// The value for `rename_device` (`""` clears the custom name).
    let onSave: (String) -> Void

    /// Save was pressed with a name over the limit: present again once closed.
    @State private var reopen = false

    private var tooLong: Bool { DeviceName.normalize(draft) == nil }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: $isPresented) {
            TextField(device?.ownName ?? "", text: $draft)
                .accessibilityIdentifier(fieldIdentifier)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                if tooLong {
                    reopen = true
                } else if let device, let name = DeviceName.renameValue(draft: draft, for: device) {
                    onSave(name)
                }
            }
        } message: {
            if tooLong {
                Text("Names can be up to \(DeviceName.maxLength) characters.")
            } else {
                Text("Shown on all your devices. Leave it empty to use \"\(device?.ownName ?? "")\".")
            }
        }
        .onChange(of: isPresented) { _, shown in
            guard !shown, reopen else { return }
            reopen = false
            DispatchQueue.main.async { isPresented = true }
        }
    }
}
