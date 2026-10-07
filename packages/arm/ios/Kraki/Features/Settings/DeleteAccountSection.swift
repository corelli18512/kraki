import SwiftUI

/// Settings → "Delete Account" (App Store 5.1.1(v)). Two steps: an
/// explanation of what is deleted, then a final destructive confirmation.
/// The deletion runs on the relay; this view shows progress and errors.
struct DeleteAccountSection: View {
    @Environment(AppState.self) private var appState
    @State private var showExplanation = false
    @State private var showFinalConfirm = false

    var body: some View {
        Section {
            Button(role: .destructive) {
                showExplanation = true
            } label: {
                HStack {
                    Text("Delete Account…")
                    if appState.accountDeletion == .deleting {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
            .disabled(appState.accountDeletion == .deleting)
            .alert("Delete your Kraki account?", isPresented: $showExplanation) {
                Button("Continue", role: .destructive) { showFinalConfirm = true }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(Self.explanation)
            }
            .alert("Delete account permanently?", isPresented: $showFinalConfirm) {
                Button("Delete Account", role: .destructive) { appState.requestAccountDeletion() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can't be undone.")
            }

            if case .failed(let message) = appState.accountDeletion {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        } footer: {
            Text("Deletes your account and its data from Kraki's servers and signs out every device.")
        }
    }

    static let explanation = """
    Kraki's servers delete your account, your devices, notification tokens, \
    preferences, custom words and voice usage. Every phone, browser and computer \
    is signed out.

    Conversations are stored on your own computers, not on Kraki's servers; they \
    stay there. To remove them too, delete them first or run `kraki` on the \
    computer and choose "Delete all Kraki data".

    Signing in with GitHub again later creates a new, empty account.
    """
}

/// Shown on the sign-in screen after the account was deleted.
struct AccountDeletedNotice: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.accountDeletedNotice {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your Kraki account was deleted.")
                        .font(.subheadline.weight(.semibold))
                    Text("This device has been signed out.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    appState.accountDeletedNotice = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
            .frame(maxWidth: 440)
            .padding(.horizontal, 20)
            .padding(.top, 12)
        }
    }
}
