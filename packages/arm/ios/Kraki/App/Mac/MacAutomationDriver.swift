#if os(macOS) && DEBUG
import AppKit
import Darwin
import Foundation
import SwiftUI
import WebKit

/// Debug-only, focus-safe control plane for the native Mac app.
///
/// Unlike AX/XCTest/Appium automation, this driver never synthesizes input,
/// activates the application, raises a window, or changes the key window. It
/// invokes the same semantic actions as the SwiftUI controls and exposes state
/// over a user-private Unix domain socket using newline-delimited JSON.
///
/// Enable explicitly with `KRAKI_NATIVE_AUTOMATION=1` or the Debug-only
/// `--kraki-native-automation` launch argument. An already-running app is
/// never launched or restarted by the client; the client only connects to
/// the socket advertised in `KRAKI_NATIVE_AUTOMATION_SOCKET` or the matching
/// launch argument.
@MainActor
final class MacAutomationDriver {
    static let shared = MacAutomationDriver()

    static let defaultSocketPath = "/tmp/kraki-native-automation-\(getuid()).sock"

    private weak var appState: AppState?
    private var serverFD: Int32 = -1
    private var clientFDs: Set<Int32> = []
    private(set) var selectedSessionId: String?
    private(set) var presentedSteps: (sessionId: String, seq: Int)?

    private init() {}

    var enabled: Bool {
        ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION"] == "1"
            || CommandLine.arguments.contains("--kraki-native-automation")
    }

    var socketPath: String {
        if let value = CommandLine.arguments.first(where: {
            $0.hasPrefix("--kraki-native-automation-socket=")
        }) {
            return String(value.dropFirst("--kraki-native-automation-socket=".count))
        }
        if let index = CommandLine.arguments.firstIndex(
            of: "--kraki-native-automation-socket"
        ), index + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[index + 1]
        }
        return ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION_SOCKET"]
            ?? Self.defaultSocketPath
    }

    func start(appState: AppState) {
        guard enabled, serverFD < 0 else { return }
        self.appState = appState

        let path = socketPath
        let maxPathBytes = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        guard path.utf8.count < maxPathBytes else {
            KLog.d("❌ Native automation socket path is too long: \(path)")
            return
        }
        try? FileManager.default.removeItem(atPath: path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            KLog.d("❌ Native automation socket() failed: \(String(cString: strerror(errno)))")
            return
        }
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            let utf8 = Array(path.utf8) + [0]
            bytes.copyBytes(from: utf8)
        }
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0, Darwin.listen(fd, 8) == 0 else {
            let reason = String(cString: strerror(errno))
            Darwin.close(fd)
            KLog.d("❌ Native automation bind/listen failed: \(reason)")
            return
        }

        serverFD = fd
        chmod(path, S_IRUSR | S_IWUSR)
        KLog.d("🤖 Native automation ready at \(path)")
        DispatchQueue.global(qos: .userInitiated).async {
            Self.acceptLoop(serverFD: fd)
        }
    }

    func stop() {
        let fd = serverFD
        serverFD = -1
        if fd >= 0 { Darwin.close(fd) }
        for clientFD in clientFDs { Darwin.close(clientFD) }
        clientFDs.removeAll()
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    func updateSelectedSession(_ sessionId: String?) {
        selectedSessionId = sessionId
    }

    func updatePresentedSteps(sessionId: String, seq: Int) {
        presentedSteps = (sessionId, seq)
    }

    func clearPresentedSteps() {
        presentedSteps = nil
    }

    // MARK: - Transport

    nonisolated private static func acceptLoop(serverFD: Int32) {
        while true {
            let clientFD = Darwin.accept(serverFD, nil, nil)
            guard clientFD >= 0 else { return }
            var noSigPipe: Int32 = 1
            setsockopt(clientFD, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            Task { @MainActor in shared.clientFDs.insert(clientFD) }
            DispatchQueue.global(qos: .userInitiated).async {
                readLoop(clientFD: clientFD)
            }
        }
    }

    nonisolated private static func readLoop(clientFD: Int32) {
        var pending = Data()
        var bytes = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = Darwin.read(clientFD, &bytes, bytes.count)
            guard count > 0 else { break }
            pending.append(contentsOf: bytes.prefix(count))
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = Data(pending[..<newline])
                pending.removeSubrange(...newline)
                Task { @MainActor in shared.handle(line, on: clientFD) }
            }
            if pending.count > 1024 * 1024 { break }
        }
        Darwin.close(clientFD)
        Task { @MainActor in shared.clientFDs.remove(clientFD) }
    }

    private func send(_ object: [String: Any], on clientFD: Int32) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(clientFD, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard written > 0 else { return }
                offset += written
            }
        }
    }

    private func handle(_ data: Data, on connection: Int32) {
        guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let method = request["method"] as? String else {
            send(error: "invalid_request", message: "Expected a JSON object with a method", id: nil, on: connection)
            return
        }
        let id = request["id"]
        let params = request["params"] as? [String: Any] ?? [:]

        switch method {
        case "ping":
            send(result: [
                "version": 1,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "activationPolicy": activationPolicyName,
                "isActive": NSApp.isActive,
                "hasKeyWindow": NSApp.keyWindow != nil,
                "hasMainWindow": NSApp.mainWindow != nil,
            ], id: id, on: connection)
        case "resizeWindow":
            let width = CGFloat(params["width"] as? Double ?? 1_600)
            let height = CGFloat(params["height"] as? Double ?? 900)
            guard let window = NSApp.windows
                .filter({ $0.contentView != nil && $0.frame.width > 300 && $0.frame.height > 200 })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                send(error: "invalid_state", message: "No production window is mounted", id: id, on: connection); return
            }
            window.setContentSize(NSSize(width: max(width, 700), height: max(height, 500)))
            window.contentView?.layoutSubtreeIfNeeded()
            send(result: ["width": Double(window.contentLayoutRect.width), "height": Double(window.contentLayoutRect.height)], id: id, on: connection)
        case "snapshot":
            send(result: snapshot(), id: id, on: connection)
        case "mockSnapshot":
            guard let mock = MacChatMockSnapshotCache.shared.cached else {
                send(error: "invalid_state", message: "Mock snapshot is not ready", id: id, on: connection); return
            }
            send(result: snapshot(appState: mock, selectedSessionId: mock.sessionStore.activeSessionId), id: id, on: connection)
        case "createSession":
            createSession(params: params, id: id, connection: connection)
        case "selectSession":
            guard let sessionId = params["sessionId"] as? String else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            postUIAction("selectSession", ["sessionId": sessionId])
            send(result: ["selectedSessionId": sessionId], id: id, on: connection)
        case "pageOlder":
            let sessionId = params["sessionId"] as? String ?? selectedSessionId
            guard let sessionId else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            postUIAction("pageOlder", ["sessionId": sessionId])
            send(result: ["requested": true, "sessionId": sessionId], id: id, on: connection)
        case "pageNewer":
            let sessionId = params["sessionId"] as? String ?? selectedSessionId
            guard let appState, let sessionId else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            let moved = appState.messageProvider?.ensureNewerLoaded(sessionId: sessionId) ?? false
            send(result: ["requested": true, "moved": moved, "sessionId": sessionId], id: id, on: connection)
        case "jumpLatest":
            let sessionId = params["sessionId"] as? String ?? selectedSessionId
            guard let sessionId else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            postUIAction("jumpLatest", ["sessionId": sessionId])
            send(result: ["requested": true, "sessionId": sessionId], id: id, on: connection)
        case "toggleModePicker":
            postUIAction("toggleModePicker", selectedSessionId.map { ["sessionId": $0] } ?? [:])
            send(result: ["requested": true], id: id, on: connection)
        case "scrollToBubble":
            guard let seq = params["seq"] as? Int else {
                send(error: "invalid_params", message: "seq is required", id: id, on: connection); return
            }
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            let screenY = CGFloat(params["screenY"] as? Double ?? 96)
            let found = scrollView.automationScrollToBubble(seq: seq, screenY: screenY)
            send(result: ["found": found, "seq": seq], id: id, on: connection)
        case "scrollChat":
            let direction = params["direction"] as? String ?? "up"
            let ticks = min(max(params["ticks"] as? Int ?? 1, 1), 500)
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            let result = scrollView.automationScroll(direction: direction, ticks: ticks)
            send(result: [
                "requested": true,
                "direction": direction,
                "ticks": ticks,
                "beforeY": Double(result.before),
                "afterY": Double(result.after),
                "moved": abs(result.after - result.before) > 0.5,
            ], id: id, on: connection)
        case "simulateMissingLiveScrollEnd":
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            let overlapScrollerKnob = params["overlapScrollerKnob"] as? Bool ?? false
            scrollView.automationSimulateMissingLiveScrollEnd(
                overlapScrollerKnob: overlapScrollerKnob
            )
            send(result: [
                "requested": true,
                "overlapScrollerKnob": overlapScrollerKnob,
            ], id: id, on: connection)
        case "captureHTMLArtifactCard":
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            let path = params["path"] as? String ?? "/tmp/kraki-html-artifact-card.png"
            let captured = scrollView.chatDocumentView.captureVisibleHTMLArtifactCard(to: path)
            send(result: ["captured": captured, "path": path], id: id, on: connection)
        case "openHTMLArtifact":
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            let artifactID = params["artifactId"] as? String
            let opened = scrollView.chatDocumentView.openVisibleHTMLArtifact(id: artifactID)
            send(result: ["opened": opened, "artifactId": artifactID ?? NSNull()], id: id, on: connection)
        case "artifactState":
            let webViews = findViews(of: WKWebView.self)
            send(result: [
                "webViewCount": webViews.count,
                "loadingCount": webViews.filter(\.isLoading).count,
                "titles": webViews.compactMap(\.title),
                "progress": webViews.map(\.estimatedProgress),
                "frames": webViews.map { [
                    "width": Double($0.frame.width),
                    "height": Double($0.frame.height),
                ] },
            ], id: id, on: connection)
        case "artifactSecurity":
            guard let webView = findViews(of: WKWebView.self).first else {
                send(error: "invalid_state", message: "No HTML artifact WebView is mounted", id: id, on: connection); return
            }
            let script = """
            (() => ({
              href: location.href,
              title: document.title,
              bodyTextLength: (document.body?.innerText || '').length,
              scrollHeight: document.documentElement?.scrollHeight || 0,
              iframeCount: document.querySelectorAll('iframe').length,
              formCount: document.querySelectorAll('form').length,
              csp: document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || '',
              nativeHandlerCount: Object.keys(window.webkit?.messageHandlers || {}).length
            }))()
            """
            webView.evaluateJavaScript(script) { value, error in
                Task { @MainActor in
                    if let error {
                        self.send(error: "javascript_failed", message: error.localizedDescription, id: id, on: connection)
                        return
                    }
                    var result = value as? [String: Any] ?? [:]
                    result["persistentDataStore"] = webView.configuration.websiteDataStore === WKWebsiteDataStore.default()
                    self.send(result: result, id: id, on: connection)
                }
            }
        case "captureArtifact":
            guard let webView = findViews(of: WKWebView.self).first else {
                send(error: "invalid_state", message: "No HTML artifact WebView is mounted", id: id, on: connection); return
            }
            let path = params["path"] as? String ?? "/tmp/kraki-html-artifact.png"
            let configuration = WKSnapshotConfiguration()
            configuration.rect = webView.bounds
            configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { image, error in
                Task { @MainActor in
                    guard let image,
                          let tiff = image.tiffRepresentation,
                          let bitmap = NSBitmapImageRep(data: tiff),
                          let png = bitmap.representation(using: .png, properties: [:]) else {
                        self.send(error: "capture_failed", message: error?.localizedDescription ?? "WKWebView snapshot failed", id: id, on: connection)
                        return
                    }
                    do {
                        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
                        self.send(result: ["path": path, "width": Int(image.size.width), "height": Int(image.size.height)], id: id, on: connection)
                    } catch {
                        self.send(error: "capture_failed", message: error.localizedDescription, id: id, on: connection)
                    }
                }
            }
        case "closeHTMLArtifact":
            postUIAction("closeHTMLArtifact")
            send(result: ["closed": true], id: id, on: connection)
        case "chatLayout":
            guard let scrollView = findChatScrollView() else {
                send(error: "invalid_state", message: "No production MacChatScrollView is mounted", id: id, on: connection); return
            }
            var result = scrollView.chatDocumentView.layoutDiagnostics(
                viewport: scrollView.contentView.bounds
            )
            result["scrollAlpha"] = Double(scrollView.alphaValue)
            result["scrollHidden"] = scrollView.isHidden
            result["distanceToBottom"] = Double(scrollView.distanceToBottom)
            result["representedSessionId"] = scrollView.representedSessionId ?? NSNull()
            result["entryBottomLocked"] = scrollView.isEntryBottomLocked
            result["followingBottom"] = scrollView.followingBottom
            result["contentInsetTop"] = Double(scrollView.contentInsets.top)
            result["contentInsetBottom"] = Double(scrollView.contentInsets.bottom)
            result["clipMinY"] = Double(scrollView.contentView.bounds.minY)
            result["clipMaxY"] = Double(scrollView.contentView.bounds.maxY)
            result["clipViewClass"] = NSStringFromClass(type(of: scrollView.contentView))
            result["scrollViewClass"] = NSStringFromClass(type(of: scrollView))
            result["scrollViewObjectID"] = String(describing: ObjectIdentifier(scrollView))
            result["firstResponderClass"] = scrollView.window?.firstResponder.map { NSStringFromClass(type(of: $0)) } ?? NSNull()
            result["clipDocumentMinY"] = Double(scrollView.contentView.documentRect.minY)
            result["clipDocumentMaxY"] = Double(scrollView.contentView.documentRect.maxY)
            result["clipDocumentHeight"] = Double(scrollView.contentView.documentRect.height)
            result["contentViewportFrameX"] = Double(scrollView.contentView.frame.minX)
            result["contentViewportFrameY"] = Double(scrollView.contentView.frame.minY)
            result["contentViewportFrameWidth"] = Double(scrollView.contentView.frame.width)
            result["contentViewportFrameHeight"] = Double(scrollView.contentView.frame.height)
            result["scrollFrameHeight"] = Double(scrollView.frame.height)
            for (key, value) in scrollView.edgePagingDiagnostics {
                result[key] = value
            }
            result["calculatedBottomY"] = Double(max(
                -scrollView.contentInsets.top,
                scrollView.chatDocumentView.frame.height
                    - scrollView.contentView.bounds.height
            ))
            send(result: result, id: id, on: connection)
        case "chatState":
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            var result: [String: Any] = [
                "selectedSessionId": selectedSessionId ?? NSNull(),
            ]
            if let sessionId = selectedSessionId,
               let session = appState.sessionStore.sessions[sessionId] {
                let window = appState.messageStore.windowState(sessionId)
                let viewModel = ChatViewModel(sessionId: sessionId, appState: appState)
                result["sessionId"] = sessionId
                result["expectedLastSeq"] = max(session.lastSeq, viewModel.sessionLastSeq)
                result["dbLastSeq"] = appState.messageStore.dbLastSeq(sessionId)
                result["windowTopSeq"] = window?.topSeq ?? 0
                result["windowBottomSeq"] = window?.bottomSeq ?? 0
                result["waitingForLatest"] = viewModel.isWaitingForLatestBubble
                result["loading"] = appState.sessionStore.loadingSessions.contains(sessionId)
            }
            if let scrollView = findChatScrollView() {
                let layout = scrollView.chatDocumentView.layoutDiagnostics(viewport: scrollView.contentView.bounds)
                result["representedSessionId"] = scrollView.representedSessionId ?? NSNull()
                result["scrollAlpha"] = Double(scrollView.alphaValue)
                result["distanceToBottom"] = Double(scrollView.distanceToBottom)
                result["realCellCount"] = layout["realCellCount"] ?? 0
                result["visibleCellCount"] = layout["visibleCellCount"] ?? 0
                result["placeholderCount"] = layout["placeholderCount"] ?? 0
                result["intersectingPlaceholderCount"] = layout["intersectingPlaceholderCount"] ?? 0
                result["itemCount"] = layout["itemCount"] ?? 0
            }
            send(result: result, id: id, on: connection)
        case "voiceState":
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            send(result: voiceState(appState), id: id, on: connection)
        case "voiceBegin":
            guard let appState,
                  let sessionId = params["sessionId"] as? String ?? selectedSessionId,
                  let session = appState.sessionStore.sessions[sessionId] else {
                send(error: "invalid_params", message: "A valid sessionId is required", id: id, on: connection); return
            }
            let context = VoiceSessionContextBuilder.build(
                session: session,
                recentMessages: appState.messageStore.recentFromDB(sessionId, limit: 20)
            )
            Task { @MainActor in
                await appState.voiceInputController.begin(
                    sessionID: sessionId,
                    context: context,
                    onFinal: { final in
                        guard appState.sessionStore.sessions[sessionId] != nil else { return }
                        let existing = appState.sessionStore.drafts[sessionId] ?? ""
                        appState.sessionStore.setDraft(
                            sessionId,
                            VoiceDraftMerger.merge(existing: existing, final: final)
                        )
                    }
                )
            }
            send(result: ["requested": true, "sessionId": sessionId], id: id, on: connection)
        case "voiceFinish":
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            appState.voiceInputController.finish()
            send(result: voiceState(appState), id: id, on: connection)
        case "voiceCancel":
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            appState.voiceInputController.cancel()
            send(result: voiceState(appState), id: id, on: connection)
        case "sendInput":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let text = params["text"] as? String else {
                send(error: "invalid_params", message: "sessionId and text are required", id: id, on: connection); return
            }
            let delivery = (params["delivery"] as? String).flatMap(CommandSender.InputDelivery.init(rawValue:)) ?? .prompt
            let accepted = appState.commandSender?.sendInput(sessionId: sessionId, text: text, delivery: delivery) ?? false
            send(result: ["accepted": accepted], id: id, on: connection)
        case "setMode":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let raw = params["mode"] as? String,
                  let mode = SessionMode(rawValue: raw) else {
                send(error: "invalid_params", message: "valid sessionId and mode are required", id: id, on: connection); return
            }
            appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
            send(result: ["mode": mode.rawValue], id: id, on: connection)
        case "abort":
            guard let appState, let sessionId = params["sessionId"] as? String else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            let accepted = appState.commandSender?.abortSession(sessionId: sessionId) ?? false
            send(result: ["accepted": accepted], id: id, on: connection)
        case "presentSteps":
            guard let sessionId = params["sessionId"] as? String else {
                send(error: "invalid_params", message: "sessionId is required", id: id, on: connection); return
            }
            var payload: [String: Any] = ["sessionId": sessionId]
            if let seq = params["seq"] as? Int { payload["seq"] = seq }
            postUIAction("steps", payload)
            send(result: ["requested": true], id: id, on: connection)
        case "closeSteps":
            postUIAction("closeSteps")
            send(result: ["requested": true], id: id, on: connection)
        case "requestSteps":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let seq = params["seq"] as? Int else {
                send(error: "invalid_params", message: "sessionId and seq are required", id: id, on: connection); return
            }
            appState.messageProvider?.requestTurnTrace(sessionId: sessionId, bubbleSeq: seq)
            send(result: ["requested": true], id: id, on: connection)
        case "permission":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let decision = params["decision"] as? String,
                  let action = appState.messageStore.cards[sessionId]?.action,
                  let permissionId = action.permissionId else {
                send(error: "invalid_state", message: "No pending permission for this session", id: id, on: connection); return
            }
            switch decision {
            case "approve":
                appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
            case "execute":
                appState.commandSender?.setSessionMode(sessionId: sessionId, mode: .execute)
                appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
            case "always_allow":
                appState.commandSender?.alwaysAllow(sessionId: sessionId, permissionId: permissionId, toolKind: action.toolName)
            case "deny":
                appState.commandSender?.deny(sessionId: sessionId, permissionId: permissionId)
            default:
                send(error: "invalid_params", message: "Unknown permission decision", id: id, on: connection); return
            }
            send(result: ["accepted": true, "permissionId": permissionId], id: id, on: connection)
        case "answer":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let action = appState.messageStore.cards[sessionId]?.action,
                  let questionId = action.questionId else {
                send(error: "invalid_state", message: "No pending question for this session", id: id, on: connection); return
            }
            let answer = params["text"] as? String ?? ""
            let wasFreeform = params["wasFreeform"] as? Bool ?? true
            appState.commandSender?.answer(sessionId: sessionId, questionId: questionId, answer: answer, wasFreeform: wasFreeform)
            send(result: ["accepted": true, "questionId": questionId], id: id, on: connection)
        case "codeContrastRegression":
            send(result: codeContrastRegression(), id: id, on: connection)
        case "tableWheelRegression":
            send(result: tableWheelRegression(), id: id, on: connection)
        case "transientScrollerRegression":
            transientScrollerRegression(id: id, connection: connection)
        case "sessionListScrollerRegression":
            sessionListScrollerRegression(id: id, connection: connection)
        case "composerPasteFocusRegression":
            MacComposerPasteFocusRegression.run { [weak self] result in
                self?.send(result: result, id: id, on: connection)
            }
        case "sessionSpeakerStatusRegression":
            send(result: sessionSpeakerStatusRegression(), id: id, on: connection)
        case "sessionSpeakerDiagnostics":
            send(result: sessionSpeakerDiagnostics(), id: id, on: connection)
        case "chatLoadingDiagnostics":
            send(result: chatLoadingDiagnostics(), id: id, on: connection)
        case "historyDisconnectRegression":
            send(result: historyDisconnectRegression(), id: id, on: connection)
        case "historyCoverageDiagnostics":
            send(result: historyCoverageDiagnostics(), id: id, on: connection)
        case "bubbleActionOrderRegression":
            send(result: bubbleActionOrderRegression(), id: id, on: connection)
        case "captureSidebar":
            let path = params["path"] as? String ?? "/tmp/kraki-native-sidebar.png"
            switch captureSidebar(path: path) {
            case .success(let size):
                send(result: ["path": path, "width": Int(size.width), "height": Int(size.height)], id: id, on: connection)
            case .failure(let error):
                send(error: "capture_failed", message: error.localizedDescription, id: id, on: connection)
            }
        case "captureSessionSpeakerGlyphs":
            let path = params["path"] as? String ?? "/tmp/kraki-session-speaker-glyphs.png"
            switch captureSessionSpeakerGlyphs(path: path) {
            case .success(let size):
                send(result: ["path": path, "width": Int(size.width), "height": Int(size.height)], id: id, on: connection)
            case .failure(let error):
                send(error: "capture_failed", message: error.localizedDescription, id: id, on: connection)
            }
        case "capture":
            let path = params["path"] as? String ?? "/tmp/kraki-native-capture.png"
            let sheetOnly = params["sheetOnly"] as? Bool ?? false
            switch captureWindow(path: path, sheetOnly: sheetOnly) {
            case .success(let size):
                send(result: ["path": path, "width": Int(size.width), "height": Int(size.height)], id: id, on: connection)
            case .failure(let error):
                send(error: "capture_failed", message: error.localizedDescription, id: id, on: connection)
            }
        case "wait":
            wait(params: params, id: id, connection: connection)
        case "shutdown":
            send(result: ["stopped": true], id: id, on: connection)
            Task { @MainActor in self.stop() }
        default:
            send(error: "unknown_method", message: "Unknown method: \(method)", id: id, on: connection)
        }
    }

    private func captureSessionSpeakerGlyphs(path: String) -> Result<NSSize, CaptureError> {
        let host = NSHostingView(rootView: MacSessionSpeakerGlyphRegressionView())
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.display()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            window.close()
            return .failure(.bitmap)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            window.close()
            return .failure(.encode)
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            window.close()
            return .success(size)
        } catch {
            window.close()
            return .failure(.write(error))
        }
    }

    private func bubbleActionOrderRegression() -> [String: Any] {
        let action = ChatMessage(
            type: "tool_start",
            seq: 0,
            sessionId: "bubble-action-order",
            deviceId: "tentacle-test",
            timestamp: nil,
            payload: [
                "toolName": AnyCodable("bash"),
                "headline": AnyCodable("$ npm test"),
            ]
        )
        let texts = [
            "Preparing the change.",
            "Preparing the change.\n\nThe streaming response now spans several lines so the bubble grows smoothly while the tool call remains below the message body.",
        ]
        let checks = texts.map { text -> [String: Any] in
            let content = MacChatBubbleContentBuilder.live(
                card: MessageStore.SessionCard(text: text, action: action),
                sessionId: "bubble-action-order",
                agent: "pi",
                documentWidth: 640,
                traceSeq: 1,
                steps: 1
            )
            let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: 640, height: 1))
            cell.configure(
                content: content,
                renderKey: "bubble-action-order:\(text.count)",
                documentWidth: 640,
                sessionMode: .execute,
                onTapSteps: { _ in },
                onResolvePermission: { _, _, _ in },
                onAnswerQuestion: { _, _ in },
                onOpenImage: { _ in },
                onOpenHTMLArtifact: { _ in },
                onHeightInvalidated: {}
            )
            let height = cell.configuredHeight()
            cell.frame.size.height = height
            cell.layoutSubtreeIfNeeded()
            let body = cell.bodyFrameForRegression
            let action = cell.actionFrameForRegression
            return [
                "flipped": cell.contentClipIsFlippedForRegression,
                "bodyMinY": Double(body.minY),
                "bodyMaxY": Double(body.maxY),
                "actionMinY": Double(action.minY),
                "actionMaxY": Double(action.maxY),
                "cellHeight": Double(height),
                "actionBelowBody": action.minY >= body.maxY + 7.5,
                "contained": action.maxY <= height,
            ]
        }
        let passed = checks.allSatisfy {
            ($0["flipped"] as? Bool) == true
                && ($0["actionBelowBody"] as? Bool) == true
                && ($0["contained"] as? Bool) == true
        }
        return ["passed": passed, "checks": checks]
    }

    private func historyCoverageDiagnostics() -> [String: Any] {
        guard let appState,
              let provider = appState.messageProvider else { return ["ready": false] }
        let rows = appState.sessionStore.navigationOrderedSessions.map { session -> [String: Any] in
            let dbLast = appState.messageStore.dbLastSeq(session.id)
            let tentacleLast = provider.tentacleLastKnownSeq(session.id) ?? session.lastSeq
            return [
                "id": session.id,
                "title": session.displayTitle,
                "dbLastSeq": dbLast,
                "tentacleLastSeq": tentacleLast,
                "gap": max(0, tentacleLast - dbLast),
                "state": session.state.rawValue,
            ]
        }
        let missing = rows.filter { ($0["gap"] as? Int ?? 0) > 0 }
        return [
            "ready": true,
            "total": rows.count,
            "missingCount": missing.count,
            "missing": Array(missing.prefix(30)),
        ]
    }

    private func historyDisconnectRegression() -> [String: Any] {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-history-disconnect-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            let state = AppState(testDatabase: database)
            let sessionId = "disconnect-regression"
            let digest = SessionDigest(
                id: sessionId,
                agent: "claude",
                model: "test",
                title: "Disconnect regression",
                autoTitle: nil,
                state: .idle,
                mode: .discuss,
                lastSeq: 99,
                readSeq: 0,
                messageCount: 1,
                createdAt: ISO8601.withFractional.string(from: Date()),
                usage: nil,
                pinned: false,
                source: nil,
                preview: nil
            )
            state.sessionStore.upsertSession(digest, deviceId: "tentacle-test", deviceName: "Test")
            state.messageStore.ingestBatch(sessionId, [
                ChatMessage(
                    type: "agent_message",
                    seq: 1,
                    sessionId: sessionId,
                    deviceId: "tentacle-test",
                    timestamp: nil,
                    payload: ["content": AnyCodable("preserved local message")]
                ),
            ])
            _ = state.messageProvider?.openSession(sessionId)
            state.messageProvider?.debugSeedDisconnectRegressionState(sessionId)

            let beforeKinds = state.messageProvider?.outstandingKinds(sessionId) ?? []
            let beforeWindowCount = state.messageProvider?.currentWindow(sessionId).count ?? 0
            state.messageProvider?.onDisconnected()
            let afterKinds = state.messageProvider?.outstandingKinds(sessionId) ?? []
            let afterWindowCount = state.messageProvider?.currentWindow(sessionId).count ?? 0
            let metadataCleared = state.messageProvider?.tentacleLastKnownSeq(sessionId) == nil
            let loadingCleared = !state.sessionStore.loadingSessions.contains(sessionId)
            let passed = beforeKinds.count == 3
                && afterKinds.isEmpty
                && loadingCleared
                && metadataCleared
                && beforeWindowCount == 1
                && afterWindowCount == 1
            return [
                "passed": passed,
                "beforeSlots": beforeKinds.map { String(describing: $0) },
                "afterSlots": afterKinds.map { String(describing: $0) },
                "loadingCleared": loadingCleared,
                "metadataCleared": metadataCleared,
                "beforeWindowCount": beforeWindowCount,
                "afterWindowCount": afterWindowCount,
            ]
        } catch {
            return ["passed": false, "error": error.localizedDescription]
        }
    }

    private func chatLoadingDiagnostics() -> [String: Any] {
        guard let appState else { return ["ready": false] }
        let sessionId = selectedSessionId
            ?? appState.sessionStore.activeSessionId
            ?? appState.sessionStore.navigationOrderedSessions.first?.id
        guard let sessionId,
              let provider = appState.messageProvider else {
            return ["ready": false]
        }
        let window = appState.messageStore.windowState(sessionId)
        return [
            "ready": true,
            "sessionId": sessionId,
            "connectionStatus": String(describing: appState.connectionStatus),
            "reconnectAttempt": appState.reconnectAttempt,
            "dbLastSeq": appState.messageStore.dbLastSeq(sessionId),
            "windowTopSeq": window?.topSeq ?? 0,
            "windowBottomSeq": window?.bottomSeq ?? 0,
            "tentacleLastSeq": provider.tentacleLastKnownSeq(sessionId) ?? 0,
            "outstanding": provider.outstandingKinds(sessionId).map { String(describing: $0) },
            "sessionLoading": appState.sessionStore.loadingSessions.contains(sessionId),
            "loadFailed": appState.sessionStore.loadFailedSessions.contains(sessionId),
            "atHead": provider.atHead(sessionId),
            "fillingTail": provider.isFillingTail(sessionId),
        ]
    }

    private func sessionSpeakerDiagnostics() -> [String: Any] {
        guard let appState else { return ["ready": false] }
        let sessions = appState.sessionStore.navigationOrderedSessions
        var counts: [String: Int] = [:]
        for session in sessions {
            let previewType = appState.sessionStore.sessionPreviews[session.id]?.type ?? "nil"
            let hasDraft = appState.sessionStore.drafts[session.id]?.isEmpty == false
            let key = "\(session.state.rawValue)|\(previewType)|draft:\(hasDraft ? 1 : 0)"
            counts[key, default: 0] += 1
        }
        let visible = sessions.prefix(20).map { session -> [String: Any] in
            let previewType = appState.sessionStore.sessionPreviews[session.id]?.type ?? "nil"
            let hasDraft = appState.sessionStore.drafts[session.id]?.isEmpty == false
            let online = appState.deviceStore.devices[session.deviceId]?.online
            let resolved = SessionCardStatus.resolve(
                sessionState: session.state,
                previewType: previewType == "nil" ? nil : previewType,
                deviceOnline: online,
                hasDraft: hasDraft
            )
            return [
                "id": session.id,
                "title": session.displayTitle,
                "state": session.state.rawValue,
                "previewType": previewType,
                "draft": hasDraft,
                "online": online as Any,
                "resolved": String(describing: resolved),
            ]
        }
        return [
            "ready": true,
            "total": sessions.count,
            "counts": counts,
            "visible": visible,
        ]
    }

    private func sessionSpeakerStatusRegression() -> [String: Any] {
        func status(
            state: SessionState = .idle,
            previewType: String? = nil,
            online: Bool? = true,
            draft: Bool = false
        ) -> SessionCardStatus {
            .resolve(
                sessionState: state,
                previewType: previewType,
                deviceOnline: online,
                hasDraft: draft
            )
        }

        let checks: [String: Bool] = [
            "agentProduction": status(previewType: "agent") == .agentMessage,
            "humanProduction": status(previewType: "user") == .humanMessage,
            "agentEventAlias": status(previewType: "agent_message") == .agentMessage,
            "humanEventAlias": status(previewType: "user_message") == .humanMessage,
            "draft": status(previewType: "agent", draft: true) == .humanMessage,
            "legacyUnknown": status(previewType: "message") == .idle,
            "offlinePrecedence": status(
                state: .active,
                previewType: "question",
                online: false,
                draft: true
            ) == .offline,
            "questionPrecedence": status(
                state: .active,
                previewType: "question",
                draft: true
            ) == .waiting,
            "permissionPrecedence": status(
                state: .active,
                previewType: "permission",
                draft: true
            ) == .approval,
            "errorPrecedence": status(
                state: .active,
                previewType: "error",
                draft: true
            ) == .error,
            "activePrecedence": status(
                state: .active,
                previewType: "agent_message",
                draft: true
            ) == .active,
            "compactingPrecedence": status(
                state: .compacting,
                previewType: "user_message",
                draft: true
            ) == .compacting,
        ]
        return [
            "passed": checks.values.allSatisfy { $0 },
            "checks": checks,
        ]
    }

    private func codeContrastRegression() -> [String: Any] {
        let nonce = UUID().uuidString
        let markdown = """
        ```swift
        let foregroundContrastProbe_\(nonce.replacingOccurrences(of: "-", with: "")) = true
        print("code must remain visible on the editor surface")
        ```
        """
        let attributed = MacMarkdown.attributed(markdown, cacheKey: "contrast-regression-\(nonce)")
        var minimumContrast = CGFloat.greatestFiniteMagnitude
        var glyphRanges = 0
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length)
        ) { attributes, range, _ in
            guard attributes[.tkBlockKind] as? String == TKBlockKind.code.rawValue,
                  attributes[.tkDecorativeSpacer] == nil else { return }
            let text = attributed.attributedSubstring(from: range).string
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            let color = attributes[.foregroundColor] as? NSColor ?? .black
            minimumContrast = min(
                minimumContrast,
                MacCodePalette.contrastRatio(
                    foreground: color,
                    background: MacCodePalette.background
                )
            )
            glyphRanges += 1
        }
        let resolvedMinimum = minimumContrast.isFinite ? minimumContrast : 0
        return [
            "passed": glyphRanges > 0 && resolvedMinimum >= 4.5,
            "glyphRanges": glyphRanges,
            "minimumContrast": Double(resolvedMinimum),
        ]
    }

    private func tableWheelRegression() -> [String: Any] {
        let chat = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 220))

        let rows = [
            ["Column A with enough width", "Column B with enough width", "Column C with enough width"],
            ["One", "Two", "Three"],
        ]
        let table = MacTableScrollView(
            layout: MacTableLayout(rows: rows, alignments: [.leading, .leading, .leading])
        )
        table.frame = NSRect(x: 20, y: 300, width: 240, height: 80)
        chat.chatDocumentView.addSubview(table)

        let window = NSWindow(
            contentRect: chat.bounds,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = chat
        chat.layoutSubtreeIfNeeded()
        chat.chatDocumentView.frame = NSRect(x: 0, y: 0, width: 420, height: 1_200)
        chat.contentView.bounds.origin.y = 260
        table.layoutSubtreeIfNeeded()
        table.contentView.scroll(to: NSPoint(x: 30, y: 0))
        table.reflectScrolledClipView(table.contentView)

        func wheel(y: Int32, x: Int32) -> NSEvent? {
            guard let cgEvent = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .line,
                wheelCount: 2,
                wheel1: y,
                wheel2: x,
                wheel3: 0
            ) else { return nil }
            return NSEvent(cgEvent: cgEvent)
        }

        let outerBeforeVertical = chat.contentView.bounds.minY
        let tableBeforeVertical = table.contentView.bounds.minX
        var verticalPackets: [[String: Any]] = []
        for _ in 0..<2 {
            if let event = wheel(y: 3, x: 0) {
                table.scrollWheel(with: event)
                verticalPackets.append([
                    "deltaX": Double(event.scrollingDeltaX),
                    "deltaY": Double(event.scrollingDeltaY),
                    "route": table.debugLastWheelRoute,
                    "outerY": Double(chat.contentView.bounds.minY),
                    "tableX": Double(table.contentView.bounds.minX),
                ])
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        let outerAfterVertical = chat.contentView.bounds.minY
        let tableAfterVertical = table.contentView.bounds.minX

        let outerBeforeHorizontal = chat.contentView.bounds.minY
        let tableBeforeHorizontal = table.contentView.bounds.minX
        var horizontalPackets: [[String: Any]] = []
        for _ in 0..<2 {
            if let event = wheel(y: 0, x: -3) {
                table.scrollWheel(with: event)
                horizontalPackets.append([
                    "deltaX": Double(event.scrollingDeltaX),
                    "deltaY": Double(event.scrollingDeltaY),
                    "route": table.debugLastWheelRoute,
                    "outerY": Double(chat.contentView.bounds.minY),
                    "tableX": Double(table.contentView.bounds.minX),
                ])
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
        let outerAfterHorizontal = chat.contentView.bounds.minY
        let tableAfterHorizontal = table.contentView.bounds.minX
        window.contentView = nil

        let verticalPassed = abs(outerAfterVertical - outerBeforeVertical) > 0.5
            && abs(tableAfterVertical - tableBeforeVertical) < 0.5
        let horizontalPassed = abs(tableAfterHorizontal - tableBeforeHorizontal) > 0.5
            && abs(outerAfterHorizontal - outerBeforeHorizontal) < 0.5
        return [
            "passed": verticalPassed && horizontalPassed,
            "verticalPassed": verticalPassed,
            "horizontalPassed": horizontalPassed,
            "outerBeforeVertical": Double(outerBeforeVertical),
            "outerAfterVertical": Double(outerAfterVertical),
            "tableBeforeVertical": Double(tableBeforeVertical),
            "tableAfterVertical": Double(tableAfterVertical),
            "outerBeforeHorizontal": Double(outerBeforeHorizontal),
            "outerAfterHorizontal": Double(outerAfterHorizontal),
            "tableBeforeHorizontal": Double(tableBeforeHorizontal),
            "tableAfterHorizontal": Double(tableAfterHorizontal),
            "hasEnclosingChat": table.debugHasEnclosingChatScrollView,
            "tableDocumentWidth": Double(table.documentView?.frame.width ?? 0),
            "tableViewportWidth": Double(table.contentView.bounds.width),
            "chatDocumentHeight": Double(chat.documentView?.frame.height ?? 0),
            "chatViewportHeight": Double(chat.contentView.bounds.height),
            "verticalPackets": verticalPackets,
            "horizontalPackets": horizontalPackets,
        ]
    }

    private func sessionListScrollerRegression(id: Any?, connection: Int32) {
        guard let appState else {
            send(error: "unavailable", message: "AppState is unavailable", id: id, on: connection)
            return
        }
        let size = NSSize(width: 280, height: 720)
        let selected = appState.sessionStore.navigationOrderedSessions.first?.id
        let host = NSHostingView(rootView:
            SessionsSidebarView(selectedSessionId: .constant(selected), onNewSession: {})
                .environment(appState)
                .frame(width: size.width, height: size.height)
        )
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.display()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self] in
            guard let self else { return }
            host.layoutSubtreeIfNeeded()
            guard let probe = self.findViews(in: host, of: MacSessionSmoothScrollProbeView.self).first,
                  let scrollView = probe.debugObservedScrollView else {
                window.close()
                self.send(error: "unavailable", message: "Session list scroll probe was not attached", id: id, on: connection)
                return
            }

            func state() -> [String: Any] {
                [
                    "alpha": Double(scrollView.verticalScroller?.alphaValue ?? -1),
                    "enabled": scrollView.verticalScroller?.isEnabled ?? false,
                    "hidden": scrollView.verticalScroller?.isHidden ?? true,
                    "style": scrollView.scrollerStyle.rawValue,
                ]
            }
            guard let cgEvent = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .line,
                wheelCount: 1,
                wheel1: 3,
                wheel2: 0,
                wheel3: 0
            ), let event = NSEvent(cgEvent: cgEvent) else {
                window.close()
                self.send(error: "unavailable", message: "Could not build wheel event", id: id, on: connection)
                return
            }

            let initial = state()
            _ = probe.debugHandleScrollEvent(event)
            let immediate = state()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self] in
                guard let self else { return }
                let held = state()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.70) { [weak self] in
                    guard let self else { return }
                    _ = probe
                    let final = state()
                    let passed = (initial["alpha"] as? Double ?? 1) <= 0.01
                        && initial["enabled"] as? Bool == false
                        && (immediate["alpha"] as? Double ?? 0) >= 0.99
                        && immediate["enabled"] as? Bool == true
                        && (held["alpha"] as? Double ?? 0) >= 0.99
                        && (final["alpha"] as? Double ?? 1) <= 0.01
                        && final["enabled"] as? Bool == false
                    window.close()
                    self.send(result: [
                        "passed": passed,
                        "sessionCount": appState.sessionStore.sessions.count,
                        "initial": initial,
                        "immediate": immediate,
                        "held": held,
                        "final": final,
                    ], id: id, on: connection)
                }
            }
        }
    }

    private func transientScrollerRegression(id: Any?, connection: Int32) {
        func wheel() -> NSEvent? {
            guard let cgEvent = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .line,
                wheelCount: 1,
                wheel1: 3,
                wheel2: 0,
                wheel3: 0
            ) else { return nil }
            return NSEvent(cgEvent: cgEvent)
        }

        func state(_ scrollView: NSScrollView) -> [String: Any] {
            [
                "alpha": Double(scrollView.verticalScroller?.alphaValue ?? -1),
                "enabled": scrollView.verticalScroller?.isEnabled ?? false,
                "hidden": scrollView.verticalScroller?.isHidden ?? true,
                "style": scrollView.scrollerStyle.rawValue,
            ]
        }

        let list = NSScrollView(frame: NSRect(x: 0, y: 0, width: 280, height: 320))
        list.documentView = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 1_200))
        let listController = MacTransientOverlayScrollerController()
        listController.attach(to: list)
        let listInitial = state(list)
        if let event = wheel() { listController.noteScrollEvent(event) }
        let listImmediate = state(list)

        let chat = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 260))
        chat.chatDocumentView.frame = NSRect(x: 0, y: 0, width: 420, height: 1_200)
        chat.contentView.bounds.origin.y = 260
        chat.layoutSubtreeIfNeeded()
        let chatInitial = state(chat)
        if let event = wheel() { chat.scrollWheel(with: event) }
        let chatImmediate = state(chat)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self] in
            guard let self else { return }
            let listHeld = state(list)
            let chatHeld = state(chat)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.70) { [weak self] in
                guard let self else { return }
                _ = listController
                let listFinal = state(list)
                let chatFinal = state(chat)

                func passed(initial: [String: Any], immediate: [String: Any], held: [String: Any], final: [String: Any]) -> Bool {
                    let initiallyHidden = (initial["alpha"] as? Double ?? 1) <= 0.01
                        && initial["enabled"] as? Bool == false
                    let immediatelyVisible = immediate["enabled"] as? Bool == true
                        && (immediate["alpha"] as? Double ?? 0) >= 0.99
                    let remainsVisible = held["enabled"] as? Bool == true
                        && (held["alpha"] as? Double ?? 0) >= 0.99
                    let finallyHidden = final["enabled"] as? Bool == false
                        && (final["alpha"] as? Double ?? 1) <= 0.01
                    return initiallyHidden && immediatelyVisible && remainsVisible && finallyHidden
                }

                let listPassed = passed(initial: listInitial, immediate: listImmediate, held: listHeld, final: listFinal)
                let chatPassed = passed(initial: chatInitial, immediate: chatImmediate, held: chatHeld, final: chatFinal)
                self.send(result: [
                    "passed": listPassed && chatPassed,
                    "sessionListPassed": listPassed,
                    "chatPassed": chatPassed,
                    "sessionList": ["initial": listInitial, "immediate": listImmediate, "held": listHeld, "final": listFinal],
                    "chat": ["initial": chatInitial, "immediate": chatImmediate, "held": chatHeld, "final": chatFinal],
                ], id: id, on: connection)
            }
        }
    }

    private func voiceState(_ appState: AppState) -> [String: Any] {
        let controller = appState.voiceInputController
        let state: String
        let error: Any
        switch controller.state {
        case .idle: state = "idle"; error = NSNull()
        case .requestingPermission: state = "requestingPermission"; error = NSNull()
        case .obtainingLease: state = "obtainingLease"; error = NSNull()
        case .recording: state = "recording"; error = NSNull()
        case .finishing: state = "finishing"; error = NSNull()
        case .failed(let message): state = "failed"; error = message
        }
        return [
            "available": appState.voiceCapability != nil,
            "brokerHost": appState.voiceCapability.flatMap { URL(string: $0.brokerUrl)?.host } ?? "",
            "resource": appState.voiceCapability?.resource ?? "",
            "state": state,
            "sessionId": controller.activeSessionID ?? "",
            "displayLength": controller.displayText.count,
            "rawLength": controller.rawText.count,
            "correctionLength": controller.correctionText.count,
            "error": error as? String ?? "",
        ]
    }

    // MARK: - Commands

    private func createSession(params: [String: Any], id: Any?, connection: Int32) {
        guard let appState,
              let targetDeviceId = params["targetDeviceId"] as? String,
              let agentId = params["agentId"] as? String,
              let model = params["model"] as? String else {
            send(error: "invalid_params", message: "targetDeviceId, agentId, and model are required", id: id, on: connection)
            return
        }
        let effort = (params["reasoningEffort"] as? String).flatMap(ReasoningEffort.init(rawValue:))
        let requestId = appState.commandSender?.createSession(
            targetDeviceId: targetDeviceId,
            agentId: agentId,
            model: model,
            reasoningEffort: effort,
            prompt: params["prompt"] as? String,
            cwd: params["cwd"] as? String,
            title: params["title"] as? String
        ) ?? ""
        send(result: ["requestId": requestId], id: id, on: connection)
    }

    private func wait(params: [String: Any], id: Any?, connection: Int32) {
        guard let condition = params["condition"] as? String else {
            send(error: "invalid_params", message: "condition is required", id: id, on: connection); return
        }
        let timeoutMs = min(max(params["timeoutMs"] as? Int ?? 30_000, 1), 300_000)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = ContinuousClock.now + .milliseconds(timeoutMs)
            while ContinuousClock.now < deadline {
                if let result = self.evaluate(condition: condition, params: params) {
                    self.send(result: result, id: id, on: connection)
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            self.send(error: "timeout", message: "Condition not met: \(condition)", id: id, on: connection)
        }
    }

    private func evaluate(condition: String, params: [String: Any]) -> [String: Any]? {
        guard let appState else { return nil }
        switch condition {
        case "connected":
            return appState.isFullyOnline ? ["connection": "connected"] : nil
        case "sessionCreated":
            guard let requestId = params["requestId"] as? String,
                  let sessionId = appState.commandSender?.resolvedCreateSessions[requestId] else { return nil }
            return ["requestId": requestId, "sessionId": sessionId]
        case "sessionIdle":
            guard let sessionId = params["sessionId"] as? String,
                  let session = appState.sessionStore.sessions[sessionId],
                  session.state == .idle,
                  appState.messageStore.cards[sessionId] == nil,
                  appState.commandSender?.pendingInputs(sessionId).isEmpty != false else { return nil }
            return ["sessionId": sessionId, "state": "idle", "lastSeq": session.lastSeq]
        case "messageContains":
            guard let sessionId = params["sessionId"] as? String,
                  let text = params["text"] as? String else { return nil }
            let messages = appState.messageStore.recentFromDB(sessionId, limit: 200)
            guard let match = messages.last(where: { ($0.content ?? $0.interruptedDraft ?? "").localizedCaseInsensitiveContains(text) }) else { return nil }
            return ["sessionId": sessionId, "seq": match.seq, "type": match.type]
        case "stepsLoaded":
            guard let sessionId = params["sessionId"] as? String,
                  let seq = params["seq"] as? Int,
                  let steps = appState.messageStore.turnSteps(sessionId, bubbleSeq: seq) else { return nil }
            return ["sessionId": sessionId, "seq": seq, "count": steps.count]
        case "stepsPresented":
            guard let sessionId = params["sessionId"] as? String,
                  let presentedSteps,
                  presentedSteps.sessionId == sessionId else { return nil }
            if let seq = params["seq"] as? Int, presentedSteps.seq != seq { return nil }
            return ["sessionId": sessionId, "seq": presentedSteps.seq]
        case "selectedSession":
            guard let sessionId = params["sessionId"] as? String,
                  selectedSessionId == sessionId else { return nil }
            return ["sessionId": sessionId]
        default:
            return nil
        }
    }

    private func findViews<T: NSView>(in root: NSView, of type: T.Type) -> [T] {
        func collect(in view: NSView, into result: inout [T]) {
            if let match = view as? T { result.append(match) }
            for child in view.subviews { collect(in: child, into: &result) }
        }
        var result: [T] = []
        collect(in: root, into: &result)
        return result
    }

    private func findViews<T: NSView>(of type: T.Type) -> [T] {
        NSApp.windows
            .compactMap(\.contentView)
            .flatMap { findViews(in: $0, of: type) }
    }

    private func findChatScrollView() -> MacChatScrollView? {
        func find(in view: NSView) -> MacChatScrollView? {
            if let chat = view as? MacChatScrollView { return chat }
            for child in view.subviews {
                if let match = find(in: child) { return match }
            }
            return nil
        }
        for window in NSApp.windows
        where window.contentView != nil && window.frame.width > 700 && window.frame.height > 500 {
            if let match = window.contentView.flatMap(find(in:)) { return match }
        }
        return nil
    }

    private enum CaptureError: LocalizedError {
        case noWindow
        case bitmap
        case encode
        case write(Error)

        var errorDescription: String? {
            switch self {
            case .noWindow: return "No laid-out Kraki window is available"
            case .bitmap: return "Could not allocate a window bitmap"
            case .encode: return "Could not encode the window as PNG"
            case .write(let error): return "Could not write PNG: \(error.localizedDescription)"
            }
        }
    }

    private func captureSidebar(path: String) -> Result<NSSize, CaptureError> {
        guard let appState else { return .failure(.noWindow) }
        let size = NSSize(width: 280, height: 720)
        let selected = appState.sessionStore.navigationOrderedSessions.first?.id
        let host = NSHostingView(rootView:
            SessionsSidebarView(
                selectedSessionId: .constant(selected),
                onNewSession: {}
            )
            .environment(appState)
            .frame(width: size.width, height: size.height)
        )
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.display()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            window.close()
            return .failure(.bitmap)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            window.close()
            return .failure(.encode)
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            window.close()
            return .success(size)
        } catch {
            window.close()
            return .failure(.write(error))
        }
    }

    private func captureWindow(path: String, sheetOnly: Bool) -> Result<NSSize, CaptureError> {
        let candidates = NSApp.windows.filter {
            $0.contentView != nil && $0.frame.width > 300 && $0.frame.height > 200
        }
        let window: NSWindow? = {
            if sheetOnly {
                return candidates.first(where: { $0.sheetParent != nil })
                    ?? candidates.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            }
            return candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        }()
        guard let window, let view = window.contentView else { return .failure(.noWindow) }

        var hiddenEffectViews: [NSVisualEffectView] = []
        func hideEffects(_ candidate: NSView) {
            if let effect = candidate as? NSVisualEffectView, !effect.isHidden {
                effect.isHidden = true
                hiddenEffectViews.append(effect)
            }
            candidate.subviews.forEach(hideEffects)
        }
        hideEffects(view)
        view.wantsLayer = true
        let priorBackground = view.layer?.backgroundColor
        view.layer?.backgroundColor = (window.backgroundColor.usingColorSpace(.deviceRGB) ?? window.backgroundColor).cgColor
        view.layoutSubtreeIfNeeded()
        let bounds = view.bounds
        defer {
            hiddenEffectViews.forEach { $0.isHidden = false }
            view.layer?.backgroundColor = priorBackground
        }
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: bounds) else { return .failure(.bitmap) }
        view.cacheDisplay(in: bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return .failure(.encode) }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            return .success(bounds.size)
        } catch {
            return .failure(.write(error))
        }
    }

    // MARK: - State

    private func snapshot() -> [String: Any] {
        guard let appState else { return ["ready": false] }
        return snapshot(appState: appState, selectedSessionId: selectedSessionId)
    }

    private func snapshot(appState: AppState, selectedSessionId: String?) -> [String: Any] {
        let devices = appState.deviceStore.devices.values
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            .map { device -> [String: Any] in
                let agents = appState.deviceStore.agents(for: device.id).map { agent -> [String: Any] in
                    ["id": agent.id, "type": agent.type, "models": agent.models ?? []]
                }
                return [
                    "id": device.id, "name": device.name, "role": device.role.rawValue,
                    "online": device.online, "agents": agents,
                ]
            }
        let sessions = appState.sessionStore.sessions.values
            .sorted { $0.createdAt > $1.createdAt }
            .map { session -> [String: Any] in
                var item: [String: Any] = [
                    "id": session.id, "title": session.displayTitle,
                    "deviceId": session.deviceId, "agentId": session.agent,
                    "state": session.state.rawValue, "mode": session.mode.rawValue,
                    "lastSeq": session.lastSeq, "messageCount": session.messageCount,
                ]
                if let model = session.model { item["model"] = model }
                if let preview = appState.sessionStore.sessionPreviews[session.id] {
                    item["preview"] = preview.text
                    item["previewType"] = preview.type
                    item["previewTimestamp"] = preview.timestamp
                }
                item["deviceOnline"] = appState.deviceStore.devices[session.deviceId]?.online ?? false
                return item
            }
        var result: [String: Any] = [
            "ready": true,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "activationPolicy": activationPolicyName,
            "isActive": NSApp.isActive,
            "hasKeyWindow": NSApp.keyWindow != nil,
            "hasMainWindow": NSApp.mainWindow != nil,
            "connection": String(describing: appState.connectionStatus),
            "relayURL": appState.relayURL,
            "selectedSessionId": selectedSessionId ?? NSNull(),
            "devices": devices,
            "sessions": sessions,
        ]
        if let selectedSessionId,
           let session = appState.sessionStore.sessions[selectedSessionId] {
            let recent = appState.messageStore.recentFromDB(selectedSessionId, limit: 50).map(messageJSON)
            var selected: [String: Any] = [
                "id": session.id, "state": session.state.rawValue,
                "mode": (appState.sessionStore.sessionModes[session.id] ?? session.mode).rawValue,
                "recentMessages": recent,
                "hasLiveCard": appState.messageStore.cards[session.id] != nil,
            ]
            let window = appState.messageStore.currentWindow(selectedSessionId)
            let windowState = appState.messageStore.windowState(selectedSessionId)
            let viewModel = ChatViewModel(sessionId: selectedSessionId, appState: appState)
            viewModel.refreshMessageCache()
            selected["dbLastSeq"] = appState.messageStore.dbLastSeq(selectedSessionId)
            selected["windowRawCount"] = window.count
            selected["windowTopSeq"] = windowState?.topSeq ?? 0
            selected["windowBottomSeq"] = windowState?.bottomSeq ?? 0
            selected["projectedBubbleCount"] = viewModel.displayMessages.count
            selected["expectedLastSeq"] = max(session.lastSeq, viewModel.sessionLastSeq)
            selected["waitingForLatest"] = viewModel.isWaitingForLatestBubble
            selected["loading"] = appState.sessionStore.loadingSessions.contains(selectedSessionId)
            if let card = appState.messageStore.cards[session.id] {
                selected["liveText"] = card.text
                if let action = card.action { selected["liveAction"] = messageJSON(action) }
            }
            result["selectedSession"] = selected
        }
        if let presentedSteps {
            let steps = appState.messageStore.turnSteps(presentedSteps.sessionId, bubbleSeq: presentedSteps.seq)
            result["presentedSteps"] = [
                "sessionId": presentedSteps.sessionId,
                "seq": presentedSteps.seq,
                "loaded": steps != nil,
                "steps": steps?.map(messageJSON) ?? [],
            ] as [String: Any]
        }
        return result
    }

    private func messageJSON(_ message: ChatMessage) -> [String: Any] {
        var result: [String: Any] = ["seq": message.seq, "type": message.type]
        if let content = message.content ?? message.interruptedDraft { result["content"] = content }
        if let steps = message.steps { result["steps"] = steps }
        if let toolName = message.toolName { result["toolName"] = toolName }
        if let headline = message.headline { result["headline"] = headline }
        if let toolCallId = message.toolCallId { result["toolCallId"] = toolCallId }
        if let success = message.payload["success"]?.boolValue { result["success"] = success }
        return result
    }

    private var activationPolicyName: String {
        switch NSApp.activationPolicy() {
        case .regular: return "regular"
        case .accessory: return "accessory"
        case .prohibited: return "prohibited"
        @unknown default: return "unknown"
        }
    }

    private func postUIAction(_ action: String, _ values: [String: Any] = [:]) {
        var userInfo = values
        userInfo["action"] = action
        NotificationCenter.default.post(name: .macNativeAutomationAction, object: nil, userInfo: userInfo)
    }

    private func send(result: [String: Any], id: Any?, on connection: Int32) {
        send(["id": id ?? NSNull(), "ok": true, "result": result], on: connection)
    }

    private func send(error code: String, message: String, id: Any?, on connection: Int32) {
        send(["id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]], on: connection)
    }
}

extension Notification.Name {
    static let macNativeAutomationAction = Notification.Name("mac.nativeAutomationAction")
}
#endif
