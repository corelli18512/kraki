/// Automation commands (create session, wait, evaluate) and window/sidebar captures.

#if os(macOS) && DEBUG
import AppKit
import Darwin
import Foundation
import CryptoKit
import SwiftUI
import WebKit

extension MacAutomationDriver {
    /// Window-level commands (resize/park, close auxiliary windows). Returns
    /// false when `method` is not one of them.
    func handleWindowCommand(_ method: String, params: [String: Any], id: Any?, connection: Int32) -> Bool {
        switch method {
        case "resizeWindow":
            resizeWindow(params: params, id: id, connection: connection)
        case "closeAuxWindows":
            send(result: ["closed": closeAuxWindows()], id: id, on: connection)
        default:
            return false
        }
        return true
    }

    private func resizeWindow(params: [String: Any], id: Any?, connection: Int32) {
        let width = CGFloat(params["width"] as? Double ?? 1_600)
        let height = CGFloat(params["height"] as? Double ?? 900)
        guard let window = NSApp.windows
            .filter({ $0.contentView != nil && $0.frame.width > 300 && $0.frame.height > 200 })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            send(error: "invalid_state", message: "No production window is mounted", id: id, on: connection); return
        }
        window.setContentSize(NSSize(width: max(width, 700), height: max(height, 500)))
        // Keep the whole window on screen: partly off-screen content renders black in captures.
        if let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: visible.minX, y: visible.maxY - window.frame.height))
        }
        window.contentView?.layoutSubtreeIfNeeded()
        send(result: ["width": Double(window.contentLayoutRect.width), "height": Double(window.contentLayoutRect.height)], id: id, on: connection)
    }

    /// Debug-only: close every visible window except the main chat window
    /// (Settings, artifact/report viewers, account usage) and dismiss sheets.
    private func closeAuxWindows() -> [String] {
        let main = NSApp.windows
            .filter { $0.isVisible && $0.contentView != nil && $0.sheetParent == nil && $0.frame.width > 300 && $0.frame.height > 200 }
            .first { $0.title.isEmpty || $0.title == "Kraki" || $0.title == "Kraki (Dev)" }
        var closed: [String] = []
        for window in NSApp.windows where window.isVisible && window !== main {
            if let parent = window.sheetParent { parent.endSheet(window); closed.append("sheet"); continue }
            if window.level != .normal || window.frame.width < 200 { continue } // menu-bar extra, popovers, panels
            closed.append(window.title.isEmpty ? String(describing: type(of: window)) : window.title)
            window.performClose(nil)
            if window.isVisible { window.orderOut(nil) }
        }
        main?.makeKeyAndOrderFront(nil)
        return closed
    }

    func voiceState(_ appState: AppState) -> [String: Any] {
        let controller = appState.voiceInputController
        let state: String
        let error: Any
        switch controller.state {
        case .idle: state = "idle"; error = NSNull()
        case .requestingPermission: state = "requestingPermission"; error = NSNull()
        case .obtainingLease: state = "obtainingLease"; error = NSNull()
        case .waitingForConnection: state = "waitingForConnection"; error = NSNull()
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

    func createSession(params: [String: Any], id: Any?, connection: Int32) {
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

    func wait(params: [String: Any], id: Any?, connection: Int32) {
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

    func evaluate(condition: String, params: [String: Any]) -> [String: Any]? {
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

    func findViews<T: NSView>(in root: NSView, of type: T.Type) -> [T] {
        func collect(in view: NSView, into result: inout [T]) {
            if let match = view as? T { result.append(match) }
            for child in view.subviews { collect(in: child, into: &result) }
        }
        var result: [T] = []
        collect(in: root, into: &result)
        return result
    }

    func findViews<T: NSView>(of type: T.Type) -> [T] {
        NSApp.windows
            .compactMap(\.contentView)
            .flatMap { findViews(in: $0, of: type) }
    }

    func findChatScrollView() -> MacChatScrollView? {
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

    enum CaptureError: LocalizedError {
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

    func captureSidebar(path: String) -> Result<NSSize, CaptureError> {
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

    func captureWindow(path: String, sheetOnly: Bool) -> Result<NSSize, CaptureError> {
        // Only on-screen windows: a closed artifact/settings window that AppKit
        // keeps around (ordered out, often larger) used to win and render black.
        let candidates = NSApp.windows.filter {
            $0.contentView != nil && $0.isVisible && $0.frame.width > 300 && $0.frame.height > 200
        }
        let window: NSWindow? = {
            if sheetOnly {
                return candidates.first(where: { $0.sheetParent != nil })
                    ?? candidates.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            }
            if let main = NSApp.mainWindow, candidates.contains(main), main.sheetParent == nil { return main }
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
}
#endif
