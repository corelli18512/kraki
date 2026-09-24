import XCTest
import VoiceAudioSafety
import VoiceAudioSafetyTestSupport
@testable import VoiceInputCore

final class VoiceInputCoreTests: XCTestCase {
    func testAudioGraphExceptionsBecomeRecoverableErrors() {
        // Input getter, format getter, installTap, prepare and start can raise
        // NSException. In particular stage 3 models the reported native crash.
        for stage in 1...5 {
            let engine = VICMakeTestAudioEngine(stage)
            var error: NSError?
            XCTAssertFalse(VICStartAudioEngine(engine, 16_000, { _, _ in }, &error))
            XCTAssertTrue(error?.localizedDescription.contains("audio input unavailable") == true)
            XCTAssertEqual(VICTestEngineStops(engine), 1)
            XCTAssertEqual(VICTestTapRemovals(engine), stage >= 3 ? 1 : 0)
        }
    }

    func testAudioStartErrorCleansInstalledTapEvenThoughEngineNeverRan() {
        let engine = VICMakeTestAudioEngine(6)
        var error: NSError?
        XCTAssertFalse(VICStartAudioEngine(engine, 16_000, { _, _ in }, &error))
        XCTAssertEqual(error?.code, 42)
        XCTAssertEqual(VICTestTapRemovals(engine), 1)
        XCTAssertEqual(VICTestEngineStops(engine), 1)
    }

    func testUnavailableInputDoesNotInstallTapOrStart() {
        // Nil format, zero rate, zero channels, NaN rate and unsupported 8kHz.
        for stage in [7, 9, 10, 11, 12] {
            let engine = VICMakeTestAudioEngine(stage)
            var error: NSError?
            XCTAssertFalse(VICStartAudioEngine(engine, 16_000, { _, _ in }, &error))
            XCTAssertNotNil(error)
            XCTAssertEqual(VICTestEngineStarts(engine), 0)
            XCTAssertEqual(VICTestTapRemovals(engine), 0)
        }
    }

    func testCaptureSuccessAndCleanupAreHardwareIndependent() {
        let engine = VICMakeTestAudioEngine(0)
        var error: NSError?
        XCTAssertTrue(VICStartAudioEngine(engine, 16_000, { _, _ in }, &error))
        XCTAssertNil(error)
        VICStopAudioEngine(engine)
        XCTAssertEqual(VICTestTapRemovals(engine), 1)
        XCTAssertEqual(VICTestEngineStops(engine), 1)
    }

    func testDeviceLossDuringCleanupDoesNotEscapeAsException() {
        let engine = VICMakeTestAudioEngine(8)
        var error: NSError?
        XCTAssertTrue(VICStartAudioEngine(engine, 16_000, { _, _ in }, &error))
        VICStopAudioEngine(engine)
        XCTAssertEqual(VICTestTapRemovals(engine), 1)
        XCTAssertEqual(VICTestEngineStops(engine), 1)
    }

    func testGatewayStartMessageKeepsHostContextOpaque() throws {
        let configuration = VoiceInputConfiguration(
            gatewayURL: try XCTUnwrap(URL(string: "wss://voice.example.test/voice")),
            apiKey: "secret",
            userID: "kraki:user-42",
            correctionEnabled: true,
            context: [
                "inputMethod": .string("dictation"),
                "product": .object([
                    "name": .string("Kraki"),
                    "paid": .bool(true),
                ]),
            ],
            vocabulary: ["Kraki = cracker, kracky"]
        )

        let message = configuration.gatewayStartMessage()
        XCTAssertEqual(message["type"] as? String, "start")
        XCTAssertEqual(message["uid"] as? String, "kraki:user-42")
        XCTAssertEqual(message["apiKey"] as? String, "secret")
        XCTAssertEqual(message["correction"] as? Bool, true)

        let context = try XCTUnwrap(message["context"] as? [String: Any])
        XCTAssertEqual(context["inputMethod"] as? String, "dictation")
        XCTAssertEqual(context["vocabulary"] as? [String], ["Kraki = cracker, kracky"])
        let product = try XCTUnwrap(context["product"] as? [String: Any])
        XCTAssertEqual(product["name"] as? String, "Kraki")
        XCTAssertEqual(product["paid"] as? Bool, true)
    }

    func testGatewayAuthorizationKeepsLeaseOffPerRecordingStart() throws {
        let configuration = VoiceInputConfiguration(
            gatewayURL: try XCTUnwrap(URL(string: "wss://voice.example.test/voice")),
            userID: "kraki:user-42",
            correctionEnabled: true,
            context: ["product": .string("kraki")],
            authorizationFields: [
                "type": .string("host-must-not-win"),
                "uid": .string("wrong-user"),
                "deviceId": .string("device-1"),
                "authorization": .object([
                    "payload": .object([
                        "did": .string("device-1"),
                        "quota_seconds": .number(600),
                    ]),
                    "signature": .string("sig"),
                    "alg": .string("RSA-SHA256"),
                ]),
            ],
            startFields: [
                "deviceId": .string("device-1"),
                "sampleRate": .number(16_000),
            ]
        )

        let authorize = configuration.gatewayAuthorizeMessage()
        XCTAssertEqual(authorize["type"] as? String, "authorize")
        XCTAssertEqual(authorize["uid"] as? String, "kraki:user-42")
        XCTAssertEqual(authorize["deviceId"] as? String, "device-1")
        let lease = try XCTUnwrap(authorize["authorization"] as? [String: Any])
        XCTAssertEqual(lease["signature"] as? String, "sig")
        let payload = try XCTUnwrap(lease["payload"] as? [String: Any])
        XCTAssertEqual(payload["did"] as? String, "device-1")
        XCTAssertEqual(payload["quota_seconds"] as? Double, 600)

        let start = configuration.gatewayStartMessage()
        XCTAssertEqual(start["type"] as? String, "start")
        XCTAssertEqual(start["deviceId"] as? String, "device-1")
        XCTAssertEqual(start["sampleRate"] as? Double, 16_000)
        XCTAssertNil(start["authorization"])
    }

    func testGatewayStartMessageOmitsEmptyApiKey() throws {
        let configuration = VoiceInputConfiguration(
            gatewayURL: try XCTUnwrap(URL(string: "wss://voice.example.test/voice")),
            apiKey: "",
            userID: "voice-type",
            correctionEnabled: false
        )
        let message = configuration.gatewayStartMessage()
        XCTAssertNil(message["apiKey"])
        XCTAssertEqual(message["correction"] as? Bool, false)
    }

    func testPCMConverterDownsamplesAndReportsPeak() {
        // Four 48 kHz samples become two 24 kHz samples by averaging pairs.
        let input: [Float] = [1.0, 0.0, -1.0, 0.0]
        let converted = input.withUnsafeBufferPointer {
            VoicePCMConverter.convert(
                samples: $0.baseAddress!,
                frameLength: $0.count,
                sourceRate: 48_000,
                targetRate: 24_000
            )
        }
        XCTAssertNotNil(converted)
        XCTAssertEqual(Double(converted!.peak), 0.5, accuracy: 0.0001)
        let output = converted!.data.withUnsafeBytes {
            Array($0.bindMemory(to: Int16.self))
        }
        XCTAssertEqual(output.count, 2)
        XCTAssertEqual(output[0], 16_383)
        XCTAssertEqual(output[1], -16_383)
    }

    func testPCMConverterRejectsUpsampling() {
        let input: [Float] = [0.25, -0.25]
        let converted = input.withUnsafeBufferPointer {
            VoicePCMConverter.convert(
                samples: $0.baseAddress!,
                frameLength: $0.count,
                sourceRate: 8_000,
                targetRate: 16_000
            )
        }
        XCTAssertNil(converted)
    }

    func testCorrectionDeltaIsNotAnAuthoritativeFinal() {
        let delta = VoiceInputEvent.correctionDelta("正在修正")
        let final = VoiceInputEvent.final("最终文本", rawText: "原始文本")
        XCTAssertNotEqual(delta, final)
    }
}
