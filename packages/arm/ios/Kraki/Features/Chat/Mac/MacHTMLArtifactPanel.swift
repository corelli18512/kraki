#if os(macOS)
import AppKit
import SwiftUI
import WebKit

struct MacSelectedHTMLArtifact: Equatable {
    let sessionId: String
    let ref: ContentRef
}

struct MacHTMLArtifactPanel: View {
    @Environment(AppState.self) private var appState

    let selection: MacSelectedHTMLArtifact
    let expanded: Bool
    let canToggleExpanded: Bool
    let onToggleExpanded: () -> Void
    let onClose: () -> Void

    private var title: String {
        let caption = selection.ref.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = selection.ref.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let caption, !caption.isEmpty { return caption }
        if let name, !name.isEmpty { return name }
        return "HTML Report"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 9) {
                Image(systemName: "doc.richtext")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 20, height: 20)

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.textTitle)
                        .lineLimit(1)
                    Text("HTML Report · \(ByteCountFormatter.string(fromByteCount: Int64(selection.ref.size), countStyle: .file))")
                        .font(.system(size: 9.5))
                        .foregroundStyle(Color.textMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if canToggleExpanded {
                    Button(action: onToggleExpanded) {
                        Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.textSecondary)
                    .help(expanded ? "Restore Split View" : "Expand Report")
                }

                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.textSecondary)
                .help("Close Report")
                .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .background(Color.surfacePrimary)

            Rectangle()
                .fill(Color.borderPrimary.opacity(0.7))
                .frame(height: 1)

            artifactBody
        }
        .background(Color.surfacePrimary)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("HTML report preview")
        .task(id: selection.ref.id) {
            guard selection.ref.size <= HTMLArtifactSecurity.maxBytes else { return }
            appState.attachmentStore.requestIfNeeded(
                id: selection.ref.id,
                sessionId: selection.sessionId
            )
        }
    }

    @ViewBuilder
    private var artifactBody: some View {
        if selection.ref.size > HTMLArtifactSecurity.maxBytes {
            errorState("This report exceeds the 10 MB safety limit.")
        } else {
            switch appState.attachmentStore.state(for: selection.ref.id) {
            case .ready(let mimeType, let data):
                if data.count > HTMLArtifactSecurity.maxBytes {
                    errorState("This report exceeds the 10 MB safety limit.")
                } else if mimeType == "text/html", let html = String(data: data, encoding: .utf8) {
                    MacHTMLArtifactWebView(
                        html: HTMLArtifactSecurity.securedHTML(html),
                        artifactID: selection.ref.id
                    )
                    .background(Color.white)
                } else {
                    errorState("This attachment is not a valid UTF-8 HTML report.")
                }
            case .error(let reason):
                errorState(reason)
            case .awaitingChunks, .fetching, nil:
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading report…")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func errorState(_ reason: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.orange)
            Text("Couldn’t load this report")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textTitle)
            Text(reason)
                .font(.system(size: 11))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct MacHTMLArtifactWebView: NSViewRepresentable {
    let html: String
    let artifactID: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.suppressesIncrementalRendering = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.underPageBackgroundColor = .white
        webView.allowsMagnification = true
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isInspectable = false
        webView.setAccessibilityLabel("HTML report content")
        context.coordinator.load(html: html, artifactID: artifactID, into: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(html: html, artifactID: artifactID, into: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var loadedArtifactID: String?
        private var loadedHTML: String?
        private var initialNavigationPending = false
        private var recoveryAttempts = 0

        func load(html: String, artifactID: String, into webView: WKWebView) {
            guard loadedArtifactID != artifactID else { return }
            loadedArtifactID = artifactID
            loadedHTML = html
            initialNavigationPending = true
            webView.stopLoading()
            webView.loadHTMLString(html, baseURL: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            recoveryAttempts = 0
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard recoveryAttempts == 0,
                  let artifactID = loadedArtifactID,
                  let html = loadedHTML else { return }
            recoveryAttempts += 1
            loadedArtifactID = nil
            load(html: html, artifactID: artifactID, into: webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if initialNavigationPending,
               navigationAction.navigationType == .other,
               navigationAction.targetFrame?.isMainFrame != false {
                initialNavigationPending = false
                decisionHandler(.allow)
                return
            }
            if navigationAction.targetFrame?.isMainFrame != false,
               let url = navigationAction.request.url,
               url.scheme == "about",
               url.path == "blank",
               url.fragment != nil {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            guard navigationResponse.canShowMIMEType else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.deny)
        }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            completionHandler(nil)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            completionHandler()
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            completionHandler(false)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}
#endif
