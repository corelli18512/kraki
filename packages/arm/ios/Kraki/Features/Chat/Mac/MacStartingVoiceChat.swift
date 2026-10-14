#if os(macOS)
import SwiftUI

/// A new voice message is already a chat, even before the computer assigns
/// its session id. Use the actual chat list, bubble correction and composer;
/// never reimplement their presentation in the new-session form.
struct MacStartingVoiceChat: View {
    let sessionID: String
    @State private var viewModel: ChatViewModel

    init(sessionID: String, appState: AppState) {
        self.sessionID = sessionID
        _viewModel = State(initialValue: ChatViewModel(sessionId: sessionID, appState: appState))
    }

    var body: some View {
        MacChatView(sessionId: sessionID, prebuiltViewModel: viewModel)
            .overlay(alignment: .top) {
                Text("Starting session…")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.top, 52)
                    .allowsHitTesting(false)
            }
    }
}
#endif
