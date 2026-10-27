import XCTest
@testable import Kraki

@MainActor
final class BackgroundGraceRound2Tests: XCTestCase {
    func testDuplicateBackgroundWhileVoiceWaitsForDeliveryThenForegroundRetiresBothTasks() throws {
        let app = AppState(testDatabase: MessageDatabase(inMemory: ()))
        var voiceEnded: [Int] = [], graceEnded: [Int] = []
        var expirations: [() -> Void] = []
        var visibility: [Bool] = []
        var teardown = 0, tasks = 0
        var finishing = true
        app.backgroundVoiceFinisher = BackgroundVoiceFinisher(hooks: .init(
            isFinishing: { finishing }, isDelivered: { false }, retire: {},
            teardown: { teardown += 1 }, beginTask: { _ in 90 }, endTask: { voiceEnded.append($0) }))
        app.backgroundSocketGrace = BackgroundSocketGrace(hooks: .init(
            canKeep: { true }, setVisible: { visibility.append($0) }, teardown: { teardown += 1 },
            beginTask: { expiry in tasks += 1; expirations.append(expiry); return tasks }, endTask: { graceEnded.append($0) }))
        XCTAssertTrue(app.backgroundVoiceFinisher.beginIfNeeded())
        finishing = false // correction handed to transport; the voice task awaits its echo
        app.handleBackground()
        app.handleBackground() // duplicate scene event during the delivery wait
        XCTAssertTrue(app.backgroundVoiceFinisher.isActive)
        XCTAssertTrue(app.backgroundSocketGrace.isActive)
        XCTAssertEqual(tasks, 1)
        app.handleForegroundRehydrate()
        XCTAssertFalse(app.backgroundVoiceFinisher.isActive)
        XCTAssertFalse(app.backgroundSocketGrace.isActive)
        XCTAssertEqual(voiceEnded, [90])
        XCTAssertEqual(graceEnded, [1])
        expirations[0]()
        XCTAssertEqual(teardown, 0)
        XCTAssertEqual(visibility, [false, true])
    }
}
