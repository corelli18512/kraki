import XCTest
import SwiftUI
import QuartzCore
#if os(macOS)
import AppKit
@testable import Kraki_Dev

/// WindowServer occlusion depends on screen lock / the human's active Space.
/// Control that OS input only; attachment, clipping and NSView layout stay real.
@MainActor private final class GlyphTestWindow: NSWindow {
    var simulatedOcclusion: NSWindow.OcclusionState = .visible
    override var occlusionState: NSWindow.OcclusionState { simulatedOcclusion }
}
#else
import UIKit
@testable import Kraki
#endif

@MainActor final class SessionPreviewGlyphTests: XCTestCase {
    private let sid = "preview-status"
    private var session: SessionInfo {
        SessionInfo(id: sid, deviceId: "device", deviceName: "Mac", agent: "pi", model: "model",
                    title: "Preview", state: .idle, mode: .auto, lastSeq: 4, readSeq: 2,
                    messageCount: 4, createdAt: Date(), pinned: false)
    }
    private func pending(_ id: String, _ state: String = "sending", order: Int = 1, text: String = "hello") -> ChatMessage {
        ChatMessage(type: "pending_input", seq: 0, sessionId: sid, deviceId: "device", timestamp: "2026-09-27T12:00:00.000Z",
                    payload: ["clientId": AnyCodable(id), "localOrder": AnyCodable(order), "localState": AnyCodable(state), "content": AnyCodable(text)])
    }
    private func project(_ inputs: [ChatMessage], online: Bool = true, draft: String? = nil, compacting: Bool = false) -> SessionCardProjection {
        SessionCardProjection.make(session: session, device: nil,
            preview: SessionPreview(text: "old assistant", type: "agent", timestamp: "2026-09-26T12:00:00.000Z"),
            draft: draft, isCompacting: compacting, pendingInputs: inputs, isDeliveryOnline: online)
    }

    func testOptimisticTextAndIconReplaceOldPreviewAtomically() {
        let p = project([pending("a", text: "new\n   input")])
        XCTAssertEqual(p.status, .delivery(.sending)); XCTAssertEqual(p.previewText, "new input")
        XCTAssertEqual(p.timestamp, "2026-09-27T12:00:00.000Z"); XCTAssertTrue(p.isUnread)
    }
    func testCorrectionOnlyForSentVoiceNotDraft() {
        let draft = project([], draft: "editing correction")
        XCTAssertEqual(draft.status, .humanMessage); XCTAssertTrue(draft.isDraft)
        let sent = project([pending("a", "correcting")], draft: "next draft")
        XCTAssertEqual(sent.status, .delivery(.correcting)); XCTAssertFalse(sent.isDraft)
        XCTAssertEqual(sent.previewText, "hello")
    }
    func testFailurePriorityAndNewestWithinPriorityRegardlessOfArrayOrder() {
        let inputs = [pending("old", "failed", order: 1), pending("new", order: 10), pending("failed-new", "failed", order: 3, text: "unconfirmed")]
        for rows in [inputs, inputs.reversed().map { $0 }] {
            let p = project(rows, draft: "draft")
            XCTAssertEqual(p.status, .delivery(.failed)); XCTAssertEqual(p.previewText, "Send failed · unconfirmed")
            XCTAssertFalse(p.isDraft)
        }
    }
    func testLatestPendingAndStableTieBreak() {
        XCTAssertEqual(SessionPendingPreview.select([pending("b"), pending("a")], sessionId: sid, isOnline: true)?.clientId, "b")
        XCTAssertEqual(SessionPendingPreview.select([pending("b", order: 1), pending("a", order: 2)], sessionId: sid, isOnline: true)?.clientId, "a")
    }
    func testOfflineQueuesSendingButDoesNotEraseFailureOrLocalCorrection() {
        XCTAssertEqual(project([pending("a")], online: false).status, .delivery(.queued))
        XCTAssertEqual(project([pending("a", "correcting")], online: false).status, .delivery(.correcting))
        XCTAssertEqual(project([pending("a", "failed")], online: false).status, .delivery(.failed))
        XCTAssertEqual(project([pending("a")], online: true).status, .delivery(.sending))
    }
    func testUnconfirmedIsNotFailureOrEndlessSendingIncludingWhileOffline() {
        for online in [true, false] {
            let p = project([pending("uncertain", "unconfirmed")], online: online)
            XCTAssertEqual(p.status, .delivery(.unconfirmed))
            XCTAssertEqual(p.previewText, "Awaiting confirmation · hello")
        }
        XCTAssertFalse(SessionPreviewGlyphKind.delivery(.unconfirmed).animates)
        XCTAssertEqual(SessionDeliveryStatus.unconfirmed.accessibilityLabel, "Awaiting delivery confirmation")
        XCTAssertEqual(project([pending("uncertain", "unconfirmed", order: 2), pending("failed", "failed")]).status, .delivery(.failed))
    }
    func testOtherSessionAndNonPendingRecordsNeverOverride() {
        let other = ChatMessage(type: "pending_input", seq: 0, sessionId: "other", deviceId: nil, timestamp: nil, payload: pending("a").payload)
        let echo = ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: nil, timestamp: nil, payload: pending("b").payload)
        XCTAssertEqual(project([other, echo]).status, .agentMessage)
    }
    func testEmptyAttachmentPreviewStillHasReadableContent() {
        var p = pending("a", text: "   "); p.payload["attachments"] = AnyCodable([["type": "image"]])
        XCTAssertEqual(project([p]).previewText, "[image]")
    }
    func testClearRevealsLiveCompactingOrDraftNotHardcodedHuman() {
        XCTAssertEqual(project([pending("a")], compacting: true).status, .delivery(.sending))
        XCTAssertEqual(project([], compacting: true).status, .compacting)
        XCTAssertEqual(project([], draft: "next").previewText, "next")
        XCTAssertEqual(project([]).status, .agentMessage)
    }

    func testRealOutboxVoiceFailureRetryAndLateAckIsolation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preview-outbox-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = session
        var payloads: [[String: Any]] = []
        app.testOutboundMessageHandler = { msg, _, _ in payloads.append(msg); return true }
        let sender = try XCTUnwrap(app.commandSender)
        let a = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "raw"))
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.correcting))
        XCTAssertTrue(payloads.isEmpty)
        sender.updateStagedInput(sessionId: sid, clientId: a, text: "corrected")
        XCTAssertEqual(project(sender.pendingInputs(sid)).previewText, "corrected")
        sender.failStagedInput(sessionId: sid, clientId: a, text: "raw")
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.failed))
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: a))
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.sending))
        let b = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "next voice"))
        sender.clearPending(sid, clientId: a)
        sender.clearPending(sid, clientId: a) // duplicate/late ACK cannot clear b
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.correcting))
        XCTAssertEqual(project(sender.pendingInputs(sid)).previewText, "next voice")
        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: b, text: "next corrected"))
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.sending))
        sender.clearPending(sid, clientId: b)
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .agentMessage)
        XCTAssertEqual(payloads.count, 2)
    }

    func testHistoryReplayConfirmsOnlyMatchingInputWithoutOpeningChat() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preview-replay-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = session
        let sender = try XCTUnwrap(app.commandSender)
        let a = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "old"))
        sender.failStagedInput(sessionId: sid, clientId: a, text: "old")
        let b = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "new"))
        let payload = ["clientId": AnyCodable(a), "content": AnyCodable("old")]
        sender.confirmPendingInputs(sid, messages: [
            ChatMessage(type: "user_message", seq: 1, sessionId: "other", deviceId: nil, timestamp: nil, payload: payload),
            ChatMessage(type: "agent_message", seq: 1, sessionId: sid, deviceId: nil, timestamp: nil, payload: payload)
        ])
        XCTAssertEqual(sender.pendingInputs(sid).count, 2)
        let echo = ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: nil, timestamp: nil, payload: payload)
        app.messageProvider?.handleBatch(sessionId: sid, messages: [echo], lastSeq: 1, totalLastSeq: 1, containsHead: true)
        XCTAssertEqual(sender.pendingInputs(sid).count, 1)
        XCTAssertEqual(sender.pendingInputs(sid).first?.payload["clientId"]?.stringValue, b)
        XCTAssertEqual(project(sender.pendingInputs(sid)).status, .delivery(.correcting))
        let nextEcho = ChatMessage(type: "user_message", seq: 2, sessionId: nil, deviceId: nil, timestamp: nil,
                                  payload: ["clientId": AnyCodable(b), "content": AnyCodable("new")])
        app.messageProvider?.ingestTailCandidate(sid, [nextEcho, echo])
        XCTAssertTrue(sender.pendingInputs(sid).isEmpty)
    }

    func testRestoredOutboxSkipsAlreadyCachedConfirmation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preview-restore-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        let app = AppState(testDatabase: db)
        let url = root.appendingPathComponent("outbox.json")
        let first = CommandSender(appState: app, outboxURL: url)
        func waitForPersistedCount(_ count: Int) {
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline {
                if let data = try? Data(contentsOf: url),
                   let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], rows.count == count { return }
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            XCTFail("Outbox fixture was not persisted")
        }
        let a = try XCTUnwrap(first.stageInput(sessionId: sid, text: "confirmed"))
        waitForPersistedCount(1)
        let b = try XCTUnwrap(first.stageInput(sessionId: sid, text: "unconfirmed"))
        waitForPersistedCount(2)
        let echo = ChatMessage(type: "user_message", seq: 1, sessionId: sid, deviceId: nil, timestamp: nil,
                              payload: ["clientId": AnyCodable(a), "content": AnyCodable("confirmed")])
        try db.insert(sid, [echo])
        XCTAssertTrue(db.hasConfirmedInput(sid, clientId: a))
        XCTAssertFalse(db.hasConfirmedInput("other", clientId: a))
        RunLoop.main.run(until: Date().addingTimeInterval(0.3)) // durable outbox writer is asynchronous
        let restored = CommandSender(appState: app, outboxURL: url)
        XCTAssertEqual(restored.pendingInputs(sid).count, 1)
        XCTAssertEqual(restored.pendingInputs(sid).first?.payload["clientId"]?.stringValue, b)
        XCTAssertEqual(project(restored.pendingInputs(sid)).status, .delivery(.failed))
    }

    func testB3AlignedGeometryAndOvershootStayInSlot() {
        let expectedScale = 0.98 * 0.80
        XCTAssertEqual(SessionStatusGlyphMetrics.agentSize, 15.6, accuracy: 0.0001)
        XCTAssertEqual(SessionStatusGlyphMetrics.humanSize, 14.3, accuracy: 0.0001)
        XCTAssertEqual(SessionStatusGlyphMetrics.approvalSize, 15.4, accuracy: 0.0001)
        XCTAssertEqual(SessionCompactingGeometry.scale, expectedScale, accuracy: 0.0001)
        let top = SessionCompactingGeometry.path(index: 0).boundingBoxOfPath
        for i in 1...2 {
            let path = SessionCompactingGeometry.path(index: i)
            XCTAssertEqual(path.boundingBoxOfPath.minX, top.minX, accuracy: 0.0001)
            XCTAssertEqual(path.boundingBoxOfPath.maxX, top.maxX, accuracy: 0.0001)
        }
        let layer = SessionPreviewGlyphLayer()
        layer.configure(kind: .compacting, color: CGColor(gray: 0.5, alpha: 1), image: nil, displayScale: 2, animate: false)
        let aspect = CGAffineTransform(translationX: 8, y: 8)
            .scaledBy(x: layer.sublayerTransform.m11, y: layer.sublayerTransform.m22)
            .translatedBy(x: -8, y: -8)
        for t in 0...2000 {
            let c = SessionCompactingGeometry.compression(Double(t)/2000)
            XCTAssertGreaterThanOrEqual(c, -0.1600001); XCTAssertLessThanOrEqual(c, 1.0000001)
            for i in 0..<3 {
                let bounds = layer.planes[i].path!.copy(strokingWithWidth: 1.05*expectedScale, lineCap: .round, lineJoin: .round, miterLimit: 10).boundingBoxOfPath
                let positioned = bounds.offsetBy(dx: 0, dy: CGFloat(i-1)*(3.6-1.75*c)*expectedScale)
                XCTAssertTrue(CGRect(x: 0, y: 0, width: 16, height: 16).contains(positioned.applying(aspect)))
            }
        }
        XCTAssertEqual(SessionCompactingGeometry.compression(0), 0)
        XCTAssertEqual(SessionCompactingGeometry.compression(1), 0)
        XCTAssertEqual(SessionCompactingGeometry.compression(0.4), 1)
        XCTAssertEqual(SessionCompactingGeometry.compression(0.73), -0.16, accuracy: 0.0001)
        XCTAssertEqual(layer.planes[0].lineWidth, 1.05*expectedScale, accuracy: 0.0001)
        XCTAssertEqual(layer.bounds, CGRect(x: 0, y: 0, width: 16, height: 16))
    }
    func testCompactingAnimationUsesSameScaleAsGeometry() throws {
        let layer = SessionPreviewGlyphLayer()
        layer.configure(kind: .compacting, color: CGColor(gray: 0.5, alpha: 1), image: nil, displayScale: 2, animate: true)
        for i in [0, 2] {
            let animation = try XCTUnwrap(layer.planes[i].animation(forKey: "compression") as? CAKeyframeAnimation)
            let values = try XCTUnwrap(animation.values as? [Double])
            XCTAssertEqual(animation.duration, 2)
            XCTAssertEqual(values.count, SessionCompactingGeometry.keyTimes.count)
            for (time, value) in zip(SessionCompactingGeometry.keyTimes, values) {
                let expected = Double(i-1)*(3.6-1.75*SessionCompactingGeometry.compression(time))*Double(SessionCompactingGeometry.scale)
                XCTAssertEqual(value, expected, accuracy: 0.000001)
            }
            XCTAssertEqual(layer.planes[i].transform.m42, CGFloat(i-1)*3.6*SessionCompactingGeometry.scale, accuracy: 0.000001)
        }
    }
    func testCompactingAspectScaleResetsForDeliveryReuse() {
        let layer = SessionPreviewGlyphLayer(), color = CGColor(gray: 0.5, alpha: 1)
        let expected = CGSize(width: 1.20, height: 1.10)
        XCTAssertEqual(SessionCompactingGeometry.aspectScale, expected)
        for animate in [false, true] {
            layer.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: animate)
            XCTAssertEqual(layer.sublayerTransform.m11, expected.width)
            XCTAssertEqual(layer.sublayerTransform.m22, expected.height)
            XCTAssertEqual(layer.anchorPoint, CGPoint(x: 0.5, y: 0.5))
            XCTAssertEqual(layer.bounds, CGRect(x: 0, y: 0, width: 16, height: 16))
            for status: SessionDeliveryStatus in [.sending, .correcting, .failed, .queued, .unconfirmed] {
                layer.configure(kind: .delivery(status), color: color, image: nil, displayScale: 2, animate: animate)
                XCTAssertTrue(CATransform3DIsIdentity(layer.sublayerTransform))
            }
        }
    }
    func testLayerIdentityAndPhaseSurviveThemeAndDisplayScaleChanges() throws {
        let layer = SessionPreviewGlyphLayer(), blue = CGColor(red: 0, green: 0, blue: 1, alpha: 1)
        layer.configure(kind: .compacting, color: blue, image: nil, displayScale: 2, animate: true)
        let plane = layer.planes[0], start = try XCTUnwrap(layer.planes[0].animation(forKey: "compression")).beginTime
        for _ in 0..<100 {
            layer.configure(kind: .compacting, color: CGColor(gray: 1, alpha: 1), image: nil, displayScale: 3, animate: true)
            XCTAssertTrue(layer.planes[0] === plane)
            XCTAssertEqual(plane.animation(forKey: "compression")?.beginTime, start)
        }
        XCTAssertNil(layer.planes[1].animationKeys())
    }
    func testOffscreenReduceMotionReuseAndFailureClearAllAnimations() {
        let layer = SessionPreviewGlyphLayer(), color = CGColor(gray: 0.5, alpha: 1)
        for kind: SessionPreviewGlyphKind in [.compacting, .delivery(.correcting), .delivery(.sending), .delivery(.unconfirmed), .delivery(.failed), .delivery(.queued)] {
            layer.configure(kind: kind, color: color, image: nil, displayScale: 2, animate: true)
            XCTAssertEqual(layer.isAnimating, kind.animates)
            layer.configure(kind: kind, color: color, image: nil, displayScale: 2, animate: false)
            XCTAssertFalse(layer.isAnimating)
            XCTAssertTrue(([layer.delivery] + layer.planes).allSatisfy { ($0.animationKeys() ?? []).isEmpty })
            layer.configure(kind: kind, color: color, image: nil, displayScale: 2, animate: true)
            XCTAssertEqual(layer.isAnimating, kind.animates)
        }
    }
    func testDeliveryUsesUpwardTrayMotionNotHorizontalPaperplane() throws {
        let layer = SessionPreviewGlyphLayer()
        layer.configure(kind: .delivery(.sending), color: CGColor(gray: 0, alpha: 1), image: nil, displayScale: 2, animate: true)
        let animation = try XCTUnwrap(layer.delivery.animation(forKey: "outgoing") as? CAKeyframeAnimation)
        XCTAssertEqual(animation.keyPath, "transform.translation.y")
        XCTAssertEqual(animation.duration, 1.3)
        let values = try XCTUnwrap(animation.values as? [Double])
        XCTAssertEqual(values.min() ?? 0, -0.65, accuracy: 0.0001)
    }
    func testProductionSessionRowObservesOutboxWithoutManualReconfiguration() throws {
        try requireForegroundUITests()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preview-row-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.sessionStore.sessions[sid] = session
        app.sessionStore.setPreview(sid, text: "previous reply", type: "agent")
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        let sender = try XCTUnwrap(app.commandSender)
        #if os(macOS)
        let host = NSHostingView(rootView: MacSidebarSessionRow(session: session, isSelected: false).environment(app))
        let window = NSWindow(contentRect: CGRect(x: 50, y: 50, width: 360, height: 130), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        let rootView: NSView = host
        #else
        let controller = UIHostingController(rootView: SessionTable(appState: app, deviceFilter: nil, onCellTapped: { _ in }))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller; window.makeKeyAndVisible()
        controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
        defer { window.isHidden = true; window.rootViewController = nil }
        let rootView = controller.view!
        #endif
        func hosts(_ view: PreviewPlatformView) -> [PreviewGlyphHost] {
            (view as? PreviewGlyphHost).map { [$0] } ?? view.subviews.flatMap { hosts($0) }
        }
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.5)) }
        func expect(_ kind: SessionPreviewGlyphKind, file: StaticString = #filePath, line: UInt = #line) {
            settle()
            if !hosts(rootView).contains(where: { $0.renderer.kind == kind }) {
                func dump(_ view: PreviewPlatformView, _ depth: Int = 0) {
                    print("ROW \(String(repeating: " ", count: depth))\(type(of: view)) \(view.frame)")
                    view.subviews.forEach { dump($0, depth+1) }
                }
                dump(rootView)
            }
            XCTAssertTrue(hosts(rootView).contains { $0.renderer.kind == kind }, "Expected \(kind) in real row", file: file, line: line)
        }
        settle()
        let id = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "voice"))
        expect(.delivery(.correcting))
        XCTAssertTrue(sender.dispatchStagedInput(sessionId: sid, clientId: id, text: "corrected"))
        expect(.delivery(.sending))
        app.connectionStatus = .disconnected
        expect(.delivery(.queued))
        app.connectionStatus = .connected
        expect(.delivery(.sending))
        sender.clearPending(sid, clientId: id); settle()
        XCTAssertTrue(hosts(rootView).isEmpty, "Confirmed input must remove local delivery glyph")
        let failedId = try XCTUnwrap(sender.stageInput(sessionId: sid, text: "another"))
        sender.failStagedInput(sessionId: sid, clientId: failedId, text: "original")
        expect(.delivery(.failed))
        XCTAssertTrue(sender.retryPending(sessionId: sid, clientId: failedId))
        expect(.delivery(.sending))
        sender.clearPending(sid, clientId: failedId)
    }

    func testNativeHostStopsWhenHiddenDetachedOrOffscreenAndResumes() throws {
        try requireForegroundUITests()
        let host = PreviewGlyphHost(frame: CGRect(x: 10, y: 10, width: 16, height: 16))
        let blue = CGColor(red: 0, green: 0, blue: 1, alpha: 1)
        #if os(macOS)
        let window = GlyphTestWindow(contentRect: CGRect(x: 50, y: 50, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        let container = NSView(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        window.contentView = container; container.addSubview(host)
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.contentView = nil }
        #else
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        let vc = UIViewController(); window.rootViewController = vc; window.makeKeyAndVisible()
        let container = vc.view!; container.addSubview(host)
        defer { window.isHidden = true; window.rootViewController = nil }
        #endif
        #if os(macOS)
        XCTAssertNil(host.hitTest(CGPoint(x: 8, y: 8)), "Decorative glyph must not intercept row navigation")
        #else
        XCTAssertNil(host.hitTest(CGPoint(x: 8, y: 8), with: nil), "Decorative glyph must not intercept row navigation")
        #endif
        func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.4)) }
        host.configure(kind: .compacting, color: blue, enabled: true); settle()
        XCTAssertTrue(host.renderer.isAnimating)
        #if os(macOS)
        window.simulatedOcclusion = []; settle(); XCTAssertFalse(host.renderer.isAnimating)
        window.simulatedOcclusion = .visible; settle(); XCTAssertTrue(host.renderer.isAnimating)
        #endif
        host.isHidden = true; settle(); XCTAssertFalse(host.renderer.isAnimating)
        host.isHidden = false; settle(); XCTAssertTrue(host.renderer.isAnimating)
        host.frame.origin = CGPoint(x: 10000, y: 10000); settle(); XCTAssertFalse(host.renderer.isAnimating)
        host.frame.origin = CGPoint(x: 10, y: 10); settle(); XCTAssertTrue(host.renderer.isAnimating)
        host.removeFromSuperview(); settle(); XCTAssertFalse(host.renderer.isAnimating)
        container.addSubview(host); settle(); XCTAssertTrue(host.renderer.isAnimating)
        host.configure(kind: .delivery(.sending), color: blue, enabled: true); settle()
        XCTAssertTrue(host.renderer.isAnimating); XCTAssertNotNil(host.renderer.delivery.contents)
        host.configure(kind: .delivery(.failed), color: CGColor(red: 1, green: 0, blue: 0, alpha: 1), enabled: true)
        XCTAssertFalse(host.renderer.isAnimating)
        host.configure(kind: .compacting, color: blue, enabled: false)
        XCTAssertFalse(host.renderer.isAnimating)
    }

    #if os(iOS)
    func testReusedTableFingerprintTracksCorrectionPhaseAndConnection() {
        let store = SessionStore(persistenceEnabled: false)
        func fingerprint(_ p: ChatMessage, online: Bool = true) -> Int {
            SessionTableController.fingerprint(for: session, store: store, device: nil, isAwaitingGreeting: false,
                isCompacting: false, pendingInputs: [p], isDeliveryOnline: online)
        }
        XCTAssertNotEqual(fingerprint(pending("a", "correcting")), fingerprint(pending("a")))
        XCTAssertNotEqual(fingerprint(pending("a")), fingerprint(pending("a"), online: false))
        XCTAssertNotEqual(fingerprint(pending("a", "correcting", text: "raw")), fingerprint(pending("a", "correcting", text: "corrected")))
        XCTAssertEqual(fingerprint(pending("a")), fingerprint(pending("a")))
    }
    #endif
}
