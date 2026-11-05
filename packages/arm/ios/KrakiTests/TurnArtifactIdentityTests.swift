import XCTest
@testable import Kraki

/// K-023: the chat lists cache a row's height and content by its id. A reply
/// that gains the turn's artifacts when its `idle` lands draws differently, so
/// it must get a new identity, or the live list never redraws it.
final class TurnArtifactIdentityTests: XCTestCase {
    private let sid = "projection-artifact-identity"
    private let artifact: [String: AnyCodable] = [
        "type": AnyCodable("content_ref"), "id": AnyCodable("chart"),
        "mimeType": AnyCodable("image/png"), "size": AnyCodable(42),
    ]

    private func row(_ type: String, _ seq: Int, _ payload: [String: AnyCodable]) -> ChatMessage {
        ChatMessage(type: type, seq: seq, sessionId: sid, deviceId: "d", timestamp: nil, payload: payload)
    }

    func testFoldedTurnArtifactsGiveTheReplyANewIdentity() {
        let reply = [row("user_message", 1, ["content": AnyCodable("draw it")]),
                     row("agent_message", 2, ["content": AnyCodable("Here it is.")])]
        let idle = row("idle", 3, ["turnArtifacts": AnyCodable([artifact])])
        let before = TurnSpineProjection.project(reply)
        let after = TurnSpineProjection.project(reply + [idle])
        XCTAssertEqual(after[1].contentRefAttachments.map(\.id), ["chart"])
        XCTAssertNotEqual(after[1].id, before[1].id, "a row that gains attachments is a new identity")
        XCTAssertEqual(after[0].id, before[0].id)
    }

    func testArtifactTheReplyAlreadyCarriesKeepsItsIdentity() {
        let projected = TurnSpineProjection.project([
            row("user_message", 1, ["content": AnyCodable("draw it")]),
            row("agent_message", 2, ["content": AnyCodable("Here it is."), "attachments": AnyCodable([artifact])]),
            row("idle", 3, ["turnArtifacts": AnyCodable([artifact])]),
        ])
        XCTAssertEqual(projected[1].id, "\(sid):2")
    }
}
