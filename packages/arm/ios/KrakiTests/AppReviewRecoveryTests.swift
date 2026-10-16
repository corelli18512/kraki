#if os(iOS)
import XCTest
import SwiftUI
@testable import Kraki

@MainActor
final class AppReviewRecoveryTests: XCTestCase {
    func testSameRelayAfterLogoutReconnectsOnlyOnce() async {
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:9")
        defer { socket.disconnect() }
        socket.disconnect()
        let started = expectation(description: "same-URL pairing reconnects")
        var starts = 0
        socket.onStateChange = { state in
            if state == .connecting { starts += 1; started.fulfill() }
        }
        socket.setRelayURL(socket.relayURL)
        socket.setRelayURL(socket.relayURL)
        await fulfillment(of: [started], timeout: 1)
        XCTAssertEqual(starts, 1, "duplicate requests must not replace the pending connection")
        XCTAssertFalse(socket.isAuthenticated)
    }

    func testLogoutCancelsDeferredSameRelayReconnect() async {
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:9")
        defer { socket.disconnect() }
        socket.setRelayURL(socket.relayURL)
        socket.disconnect()
        // Drain the scheduled main-queue connect without making any real server necessary.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertEqual(socket.state, .disconnected)
    }

    func testSameRelayDoesNotReplaceAnInFlightConnection() {
        let socket = WebSocketClient(relayURL: "ws://127.0.0.1:9")
        defer { socket.disconnect() }
        var starts = 0
        socket.onStateChange = { if $0 == .connecting { starts += 1 } }
        socket.connect()
        socket.setRelayURL(socket.relayURL)
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(socket.state, .connecting)
    }

    private func permissionFixture() -> ChatMessage {
        let payload: [String: AnyCodable] = [
            "permissionId": AnyCodable("review-permission"), "toolName": AnyCodable("Edit"),
            "description": AnyCodable("Edit: /home/node/workspace/review-demo/approval/theme.ts"),
            "args": AnyCodable([
                "kind": AnyCodable("file_edit"),
                "path": AnyCodable("/home/node/workspace/review-demo/approval/theme.ts"),
                "content": AnyCodable("@@\n-export const theme = 'light';\n+export const theme = 'dark';"),
            ]),
        ]
        return ChatMessage(type: "permission", seq: 1, sessionId: "review", deviceId: "demo",
                           timestamp: nil, payload: payload)
    }

    // Run this with the simulator's SYSTEM text size at its accessibility maximum
    // as well as .large: an offscreen-only explicit-environment test misses the
    // visible host/controller sizing mismatch.
    func testVisibleHostMatchesSharedMeasurementAtSystemTextSize() throws {
        let action = permissionFixture()
        print("REVIEW_SYSTEM_TEXT_SIZE \(UIApplication.shared.preferredContentSizeCategory.rawValue)")
        XCTAssertNotNil(PermissionDiffPreview.diff(action.args))
        let width: CGFloat = 336
        let host = BubbleActionHostView(frame: CGRect(x: 0, y: 0, width: width, height: 1))
        host.configure(action: action, sessionMode: .safe)
        let measured = host.measuredHeight(forWidth: width)
        let expected = TKActionMeasure.height(action: action, width: width)
        XCTAssertEqual(measured, expected, accuracy: 3)
        let size = try XCTUnwrap(DynamicTypeSize(UIApplication.shared.preferredContentSizeCategory))
        let reference = BubbleActionSlot(action: action, sessionMode: .safe)
            .frame(width: width).fixedSize(horizontal: false, vertical: true)
            .environment(\.dynamicTypeSize, size)
            .environment(\.displayScale, UIScreen.main.scale)
        let renderer = ImageRenderer(content: reference)
        renderer.scale = UIScreen.main.scale
        XCTAssertEqual(measured, CGFloat(try XCTUnwrap(renderer.cgImage).height) / renderer.scale, accuracy: 3)
    }

    func testPermissionMeasurementMatchesRenderedAccessibilitySizeAndResets() throws {
        let action = permissionFixture()
        for width in [CGFloat(280), CGFloat(336)] {
            var regularHeight: CGFloat = 0
            for (category, size) in [(UIContentSizeCategory.large, DynamicTypeSize.large),
                                     (.accessibilityExtraExtraExtraLarge, .accessibility5),
                                     (.large, .large)] {
                let reference = BubbleActionSlot(action: action, sessionMode: .safe)
                    .frame(width: width).fixedSize(horizontal: false, vertical: true)
                    .environment(\.dynamicTypeSize, size)
                    .environment(\.displayScale, UIScreen.main.scale)
                let renderer = ImageRenderer(content: reference)
                renderer.scale = UIScreen.main.scale
                let renderedHeight = CGFloat(try XCTUnwrap(renderer.cgImage).height) / renderer.scale
                let measured = TKActionMeasure.height(action: action, width: width, contentSizeCategory: category)
                XCTAssertEqual(measured, renderedHeight, accuracy: 3,
                               "offscreen cached measurement must reserve all rendered controls at \(category)")
                if category == .large { regularHeight = measured }
                else { XCTAssertGreaterThan(measured, regularHeight + 100) }
            }
        }
    }
}
#endif
