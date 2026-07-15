import XCTest
@testable import Kraki

final class AnyCodableTests: XCTestCase {

    private func roundTrip(_ value: AnyCodable) throws -> AnyCodable {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(AnyCodable.self, from: data)
    }

    // MARK: - Encode / Decode

    func testStringEncodeDecode() throws {
        let original = AnyCodable("hello")
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded.stringValue, "hello")
    }

    func testIntEncodeDecode() throws {
        let original = AnyCodable(42)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded.intValue, 42)
    }

    func testDoubleEncodeDecode() throws {
        let original = AnyCodable(3.14)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded.doubleValue, 3.14)
    }

    func testBoolEncodeDecode() throws {
        let original = AnyCodable(true)
        let decoded = try roundTrip(original)
        XCTAssertEqual(decoded.boolValue, true)
    }

    func testNilEncodeDecode() throws {
        let original = AnyCodable(nil)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
        XCTAssertNil(decoded.value)
    }

    func testArrayEncodeDecode() throws {
        let original = AnyCodable([AnyCodable(1), AnyCodable("two"), AnyCodable(true)])
        let decoded = try roundTrip(original)
        let arr = try XCTUnwrap(decoded.arrayValue)
        XCTAssertEqual(arr.count, 3)
        XCTAssertEqual(arr[0].intValue, 1)
        XCTAssertEqual(arr[1].stringValue, "two")
        XCTAssertEqual(arr[2].boolValue, true)
    }

    func testDictEncodeDecode() throws {
        let original = AnyCodable(["name": AnyCodable("test"), "count": AnyCodable(5)])
        let decoded = try roundTrip(original)
        let dict = try XCTUnwrap(decoded.dictValue)
        XCTAssertEqual(dict["name"]?.stringValue, "test")
        XCTAssertEqual(dict["count"]?.intValue, 5)
    }

    func testNestedStructureEncodeDecode() throws {
        let nested = AnyCodable([
            "users": AnyCodable([
                AnyCodable(["name": AnyCodable("Alice"), "age": AnyCodable(30)])
            ])
        ])
        let decoded = try roundTrip(nested)
        let dict = try XCTUnwrap(decoded.dictValue)
        let users = try XCTUnwrap(dict["users"]?.arrayValue)
        XCTAssertEqual(users.count, 1)
        let user = try XCTUnwrap(users[0].dictValue)
        XCTAssertEqual(user["name"]?.stringValue, "Alice")
        XCTAssertEqual(user["age"]?.intValue, 30)
    }

    /// Raw `[Any]` (not wrapped in `AnyCodable`) must encode through
    /// the wrap-each-element fallback added to `AnyCodable.encode`.
    /// Without that fallback, the old default-case `encodeNil` would
    /// silently drop the array as `null`, losing user data.
    func testRawArrayEncodesAsArray() throws {
        let raw: [Any] = ["hello", 42, true]
        let wrapped = AnyCodable(raw)
        let decoded = try roundTrip(wrapped)
        let arr = try XCTUnwrap(decoded.arrayValue)
        XCTAssertEqual(arr.count, 3)
        XCTAssertEqual(arr[0].stringValue, "hello")
        XCTAssertEqual(arr[1].intValue, 42)
        XCTAssertEqual(arr[2].boolValue, true)
    }

    /// Raw `[String: Any]` (not wrapped in `AnyCodable`) must encode
    /// through the wrap-each-value fallback rather than vanish to
    /// `null`. Mirrors `testRawArrayEncodesAsArray`.
    func testRawDictionaryEncodesAsObject() throws {
        let raw: [String: Any] = ["k1": "v1", "k2": 99, "k3": false]
        let wrapped = AnyCodable(raw)
        let decoded = try roundTrip(wrapped)
        let dict = try XCTUnwrap(decoded.dictValue)
        XCTAssertEqual(dict["k1"]?.stringValue, "v1")
        XCTAssertEqual(dict["k2"]?.intValue, 99)
        XCTAssertEqual(dict["k3"]?.boolValue, false)
    }

    // MARK: - Equatable

    func testEquality() {
        XCTAssertEqual(AnyCodable("a"), AnyCodable("a"))
        XCTAssertNotEqual(AnyCodable("a"), AnyCodable("b"))
        XCTAssertEqual(AnyCodable(1), AnyCodable(1))
        XCTAssertNotEqual(AnyCodable(1), AnyCodable(2))
        XCTAssertEqual(AnyCodable(true), AnyCodable(true))
        XCTAssertNotEqual(AnyCodable(true), AnyCodable(false))
        XCTAssertEqual(AnyCodable(nil), AnyCodable(nil))
        XCTAssertNotEqual(AnyCodable(nil), AnyCodable(1))
        XCTAssertEqual(AnyCodable(3.14), AnyCodable(3.14))
        XCTAssertEqual(
            AnyCodable([AnyCodable(1)]),
            AnyCodable([AnyCodable(1)])
        )
        XCTAssertEqual(
            AnyCodable(["k": AnyCodable("v")]),
            AnyCodable(["k": AnyCodable("v")])
        )
    }

    // MARK: - Literal Init

    func testLiteralInit() {
        let str: AnyCodable = "hello"
        XCTAssertEqual(str.stringValue, "hello")

        let int: AnyCodable = 42
        XCTAssertEqual(int.intValue, 42)

        let dbl: AnyCodable = 2.5
        XCTAssertEqual(dbl.doubleValue, 2.5)

        let bool: AnyCodable = true
        XCTAssertEqual(bool.boolValue, true)

        let none: AnyCodable = nil
        XCTAssertNil(none.value)
    }

    // MARK: - Description

    func testDescription() {
        XCTAssertEqual(AnyCodable("text").description, "text")
        XCTAssertEqual(AnyCodable(42).description, "42")
        XCTAssertEqual(AnyCodable(nil).description, "nil")
        XCTAssertEqual(AnyCodable(true).description, "true")
    }

    // MARK: - Accessor edge cases

    func testIntValueFromDouble() {
        let v = AnyCodable(3.0)
        // doubleValue should work
        XCTAssertEqual(v.doubleValue, 3.0)
        // intValue falls back from Double
        XCTAssertEqual(v.intValue, 3)
    }
}

// MARK: - Enum Tests

final class ProtocolEnumTests: XCTestCase {

    func testSessionStateRawValues() {
        XCTAssertEqual(SessionState.active.rawValue, "active")
        XCTAssertEqual(SessionState.idle.rawValue, "idle")
        XCTAssertEqual(SessionState.compacting.rawValue, "compacting")
        XCTAssertEqual(SessionState(rawValue: "active"), .active)
        XCTAssertEqual(SessionState(rawValue: "idle"), .idle)
        XCTAssertEqual(SessionState(rawValue: "compacting"), .compacting)
        XCTAssertNil(SessionState(rawValue: "unknown"))
    }

    func testSessionModeRawValues() {
        XCTAssertEqual(SessionMode.safe.rawValue, "safe")
        XCTAssertEqual(SessionMode.discuss.rawValue, "discuss")
        XCTAssertEqual(SessionMode.execute.rawValue, "execute")
        XCTAssertEqual(SessionMode.delegate.rawValue, "delegate")
    }

    func testDeviceRoleRawValues() {
        XCTAssertEqual(DeviceRole.tentacle.rawValue, "tentacle")
        XCTAssertEqual(DeviceRole.app.rawValue, "app")
    }

    func testDeviceKindRawValues() {
        XCTAssertEqual(DeviceKind.desktop.rawValue, "desktop")
        XCTAssertEqual(DeviceKind.server.rawValue, "server")
        XCTAssertEqual(DeviceKind.vm.rawValue, "vm")
        XCTAssertEqual(DeviceKind.web.rawValue, "web")
        XCTAssertEqual(DeviceKind.ios.rawValue, "ios")
        XCTAssertEqual(DeviceKind.android.rawValue, "android")
    }

    func testReasoningEffortRawValues() {
        XCTAssertEqual(ReasoningEffort.low.rawValue, "low")
        XCTAssertEqual(ReasoningEffort.medium.rawValue, "medium")
        XCTAssertEqual(ReasoningEffort.high.rawValue, "high")
        XCTAssertEqual(ReasoningEffort.xhigh.rawValue, "xhigh")
    }
}

// MARK: - Codable Struct Tests

final class ProtocolStructTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func testSessionUsageCodable() throws {
        let usage = SessionUsage(
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 50,
            cacheWriteTokens: 25,
            totalCost: 0.05,
            totalDurationMs: 1500
        )
        let data = try encoder.encode(usage)
        let decoded = try decoder.decode(SessionUsage.self, from: data)
        XCTAssertEqual(decoded, usage)
        XCTAssertEqual(decoded.inputTokens, 100)
        XCTAssertEqual(decoded.outputTokens, 200)
        XCTAssertEqual(decoded.cacheReadTokens, 50)
        XCTAssertEqual(decoded.cacheWriteTokens, 25)
        XCTAssertEqual(decoded.totalCost, 0.05)
        XCTAssertEqual(decoded.totalDurationMs, 1500)
    }

    func testSessionDigestCodable() throws {
        let digest = SessionDigest(
            id: "sess-1",
            agent: "claude",
            model: "claude-3",
            title: "My Session",
            autoTitle: "Auto Title",
            state: .active,
            mode: .execute,
            lastSeq: 10,
            readSeq: 5,
            messageCount: 8,
            createdAt: "2024-01-01T00:00:00Z",
            usage: nil,
            pinned: true
        )
        let data = try encoder.encode(digest)
        let decoded = try decoder.decode(SessionDigest.self, from: data)
        XCTAssertEqual(decoded.id, "sess-1")
        XCTAssertEqual(decoded.agent, "claude")
        XCTAssertEqual(decoded.model, "claude-3")
        XCTAssertEqual(decoded.title, "My Session")
        XCTAssertEqual(decoded.autoTitle, "Auto Title")
        XCTAssertEqual(decoded.state, .active)
        XCTAssertEqual(decoded.mode, .execute)
        XCTAssertEqual(decoded.lastSeq, 10)
        XCTAssertEqual(decoded.readSeq, 5)
        XCTAssertEqual(decoded.messageCount, 8)
        XCTAssertEqual(decoded.pinned, true)
    }

    func testSessionDigestWithOptionalFields() throws {
        let digest = SessionDigest(
            id: "sess-2",
            agent: "gpt",
            model: nil,
            title: nil,
            autoTitle: nil,
            state: .idle,
            mode: .safe,
            lastSeq: 0,
            readSeq: 0,
            messageCount: 0,
            createdAt: "2024-01-01T00:00:00Z",
            usage: nil,
            pinned: nil
        )
        let data = try encoder.encode(digest)
        let decoded = try decoder.decode(SessionDigest.self, from: data)
        XCTAssertEqual(decoded.id, "sess-2")
        XCTAssertNil(decoded.model)
        XCTAssertNil(decoded.title)
        XCTAssertNil(decoded.autoTitle)
        XCTAssertNil(decoded.usage)
        XCTAssertNil(decoded.pinned)
    }

    func testDeviceSummaryCodable() throws {
        let device = DeviceSummary(
            id: "dev-1",
            name: "MacBook",
            role: .tentacle,
            kind: .desktop,
            publicKey: "pk123",
            encryptionKey: "ek456",
            online: true,
            lastSeen: "2024-01-01T00:00:00Z",
            createdAt: "2024-01-01T00:00:00Z"
        )
        let data = try encoder.encode(device)
        let decoded = try decoder.decode(DeviceSummary.self, from: data)
        XCTAssertEqual(decoded, device)
        XCTAssertEqual(decoded.id, "dev-1")
        XCTAssertEqual(decoded.name, "MacBook")
        XCTAssertEqual(decoded.role, .tentacle)
        XCTAssertEqual(decoded.kind, .desktop)
        XCTAssertEqual(decoded.publicKey, "pk123")
        XCTAssertEqual(decoded.encryptionKey, "ek456")
        XCTAssertEqual(decoded.online, true)
    }

    func testModelDetailCodable() throws {
        let detail = ModelDetail(
            id: "claude-3",
            name: "Claude 3",
            supportsReasoningEffort: true,
            supportedReasoningEfforts: [.low, .high],
            defaultReasoningEffort: .medium
        )
        let data = try encoder.encode(detail)
        let decoded = try decoder.decode(ModelDetail.self, from: data)
        XCTAssertEqual(decoded, detail)
    }
}
