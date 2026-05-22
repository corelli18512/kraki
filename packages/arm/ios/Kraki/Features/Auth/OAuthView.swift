#if os(iOS)
import SwiftUI
import AuthenticationServices

/// GitHub OAuth flow using ASWebAuthenticationSession.
///
/// Presented as a sheet from LoginView. Builds the GitHub authorize URL,
/// opens the system browser sheet, and extracts the authorization code
/// from the callback.
///
/// Multi-platform layout: we share a single OAuth App with the web,
/// and the same `https://app.kraki.chat/auth/callback` URL handles
/// both surfaces. iOS captures the redirect via the iOS 17.4+
/// `ASWebAuthenticationSession.Callback.https(host:path:)` API, which
/// is backed by Universal Links — the Associated Domains entitlement
/// + the AASA file hosted at the web domain authorize this app to
/// claim that URL. Web users without the iOS app still land on the
/// real `/auth/callback` page normally.
struct OAuthView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let clientId: String

    @State private var isAuthenticating = false
    @State private var errorMessage: String?
    // ASWebAuthenticationSession + its presentationContextProvider must
    // be kept alive for the duration of the system sheet. The system
    // holds the provider weakly, so without a strong reference we get
    // `WebAuthenticationSession error 2` (`presentationContextNotProvided`).
    @State private var authSession: ASWebAuthenticationSession?
    @State private var contextProvider: PresentationContextProvider?

    // Callback URL details — kept in lockstep with the AASA file at
    // https://app.kraki.chat/.well-known/apple-app-site-association.
    // If either side changes, the OS will no longer intercept the
    // redirect and the OAuth flow will hang on GitHub's redirect page.
    private static let callbackHost = "app.kraki.chat"
    private static let callbackPath = "/auth/callback"
    private static var redirectURL: String { "https://\(callbackHost)\(callbackPath)" }

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
        let codeVerifier = PKCE.generateCodeVerifier()
        let codeChallenge = PKCE.deriveChallenge(verifier: codeVerifier)

        var components = URLComponents(string: "https://github.com/login/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "scope", value: "read:user"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURL),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]

        guard let authURL = components.url else {
            errorMessage = "Failed to build authorization URL"
            isAuthenticating = false
            return
        }

        let callback: ASWebAuthenticationSession.Callback = .https(
            host: Self.callbackHost,
            path: Self.callbackPath
        )

        let session = ASWebAuthenticationSession(
            url: authURL,
            callback: callback
        ) { callbackURL, error in
            isAuthenticating = false
            // Release the strong references now that the system sheet
            // has resolved one way or the other.
            authSession = nil
            contextProvider = nil

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

            // Send the code + PKCE verifier + the exact redirect_uri
            // we used to the relay. The relay forwards all three to
            // GitHub's token-exchange endpoint; GitHub binds the code
            // to (verifier, redirect_uri) so a stolen code alone is
            // not enough to mint a token.
            appState.authManager?.authenticateWithGitHubCode(
                code,
                codeVerifier: codeVerifier,
                redirectUri: Self.redirectURL
            )
            dismiss()
        }

        // Use the window scene for presentation context. Hold a strong
        // reference to the provider via @State — ASWebAuthenticationSession
        // weakly references it and would otherwise let it deallocate
        // before presenting the sheet.
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first {
            let provider = PresentationContextProvider(anchor: window)
            contextProvider = provider
            session.presentationContextProvider = provider
        }

        session.prefersEphemeralWebBrowserSession = false
        authSession = session
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
