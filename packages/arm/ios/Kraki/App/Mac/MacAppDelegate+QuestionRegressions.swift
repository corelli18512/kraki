/// Debug-only launch regressions for question hit-testing and unread projection.

#if os(macOS) && DEBUG
import AppKit
import SwiftUI

#if DEBUG
private struct MacQuestionHitProbeHost: NSViewRepresentable {
    let cell: MacChatBubbleCell

    func makeNSView(context: Context) -> MacChatBubbleCell { cell }

    func updateNSView(_ nsView: MacChatBubbleCell, context: Context) {
        nsView.needsLayout = true
    }
}

#endif

extension MacAppDelegate {
    func runQuestionHitRegression() {
        let question = ChatMessage(
            type: "question",
            seq: 2,
            sessionId: "question-hit-regression",
            deviceId: "tentacle-test",
            timestamp: nil,
            payload: [
                "id": AnyCodable("question-hit"),
                "question": AnyCodable("Which button did the pointer actually reach?"),
                "choices": AnyCodable(["First visual choice", "Second visual choice"]),
            ]
        )
        let content = MacChatBubbleContentBuilder.live(
            card: MessageStore.SessionCard(
                text: "Choose one option below. The native event bands must match the rendered rows.",
                action: question
            ),
            sessionId: "question-hit-regression",
            agent: "pi",
            documentWidth: 640,
            traceSeq: 2,
            steps: 0
        )

        func makeCell(onAnswer: @escaping (String) -> Void) -> MacChatBubbleCell {
            let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: 640, height: 1))
            cell.configure(
                content: content,
                renderKey: "question-hit-regression",
                documentWidth: 640,
                sessionMode: .auto,
                onTapSteps: { _ in },
                onResolvePermission: { _, _, _ in },
                onAnswerQuestion: { _, value in onAnswer(value) },
                onOpenImage: { _ in },
                onOpenHTMLArtifact: { _ in },
                onHeightInvalidated: {}
            )
            let height = cell.configuredHeight()
            cell.frame = NSRect(x: 0, y: 0, width: 640, height: height)
            return cell
        }

        func sendClick(to window: NSWindow, point: NSPoint, eventNumber: Int) {
            let timestamp = ProcessInfo.processInfo.systemUptime + Double(eventNumber) * 0.001
            guard let down = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: point,
                modifierFlags: [],
                timestamp: timestamp,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: eventNumber,
                clickCount: 1,
                pressure: 1
            ), let up = NSEvent.mouseEvent(
                with: .leftMouseUp,
                location: point,
                modifierFlags: [],
                timestamp: timestamp + 0.0005,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: eventNumber + 1,
                clickCount: 1,
                pressure: 0
            ) else { return }
            NSApp.sendEvent(down)
            NSApp.sendEvent(up)
        }

        func capture(_ view: NSView, to path: String) -> Bool {
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [.compressionFactor: 1]) else {
                return false
            }
            return (try? png.write(to: URL(fileURLWithPath: path), options: .atomic)) != nil
        }

        func range(_ values: [CGFloat]) -> String {
            guard let first = values.first, let last = values.last else { return "none" }
            return String(format: "%.1f...%.1f", first, last)
        }

        var directAnswer = ""
        let directCell = makeCell { directAnswer = $0 }
        let directWindow = NSWindow(
            contentRect: directCell.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        directWindow.isReleasedWhenClosed = false
        directWindow.contentView = directCell
        directWindow.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        directWindow.makeKeyAndOrderFront(nil)
        directCell.layoutSubtreeIfNeeded()
        directCell.display()
        let directPath = "/tmp/kraki-question-hit-regression.png"
        let directCaptured = capture(directCell, to: directPath)
        let actionFrame = directCell.actionFrameForRegression
        var directFirst: [CGFloat] = []
        var directSecond: [CGFloat] = []
        var eventNumber = 1
        for y in stride(
            from: floor(actionFrame.minY),
            through: ceil(actionFrame.maxY),
            by: 1
        ) {
            directAnswer = ""
            let windowPoint = directCell.convert(
                NSPoint(x: actionFrame.midX, y: y),
                to: nil
            )
            sendClick(to: directWindow, point: windowPoint, eventNumber: eventNumber)
            if directAnswer == "First visual choice" { directFirst.append(y) }
            if directAnswer == "Second visual choice" { directSecond.append(y) }
            eventNumber += 2
        }
        directWindow.close()

        let zoom: CGFloat = 1.2
        var zoomAnswer = ""
        let zoomCell = makeCell { zoomAnswer = $0 }
        let zoomSize = NSSize(
            width: zoomCell.frame.width * zoom,
            height: zoomCell.frame.height * zoom
        )
        let zoomRoot = GeometryReader { geometry in
            MacQuestionHitProbeHost(cell: zoomCell)
                .frame(
                    width: max(1, geometry.size.width / zoom),
                    height: max(1, geometry.size.height / zoom)
                )
                .scaleEffect(zoom, anchor: .topLeading)
        }
        let zoomHost = NSHostingController(rootView: zoomRoot)
        zoomHost.view.frame = NSRect(origin: .zero, size: zoomSize)
        let zoomWindow = NSWindow(
            contentRect: zoomHost.view.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        zoomWindow.isReleasedWhenClosed = false
        zoomWindow.contentViewController = zoomHost
        zoomWindow.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        zoomWindow.makeKeyAndOrderFront(nil)
        zoomHost.view.layoutSubtreeIfNeeded()
        zoomCell.layoutSubtreeIfNeeded()
        zoomHost.view.display()
        let zoomPath = "/tmp/kraki-question-hit-zoom-regression.png"
        let zoomCaptured = capture(zoomHost.view, to: zoomPath)
        var correctedFirst: [CGFloat] = []
        var correctedSecond: [CGFloat] = []
        for visualTopY in stride(from: CGFloat(0), through: zoomSize.height, by: 1) {
            let windowPoint = NSPoint(
                x: actionFrame.midX * zoom,
                y: zoomSize.height - visualTopY
            )
            let target = zoomCell.questionChoiceHitTarget(
                atWindowPoint: windowPoint
            )
            if target?.answer == "First visual choice" { correctedFirst.append(visualTopY) }
            if target?.answer == "Second visual choice" { correctedSecond.append(visualTopY) }
        }
        var zoomFirst: [CGFloat] = []
        var zoomSecond: [CGFloat] = []
        let visualX = actionFrame.midX * zoom
        for topY in stride(from: CGFloat(0), through: zoomSize.height, by: 1) {
            zoomAnswer = ""
            sendClick(
                to: zoomWindow,
                point: NSPoint(x: visualX, y: zoomSize.height - topY),
                eventNumber: eventNumber
            )
            if zoomAnswer == "First visual choice" { zoomFirst.append(topY) }
            if zoomAnswer == "Second visual choice" { zoomSecond.append(topY) }
            eventNumber += 2
        }

        let fallbackProbeTopY = ((correctedFirst.first ?? 0) + (correctedFirst.last ?? 0)) / 2
        let fallbackProbePoint = NSPoint(
            x: visualX,
            y: zoomSize.height - fallbackProbeTopY
        )
        let fallbackContext = zoomCell.actionCaptureContext(
            atWindowPoint: fallbackProbePoint
        )
        let fallbackCaptureBefore = fallbackContext?.capture == .question("question-hit")
        let stableTargetBeforeMove = fallbackContext.flatMap {
            zoomCell.actionHitTarget(
                for: $0.capture,
                atActionPoint: $0.actionPoint
            )
        } == .question(MacQuestionChoiceHitTarget(
            questionId: "question-hit",
            answer: "First visual choice"
        ))
        zoomCell.offsetActionHostForRegression(y: 40)
        let movedWindowTarget = zoomCell.questionChoiceHitTarget(
            atWindowPoint: fallbackProbePoint
        )
        let stableTargetAfterMove = fallbackContext.flatMap {
            zoomCell.actionHitTarget(
                for: $0.capture,
                atActionPoint: $0.actionPoint
            )
        } == .question(MacQuestionChoiceHitTarget(
            questionId: "question-hit",
            answer: "First visual choice"
        ))
        let movingCardPassed = stableTargetBeforeMove
            && movedWindowTarget?.answer != "First visual choice"
            && stableTargetAfterMove
        zoomCell.offsetActionHostForRegression(y: -40)
        zoomCell.clearActionHitFramesForRegression()
        let fallbackTargetMissing = zoomCell.questionChoiceHitTarget(
            atWindowPoint: fallbackProbePoint
        ) == nil
        let fallbackCaptureAfter = zoomCell.actionCapture(
            atWindowPoint: fallbackProbePoint
        ) == .question("question-hit")
        let fallbackCapturePassed = fallbackCaptureBefore
            && fallbackTargetMissing
            && fallbackCaptureAfter

        zoomWindow.close()

        // Permission buttons use the same rendered-frame interception as
        // Question choices. Their layout is horizontal, so compare each full
        // hit rectangle before/after the production 1.2× root zoom.
        let permission = ChatMessage(
            type: "permission",
            seq: 2,
            sessionId: "permission-hit-regression",
            deviceId: "tentacle-test",
            timestamp: nil,
            payload: [
                "id": AnyCodable("permission-hit"),
                "toolName": AnyCodable("write_file"),
                "description": AnyCodable("MacChatView.swift"),
                "args": AnyCodable(["path": "MacChatView.swift"]),
            ]
        )
        let permissionContent = MacChatBubbleContentBuilder.live(
            card: MessageStore.SessionCard(
                text: "Approve this production-aligned write request.",
                action: permission
            ),
            sessionId: "permission-hit-regression",
            agent: "pi",
            documentWidth: 640,
            traceSeq: 2,
            steps: 0
        )
        func makePermissionCell() -> MacChatBubbleCell {
            let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: 640, height: 1))
            cell.configure(
                content: permissionContent,
                renderKey: "permission-hit-regression",
                documentWidth: 640,
                sessionMode: .auto,
                onTapSteps: { _ in },
                onResolvePermission: { _, _, _ in },
                onAnswerQuestion: { _, _ in },
                onOpenImage: { _ in },
                onOpenHTMLArtifact: { _ in },
                onHeightInvalidated: {}
            )
            cell.frame.size.height = cell.configuredHeight()
            return cell
        }
        func permissionHitRects(
            cell: MacChatBubbleCell,
            visualSize: NSSize
        ) -> [String: NSRect] {
            var points: [String: [NSPoint]] = [:]
            for x in stride(from: CGFloat(0), through: visualSize.width, by: 2) {
                for topY in stride(from: CGFloat(0), through: visualSize.height, by: 2) {
                    let point = NSPoint(x: x, y: visualSize.height - topY)
                    if let target = cell.permissionButtonHitTarget(atWindowPoint: point) {
                        points[target.decision, default: []].append(NSPoint(x: x, y: topY))
                    }
                }
            }
            return points.reduce(into: [:]) { result, entry in
                guard let minX = entry.value.map(\.x).min(),
                      let maxX = entry.value.map(\.x).max(),
                      let minY = entry.value.map(\.y).min(),
                      let maxY = entry.value.map(\.y).max() else { return }
                result[entry.key] = NSRect(
                    x: minX,
                    y: minY,
                    width: maxX - minX,
                    height: maxY - minY
                )
            }
        }

        let directPermissionCell = makePermissionCell()
        let directPermissionWindow = NSWindow(
            contentRect: directPermissionCell.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        directPermissionWindow.isReleasedWhenClosed = false
        directPermissionWindow.contentView = directPermissionCell
        directPermissionWindow.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        directPermissionWindow.makeKeyAndOrderFront(nil)
        directPermissionCell.layoutSubtreeIfNeeded()
        directPermissionCell.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
        let directPermissionRects = permissionHitRects(
            cell: directPermissionCell,
            visualSize: directPermissionCell.frame.size
        )
        directPermissionWindow.close()

        let zoomPermissionCell = makePermissionCell()
        let zoomPermissionSize = NSSize(
            width: zoomPermissionCell.frame.width * zoom,
            height: zoomPermissionCell.frame.height * zoom
        )
        let zoomPermissionRoot = GeometryReader { geometry in
            MacQuestionHitProbeHost(cell: zoomPermissionCell)
                .frame(
                    width: max(1, geometry.size.width / zoom),
                    height: max(1, geometry.size.height / zoom)
                )
                .scaleEffect(zoom, anchor: .topLeading)
        }
        let zoomPermissionHost = NSHostingController(rootView: zoomPermissionRoot)
        zoomPermissionHost.view.frame = NSRect(origin: .zero, size: zoomPermissionSize)
        let zoomPermissionWindow = NSWindow(
            contentRect: zoomPermissionHost.view.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        zoomPermissionWindow.isReleasedWhenClosed = false
        zoomPermissionWindow.contentViewController = zoomPermissionHost
        zoomPermissionWindow.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        zoomPermissionWindow.makeKeyAndOrderFront(nil)
        zoomPermissionHost.view.layoutSubtreeIfNeeded()
        zoomPermissionCell.layoutSubtreeIfNeeded()
        zoomPermissionHost.view.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
        let zoomPermissionRects = permissionHitRects(
            cell: zoomPermissionCell,
            visualSize: zoomPermissionSize
        )
        zoomPermissionWindow.close()

        func bandMatches(_ zoomed: [CGFloat], _ direct: [CGFloat]) -> Bool {
            guard let zoomedFirst = zoomed.first,
                  let zoomedLast = zoomed.last,
                  let directFirst = direct.first,
                  let directLast = direct.last else { return false }
            return abs(zoomedFirst - directFirst * zoom) <= 2
                && abs(zoomedLast - directLast * zoom) <= 2
        }
        func rectMatches(_ zoomed: NSRect?, _ direct: NSRect?) -> Bool {
            guard let zoomed, let direct else { return false }
            return abs(zoomed.minX - direct.minX * zoom) <= 4
                && abs(zoomed.maxX - direct.maxX * zoom) <= 4
                && abs(zoomed.minY - direct.minY * zoom) <= 4
                && abs(zoomed.maxY - direct.maxY * zoom) <= 4
        }
        let directPassed = !directFirst.isEmpty
            && !directSecond.isEmpty
            && (directFirst.last ?? 0) < (directSecond.first ?? 0)
        let zoomPassed = bandMatches(zoomFirst, directFirst)
            && bandMatches(zoomSecond, directSecond)
        let correctedPassed = bandMatches(correctedFirst, directFirst)
            && bandMatches(correctedSecond, directSecond)
        let permissionDecisions = ["approve", "execute", "deny"]
        let permissionPassed = Set(directPermissionRects.keys) == Set(permissionDecisions)
            && Set(zoomPermissionRects.keys) == Set(permissionDecisions)
            && permissionDecisions.allSatisfy {
                rectMatches(zoomPermissionRects[$0], directPermissionRects[$0])
            }
        let passed = directPassed
            && correctedPassed
            && permissionPassed
            && fallbackCapturePassed
            && movingCardPassed
            && directCaptured
            && zoomCaptured
        NSLog(
            "[question-hit-regression] directFirst=%@ directSecond=%@ rawZoomFirst=%@ rawZoomSecond=%@ correctedFirst=%@ correctedSecond=%@ rawAligned=%d correctedAligned=%d permissionDirect=%@ permissionZoom=%@ permissionAligned=%d fallbackCapture=%d movingCard=%d directCapture=%d zoomCapture=%d passed=%d paths=%@,%@",
            range(directFirst),
            range(directSecond),
            range(zoomFirst),
            range(zoomSecond),
            range(correctedFirst),
            range(correctedSecond),
            zoomPassed ? 1 : 0,
            correctedPassed ? 1 : 0,
            String(describing: directPermissionRects),
            String(describing: zoomPermissionRects),
            permissionPassed ? 1 : 0,
            fallbackCapturePassed ? 1 : 0,
            movingCardPassed ? 1 : 0,
            directCaptured ? 1 : 0,
            zoomCaptured ? 1 : 0,
            passed ? 1 : 0,
            directPath,
            zoomPath
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    func runUnreadProjectionRegression() {
        func session(_ id: String, lastSeq: Int, readSeq: Int) -> SessionInfo {
            SessionInfo(
                id: id,
                deviceId: "dev-test",
                deviceName: "Test Device",
                agent: "pi",
                title: "Unread regression",
                state: .idle,
                mode: .auto,
                lastSeq: lastSeq,
                readSeq: readSeq,
                messageCount: lastSeq,
                createdAt: Date(),
                pinned: false
            )
        }

        let store = SessionStore(persistenceEnabled: false)
        store.sessions["caught-up"] = session("caught-up", lastSeq: 10, readSeq: 10)
        store.observeLastSeq("caught-up", seq: 11, advancesReadWhenCaughtUp: true)
        let caughtUp = store.sessions["caught-up"]?.lastSeq == 11
            && store.sessions["caught-up"]?.readSeq == 11
            && !store.isUnread("caught-up")

        store.sessions["existing"] = session("existing", lastSeq: 10, readSeq: 9)
        store.observeLastSeq("existing", seq: 11, advancesReadWhenCaughtUp: true)
        let existing = store.sessions["existing"]?.readSeq == 9 && store.isUnread("existing")

        store.sessions["gap"] = session("gap", lastSeq: 20, readSeq: 20)
        store.observeLastSeq("gap", seq: 22, advancesReadWhenCaughtUp: true)
        let gap = store.sessions["gap"]?.readSeq == 20 && store.isUnread("gap")

        store.sessions["attention"] = session("attention", lastSeq: 10, readSeq: 10)
        store.observeLastSeq("attention", seq: 11)
        let attention = store.sessions["attention"]?.readSeq == 10 && store.isUnread("attention")

        var routerUser = false
        var routerAgent = false
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-unread-regression-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            let app = AppState(testDatabase: database)
            app.sessionStore.sessions["user"] = session("user", lastSeq: 10, readSeq: 10)
            app.sessionStore.sessions["agent"] = session("agent", lastSeq: 10, readSeq: 10)
            let router = MessageRouter(appState: app)
            func route(type: String, sessionId: String) throws {
                let payload: [String: Any] = type == "user_message" ? ["content": "hello"] : ["content": "reply"]
                let data = try JSONSerialization.data(withJSONObject: [
                    "type": type,
                    "sessionId": sessionId,
                    "deviceId": "dev-test",
                    "seq": 11,
                    "timestamp": "2026-08-07T00:00:00Z",
                    "payload": payload,
                ])
                router.handleDataMessage(data)
            }
            try route(type: "user_message", sessionId: "user")
            try route(type: "agent_message", sessionId: "agent")
            routerUser = app.sessionStore.sessions["user"]?.readSeq == 11
                && !app.sessionStore.isUnread("user")
            routerAgent = app.sessionStore.sessions["agent"]?.readSeq == 10
                && app.sessionStore.isUnread("agent")
        } catch {
            NSLog("[unread-projection-regression] setup-error=%@", error.localizedDescription)
        }

        let passed = caughtUp && existing && gap && attention && routerUser && routerAgent
        NSLog(
            "[unread-projection-regression] caughtUp=%d existing=%d gap=%d attention=%d routerUser=%d routerAgent=%d passed=%d",
            caughtUp ? 1 : 0,
            existing ? 1 : 0,
            gap ? 1 : 0,
            attention ? 1 : 0,
            routerUser ? 1 : 0,
            routerAgent ? 1 : 0,
            passed ? 1 : 0
        )
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}
#endif
