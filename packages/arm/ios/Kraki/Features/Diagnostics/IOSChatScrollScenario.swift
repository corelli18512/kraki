#if os(iOS) && DEBUG
import SwiftUI
import UIKit

/// Visible, isolated Debug fixture for hands-on validation of the production
/// UIKit/TextKit Chat scroll surface. The fixture owns a temporary SQLite
/// database and never constructs the production networking/auth graph.
@MainActor
enum IOSChatScrollScenarioFixture {
    static let sessionID = "ios-visible-scroll-scenario"
    static let deviceID = "ios-visible-scroll-device"
    static let totalMessages = 240

    static func makeAppState() -> AppState {
        do {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("kraki-ios-visible-scroll-\(UUID().uuidString)", isDirectory: true)
            let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
            // Realistic mixed content: uniform English prose is the one shape
            // whose estimated height is already exact, so it cannot reveal
            // estimate→exact jumps. Mix CJK prose, code, lists and tables.
            let zh = "\u{597D}\u{7684}\u{FF0C}\u{6211}\u{6765}\u{68C0}\u{67E5}\u{4E00}\u{4E0B}\u{8FD9}\u{4E2A}\u{95EE}\u{9898}\u{3002}\u{9996}\u{5148}\u{786E}\u{8BA4}\u{670D}\u{52A1}\u{7AEF}\u{914D}\u{7F6E}\u{FF0C}\u{518D}\u{770B}\u{5BA2}\u{6237}\u{7AEF}\u{8BF7}\u{6C42}\u{662F}\u{5426}\u{5E26}\u{4E0A}\u{4E86}\u{6B63}\u{786E}\u{7684}\u{9274}\u{6743}\u{5934}\u{FF1B}\u{4E24}\u{8FB9}\u{90FD}\u{6CA1}\u{95EE}\u{9898}\u{7684}\u{8BDD}\u{FF0C}\u{591A}\u{534A}\u{662F}\u{7F13}\u{5B58}\u{5BFC}\u{81F4}\u{7684}\u{3002}"
            let code = "\u{4FEE}\u{6539}\u{5982}\u{4E0B}\u{FF1A}\n\n```swift\nfunc load() async throws {\n    let data = try await api.fetch()\n    cache.store(data)\n    try decode(data)\n}\n```\n\n\u{518D}\u{8DD1}\u{4E00}\u{6B21}\u{6D4B}\u{8BD5}\u{3002}"
            let list = "\u{6539}\u{52A8}\u{FF1A}\n\n1. \u{4FEE}\u{590D}\u{767B}\u{5F55}\u{6001}\n2. \u{4F18}\u{5316}\u{6EDA}\u{52A8}\n3. \u{65B0}\u{589E}\u{91CD}\u{8BD5}\n\n- \u{98CE}\u{9669}\u{FF1A}\u{4F4E}\n- \u{9700}\u{8981}\u{56DE}\u{5F52}\u{FF1A}\u{662F}"
            let table = "| \u{6307}\u{6807} | \u{4E4B}\u{524D} | \u{4E4B}\u{540E} |\n|---|---|---|\n| \u{51B7}\u{542F}\u{52A8} | 1.8s | 0.9s |\n| \u{6389}\u{5E27} | 12% | 2% |"
            let shapes = [zh + "\n\n" + zh, code, list, table, zh + zh + zh]
            let messages = (1...totalMessages).map { seq in
                let content: String
                if seq == totalMessages {
                    content = (0..<6).map { _ in zh + "\n\n" + code + "\n\n" + list }.joined(separator: "\n\n")
                } else if seq.isMultiple(of: 2) {
                    content = "Message \(seq): " + shapes[(seq / 2) % shapes.count]
                } else {
                    content = "Message \(seq): \u{5E2E}\u{6211}\u{770B}\u{4E00}\u{4E0B}\u{4E3A}\u{4EC0}\u{4E48}\u{5F80}\u{4E0A}\u{7FFB}\u{5386}\u{53F2}\u{4F1A}\u{8DF3}"
                }
                return ChatMessage(
                    type: seq.isMultiple(of: 2) ? "agent_message" : "user_message",
                    seq: seq,
                    sessionId: sessionID,
                    deviceId: deviceID,
                    timestamp: "2026-08-30T00:00:00Z",
                    payload: ["content": AnyCodable(content)]
                )
            }
            try database.insert(sessionID, messages)

            let appState = AppState(testDatabase: database, loadPersistedState: false)
            appState.sessionStore.sessions[sessionID] = SessionInfo(
                id: sessionID,
                deviceId: deviceID,
                deviceName: "Visible Simulator Fixture",
                agent: "pi",
                model: "isolated-scroll-policy",
                title: "Visible Scroll Policy Gate",
                state: .idle,
                mode: .auto,
                lastSeq: totalMessages,
                readSeq: totalMessages,
                messageCount: totalMessages,
                createdAt: Date(),
                pinned: false
            )
            appState.deviceStore.devices[deviceID] = DeviceSummary(
                id: deviceID,
                name: "Visible Simulator Fixture",
                role: .tentacle,
                kind: .desktop,
                publicKey: nil,
                encryptionKey: nil,
                online: false,
                lastSeen: nil,
                createdAt: nil
            )
            appState.messageProvider?.setTentacleInfo(
                sessionId: sessionID,
                lastSeq: totalMessages,
                deviceId: deviceID
            )
            _ = appState.messageStore.loadInitialWindow(sessionID)
            return appState
        } catch {
            fatalError("Unable to create visible iOS scroll fixture: \(error)")
        }
    }
}

@MainActor
@Observable
private final class IOSVisibleScrollScenarioRunner {
    private(set) var status = "Ready for touch or visible automatic gate"
    private(set) var passedCount = 0
    private(set) var testCount = 0
    private(set) var finished = false

    private weak var viewController: ChatPerfListVC?
    private weak var appState: AppState?
    private var started = false

    func attach(viewController: ChatPerfListVC, appState: AppState) {
        self.viewController = viewController
        self.appState = appState
        guard ProcessInfo.processInfo.environment["KRAKI_IOS_VISIBLE_SCROLL_AUTORUN"] == "1",
              !started else { return }
        started = true
        Task { await run() }
    }

    private func record(_ name: String, _ passed: Bool) {
        testCount += 1
        if passed { passedCount += 1 }
        NSLog("[ios-visible-scroll] \(name) passed=\(passed ? 1 : 0) total=\(passedCount)/\(testCount)")
    }

    private func pause(_ milliseconds: Int) async {
        try? await Task.sleep(for: .milliseconds(milliseconds))
    }

    private func collectionView(in view: UIView) -> UICollectionView? {
        if let collectionView = view as? UICollectionView { return collectionView }
        for child in view.subviews {
            if let collectionView = collectionView(in: child) { return collectionView }
        }
        return nil
    }

    private func buttons(in view: UIView) -> [UIButton] {
        var result: [UIButton] = []
        if let button = view as? UIButton { result.append(button) }
        for child in view.subviews { result.append(contentsOf: buttons(in: child)) }
        return result
    }

    private func distanceToBottom(_ collectionView: UICollectionView) -> CGFloat {
        collectionView.contentSize.height
            + collectionView.adjustedContentInset.bottom
            - collectionView.bounds.height
            - collectionView.contentOffset.y
    }

    private func maximumOffset(_ collectionView: UICollectionView) -> CGFloat {
        max(
            -collectionView.adjustedContentInset.top,
            collectionView.contentSize.height
                - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom
        )
    }

    private func topSeq() -> Int {
        appState?.messageStore.windowState(IOSChatScrollScenarioFixture.sessionID)?.topSeq ?? 0
    }

    private func run() async {
        await pause(1_200)
        guard let viewController,
              let collectionView = collectionView(in: viewController.view) else {
            status = "FAILED · production UICollectionView not mounted"
            finished = true
            return
        }
        collectionView.layoutIfNeeded()

        status = "1/6 · Entry lock at live tail"
        record("entry-tail-lock", abs(distanceToBottom(collectionView)) <= 1.5)
        await pause(650)

        status = "2/6 · First 12pt upward intent + late Composer inset"
        let entryMaximum = maximumOffset(collectionView)
        viewController.automationMarkUserScrolledAway()
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: entryMaximum - 12),
            animated: false
        )
        collectionView.layoutIfNeeded()
        let beforeInset = collectionView.contentOffset.y
        viewController.updateBottomContentInset(86)
        collectionView.layoutIfNeeded()
        record(
            "first-upward-intent-survives-late-inset",
            abs(collectionView.contentOffset.y - beforeInset) <= 1
                && distanceToBottom(collectionView) > 24
        )
        await pause(900)

        status = "3/6 · Tail navigation animation"
        viewController.updateBottomContentInset(24)
        collectionView.layoutIfNeeded()
        let tailButton = buttons(in: viewController.view)
            .first { $0.accessibilityLabel == "Jump to latest" }
        tailButton?.sendActions(for: .touchUpInside)
        await pause(1_500)
        collectionView.layoutIfNeeded()
        record(
            "tail-navigation",
            tailButton != nil && abs(distanceToBottom(collectionView)) <= 1.5
        )

        status = "4/6 · Latest-message start navigation"
        let startButton = buttons(in: viewController.view)
            .first { $0.accessibilityLabel == "Jump to previous reply start" }
        startButton?.sendActions(for: .touchUpInside)
        await pause(1_500)
        collectionView.layoutIfNeeded()
        record(
            "latest-message-start-navigation",
            startButton != nil && distanceToBottom(collectionView) > 100
        )
        await pause(550)

        status = "5/6 · One older page in one continuous gesture"
        let tailAfterStart = buttons(in: viewController.view)
            .first { $0.accessibilityLabel == "Jump to latest" }
        tailAfterStart?.sendActions(for: .touchUpInside)
        await pause(1_500)
        let initialTop = topSeq()
        let minimumOffset = -collectionView.adjustedContentInset.top
        viewController.automationMarkUserScrolledAway()
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: minimumOffset),
            animated: true
        )
        await pause(1_800)
        collectionView.layoutIfNeeded()
        let firstRequestTop = topSeq()
        for _ in 0..<5 {
            viewController.scrollViewDidScroll(collectionView)
            await pause(220)
        }
        let sameGestureTop = topSeq()
        record(
            "one-older-page-per-continuous-gesture",
            firstRequestTop < initialTop && sameGestureTop == firstRequestTop
        )

        status = "6/6 · Next settled gesture re-arms older paging"
        viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        viewController.automationMarkUserScrolledAway()
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: minimumOffset),
            animated: true
        )
        await pause(1_000)
        viewController.scrollViewDidEndDragging(collectionView, willDecelerate: false)
        await pause(1_800)
        collectionView.layoutIfNeeded()
        record("next-gesture-rearms-older-paging", topSeq() < sameGestureTop)

        finished = true
        status = passedCount == testCount
            ? "PASSED · \(passedCount)/\(testCount) visible production-scroll checks"
            : "FAILED · \(passedCount)/\(testCount) visible production-scroll checks"
        NSLog("[ios-visible-scroll] finished passed=\(passedCount == testCount ? 1 : 0) total=\(passedCount)/\(testCount)")
    }
}

private struct IOSVisibleScrollScenarioHost: UIViewControllerRepresentable {
    let runner: IOSVisibleScrollScenarioRunner
    @Environment(AppState.self) private var appState

    func makeUIViewController(context: Context) -> ChatPerfListVC {
        let viewController = ChatPerfListVC(
            sessionId: IOSChatScrollScenarioFixture.sessionID,
            appState: appState,
            agent: "pi",
            bottomContentInset: 24
        )
        DispatchQueue.main.async {
            runner.attach(viewController: viewController, appState: appState)
        }
        return viewController
    }

    func updateUIViewController(_ viewController: ChatPerfListVC, context: Context) {
        viewController.syncLiveUpdates()
    }
}

struct IOSChatScrollScenarioView: View {
    @State private var runner = IOSVisibleScrollScenarioRunner()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: runner.finished && runner.passedCount == runner.testCount
                    ? "checkmark.shield.fill"
                    : "gearshape.2.fill")
                    .foregroundStyle(runner.finished ? .green : .orange)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Visible Scroll Policy Gate")
                        .font(.subheadline.weight(.semibold))
                    Text(runner.status)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Text("\(runner.passedCount)/\(runner.testCount)")
                    .font(.caption.monospacedDigit().weight(.bold))
                    .foregroundStyle(Color.textSecondary)
            }
            .padding(.horizontal, 14)
            .frame(height: 58)
            .background(Color.surfaceSecondary)

            IOSVisibleScrollScenarioHost(runner: runner)
        }
        .background(Color.surfacePrimary)
        .accessibilityIdentifier("ios.visibleScrollScenario")
    }
}
#endif
