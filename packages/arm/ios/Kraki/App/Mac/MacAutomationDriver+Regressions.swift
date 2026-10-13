/// Automation regressions and diagnostics: speaker glyphs, bubble action order, history disconnect, code contrast, table wheel, sidebar and transient scrollers.

#if os(macOS) && DEBUG
import AppKit
import Darwin
import Foundation
import CryptoKit
import SwiftUI
import WebKit

extension MacAutomationDriver {
    func captureSessionSpeakerGlyphs(path: String) -> Result<NSSize, CaptureError> {
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

    func bubbleActionOrderRegression() -> [String: Any] {
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
                sessionMode: .auto,
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

    func historyCoverageDiagnostics() -> [String: Any] {
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

    func historyDisconnectRegression() -> [String: Any] {
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
                mode: .auto,
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

    func chatLoadingDiagnostics() -> [String: Any] {
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

    func sessionSpeakerDiagnostics() -> [String: Any] {
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

    func sessionSpeakerStatusRegression() -> [String: Any] {
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

    func codeContrastRegression() -> [String: Any] {
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

    func tableWheelRegression() -> [String: Any] {
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

    func sessionListScrollerRegression(id: Any?, connection: Int32) {
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

    func transientScrollerRegression(id: Any?, connection: Int32) {
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
}
#endif
