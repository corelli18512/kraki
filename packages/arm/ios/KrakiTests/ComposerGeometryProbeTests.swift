import XCTest
import SwiftUI
#if os(macOS)
import AppKit
@testable import Kraki_Dev
#else
import UIKit
@testable import Kraki
#endif

/// Real production ChatView, isolated store and synthetic speech. No credentials,
/// network or microphone. Geometry assertions are also backed by native captures.
@MainActor final class ComposerGeometryProbeTests: XCTestCase {
    func testClearanceBalancesVisibleGapsWithoutDoubleCountingCellPadding() {
        for (capsule, padding): (CGFloat, CGFloat) in [(48, 6), (36, 12)] {
            let clearance = ChatBottomObstruction.composerClearance(
                capsuleHeight: capsule, bottomPadding: padding, bubbleBottomPadding: 6)
            XCTAssertEqual(clearance, 54)
            for safeArea: CGFloat in [0, 21, 34] {
                let capsuleBottom = 852 - safeArea - padding
                let bubbleBottom = 852 - safeArea - clearance - 6
                XCTAssertEqual(capsuleBottom - capsule - bubbleBottom, padding)
            }
        }
    }

    func testStatusClearanceRemainsIndependentOfFloatingExpansion() {
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: 54, composerVisible: true, compacting: false), 54)
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: 54, composerVisible: true, compacting: true), 102)
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: 54, composerVisible: false, compacting: true), 40)
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: 54, composerVisible: false, compacting: false), 0)
    }

    func testRecordingAndMultilineComposerLeaveTailInPlace() throws {
        try runScenario(readingHistory: false)
    }

    func testRecordingLeavesHistoryInPlace() throws {
        try runScenario(readingHistory: true)
    }

    private func runScenario(readingHistory: Bool) throws {
        try requireForegroundUITests()
        let app = IOSVoiceHoldScenarioFixture.makeAppState()
        let sid = "voice-a", dev = "voice-test-device"
        app.testOutboundMessageHandler = { _, _, _ in true }
        let messages = (1...40).map { seq in
            ChatMessage(type: seq % 2 == 0 ? "agent_message" : "user_message", seq: seq,
                        sessionId: sid, deviceId: dev, timestamp: "2026-10-04T08:00:00Z",
                        payload: ["content": AnyCodable(seq == 40 ? "This is the last bubble. Keep its position stable when recording starts." : "Message \(seq). The conversation stays in place while voice input floats above it.")])
        }
        app.sessionStore.sessions[sid]?.lastSeq = 40
        app.sessionStore.sessions[sid]?.readSeq = 40
        app.sessionStore.sessions[sid]?.messageCount = 40
        app.messageProvider?.setTentacleInfo(sessionId: sid, lastSeq: 40, deviceId: dev)
        app.messageProvider?.ingestTailCandidate(sid, messages)
        _ = app.messageProvider?.openSession(sid, reanchorLatest: true)
        let prefix = readingHistory ? "history-" : ""
        var anchorSequence: Int?
        func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
        #if os(macOS)
        let output = URL(fileURLWithPath: "/tmp/kraki-composer-geometry-review")
        let window = NSWindow(contentRect: CGRect(x: 60, y: 60, width: 820, height: 580),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.title = "Kraki composer geometry (isolated)"
        let vm = ChatViewModel(sessionId: sid, appState: app)
        vm.refreshMessageCache()
        let host = NSHostingView(rootView: MacChatView(sessionId: sid, prebuiltViewModel: vm).environment(app))
        window.contentView = host
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        defer {
            app.iosVoiceComposer.retireKeepingDraft(); app.voiceInputController.forgetLease()
            window.orderOut(nil); window.contentView = nil
        }
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        func normalized(_ rect: CGRect) -> CGRect {
            host.isFlipped ? rect : CGRect(x: rect.minX, y: host.bounds.height - rect.maxY, width: rect.width, height: rect.height)
        }
        func scrollIntoHistory() throws {
            let scroll = try XCTUnwrap(all(host).compactMap { $0 as? MacChatScrollView }.first)
            let movement = scroll.automationPreciseScrollPacket(deltaY: 180)
            XCTAssertGreaterThan(movement.before - movement.after, 100)
        }
        func snapshot(_ label: String) throws -> [String: Any] {
            host.layoutSubtreeIfNeeded()
            let scroll = try XCTUnwrap(all(host).compactMap { $0 as? MacChatScrollView }.first)
            let cells = all(scroll).compactMap { $0 as? MacChatBubbleCell }.filter { !$0.isHidden && $0.frame.height > 1 }
            let anchor: MacChatBubbleCell?
            if let seq = anchorSequence {
                anchor = cells.first { $0.content?.seq == seq }
            } else {
                // Warmed/retained cells may live beyond the viewport. Select a
                // visible anchor once, then compare the SAME message in every phase.
                anchor = cells.filter {
                    let rect = normalized($0.convert($0.bubbleFrameForRegression, to: host))
                    return rect.minY >= 0 && rect.maxY <= host.bounds.height
                }.max { $0.frame.maxY < $1.frame.maxY }
            }
            let last = try XCTUnwrap(anchor)
            anchorSequence = try XCTUnwrap(last.content).seq
            let bubble = normalized(last.convert(last.bubbleFrameForRegression, to: host))
            let inputView: NSView? = app.iosVoiceComposer.isRecording
                ? all(host).compactMap { $0 as? MacComposerVoiceTranscriptView }.first
                : all(host).compactMap { $0 as? NSTextView }.first(where: \.isEditable)
            let input = try XCTUnwrap(inputView?.enclosingScrollView)
            let viewport = normalized(input.convert(input.bounds, to: host))
            let capsule = viewport.insetBy(dx: 0, dy: -MacComposerMetrics.textVerticalPadding)
            let row: [String: Any] = ["phase": label, "windowHeight": host.bounds.height,
                "viewportHeight": scroll.contentView.bounds.height, "scrollY": scroll.contentView.bounds.minY,
                "documentHeight": scroll.chatDocumentView.frame.height,
                "bubbleTop": bubble.minY, "bubbleBottom": bubble.maxY,
                "capsuleTop": capsule.minY, "capsuleBottom": capsule.maxY, "capsuleHeight": capsule.height,
                "gapAbove": capsule.minY-bubble.maxY, "gapBelow": host.bounds.height-capsule.maxY,
                "bottomSafeArea": scroll.chatDocumentView.layoutDiagnostics(viewport: scroll.contentView.bounds)["bottomSafeArea"] ?? -1]
            if !readingHistory {
                let request: [String: Any] = ["window": window.windowNumber, "pid": ProcessInfo.processInfo.processIdentifier, "phase": label]
                try JSONSerialization.data(withJSONObject: request).write(to: output.appendingPathComponent("mac-capture-request.json"), options: .atomic)
                // Optional external runner captures ONLY this test window. Native
                // Liquid Glass needs WindowServer, not NSView.cacheDisplay().
                drain(0.5)
            }
            return row
        }
        #else
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("composer-geometry-review")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        let host = UIHostingController(rootView: ChatView(sessionId: sid).environment(app))
        window.rootViewController = host; window.makeKeyAndVisible()
        defer {
            app.iosVoiceComposer.retireKeepingDraft(); app.voiceInputController.forgetLease()
            window.isHidden = true; window.rootViewController = nil
        }
        func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
        func scrollIntoHistory() throws {
            let scroll = try XCTUnwrap(all(host.view).compactMap { $0 as? UICollectionView }.first)
            let controller = try XCTUnwrap(scroll.delegate as? ChatPerfListVC)
            controller.automationUserScrollActive = true
            controller.scrollViewWillBeginDragging(scroll)
            let before = scroll.contentOffset.y
            scroll.contentOffset.y -= 180
            controller.scrollViewDidScroll(scroll)
            controller.scrollViewDidEndDragging(scroll, willDecelerate: false)
            controller.automationUserScrollActive = false
            XCTAssertGreaterThan(before - scroll.contentOffset.y, 100)
        }
        func snapshot(_ label: String) throws -> [String: Any] {
            host.view.layoutIfNeeded()
            let scroll = try XCTUnwrap(all(host.view).compactMap { $0 as? UICollectionView }.first)
            let cells = scroll.visibleCells.compactMap { $0 as? TKBubbleCell }
            let anchor: TKBubbleCell?
            if let seq = anchorSequence {
                anchor = cells.first { $0.contentSnapshot?.message.seq == seq }
            } else {
                anchor = cells.filter {
                    let rect = $0.convert($0.bubbleFrameForRegression, to: window)
                    return rect.minY >= 0 && rect.maxY <= window.bounds.height
                }.max { $0.frame.maxY < $1.frame.maxY }
            }
            let last = try XCTUnwrap(anchor)
            anchorSequence = try XCTUnwrap(last.contentSnapshot).message.seq
            let bubble = last.convert(last.bubbleFrameForRegression, to: window)
            let viewport = scroll.convert(scroll.bounds, to: window)
            let row: [String: Any] = ["phase": label, "windowHeight": window.bounds.height,
                "viewportTop": viewport.minY, "viewportBottom": viewport.maxY, "viewportHeight": viewport.height,
                "scrollY": scroll.contentOffset.y, "contentHeight": scroll.contentSize.height,
                "bubbleTop": bubble.minY, "bubbleBottom": bubble.maxY,
                "contentInsetBottom": scroll.contentInset.bottom, "adjustedInsetBottom": scroll.adjustedContentInset.bottom,
                "windowSafeBottom": window.safeAreaInsets.bottom]
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try image.pngData()!.write(to: output.appendingPathComponent("ios-\(prefix)\(label).png"))
            return row
        }
        #endif
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        drain(1.5)
        if readingHistory { try scrollIntoHistory(); drain(0.9) }
        #if os(iOS)
        // CI's first native render can outlast a fixed sleep. Finish actual
        // production height warming before taking the scroll/content baseline;
        // keep every assertion for the recording phases unchanged.
        let list = try XCTUnwrap(all(host.view).compactMap { $0 as? UICollectionView }.first)
        let controller = try XCTUnwrap(list.delegate as? ChatPerfListVC)
        let deadline = Date().addingTimeInterval(15)
        while !controller.automationHeightMeasurementsSettled && Date() < deadline { drain(0.05) }
        XCTAssertTrue(controller.automationHeightMeasurementsSettled, "initial exact-height layout must finish before the voice experiment")
        host.view.layoutIfNeeded()
        #endif
        var rows: [[String: Any]] = []
        rows.append(try snapshot("idle"))
        app.iosVoiceComposer.begin(sessionID: sid, selection: nil, context: .init(fields: [:], vocabulary: []))
        drain(0.9)
        XCTAssertTrue(app.iosVoiceComposer.isRecording)
        rows.append(try snapshot("recording-short"))
        let longText = String(repeating: "A longer live transcript should cover the chat rather than move its bubbles. ", count: 10)
        app.voiceInputController.debugApplyPartial(longText)
        drain(0.9)
        rows.append(try snapshot("recording-long"))
        app.iosVoiceComposer.cancel()
        drain(0.9)
        rows.append(try snapshot("cancelled"))
        app.sessionStore.setDraft(sid, longText)
        drain(0.6)
        rows.append(try snapshot("multiline-draft"))

        let baseline = rows[0]
        for row in rows.dropFirst() {
            for key in ["viewportHeight", "bubbleTop", "bubbleBottom", "scrollY"] {
                XCTAssertEqual(try XCTUnwrap(row[key] as? CGFloat), try XCTUnwrap(baseline[key] as? CGFloat),
                               accuracy: 0.5, "\(prefix)\(row["phase"]!): \(key) must not follow floating composer growth")
            }
        }
        #if os(macOS)
        let platform = "mac"
        for row in rows {
            XCTAssertEqual(try XCTUnwrap(row["capsuleBottom"] as? CGFloat), 568, accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(row["documentHeight"] as? CGFloat), try XCTUnwrap(baseline["documentHeight"] as? CGFloat), accuracy: 0.5)
        }
        if !readingHistory {
            XCTAssertEqual(try XCTUnwrap(baseline["gapAbove"] as? CGFloat), 12, accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(baseline["gapBelow"] as? CGFloat), 12, accuracy: 0.5)
            XCTAssertLessThan(try XCTUnwrap(rows[2]["gapAbove"] as? CGFloat), 0, "long transcript overlaps the tail instead of reserving empty space")
        }
        #else
        let platform = "ios"
        for row in rows {
            XCTAssertEqual(try XCTUnwrap(row["contentInsetBottom"] as? CGFloat), 54, accuracy: 0.5)
            XCTAssertEqual(try XCTUnwrap(row["contentHeight"] as? CGFloat), try XCTUnwrap(baseline["contentHeight"] as? CGFloat), accuracy: 0.5)
        }
        if !readingHistory {
            let restingCapsuleTop = window.bounds.height - window.safeAreaInsets.bottom - IOSComposerMetrics.verticalPadding - IOSComposerMetrics.height
            XCTAssertEqual(restingCapsuleTop - (try XCTUnwrap(baseline["bubbleBottom"] as? CGFloat)), 6, accuracy: 0.5)
        }
        #endif
        try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("\(platform)-\(prefix)geometry.json"))
        print("COMPOSER_GEOMETRY \(platform) \(prefix): \(rows)")
    }
}
