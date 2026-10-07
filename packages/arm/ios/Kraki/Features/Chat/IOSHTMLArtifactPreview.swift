#if os(iOS)
import SwiftUI
import WebKit

struct IOSSelectedHTMLArtifact: Identifiable, Equatable {
    let sessionId: String
    let ref: ContentRef

    var id: String { "\(sessionId):\(ref.id)" }
}

struct IOSHTMLArtifactPreview: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var loadedArtifactID: String?
    @State private var exportURL: IOSReportExportItem?

    let selection: IOSSelectedHTMLArtifact

    private var title: String {
        let caption = selection.ref.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = selection.ref.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let caption, !caption.isEmpty { return caption }
        if let name, !name.isEmpty { return name }
        return "Report"
    }

    var body: some View {
        NavigationStack {
            artifactBody
                .background(Color.surfacePrimary)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let html = readyHTML {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                if let url = try? HTMLReportExport.writeBrowserCopy(html: html, ref: selection.ref) {
                                    exportURL = IOSReportExportItem(url: url)
                                }
                            } label: {
                                Image(systemName: "square.and.arrow.up")
                            }
                            .accessibilityLabel("Open in Another App")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel("Close Report")
                    }
                }
        }
        .sheet(item: $exportURL) { item in
            IOSActivityView(items: [item.url])
                .presentationDetents([.medium, .large])
        }
        .task(id: selection.ref.id) {
            guard selection.ref.size <= HTMLArtifactSecurity.maxBytes else { return }
            appState.attachmentStore.requestIfNeeded(
                id: selection.ref.id,
                sessionId: selection.sessionId,
                priority: .userOpened
            )
        }
        .onDisappear {
            appState.attachmentStore.release(id: selection.ref.id, priority: .userOpened)
        }
    }

    private var readyHTML: String? {
        guard case .ready(let mimeType, let data) = appState.attachmentStore.state(for: selection.ref.id),
              mimeType == "text/html",
              data.count <= HTMLArtifactSecurity.maxBytes else { return nil }
        return String(data: data, encoding: .utf8)
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
                    ZStack {
                        IOSHTMLArtifactWebView(
                            html: HTMLArtifactSecurity.securedHTML(html),
                            artifactID: selection.ref.id,
                            onReady: { loadedArtifactID = selection.ref.id }
                        )
                        .opacity(loadedArtifactID == selection.ref.id ? 1 : 0)
                        if loadedArtifactID != selection.ref.id {
                            VStack(spacing: 10) {
                                ProgressView()
                                Text("Rendering report…")
                                    .font(.subheadline)
                                    .foregroundStyle(Color.textSecondary)
                            }
                        }
                    }
                    .background(Color.white)
                    .ignoresSafeArea(.container, edges: .bottom)
                } else {
                    errorState("This attachment is not a valid UTF-8 HTML report.")
                }
            case .error(let reason):
                errorState(reason)
            case .awaitingChunks, .fetching, nil:
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Loading report…")
                        .font(.subheadline)
                        .foregroundStyle(Color.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func errorState(_ reason: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 24, weight: .medium))
                .foregroundStyle(.orange)
            Text("Couldn’t load this report")
                .font(.headline)
                .foregroundStyle(Color.textTitle)
            Text(reason)
                .font(.subheadline)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct IOSReportExportItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// System share sheet: lets the user open the standalone report in a
/// browser-capable app or save it to Files when the viewer is not enough.
private struct IOSActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct IOSHTMLArtifactWebView: UIViewRepresentable {
    let html: String
    let artifactID: String
    let onReady: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onReady: onReady)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.suppressesIncrementalRendering = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.underPageBackgroundColor = .white
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isInspectable = false
        webView.accessibilityLabel = "Report content"
        context.coordinator.load(html: html, artifactID: artifactID, into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onReady = onReady
        context.coordinator.load(html: html, artifactID: artifactID, into: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var onReady: () -> Void
        private var loadedArtifactID: String?
        private var loadedHTML: String?
        private var initialNavigationPending = false
        private var recoveryAttempts = 0

        init(onReady: @escaping () -> Void) {
            self.onReady = onReady
        }

        func load(html: String, artifactID: String, into webView: WKWebView) {
            guard loadedArtifactID != artifactID else { return }
            loadedArtifactID = artifactID
            loadedHTML = html
            initialNavigationPending = true
            webView.stopLoading()
            let scripts = webView.configuration.userContentController
            scripts.removeAllUserScripts()
            HTMLReportMermaid.install(into: scripts, for: html)
            HTMLReportNetworkBlock.load(html, into: webView)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            recoveryAttempts = 0
            // `didFinish` precedes WebKit's first remote-layer commit by a few
            // frames on cold process launch. Keep the native progress state
            // visible through that gap so users never see an empty white panel.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self, weak webView] in
                guard let self, webView != nil else { return }
                self.onReady()
            }
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
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
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

        @available(iOS 18.4, *)
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
