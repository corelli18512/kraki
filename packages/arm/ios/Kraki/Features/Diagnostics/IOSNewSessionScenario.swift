#if os(iOS) && DEBUG
import SwiftUI
import UIKit

/// Offline, visible reproduction of the production "new Session" journey:
/// production `MainTabView` + NavigationStack, `CommandSender.createSession`
/// (exactly what NewSessionSheet calls), the pending placeholder route, the
/// router's `session_created` swap, the first composer send, a streamed
/// answer that lands, and a real UINavigationController back pop.
///
/// A scripted in-process Tentacle answers every outbound command through
/// `MessageRouter.handleDataMessage` (the same entry point as decrypted Relay
/// frames). No network, Relay, Head or Tentacle is involved.
@MainActor
enum IOSNewSessionScenario {
    static let deviceID = "scenario-tentacle"
    static let logURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ios-new-session-scenario.log")

    static func log(_ line: String) {
        let stamped = String(format: "%.3f ", CFAbsoluteTimeGetCurrent().truncatingRemainder(dividingBy: 1000)) + line + "\n"
        NSLog("[new-session-scenario] %@", line)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            handle.write(Data(stamped.utf8))
            try? handle.close()
        } else {
            try? Data(stamped.utf8).write(to: logURL)
        }
    }

    static func makeAppState() -> AppState {
        try? FileManager.default.removeItem(at: logURL)
        do {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("kraki-new-session-\(UUID().uuidString)", isDirectory: true)
            let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            let app = AppState(testDatabase: database, loadPersistedState: false)
            app.deviceStore.devices[deviceID] = DeviceSummary(
                id: deviceID, name: "Scenario Mac", role: .tentacle, kind: .desktop,
                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
            // A few existing Sessions so the list has realistic rows.
            for index in 0..<6 {
                let id = "existing-\(index)"
                let history = (1...12).map { seq in
                    ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq,
                                sessionId: id, deviceId: deviceID, timestamp: "2026-09-25T00:00:00Z",
                                payload: ["content": AnyCodable(seq % 2 == 1 ? "帮我看一下第 \(seq) 个问题" : answer)])
                }
                try database.insert(id, history)
                app.sessionStore.upsertSession(SessionInfo(
                    id: id, deviceId: deviceID, deviceName: "Scenario Mac", agent: "pi",
                    model: "m", title: "Existing session \(index + 1)", state: .idle, mode: .discuss,
                    lastSeq: 12, readSeq: 12, messageCount: 12,
                    createdAt: Date().addingTimeInterval(Double(-3_600 * (index + 1))), pinned: false))
                app.messageProvider?.setTentacleInfo(sessionId: id, lastSeq: 12, deviceId: deviceID)
            }
            app.connectionStatus = .connected
            app.hasCompletedInitialConnect = true
            let tentacle = ScriptedTentacle(app: app)
            app.testOutboundMessageHandler = { message, target, _ in
                tentacle.receive(message, target: target)
                return true
            }
            scriptedTentacle = tentacle
            return app
        } catch {
            fatalError("new-session scenario: \(error)")
        }
    }

    static var scriptedTentacle: ScriptedTentacle?
    /// Test hook: run the scripted journey without the launch environment.
    static var forceAutorun = false
    static var finished = false

    /// In-process stand-in for a Tentacle; deterministic, no model.
    @MainActor
    final class ScriptedTentacle {
        weak var app: AppState?
        private var seqs: [String: Int] = [:]
        private(set) var subscribedSessions: Set<String> = []
        var createDelayMs = 700

        init(app: AppState) { self.app = app }

        private func nextSeq(_ sessionId: String) -> Int {
            let next = (seqs[sessionId] ?? 0) + 1
            seqs[sessionId] = next
            return next
        }

        private func deliver(_ message: [String: Any], after ms: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
                guard let app = self?.app,
                      let data = try? JSONSerialization.data(withJSONObject: message) else { return }
                app.messageRouter?.handleDataMessage(data)
            }
        }

        private func envelope(_ type: String, _ sessionId: String?, seq: Int = 0,
                              payload: [String: Any]) -> [String: Any] {
            var message: [String: Any] = [
                "type": type, "deviceId": IOSNewSessionScenario.deviceID,
                "timestamp": ISO8601.now(), "seq": seq, "payload": payload,
            ]
            if let sessionId { message["sessionId"] = sessionId }
            return message
        }

        func receive(_ message: [String: Any], target: String?) {
            let type = message["type"] as? String ?? ""
            let payload = message["payload"] as? [String: Any] ?? [:]
            let sessionId = message["sessionId"] as? String
            IOSNewSessionScenario.log("outbound type=\(type) session=\(sessionId ?? "-")")
            switch type {
            case "set_session_subscription":
                let requested = payload["sessionId"] as? String
                if let requested { subscribedSessions.insert(requested) }
                deliver(envelope("session_subscription_set", nil, payload: [
                    "accepted": true, "sessionId": requested as Any,
                ]), after: 40)
            case "create_session":
                let newId = "scenario-\(UUID().uuidString.prefix(8).lowercased())"
                let requestId = payload["requestId"] as? String ?? ""
                deliver(envelope("session_created", newId, seq: nextSeq(newId), payload: [
                    "agent": "pi", "model": "scenario-model", "requestId": requestId, "lastSeq": 0,
                ]), after: createDelayMs)
                deliver(envelope("idle", newId, seq: nextSeq(newId), payload: [:]), after: createDelayMs + 20)
            case "send_input":
                guard let sessionId else { return }
                let text = payload["text"] as? String ?? ""
                let clientId = payload["clientId"] as? String ?? UUID().uuidString
                deliver(envelope("user_message", sessionId, seq: nextSeq(sessionId), payload: [
                    "content": text, "clientId": clientId,
                ]), after: 300)
                deliver(envelope("active", sessionId, seq: 0, payload: [:]), after: 320)
                let answer = IOSNewSessionScenario.answer
                let chars = Array(answer)
                var delay = 700
                var cursor = 0
                while cursor < chars.count {
                    let end = min(cursor + 10, chars.count)
                    deliver(envelope("agent_message_delta", sessionId, payload: [
                        "content": String(chars[cursor..<end]), "reset": false,
                    ]), after: delay)
                    cursor = end
                    delay += 35
                }
                deliver(envelope("agent_message", sessionId, seq: nextSeq(sessionId), payload: [
                    "content": answer,
                ]), after: delay + 300)
                deliver(envelope("idle", sessionId, seq: nextSeq(sessionId), payload: [:]), after: delay + 320)
            default:
                break
            }
        }
    }

    static let answer: String = {
        let zh = "好的，我先确认一下需求：你希望新建会话之后，第一条消息从输入框发出，界面立即显示并回到底部，AI 的回复紧接着出现在下面。"
        let list = "我会按这个顺序检查：\n\n1. 占位页切换到真实会话\n2. 第一条消息的位置\n3. 流式回复时的滚动\n4. 返回会话列表"
        let table = "| 阶段 | 期望 |\n|---|---|\n| 创建 | 立即进入 |\n| 发送 | 回到底部 |\n| 返回 | 列表顶部是新会话 |"
        return [zh, list, table, zh, list, zh, table, list, zh].joined(separator: "\n\n")
    }()
}

struct IOSNewSessionScenarioView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        MainTabView(allowsInitialNavigation: true)
            .task { await run() }
    }

    private func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

    private var window: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow }
    }

    private func find<T: UIView>(_ type: T.Type, in view: UIView?) -> [T] {
        guard let view else { return [] }
        return ([view as? T].compactMap { $0 }) + view.subviews.flatMap { find(type, in: $0) }
    }

    private func navigationController(in vc: UIViewController?) -> UINavigationController? {
        guard let vc else { return nil }
        if let nav = vc as? UINavigationController, nav.viewControllers.count > 0 { return nav }
        for child in vc.children { if let found = navigationController(in: child) { return found } }
        return navigationController(in: vc.presentedViewController)
    }

    private func effectivelyVisible(_ view: UIView) -> Bool {
        var current: UIView? = view
        while let v = current {
            if v.isHidden || v.alpha < 0.01 { return false }
            current = v.superview
        }
        return view.window != nil
    }

    private func logAllChats(_ label: String) {
        let chats = find(UICollectionView.self, in: window).filter { $0.delegate is ChatPerfListVC }
        for (index, chat) in chats.enumerated() {
            let frame = chat.convert(chat.bounds, to: nil)
            let vc = chat.delegate as? ChatPerfListVC
            let cells = chat.visibleCells.compactMap { $0 as? TKBubbleCell }.map { c -> String in
                let f = c.convert(c.bounds, to: nil)
                let pres = c.layer.presentation()?.opacity ?? -1
                return "\(c.contentSnapshot?.message.type ?? "?") y=\(Int(f.minY))..\(Int(f.maxY)) a=\(c.alpha) pres=\(pres) hid=\(c.isHidden) bubble=\(c.bubbleFrameForRegression.integral) bubHid=\(c.bubbleHiddenForRegression) anims=\(c.layer.animationKeys() ?? [])"
            }
            IOSNewSessionScenario.log("\(label) chat#\(index) vc=\(vc.map { String(describing: ObjectIdentifier($0)) } ?? "-") visible=\(effectivelyVisible(chat)) frame=\(Int(frame.minY))..\(Int(frame.maxY)) items=\(chat.numberOfItems(inSection: 0)) cells=\(cells)")
        }
    }

    private func tabBarController(in vc: UIViewController?) -> UITabBarController? {
        guard let vc else { return nil }
        if let tab = vc as? UITabBarController { return tab }
        for child in vc.children { if let found = tabBarController(in: child) { return found } }
        return nil
    }

    private var tabBarHidden: Bool {
        guard let tab = tabBarController(in: window?.rootViewController) else { return true }
        if #available(iOS 26.0, *) { return tab.isTabBarHidden }
        return tab.tabBar.isHidden
    }

    private func logGeometry(_ label: String) {
        logAllChats(label)
        let nav = navigationController(in: window?.rootViewController)
        let stack = nav?.viewControllers.count ?? -1
        let chat = find(UICollectionView.self, in: window).first { $0.window != nil && $0.delegate is ChatPerfListVC }
        guard let chat else {
            IOSNewSessionScenario.log("\(label) navStack=\(stack) chat=none")
            return
        }
        let origin = chat.convert(CGPoint.zero, to: nil)
        let cells = chat.visibleCells.compactMap { $0 as? TKBubbleCell }
            .sorted { $0.frame.minY < $1.frame.minY }
            .map { cell -> String in
                let top = cell.convert(CGPoint.zero, to: nil).y
                return "\(cell.contentSnapshot?.message.type ?? "?")@\(Int(top))h\(Int(cell.frame.height))"
            }
        let header = chat.collectionViewLayout.layoutAttributesForSupplementaryView(
            ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: 0))?.frame.height ?? 0
        let footer = chat.collectionViewLayout.layoutAttributesForSupplementaryView(
            ofKind: UICollectionView.elementKindSectionFooter, at: IndexPath(item: 0, section: 0))?.frame.height ?? 0
        let navBottom = nav?.navigationBar.convert(CGPoint(x: 0, y: nav?.navigationBar.bounds.maxY ?? 0), to: nil).y ?? -1
        IOSNewSessionScenario.log(
            "\(label) spinnerTop=\(Int(header)) spinnerBottom=\(Int(footer)) navStack=\(stack) navBarBottom=\(Int(navBottom)) cvOriginY=\(Int(origin.y)) "
                + "offset=\(Int(chat.contentOffset.y)) adjTop=\(Int(chat.adjustedContentInset.top)) "
                + "adjBottom=\(Int(chat.adjustedContentInset.bottom)) content=\(Int(chat.contentSize.height)) "
                + "bounds=\(Int(chat.bounds.height)) cells=\(cells.joined(separator: ","))")
    }

    private func run() async {
        guard IOSNewSessionScenario.forceAutorun
                || ProcessInfo.processInfo.environment["KRAKI_IOS_NEW_SESSION_AUTORUN"] == "1" else { return }
        IOSNewSessionScenario.finished = false
        defer { IOSNewSessionScenario.finished = true }
        appState.connectionStatus = .connected
        appState.sessionSubscriptionController.onSessionList(tentacleId: IOSNewSessionScenario.deviceID)
        await pause(1_500)
        IOSNewSessionScenario.log("phase=create")
        appState.commandSender?.createSession(
            targetDeviceId: IOSNewSessionScenario.deviceID, agentId: "pi", model: "scenario-model")
        for ms in [150, 400, 900, 1_300] {
            await pause(ms == 150 ? 150 : 250)
            logGeometry("created+\(ms)")
        }
        await pause(900)
        logGeometry("empty-chat")
        guard let sessionId = appState.sessionStore.sessions.keys.first(where: { $0.hasPrefix("scenario-") }) else {
            IOSNewSessionScenario.log("FAILED no created session")
            return
        }
        let active = appState.sessionStore.activeSessionId
        let desired = appState.sessionSubscriptionController.desiredSessionId
        let subscribed = IOSNewSessionScenario.scriptedTentacle?.subscribedSessions.contains(sessionId) == true
        IOSNewSessionScenario.log("CHECK lifecycle active=\(active == sessionId ? "ok" : "BAD(\(active ?? "nil"))") desired=\(desired == sessionId ? "ok" : "BAD") subscribed=\(subscribed ? "ok" : "BAD") acceptsLive=\(appState.sessionSubscriptionController.acceptsLive(sessionId) ? "ok" : "BAD")")
        IOSNewSessionScenario.log("phase=send session=\(sessionId)")
        if appState.commandSender?.sendInput(sessionId: sessionId, text: "新会话的第一条消息：帮我检查一下这个流程") == true {
            NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil,
                                            userInfo: ["sessionId": sessionId])
        }
        var sawLive = false
        var dragged: (offset: CGFloat, step: Int)?
        for step in 0..<14 {
            await pause(step < 4 ? 120 : 400)
            logGeometry("send+\(step)")
            if appState.messageStore.cards[sessionId]?.text.isEmpty == false { sawLive = true }
            // Mid-stream, once the answer is taller than the screen, the user
            // drags up 240pt and lets go: the reading position must hold.
            if dragged == nil, step >= 6,
               let chat = find(UICollectionView.self, in: window).first(where: { $0.window != nil && $0.delegate is ChatPerfListVC }),
               let vc = chat.delegate as? ChatPerfListVC,
               chat.contentSize.height > chat.bounds.height {
                vc.scrollViewWillBeginDragging(chat)
                vc.automationMarkUserScrolledAway()
                for _ in 0..<8 {
                    chat.contentOffset.y -= 30
                    vc.scrollViewDidScroll(chat)
                    await pause(16)
                }
                vc.scrollViewDidEndDragging(chat, willDecelerate: false)
                dragged = (chat.contentOffset.y, step)
                IOSNewSessionScenario.log("user-drag offset=\(Int(chat.contentOffset.y))")
            }
        }
        if let dragged, let chat = find(UICollectionView.self, in: window).first(where: { $0.window != nil && $0.delegate is ChatPerfListVC }) {
            IOSNewSessionScenario.log("CHECK drag-holds \(abs(chat.contentOffset.y - dragged.offset) <= 2 ? "ok" : "BAD(\(Int(dragged.offset))→\(Int(chat.contentOffset.y)))")")
        }
        IOSNewSessionScenario.log("CHECK streaming \(sawLive ? "ok" : "BAD(no live card)")")
        IOSNewSessionScenario.log("CHECK tab-bar-in-chat \(tabBarHidden ? "ok" : "BAD(visible over composer)")")
        await pause(2_500)
        logGeometry("landed")
        IOSNewSessionScenario.log("phase=scroll-up")
        if let chat = find(UICollectionView.self, in: window).first(where: { $0.window != nil && $0.delegate is ChatPerfListVC }) {
            chat.setContentOffset(CGPoint(x: 0, y: -chat.adjustedContentInset.top), animated: true)
            await pause(900)
            logGeometry("scrolled-top")
            chat.setContentOffset(CGPoint(x: 0, y: max(-chat.adjustedContentInset.top,
                chat.contentSize.height - chat.bounds.height + chat.adjustedContentInset.bottom)), animated: true)
            await pause(900)
            logGeometry("scrolled-bottom")
        }
        IOSNewSessionScenario.log("phase=back")
        navigationController(in: window?.rootViewController)?.popViewController(animated: true)
        for step in 0..<6 {
            await pause(250)
            let nav = navigationController(in: window?.rootViewController)
            let firstRow = appState.sessionStore.sortedSessions.first?.id ?? "-"
            IOSNewSessionScenario.log("back+\(step) navStack=\(nav?.viewControllers.count ?? -1) firstRow=\(firstRow) active=\(appState.sessionStore.activeSessionId ?? "nil") pending=\(appState.sessionStore.pendingSessions.count)")
        }
        IOSNewSessionScenario.log("CHECK back active=\(appState.sessionStore.activeSessionId == nil ? "ok" : "BAD") unread=\(appState.sessionStore.isUnread(sessionId) ? "BAD" : "ok") firstRow=\(appState.sessionStore.sortedSessions.first?.id == sessionId ? "ok" : "BAD")")

        // Back out of "Starting session…" before creation resolves: the new
        // Session must appear in the list without pulling the user back in.
        IOSNewSessionScenario.log("phase=create-and-leave")
        IOSNewSessionScenario.scriptedTentacle?.createDelayMs = 2_000
        appState.commandSender?.createSession(
            targetDeviceId: IOSNewSessionScenario.deviceID, agentId: "pi", model: "scenario-model")
        await pause(800)
        IOSNewSessionScenario.log("leave-placeholder stackBefore=\(navigationController(in: window?.rootViewController)?.viewControllers.count ?? -1)")
        navigationController(in: window?.rootViewController)?.popViewController(animated: true)
        await pause(2_500)
        let stack = navigationController(in: window?.rootViewController)?.viewControllers.count ?? -1
        IOSNewSessionScenario.log("CHECK left-placeholder navStack=\(stack == 1 ? "ok" : "BAD(\(stack))") sessions=\(appState.sessionStore.sessions.keys.filter { $0.hasPrefix("scenario-") }.count)")
        // Programmatic navigation: notification-style jump (resets the path)
        // from the list, then again from inside a chat, then the
        // "Session deleted while viewing" pop to the list.
        appState.sessionStore.navigateToSession = "existing-0"
        await pause(1_200)
        let hiddenAfterJump = tabBarHidden
        appState.sessionStore.navigateToSession = "existing-1"
        await pause(1_200)
        let hiddenAfterChatToChat = tabBarHidden
        appState.sessionStore.popToSessionListSignal &+= 1
        await pause(1_200)
        IOSNewSessionScenario.log("CHECK programmatic-nav jump=\(hiddenAfterJump ? "ok" : "BAD") chatToChat=\(hiddenAfterChatToChat ? "ok" : "BAD") popToList=\(tabBarHidden ? "BAD(hidden on list)" : "ok")")
        IOSNewSessionScenario.log("phase=done")
    }
}
#endif
