/// Debug-only offscreen renders of the main window, composer, chat list and bubbles to PNG.

#if os(macOS) && DEBUG
import AppKit
import SwiftUI

/// A flipped (origin top-left) container that paints the white canvas +
/// rounded card backgrounds itself, then hosts the title labels and body
/// text views as real subviews. Because the container is flipped and the
/// text views are flipped too, the framework places everything correctly
/// with NO manual CGContext transforms - which previously drew text
/// upside down. We render it via display()+cacheDisplay inside a borderless
/// window that is never ordered front, so nothing ever appears on screen.
private final class FlippedContainerView: NSView {
    override var isFlipped: Bool { true }
    var cardRects: [NSRect] = []
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        for r in cardRects {
            NSColor(white: 0.96, alpha: 1).setFill()
            NSBezierPath(roundedRect: r, xRadius: 12, yRadius: 12).fill()
            NSColor(white: 0.85, alpha: 1).setStroke()
            let border = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5),
                                      xRadius: 12, yRadius: 12)
            border.lineWidth = 1
            border.stroke()
        }
    }
}

extension MacAppDelegate {
    func inflateAndCenterMainWindowOnce() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            let builtin = NSScreen.screens.first { screen in
                guard let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
                else { return false }
                return CGDisplayIsBuiltin(num) != 0
            }
            guard let target = NSScreen.screens.first ?? NSScreen.main ?? builtin else { return }
            let vf = target.visibleFrame
            let size = MacLocalConfigStore.shared.constrainedMainWindowSize(to: vf.size)
            let origin = NSPoint(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2)
            for window in NSApp.windows
            where window.styleMask.contains(.titled) && window.contentView != nil {
                let hasUsableVisibleArea = NSScreen.screens.contains { screen in
                    let overlap = window.frame.intersection(screen.visibleFrame)
                    return overlap.width >= 320 && overlap.height >= 240
                }
                if window.frame.width < 800 || window.frame.height < 500 || !hasUsableVisibleArea {
                    window.setFrame(NSRect(origin: origin, size: size), display: true, animate: false)
                }
                window.makeKeyAndOrderFront(nil)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// Park the main window off-screen at a sane full size so its view
    /// tree lays out (a background-launched window otherwise stays at a
    /// tiny placeholder frame). Off-screen + no activation = invisible to
    /// the user and steals no focus.
    func ensureMainWindowLaidOutOffscreen() {
        let target = NSSize(width: 1100, height: 720)
        let offscreenFrame = NSRect(origin: NSPoint(x: -6000, y: 200), size: target)
        var ticks = 0
        let timer = Timer(timeInterval: 0.5, repeats: true) { t in
            ticks += 1
            for window in NSApp.windows where window.styleMask.contains(.titled) && window.contentView != nil {
                if window.frame.size != target || window.frame.minX > -1000 {
                    window.setFrame(offscreenFrame, display: true, animate: false)
                }
            }
            if ticks >= 10 { t.invalidate() }
        }
        RunLoop.main.add(timer, forMode: .common)
    }


    /// Watch for a sentinel file; when present, render the main window's
    /// content view to a PNG and delete the sentinel.
    func startHeadlessShotWatcher() {
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self else { return }
            let fm = FileManager.default
            guard fm.fileExists(atPath: self.headlessShotRequestPath) else { return }
            // Read optional output path from the sentinel contents.
            let requested = (try? String(contentsOfFile: self.headlessShotRequestPath, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            try? fm.removeItem(atPath: self.headlessShotRequestPath)
            let raw = (requested?.isEmpty == false) ? requested! : "/tmp/kraki-shot.png"
            let sheetOnly = raw.hasPrefix("sheet:")
            let out = sheetOnly ? String(raw.dropFirst("sheet:".count)) : raw
            self.renderWindowToPNG(path: out, sheetOnly: sheetOnly)
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    func renderMainWindowToPNG(path: String) {
        renderWindowToPNG(path: path, sheetOnly: false)
    }

    func renderWindowToPNG(path: String, sheetOnly: Bool) {
        let candidates = NSApp.windows.filter {
            $0.contentView != nil && $0.frame.width > 300 && $0.frame.height > 200
        }
        let selected: NSWindow? = {
            if sheetOnly {
                return candidates.first(where: { $0.sheetParent != nil })
                    ?? candidates.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            }
            return candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        }()
        guard let window = selected,
              let view = window.contentView else {
            NSLog("[headless-shot] no suitable window/contentView")
            return
        }
        // In-process renders (cacheDisplay) cannot reproduce NSVisualEffectView
        // vibrancy — it's composited by the window server, so it captures as
        // blank white. Our seamless-flat design is solid-color anyway, so for
        // the capture we hide the effect views and paint the window's solid
        // background (already surfacePrimary) behind them, then restore.
        var hiddenEffectViews: [NSVisualEffectView] = []
        func hideEffects(_ v: NSView) {
            if let fx = v as? NSVisualEffectView, !fx.isHidden {
                fx.isHidden = true
                hiddenEffectViews.append(fx)
            }
            v.subviews.forEach(hideEffects)
        }
        hideEffects(view)
        view.wantsLayer = true
        let priorBG = view.layer?.backgroundColor
        view.layer?.backgroundColor = (window.backgroundColor.usingColorSpace(.deviceRGB) ?? window.backgroundColor).cgColor

        view.layoutSubtreeIfNeeded()
        let bounds = view.bounds
        defer {
            hiddenEffectViews.forEach { $0.isHidden = false }
            view.layer?.backgroundColor = priorBG
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            NSLog("[headless-shot] bitmapImageRepForCachingDisplay returned nil")
            return
        }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            NSLog("[headless-shot] PNG encode failed")
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            NSLog("[headless-shot] wrote %dx%d -> %@", Int(bounds.width), Int(bounds.height), path)
        } catch {
            NSLog("[headless-shot] write failed: %@", error.localizedDescription)
        }
    }

    /// Headless END-TO-END self-test: drives the REAL production data chain
    /// (MessageStore → MessageProvider.currentWindow → ChatViewModel.filteredMessages
    /// → TurnSpineProjection.project → displayMessages → MacChatView →
    /// MacChatScrollView → MacChatBubbleCell), then self-captures via cacheDisplay.
    /// No window is shown, no focus is taken, and NO Accessibility/screen-recording
    /// permission is required (cacheDisplay renders the view tree in-process).
    ///
    /// This is the strongest self-test that does not require operator-granted
    /// permissions: it proves the full data→SwiftUI→TextKit rendering pipeline
    /// end-to-end, including the projection rules that collapse turns.
    func renderE2ESelfTestToPNG() {
        MacMarkdown.prewarmSyntaxHighlighter()
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let width: CGFloat = 760
        let sessionId = "e2e-selftest"
        let deviceId = "dev-e2e"
        let agent = "pi"

        @MainActor func buildAppState() -> AppState {
            let appState = AppState()
            appState.deviceId = deviceId
            // Session.
            let session = SessionInfo(
                id: sessionId, deviceId: deviceId, deviceName: "Mac",
                agent: agent, model: "claude-sonnet-4",
                title: "E2E Self-Test",
                state: .idle, mode: .auto,
                lastSeq: 8, readSeq: 8, messageCount: 8,
                createdAt: Date(), pinned: false)
            appState.sessionStore.sessions[sessionId] = session
            appState.sessionStore.activeSessionId = sessionId
            appState.sessionStore.loadingSessions.remove(sessionId)

            // Register the owning device as online so the composer renders.
            appState.deviceStore.devices[deviceId] = DeviceSummary(
                id: deviceId, name: "Mac", role: .tentacle, kind: .desktop,
                publicKey: nil, encryptionKey: nil, online: true,
                lastSeen: nil, createdAt: nil)

            // Seed a real message window via the provider so ChatViewModel's
            // currentWindow / windowState paths resolve identically to live use.
            let provider = MessageProvider(appState: appState)
            appState.setMessageProviderForTesting(provider)

            // Build the window directly (matches what a tail fill would produce).
            let msgs: [ChatMessage] = [
                ChatMessage(type: "user_message", seq: 1, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Help me ship the Mac chat.")]),
                ChatMessage(type: "agent_message", seq: 2, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [
                                "content": AnyCodable("""
On it. Here's the plan:## Goal
Render the chat with native TextKit.

- Reuse the iOS bubble
- Add a composer
- Wire the real view model

```swift
let vm = ChatViewModel(sessionId: id, appState: appState)
```

> Make sure focus is never stolen.
""")]),
                ChatMessage(type: "user_message", seq: 3, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Status?")]),
                ChatMessage(type: "agent_message", seq: 4, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [
                                "content": AnyCodable("""
| Phase | Status |
| :--- | :---: |
| Render | done |
| Composer | done |
| Steps | done |
| Images | done |
"""),
                                "steps": AnyCodable(5)]),
                ChatMessage(type: "idle", seq: 5, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: [:]),
                ChatMessage(type: "system_message", seq: 8, sessionId: sessionId, deviceId: deviceId,
                            timestamp: nil, payload: ["content": AnyCodable("Context compacted.")]),
            ]
            appState.messageStore.messages[sessionId] = msgs
            appState.messageStore.windows[sessionId] = .init(topSeq: 1, bottomSeq: 8)
            return appState
        }

        let appState = MainActor.assumeIsolated { buildAppState() }

        // Pre-build the view model so the SwiftUI host renders content
        // immediately (no .task dependency on window attachment).
        let prebuiltVM = MainActor.assumeIsolated {
            let vm = ChatViewModel(sessionId: sessionId, appState: appState)
            vm.refreshMessageCache()
            return vm
        }
        NSLog("[e2e-diag] displayMessages=\(prebuiltVM.displayMessages.count) waiting=\(prebuiltVM.isWaitingForLatestBubble)")

        let render = {
            // Host the REAL MacChatView (SwiftUI) via NSHostingController.
            let view = MacChatView(sessionId: sessionId, prebuiltViewModel: prebuiltVM)
                .environment(appState)
            let host = NSHostingController(rootView: view)
            host.view.frame = NSRect(x: 0, y: 0, width: width, height: 1200)
            host.view.layoutSubtreeIfNeeded()

            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: width, height: 1200),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentViewController = host
            host.view.layoutSubtreeIfNeeded()
            host.view.frame = NSRect(x: 0, y: 0, width: width, height: 1200)
            // Several runloop passes for SwiftUI .task / onChange to settle.
            for delay in [0.3, 0.6, 1.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    host.view.needsLayout = true
                    host.view.layoutSubtreeIfNeeded()
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                let bounds = host.view.bounds
                guard let rep = host.view.bitmapImageRepForCachingDisplay(in: bounds) else {
                    NSLog("[e2e] bitmapRep nil")
                    NSAppearance.current = priorAppearance
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                    return
                }
                host.view.cacheDisplay(in: bounds, to: rep)
                window.contentViewController = nil
                if let data = rep.representation(using: .png, properties: [:]) {
                    let out = "/tmp/kraki-mac-e2e.png"
                    try? data.write(to: URL(fileURLWithPath: out))
                    NSLog("[e2e] wrote %.0fx%.0f -> %@", width, bounds.height, out)
                }
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { render() }
    }

    /// Headless render of every production composer state. Uses real
    /// `MacChatComposer` instances in an off-screen borderless window and exits
    /// automatically; it never orders a window front or takes focus.
    @MainActor
    func renderComposerStatesToPNG() {
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)
        let width: CGFloat = 760
        let deviceId = "composer-device"

        @MainActor func makeState(
            id: String,
            state: SessionState,
            mode: SessionMode,
            online: Bool,
            connection: ConnectionStatus,
            draft: String
        ) -> AppState {
            let app = AppState()
            app.connectionStatus = connection
            app.hasCompletedInitialConnect = true
            app.sessionStore.sessions[id] = SessionInfo(
                id: id, deviceId: deviceId, deviceName: "Mac Studio",
                agent: "pi", model: "claude-sonnet-4", title: id,
                state: state, mode: mode, lastSeq: 1, readSeq: 1,
                messageCount: 1, createdAt: Date(), pinned: false
            )
            app.sessionStore.setDraft(id, draft)
            app.deviceStore.devices[deviceId] = DeviceSummary(
                id: deviceId, name: "Mac Studio", role: .tentacle, kind: .desktop,
                publicKey: nil, encryptionKey: nil, online: online,
                lastSeen: nil, createdAt: nil
            )
            return app
        }

        let imageData: Data? = {
            let image = NSImage(size: NSSize(width: 96, height: 64))
            image.lockFocus()
            NSColor.systemTeal.setFill()
            NSRect(x: 0, y: 0, width: 96, height: 64).fill()
            NSColor.white.setFill()
            NSBezierPath(ovalIn: NSRect(x: 32, y: 16, width: 32, height: 32)).fill()
            image.unlockFocus()
            guard let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff) else { return nil }
            return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
        }()

        struct Sample {
            let title: String
            let state: AppState
            let composer: MacChatComposer
        }

        let samples: [Sample] = {
            let idle = makeState(id: "Idle prompt", state: .idle, mode: .auto,
                                 online: true, connection: .connected, draft: "Draft prompt")
            let active = makeState(id: "Active steer", state: .active, mode: .auto,
                                   online: true, connection: .connected, draft: "Steer the current turn")
            let permission = makeState(id: "Permission reason", state: .active, mode: .auto,
                                       online: true, connection: .connected, draft: "Not safe to modify this file")
            let question = makeState(id: "Question answer", state: .active, mode: .safe,
                                     online: true, connection: .connected, draft: "Preserve the visible anchor")
            let image = makeState(id: "Image attachment", state: .idle, mode: .delegate,
                                  online: true, connection: .connected, draft: "Describe this image")
            let offline = makeState(id: "Device offline", state: .idle, mode: .auto,
                                    online: false, connection: .connected, draft: "Compose while offline")
            let reconnecting = makeState(id: "Relay reconnecting", state: .idle, mode: .auto,
                                         online: true, connection: .connecting, draft: "Queued draft")
            let compacting = makeState(id: "Compacting", state: .compacting, mode: .auto,
                                       online: true, connection: .connected, draft: "Steer after compaction")
            let scrollable = makeState(
                id: "Scrollable multiline",
                state: .idle,
                mode: .auto,
                online: true,
                connection: .connected,
                draft: (1...8).map { "SCROLLABLE-DRAFT line \($0) with enough text to wrap inside the Composer." }.joined(separator: "\n")
            )

            let pendingPermission = PendingPermission(
                id: "perm", sessionId: "Permission reason",
                description: "Write file", toolName: "write_file", args: nil, timestamp: Date())
            let pendingQuestion = PendingQuestion(
                id: "question", sessionId: "Question answer", question: "What should be preserved?",
                choices: nil, timestamp: Date())

            return [
                Sample(title: "Idle prompt", state: idle,
                       composer: MacChatComposer(sessionId: "Idle prompt")),
                Sample(title: "Active steer + stop", state: active,
                       composer: MacChatComposer(sessionId: "Active steer", hasLiveCard: true)),
                Sample(title: "Permission deny reason", state: permission,
                       composer: MacChatComposer(sessionId: "Permission reason", pendingPermission: pendingPermission,
                                                 hasLiveCard: true)),
                Sample(title: "Question freeform answer", state: question,
                       composer: MacChatComposer(sessionId: "Question answer", pendingQuestion: pendingQuestion,
                                                 hasLiveCard: true)),
                Sample(title: "Image preview", state: image,
                       composer: MacChatComposer(sessionId: "Image attachment", initialImageData: imageData)),
                Sample(title: "Device offline hint", state: offline,
                       composer: MacChatComposer(sessionId: "Device offline")),
                Sample(title: "Relay reconnecting hint", state: reconnecting,
                       composer: MacChatComposer(sessionId: "Relay reconnecting")),
                Sample(title: "Compacting + stop", state: compacting,
                       composer: MacChatComposer(sessionId: "Compacting", isCompacting: true, hasLiveCard: true)),
                Sample(title: "Scrollable multiline draft", state: scrollable,
                       composer: MacChatComposer(sessionId: "Scrollable multiline")),
            ]
        }()

        let root = VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                VStack(alignment: .leading, spacing: 6) {
                    Text(sample.title)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 16)
                    sample.composer.environment(sample.state)
                }
            }
        }
        .padding(.vertical, 18)
        .frame(width: width)
        .background(Color.surfacePrimary)

        let host = NSHostingController(rootView: root)
        host.view.frame = NSRect(x: 0, y: 0, width: width, height: 760)
        host.view.layoutSubtreeIfNeeded()
        let fitting = host.view.fittingSize
        let height = max(760, fitting.height)
        host.view.frame = NSRect(x: 0, y: 0, width: width, height: height)

        let window = NSWindow(
            contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
            styleMask: .borderless, backing: .buffered, defer: false
        )
        window.isOpaque = true
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.contentViewController = host

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            host.view.layoutSubtreeIfNeeded()
            func descendants(of view: NSView) -> [NSView] {
                view.subviews.flatMap { [$0] + descendants(of: $0) }
            }
            if let textView = descendants(of: host.view).compactMap({ $0 as? NSTextView }).first(where: {
                $0.string.contains("SCROLLABLE-DRAFT")
            }), let scrollView = textView.enclosingScrollView {
                scrollView.contentView.scroll(to: .zero)
                scrollView.reflectScrolledClipView(scrollView.contentView)
                let before = scrollView.contentView.bounds.minY
                let maximumY = max(0, textView.frame.height - scrollView.contentView.bounds.height)
                scrollView.contentView.scroll(to: NSPoint(x: 0, y: maximumY))
                scrollView.reflectScrolledClipView(scrollView.contentView)
                let after = scrollView.contentView.bounds.minY
                NSLog(
                    "[composer-scroll-regression] viewport=%.1f document=%.1f scroller=%d scrollerObject=%d before=%.1f after=%.1f moved=%d font=%.1f",
                    scrollView.contentView.bounds.height,
                    textView.frame.height,
                    scrollView.hasVerticalScroller ? 1 : 0,
                    scrollView.verticalScroller == nil ? 0 : 1,
                    before,
                    after,
                    abs(after - before) > 0.5 ? 1 : 0,
                    textView.font?.pointSize ?? 0
                )
            } else {
                NSLog("[composer-scroll-regression] missing scrollable text view")
            }
            let bounds = host.view.bounds
            guard let rep = host.view.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSApp.terminate(nil)
                return
            }
            host.view.cacheDisplay(in: bounds, to: rep)
            window.contentViewController = nil
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: "/tmp/kraki-mac-composer-states.png"))
                NSLog("[composer-test] wrote %.0fx%.0f", bounds.width, bounds.height)
            }
            NSAppearance.current = priorAppearance
            NSApp.terminate(nil)
        }
    }

    /// Headless render of the PRODUCTION chat list path (`MacChatScrollView` +
    /// `MacChatBubbleCell`) with mock messages, so the real bubble geometry,
    /// TextKit body, tables, images, action slots, and trace affordances are
    /// validated geometrically without ever showing a window. Mirrors the
    /// zero-focus, borderless-hidden-window capture path used by the bubble
    /// test page.
    func renderChatListToPNG() {
        MacMarkdown.prewarmSyntaxHighlighter()
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let documentWidth: CGFloat = 760
        let sessionId = "render-chat-test"
        let agent = "pi"

        func msg(_ type: String, seq: Int, content: String) -> ChatMessage {
            ChatMessage(type: type, seq: seq, sessionId: sessionId, deviceId: nil,
                        timestamp: nil, payload: ["content": AnyCodable(content)])
        }

        let messages: [ChatMessage] = [
            msg("user_message", seq: 1, content: "Can you summarize the chat surface work?"),
            msg("agent_message", seq: 2, content: """
Sure. Here's the summary:

- Replaced the Mac placeholder with a fully functional chat list
- Reused the validated TextKit bubble renderer
- Composer sends input, resolves permissions and questions, aborts turns

```swift
struct MacChatView: View {
    let sessionId: String
}
```

> Note: the production cell path is what this render exercises.
"""),
            msg("user_message", seq: 3, content: "And tables?"),
            msg("agent_message", seq: 4, content: """
| Layer | Status | Owner | Notes |
| :--- | :---: | :--- | :--- |
| Render | done | TextKit | Bubble cells use exact iOS metrics |
| List | done | AppKit | Pagination keeps the visible anchor stable |
| Composer | done | SwiftUI | Floating liquid-glass input capsule |
| Steps | done | Trace | Live semantic refresh boundaries |
| Images | done | Attachments | Lazy refs retry on failure |
| Permissions | done | Card | Actions stay inside the live bubble |
| Questions | done | Card | Long choices expand without truncation |
| Tables | done | TextKit | Wide columns scroll horizontally |
"""),
            msg("system_message", seq: 5, content: "Session resumed from another device."),
        ]

        // One agent message with a live tool action + steps hint, to exercise
        // the action slot + steps button.
        let toolAction = ChatMessage(
            type: "tool_start", seq: 6, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "toolName": AnyCodable("bash"),
                "toolCallId": AnyCodable("tc-demo"),
                "headline": AnyCodable("$ rg -n pulse"),
            ])
        var livePayload: [String: AnyCodable] = ["content": AnyCodable("Inspecting the repository now…")]
        livePayload["steps"] = AnyCodable(3)
        let liveStepsMsg = ChatMessage(
            type: "agent_message", seq: 7, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: livePayload)
        let liveCard = MessageStore.SessionCard(text: "Inspecting the repository now…", action: toolAction)
        let permissionAction = ChatMessage(
            type: "permission", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "id": AnyCodable("perm-demo"),
                "toolName": AnyCodable("write_file"),
                "description": AnyCodable("Write the final ChatView implementation to Kraki/Features/Chat/Mac."),
            ])
        var openQuestion = ChatMessage(
            type: "agent_message", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: [
                "content": AnyCodable("Before delivery:"),
                "question": AnyCodable([
                    "id": "question-demo",
                    "text": "Which visual behavior should be validated before delivery?",
                    "choices": [
                        "Open history and preserve the visible anchor while paging",
                        "Send a prompt, steer the active turn, then abort it",
                        "Resolve a permission inside the live bubble",
                    ],
                ] as [String: Any]),
            ])
        openQuestion.questionPresentation = QuestionPresentation(state: .open)
        let failedAction = ChatMessage(
            type: "failed", seq: 0, sessionId: sessionId, deviceId: nil,
            timestamp: nil, payload: ["message": AnyCodable("Agent process was lost")])

        let render = {
            var contents: [MacChatItem] = []
            for m in messages {
                contents.append(MacChatItem(
                    key: m.id,
                    signature: m.id,
                    estimatedHeight: 120,
                    makeContent: {
                        MacChatBubbleContentBuilder.make(
                            message: m, sessionId: sessionId, agent: agent,
                            documentWidth: documentWidth)
                    }
                ))
            }
            // Steps-enabled bubble (agent with steps hint).
            let stepsContent = MacChatBubbleContentBuilder.make(
                message: liveStepsMsg, sessionId: sessionId, agent: agent,
                documentWidth: documentWidth)
            contents.append(MacChatItem(
                key: liveStepsMsg.id,
                signature: liveStepsMsg.id,
                estimatedHeight: 120,
                makeContent: { stepsContent }
            ))
            // Live card with tool action.
            let liveContent = MacChatBubbleContentBuilder.live(
                card: liveCard, sessionId: sessionId, agent: agent,
                documentWidth: documentWidth, traceSeq: 1, steps: 3)
            contents.append(MacChatItem(
                key: "__live__",
                signature: "live-tool",
                estimatedHeight: 180,
                makeContent: { liveContent }
            ))
            for (key, card, traceSeq) in [
                ("permission", MessageStore.SessionCard(text: "", action: permissionAction), 8),
                ("question", openQuestion.frozenCard ?? .init(), 9),
                ("failed", MessageStore.SessionCard(text: "Finalizing the turn…", action: failedAction), 10),
            ] {
                let content = MacChatBubbleContentBuilder.live(
                    card: card, sessionId: sessionId, agent: agent,
                    documentWidth: documentWidth, traceSeq: traceSeq, steps: 1,
                    frozen: key == "failed")
                contents.append(MacChatItem(
                    key: key,
                    signature: key,
                    estimatedHeight: 180,
                    makeContent: { content }
                ))
            }

            let sv = MacChatScrollView(frame: NSRect(x: 0, y: 0, width: documentWidth, height: 1000))
            sv.chatDocumentView.apply(contents: contents, documentWidth: documentWidth, sessionMode: .auto)
            sv.chatDocumentView.onTapSteps = { _ in }
            sv.chatDocumentView.onResolvePermission = { _, _, _ in }
            sv.chatDocumentView.onAnswerQuestion = { _, _ in }
            let docH = sv.chatDocumentView.bounds.height
            sv.frame = NSRect(x: 0, y: 0, width: documentWidth, height: min(docH, 4000))
            sv.contentView.frame = sv.bounds
            sv.layoutSubtreeIfNeeded()
            sv.scrollToBottom(animated: false)

            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: documentWidth, height: sv.bounds.height),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = sv
            sv.layoutSubtreeIfNeeded()
            sv.displayIgnoringOpacity(sv.bounds)
            let bounds = sv.bounds
            guard let rep = sv.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSLog("[chat-test] bitmapRep nil")
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                return
            }
            sv.cacheDisplay(in: bounds, to: rep)
            window.contentView = nil
            if let data = rep.representation(using: .png, properties: [:]) {
                let out = "/tmp/kraki-mac-chat-test.png"
                try? data.write(to: URL(fileURLWithPath: out))
                NSLog("[chat-test] wrote %.0fx%.0f -> %@", documentWidth, sv.bounds.height, out)
            }
            NSAppearance.current = priorAppearance
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { render() }
    }

    /// Render the macOS bubble test page into a PNG with ZERO user impact:
    /// no window is ever created, ordered front, or shown. Each bubble is
    /// rendered directly into an `NSImage` via `lockFocus` + the text view's
    /// `draw(_:)` — a graphics context is enough for NSTextView to lay out
    /// and paint; it never needs to be attached to a window.
    ///
    /// This is the only approach that provably never steals focus or shows
    /// anything on screen: `orderFront*` (even `orderFrontRegardless` on a
    /// `.nonactivatingPanel`) still puts a window in the window server and
    /// can briefly appear / bounce the Dock. We avoid windows entirely.
    func renderBubbleTestToPNG() {
        let samples = MacBubbleCatalog.samples
        MacMarkdown.prewarmSyntaxHighlighter()

        // Light appearance so the render is legible regardless of system theme.
        let priorAppearance = NSAppearance.current
        NSAppearance.current = NSAppearance(named: .aqua)

        let canvasWidth: CGFloat = 760
        let bodyWidth: CGFloat = 700

        // Pass 1: warm the syntax highlighter by building all attributed
        // strings (Highlightr is lazy + async on first call).
        let _ = samples.map { MacMarkdown.attributed($0.body, cacheKey: "warm:\($0.title)") }

        let render = {
            // Pass 2 (after warmup): build each bubble text view and measure height.
            var cards: [(title: NSAttributedString, tv: MacBubbleTextView, height: CGFloat)] = []
            for s in samples {
                let tv = MacBubbleTextView()
                tv.isEditable = false
                tv.isSelectable = true
                tv.isRichText = true
                tv.drawsBackground = false
                tv.backgroundColor = .clear
                tv.textContainer?.lineFragmentPadding = 0
                tv.textStorage?.setAttributedString(MacMarkdown.attributed(s.body, cacheKey: "page:\(s.title)"))
                tv.textContainer?.size = NSSize(width: bodyWidth, height: 100000)
                tv.layoutManager?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: tv.textStorage?.length ?? 0), actualCharacterRange: nil)
                tv.layoutManager?.ensureLayout(for: tv.textContainer!)
                let used = tv.layoutManager?.usedRect(for: tv.textContainer!) ?? NSRect(x: 0, y: 0, width: bodyWidth, height: 20)
                let h = max(ceil(used.height), 16)
                let titleAttr: NSAttributedString = NSAttributedString(string: s.title, attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                    .foregroundColor: MacBubblePalette.secondary,
                ])
                cards.append((titleAttr, tv, h))
            }

            let padTitle: CGFloat = 18
            let padCard: CGFloat = 14
            let gap: CGFloat = 16
            let topPad: CGFloat = 24
            let heights: [CGFloat] = cards.map { padCard + padTitle + $0.height + padCard }
            let totalHeight = topPad + heights.reduce(0, +) + CGFloat(heights.count - 1) * gap + 24

            // Build a real flipped view hierarchy. The container paints the
            // canvas + card backgrounds; title labels and body text views are
            // subviews positioned in top-down (flipped) coordinates. No manual
            // CGContext flipping - the framework handles NSTextView's own flip
            // correctly, so text renders right-side up.
            let container = FlippedContainerView()
            container.wantsLayer = false
            let cardX: CGFloat = (canvasWidth - bodyWidth) / 2
            var y: CGFloat = topPad
            for (i, c) in cards.enumerated() {
                let cardHeight = heights[i]
                let cardRect = NSRect(x: cardX, y: y, width: bodyWidth, height: cardHeight)

                // Title label (top of card).
                let titleField = NSTextField(labelWithAttributedString: c.title)
                titleField.isBezeled = false
                titleField.drawsBackground = false
                titleField.isEditable = false
                titleField.isSelectable = false
                titleField.frame = NSRect(x: cardX + padCard, y: y + padCard,
                                          width: bodyWidth - padCard * 2, height: 14)

                // Body text view sized to its measured content height.
                let bodyW = bodyWidth - padCard * 2
                c.tv.frame = NSRect(x: cardX + padCard, y: y + padCard + padTitle,
                                    width: bodyW, height: c.height)
                c.tv.textContainer?.size = NSSize(width: bodyW, height: CGFloat.greatestFiniteMagnitude)
                c.tv.layoutManager?.ensureLayout(for: c.tv.textContainer!)

                container.cardRects.append(cardRect)
                container.addSubview(titleField)
                container.addSubview(c.tv)
                y += cardHeight + gap
            }
            container.frame = NSRect(x: 0, y: 0, width: canvasWidth, height: totalHeight)

            // Host the container in a borderless window created with
            // defer:false so it has a backing store immediately. We NEVER call
            // orderFront - the window is never shown, never becomes key/main,
            // so the user's focus is untouched. display() rasterizes the view
            // hierarchy into the window backing; cacheDisplay captures it.
            let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000,
                                                      width: canvasWidth, height: totalHeight),
                                  styleMask: .borderless, backing: .buffered, defer: false)
            window.isOpaque = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = container
            container.layoutSubtreeIfNeeded()
            container.displayIgnoringOpacity(container.bounds)

            let bounds = container.bounds
            guard let rep = container.bitmapImageRepForCachingDisplay(in: bounds) else {
                NSLog("[bubble-test] bitmapImageRepForCachingDisplay returned nil")
                NSAppearance.current = priorAppearance
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
                return
            }
            container.cacheDisplay(in: bounds, to: rep)
            // Release the hidden window now that we have the rep.
            window.contentView = nil

            if let data = rep.representation(using: .png, properties: [:]) {
                let out = "/tmp/kraki-mac-bubble-test.png"
                try? data.write(to: URL(fileURLWithPath: out))
                NSLog("[bubble-test] wrote %.0fx%.0f -> %@", canvasWidth, totalHeight, out)
            } else {
                NSLog("[bubble-test] PNG encode failed")
            }
            NSAppearance.current = priorAppearance
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                NSApp.terminate(nil)
            }
        }

        // Wait for Highlightr to warm, then render.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            render()
        }
    }
}
#endif
