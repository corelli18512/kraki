import XCTest
@testable import Kraki

/// cn relay 10-17→10-21: 126 push registrations for 130 authentications, with
/// the same iPhone session registering twice (auth, then the APNs token
/// callback of the same foreground). One registration per connection.
@MainActor
final class PushRegistrationDedupTests: XCTestCase {
    func testOneRegistrationPerConnectionUnlessTheTokenChanges() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-push-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let push = PushManager(appState: app)
        let wasEnabled = push.userEnabled
        push.userEnabled = true
        defer { push.userEnabled = wasEnabled }
        app.connectionStatus = .connected
        let token = Data([0x01, 0x02, 0x03])

        push.handleDeviceToken(token)
        XCTAssertEqual(push.registrationsSentForTesting, 1)
        // The foreground refresh hands back the same token.
        push.handleDeviceToken(token)
        XCTAssertEqual(push.registrationsSentForTesting, 1)

        // A new authenticated connection registers again, once.
        push.onAuthenticated()
        XCTAssertEqual(push.registrationsSentForTesting, 2)
        push.handleDeviceToken(token)
        XCTAssertEqual(push.registrationsSentForTesting, 2)

        // APNs rotated the token.
        push.handleDeviceToken(Data([0x09]))
        XCTAssertEqual(push.registrationsSentForTesting, 3)
    }
}
