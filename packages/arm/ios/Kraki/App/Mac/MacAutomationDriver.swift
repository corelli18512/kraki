#if os(macOS) && DEBUG
import AppKit
import Darwin
import Foundation
import CryptoKit
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

    weak var appState: AppState?
    private var isolatedScenarioHostWindow: NSWindow?
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

    /// Mounts the isolated Scenario Test Page when activationPolicy=prohibited.
    /// SwiftUI does not instantiate Window scenes for a prohibited process, so
    /// unattended native gates opt into this off-screen, temporary host.
    func startIsolatedScenarioHost(appState: AppState) {
        guard enabled else { return }
        start(appState: appState)
        guard ProcessInfo.processInfo.environment["KRAKI_NATIVE_AUTOMATION_SCENARIO_HOST"] == "1",
              isolatedScenarioHostWindow == nil else { return }

        let size = NSSize(width: 1_100, height: 720)
        let root = MacChatScenarioTestView(selectionScope: "native-automation-host")
            .environment(appState)
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: size)

        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderBack(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        isolatedScenarioHostWindow = window
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
        isolatedScenarioHostWindow?.close()
        isolatedScenarioHostWindow = nil
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

    func send(_ object: [String: Any], on clientFD: Int32) {
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

        if handleWindowCommand(method, params: params, id: id, connection: connection) { return }
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
        case "presentSessionInfo":
            postUIAction("info", selectedSessionId.map { ["sessionId": $0] } ?? [:])
            send(result: ["requested": true], id: id, on: connection)
        case "chooseReasoningEffort":
            // Operate the real SwiftUI Picker's native control, not SessionStore
            // or CommandSender directly. No OS-level mouse/focus automation.
            guard let raw = params["effort"] as? String,
                  ReasoningEffort(rawValue: raw) != nil else {
                send(error: "invalid_params", message: "valid effort is required", id: id, on: connection); return
            }
            func controls(in view: NSView) -> [NSSegmentedControl] {
                (view as? NSSegmentedControl).map { [$0] } ?? view.subviews.flatMap { controls(in: $0) }
            }
            let pickers = NSApp.windows.filter { $0.sheetParent != nil }
                .compactMap(\.contentView).flatMap { controls(in: $0) }
            let matches = pickers.flatMap { picker in
                (0..<picker.segmentCount).compactMap { index -> (NSSegmentedControl, Int)? in
                    picker.label(forSegment: index)?.lowercased() == raw ? (picker, index) : nil
                }
            }
            guard matches.count == 1, let (picker, index) = matches.first,
                  picker.isEnabled, picker.isEnabled(forSegment: index), let action = picker.action else {
                send(error: "invalid_state", message: "Open Session Info with a supported effort picker first", id: id, on: connection); return
            }
            picker.selectedSegment = index
            let dispatched = picker.sendAction(action, to: picker.target)
            send(result: ["dispatched": dispatched, "effort": raw], id: id, on: connection)
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
        case "openSubagent":
            // Open the n-th subagent card on the visible Steps page.
            postUIAction("openSubagent", ["index": params["index"] as? Int ?? 0])
            send(result: ["requested": true], id: id, on: connection)
        case "subagentBack":
            postUIAction("subagentBack")
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
            case "auto":
                appState.commandSender?.setSessionMode(sessionId: sessionId, mode: .auto)
                appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
            case "deny":
                appState.commandSender?.deny(sessionId: sessionId, permissionId: permissionId)
            default:
                send(error: "invalid_params", message: "Unknown permission decision", id: id, on: connection); return
            }
            send(result: ["accepted": true, "permissionId": permissionId], id: id, on: connection)
        case "answer":
            guard let appState,
                  let sessionId = params["sessionId"] as? String,
                  let questionId = ChatViewModel(sessionId: sessionId, appState: appState).questions.last?.id else {
                send(error: "invalid_state", message: "No pending question for this session", id: id, on: connection); return
            }
            let answer = params["text"] as? String ?? ""
            appState.commandSender?.answer(sessionId: sessionId, questionId: questionId, answer: answer)
            send(result: ["accepted": true, "questionId": questionId], id: id, on: connection)
        case "clickQuestionChoice":
            guard let scrollView = findChatScrollView(),
                  let choice = params["choice"] as? String else {
                send(error: "invalid_state", message: "No chat", id: id, on: connection); return
            }
            send(result: ["clicked": scrollView.automationClickQuestionChoice(choice)], id: id, on: connection)
        case "codeContrastRegression":
            send(result: codeContrastRegression(), id: id, on: connection)
        case "tableWheelRegression":
            send(result: tableWheelRegression(), id: id, on: connection)
        case "transientScrollerRegression":
            transientScrollerRegression(id: id, connection: connection)
        case "sessionListScrollerRegression":
            sessionListScrollerRegression(id: id, connection: connection)
        case "sessionActivityDotsRegression":
            MacSessionActivityDotsRegression.run { [weak self] result in
                self?.send(result: result, id: id, on: connection)
            }
        case "compactingGlyphAnimationRegression":
            compactingGlyphAnimationRegression(id: id, connection: connection)
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
        case "scrollProductionGate":
            scrollProductionGate(id: id, connection: connection)
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
        case "attachmentProbe":
            // Debug-only: exercise attachments without a visible window.
            //  - send: {sessionId, text, imagePath, mimeType} → input with an image
            //  - request: {sessionId, id, priority:"visible"|"opened"} → fetch bytes
            //  - state: {id} → fetch state, size, sha256 of received bytes
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            switch params["action"] as? String ?? "state" {
            case "send":
                guard let sessionId = params["sessionId"] as? String,
                      let path = params["imagePath"] as? String,
                      let bytes = FileManager.default.contents(atPath: path) else {
                    send(error: "invalid_params", message: "sessionId and readable imagePath required", id: id, on: connection); return
                }
                let attachment = ImageAttachment(type: "image", mimeType: params["mimeType"] as? String ?? "image/png", data: bytes.base64EncodedString())
                let ok = appState.commandSender?.sendInput(sessionId: sessionId, text: params["text"] as? String ?? "", attachments: [attachment]) ?? false
                send(result: ["accepted": ok, "bytes": bytes.count], id: id, on: connection)
            case "request":
                guard let sessionId = params["sessionId"] as? String, let attachmentId = params["id"] as? String else {
                    send(error: "invalid_params", message: "sessionId and id required", id: id, on: connection); return
                }
                let priority: AttachmentPriority = params["priority"] as? String == "opened" ? .userOpened : .visible
                appState.attachmentStore.requestIfNeeded(id: attachmentId, sessionId: sessionId, priority: priority)
                send(result: ["requested": true], id: id, on: connection)
            default:
                guard let attachmentId = params["id"] as? String else {
                    send(error: "invalid_params", message: "id required", id: id, on: connection); return
                }
                var result: [String: Any] = ["state": "none"]
                switch appState.attachmentStore.state(for: attachmentId) {
                case .ready(let mime, let data)?:
                    result = ["state": "ready", "mimeType": mime, "bytes": data.count,
                              "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()]
                case .awaitingChunks(let received, let total)?:
                    result = ["state": "awaitingChunks", "received": received, "total": total ?? NSNull()]
                case .fetching?: result = ["state": "fetching"]
                case .error(let reason)?: result = ["state": "error", "reason": reason]
                case nil: break
                }
                send(result: result, id: id, on: connection)
            }
        case "localLinkProbe":
            // Debug-only fault injection for local-link tests.
            guard let appState else {
                send(error: "invalid_state", message: "AppState is unavailable", id: id, on: connection); return
            }
            switch params["action"] as? String ?? "status" {
            case "relayBlip": appState.wsClient?.recover(reason: "automation_relay_blip")
            case "linkDrop": appState.localLink?.debugDrop()
            case "subscribe": appState.sessionSubscriptionController.setDesired(params["sessionId"] as? String)
            default: break
            }
            let sub = appState.sessionSubscriptionController
            let card: MessageStore.SessionCard? = sub?.desiredSessionId.flatMap { appState.messageStore.cards[$0] }
            let cardText: String = card?.text ?? ""
            let cardAction: String = card?.action.map { String(describing: $0.type) } ?? ""
            send(result: [
                "connection": String(describing: appState.connectionStatus),
                "localLink": appState.localLink?.diagnostics ?? NSNull(),
                "desired": sub?.desiredSessionId ?? NSNull(),
                "confirmed": sub?.confirmedSessionId ?? NSNull(),
                "confirmedTentacle": sub?.confirmedTentacleId ?? NSNull(),
                "liveReady": sub?.liveReady ?? false,
                "cardText": cardText,
                "cardAction": cardAction,
            ], id: id, on: connection)
        case "shutdown":
            send(result: ["stopped": true], id: id, on: connection)
            Task { @MainActor in self.stop() }
        default:
            send(error: "unknown_method", message: "Unknown method: \(method)", id: id, on: connection)
        }
    }

    private func compactingGlyphAnimationRegression(id: Any?, connection: Int32) {
        // The old probe compared NSView bitmap snapshots in an offscreen
        // window. Compositor animations do not mutate that model snapshot,
        // and offscreen hosts now intentionally suspend their animations.
        // Audit the installed native curve instead; real host visibility/reuse
        // and byte-level design parity have separate native regression gates.
        let layer = SessionPreviewGlyphLayer()
        let color = NSColor(Color.krakiPrimary).cgColor
        layer.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: true)
        let curve = layer.planes[0].animation(forKey: "compression") as? CAKeyframeAnimation
        let values = curve?.values as? [Double] ?? []
        let changed = Set(values).count > 1
        let installed = curve?.duration == 2 && values.count > 200 && layer.planes[1].animationKeys() == nil
        layer.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: false)
        let stopped = layer.planes.allSatisfy { ($0.animationKeys() ?? []).isEmpty }
        send(result: ["passed": changed && installed && stopped, "changed": changed,
                      "samples": values.count, "stoppedOffscreen": stopped,
                      "method": "Core Animation curve audit (not a pixel/FPS measurement)"],
             id: id, on: connection)
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
                if let effort = session.reasoningEffort { item["reasoningEffort"] = effort.rawValue }
                let card = SessionCardProjection.make(
                    session: session, device: appState.deviceStore.devices[session.deviceId],
                    preview: appState.sessionStore.sessionPreviews[session.id], draft: nil
                )
                if let effort = card.effortLabel { item["cardEffortLabel"] = effort }
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
            "localLink": appState.localLink?.diagnostics ?? NSNull(),
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

    func send(result: [String: Any], id: Any?, on connection: Int32) {
        send(["id": id ?? NSNull(), "ok": true, "result": result], on: connection)
    }

    func send(error code: String, message: String, id: Any?, on connection: Int32) {
        send(["id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]], on: connection)
    }
}

extension Notification.Name {
    static let macNativeAutomationAction = Notification.Name("mac.nativeAutomationAction")
}
#endif
