#if os(iOS)
import SwiftUI
import AuthenticationServices

/// GitHub OAuth flow using ASWebAuthenticationSession.
///
/// Presented as a sheet from LoginView. Builds the GitHub authorize URL,
/// opens the system browser sheet, and extracts the authorization code
/// from the callback.
struct OAuthView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let clientId: String

    @State private var isAuthenticating = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 20) {
            if isAuthenticating {
                ProgressView()
                    .controlSize(.large)
                Text("Authenticating…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let error = errorMessage {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.red)
                Text("Authentication Failed")
                    .font(.headline)
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Button("Try Again") {
                    startOAuth()
                }
                .buttonStyle(.borderedProminent)

                Button("Cancel") {
                    dismiss()
                }
                .foregroundStyle(.secondary)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            startOAuth()
        }
    }

    // MARK: - OAuth Flow

    private func startOAuth() {
        errorMessage = nil
        isAuthenticating = true

        let state = UUID().uuidString
        let callbackScheme = "kraki"

        var components = URLComponents(string: "https://github.com/login/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "scope", value: "read:user"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: "\(callbackScheme)://oauth/callback"),
        ]

        guard let authURL = components.url else {
            errorMessage = "Failed to build authorization URL"
            isAuthenticating = false
            return
        }

        let session = ASWebAuthenticationSession(
            url: authURL,
            callbackURLScheme: callbackScheme
        ) { callbackURL, error in
            isAuthenticating = false

            if let error = error as? ASWebAuthenticationSessionError,
               error.code == .canceledLogin {
                dismiss()
                return
            }

            if let error {
                errorMessage = error.localizedDescription
                return
            }

            guard let callbackURL,
                  let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
                  let returnedState = components.queryItems?.first(where: { $0.name == "state" })?.value,
                  returnedState == state else {
                errorMessage = "Invalid callback from GitHub"
                return
            }

            // Send the code to the relay for token exchange
            appState.authManager?.authenticateWithGitHubCode(code)
            dismiss()
        }

        // Use the window scene for presentation context
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootVC = window.rootViewController {
            session.presentationContextProvider = PresentationContextProvider(anchor: rootVC.view.window!)
        }

        session.prefersEphemeralWebBrowserSession = false
        session.start()
    }
}

// MARK: - Presentation Context

private final class PresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }
}

#endif
