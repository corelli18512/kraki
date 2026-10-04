import AVFoundation
import XCTest
@testable import VoiceInputCore

private final class Locked<Value> {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func with<T>(_ body: (inout Value) -> T) -> T {
        lock.lock(); defer { lock.unlock() }; return body(&value)
    }
    var snapshot: Value { with { $0 } }
}

private final class Transport: VoiceInputTransport {
    struct State {
        var sent: [URLSessionWebSocketTask.Message] = []
        var pending: [URLSessionWebSocketTask.Message] = []
        var receiver: ((Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
        var held: [(Error?) -> Void] = []
        var holdAudio = false
        var cancellations = 0
        var sentOnMain = false
    }
    let state = Locked(State())
    func resume() {}
    func send(_ message: URLSessionWebSocketTask.Message, completion: @escaping (Error?) -> Void) {
        let held = state.with { value in
            value.sent.append(message)
            value.sentOnMain = value.sentOnMain || Thread.isMainThread
            if case .data = message, value.holdAudio { value.held.append(completion); return true }
            return false
        }
        if !held { completion(nil) }
    }
    func receive(_ completion: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        let next = state.with { value -> URLSessionWebSocketTask.Message? in
            if !value.pending.isEmpty { return value.pending.removeFirst() }
            value.receiver = completion; return nil
        }
        if let next { completion(.success(next)) }
    }
    func feed(_ value: [String: Any]) {
        let message = URLSessionWebSocketTask.Message.string(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
        let receiver = state.with { value -> ((Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            let receiver = value.receiver; value.receiver = nil
            if receiver == nil { value.pending.append(message) }
            return receiver
        }
        receiver?(.success(message))
    }
    func ping(_ completion: @escaping (Error?) -> Void) { completion(nil) }
    func cancel(with code: URLSessionWebSocketTask.CloseCode) { state.with { $0.cancellations += 1; $0.receiver = nil } }
    func releaseAudio(_ error: Error? = nil) {
        let callbacks = state.with { value in let held = value.held; value.held = []; return held }
        callbacks.forEach { $0(error) }
    }
    var controls: [[String: Any]] {
        state.snapshot.sent.compactMap {
            guard case .string(let text) = $0 else { return nil }
            return try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        }
    }
    var audio: [Data] { state.snapshot.sent.compactMap { if case .data(let data) = $0 { return data }; return nil } }
}

private final class Capture: VoiceInputCapture {
    struct State {
        var starts = 0
        var stops = 0
        var buffer: ((AVAudioPCMBuffer) -> Void)?
        var interrupted: (() -> Void)?
    }
    let state = Locked(State())
    func start(sampleRate: Double, onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onInterruption: @escaping () -> Void) throws {
        state.with { $0.starts += 1; $0.buffer = onBuffer; $0.interrupted = onInterruption }
    }
    func stop() { state.with { $0.stops += 1; $0.buffer = nil; $0.interrupted = nil } }
    static func buffer(rate: Double = 48_000, sample: Float = 0.25) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        buffer.frameLength = 4800
        for i in 0..<4800 { buffer.floatChannelData![0][i] = sample }
        return buffer
    }
    func audio(rate: Double = 48_000, sample: Float = 0.25) { state.snapshot.buffer?(Self.buffer(rate: rate, sample: sample)) }
}

private final class Fixture {
    let transport = Transport()
    let capture = Capture()
    let worker = DispatchQueue(label: "voice-test.worker")
    let events = Locked<[VoiceInputEvent]>([])
    let logs = Locked<[String]>([])
    var session: VoiceInputSession!
    init(monotonicTime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         configure: (inout VoiceInputConfiguration) -> Void = { _ in }) {
        var config = VoiceInputConfiguration(gatewayURL: URL(string: "wss://unused.invalid")!, userID: "private-user",
                                             authorizationTimeout: 2, readyTimeout: 2, finishTimeout: 0.3,
                                             pingInterval: 0, captureStallTimeout: 2, sendTimeout: 2)
        configure(&config)
        session = VoiceInputSession(configuration: config, transport: transport, capture: capture,
                                    queue: worker, callbackQueue: DispatchQueue(label: "voice-test.events"),
                                    monotonicTime: monotonicTime, onEvent: { [events] event in events.with { $0.append(event) } },
                                    log: { [logs] line in logs.with { $0.append(line) } })
    }
    func start(authorized: Bool = true, ready: Bool = true) {
        if authorized { transport.feed(["type": "authorized"]) }
        session.startCapture(context: [:], vocabulary: [])
        if ready { transport.feed(["type": "ready"]) }
    }
    var failures: [String] { events.snapshot.compactMap { if case .failed(let reason) = $0 { return reason }; return nil } }
    var finals: [String] { events.snapshot.compactMap { if case .final(let text, _) = $0 { return text }; return nil } }
    deinit { session.close() }
}

final class VoiceInputSessionTests: XCTestCase {
    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(2)
        while !predicate(), Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        XCTAssertTrue(predicate(), file: file, line: line)
    }

    func testPCMUploadDoesNotNeedMainQueueOrUIEventDelivery() {
        let f = Fixture(); f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        for _ in 0..<8 { f.capture.audio() }
        // Blocking this test thread (including main on the native runner) must
        // not block capture/transport. No RunLoop pumping is needed.
        eventually { f.transport.audio.count == 8 }
        XCTAssertFalse(f.transport.state.snapshot.sentOnMain)
        XCTAssertTrue(f.failures.isEmpty)
    }

    func testCaptureStallFailsBeforeUpstreamPacketTimeout() {
        let f = Fixture { $0.captureStallTimeout = 0.06 }; f.start()
        eventually { f.failures == ["audio capture stalled"] }
        eventually { f.capture.state.snapshot.stops > 0 }
        XCTAssertEqual(f.transport.state.snapshot.cancellations, 1)
        XCTAssertTrue(f.logs.snapshot.contains { $0.contains("event=capture_stalled") })
    }

    func testSilentPCMIsNotMistakenForMissingAudio() {
        let clock = Locked<TimeInterval>(1)
        let f = Fixture(monotonicTime: { clock.snapshot }) { $0.captureStallTimeout = 0.12 }
        f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        // Advance audio time explicitly: CI descheduling the producer must not
        // turn this silence test into an accidental real missing-audio test.
        for index in 0..<8 {
            clock.with { $0 += 0.08 }
            f.capture.audio(sample: 0)
            eventually { f.transport.audio.count == index + 1 }
        }
        XCTAssertTrue(f.failures.isEmpty)
        // The live watchdog still runs. A genuine gap now fails, with its age
        // measured from the last silent PCM, not the start of the recording.
        clock.with { $0 += 0.2 }
        eventually { f.failures == ["audio capture stalled"] }
        let failure = f.logs.snapshot.first { $0.contains("event=capture_stalled") } ?? ""
        let age = failure.split(separator: " ").first { $0.hasPrefix("audioAgeMs=") }
            .flatMap { Int($0.dropFirst("audioAgeMs=".count)) } ?? -1
        XCTAssertTrue((190...210).contains(age), failure)
    }

    func testInputChangeFailsOnceAndRetiresCapture() {
        let f = Fixture(); f.start()
        eventually { f.capture.state.snapshot.interrupted != nil }
        let interruption = f.capture.state.snapshot.interrupted!
        interruption(); interruption()
        eventually { f.failures.count == 1 }
        XCTAssertEqual(f.failures, ["audio input changed during recording"])
        eventually { f.capture.state.snapshot.buffer == nil }
    }

    func testInvalidRuntimeAudioIsAnExplicitFailure() {
        for rate in [8_000.0, 48_000.0] {
            let f = Fixture(); f.start()
            eventually { f.capture.state.snapshot.starts == 1 }
            f.capture.audio(rate: rate, sample: rate == 48_000 ? .nan : 0)
            eventually { f.failures == ["audio input format changed or is invalid"] }
        }
    }

    func testStalledSendHasBoundedWaitAndIgnoresLateCompletion() {
        let f = Fixture { $0.sendTimeout = 0.06 }; f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        f.transport.state.with { $0.holdAudio = true }
        f.capture.audio()
        eventually { f.failures == ["voice upload stalled"] }
        f.transport.releaseAudio(NSError(domain: "late", code: 42))
        Thread.sleep(forTimeInterval: 0.03)
        XCTAssertEqual(f.failures.count, 1)
        XCTAssertEqual(f.transport.state.snapshot.cancellations, 1)
    }

    func testAudioBufferIsBoundedBeforeReady() {
        let f = Fixture { $0.maxBufferedAudioBytes = 4000 }; f.start(ready: false)
        eventually { f.capture.state.snapshot.starts == 1 }
        f.capture.audio(); f.capture.audio() // each 100ms = 3200 bytes
        eventually { f.failures == ["voice upload buffer exhausted"] }
        XCTAssertTrue(f.transport.audio.isEmpty)
    }

    func testFinishCannotOvertakeBufferedAudioOrAnInFlightSend() {
        let f = Fixture(); f.start(authorized: false, ready: false)
        eventually { f.capture.state.snapshot.starts == 1 }
        f.capture.audio(); f.capture.audio()
        f.session.stopCapture()
        eventually { f.capture.state.snapshot.buffer == nil }
        f.transport.state.with { $0.holdAudio = true }
        f.transport.feed(["type": "authorized"])
        f.transport.feed(["type": "ready"])
        eventually { f.transport.audio.count == 1 }
        XCTAssertFalse(f.transport.controls.contains { $0["type"] as? String == "finish" })
        f.transport.releaseAudio()
        eventually { f.transport.audio.count == 2 }
        XCTAssertFalse(f.transport.controls.contains { $0["type"] as? String == "finish" })
        f.transport.releaseAudio()
        eventually { f.transport.controls.contains { $0["type"] as? String == "finish" } }
    }

    func testMissingASRFinalFailsImmediatelyWithExplicitTerminalMetadata() {
        let f = Fixture(); f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        f.transport.feed(["type": "closed", "code": 1000, "finalReceived": false])
        eventually { f.failures == ["ASR closed without final transcript"] }
        XCTAssertTrue(f.finals.isEmpty)
    }

    func testNormalASRCloseStillWaitsForCorrectionFinal() {
        let f = Fixture { $0.captureStallTimeout = 0.06 }; f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        f.transport.feed(["type": "closed", "code": 1000, "finalReceived": true])
        eventually { f.capture.state.snapshot.buffer == nil }
        Thread.sleep(forTimeInterval: 0.08) // longer than capture watchdog, not final wait
        XCTAssertTrue(f.failures.isEmpty)
        f.transport.feed(["type": "transcript", "sessionFinal": true, "text": "done"])
        eventually { f.finals == ["done"] }
        XCTAssertTrue(f.failures.isEmpty)
    }

    func testKnownASRFinalTimeoutDoesNotClaimASRFinalWasMissing() {
        let f = Fixture { $0.finishTimeout = 0.06 }; f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        f.transport.feed(["type": "closed", "code": 1000, "finalReceived": true])
        eventually { f.failures == ["timed out waiting for final transcript after ASR completed"] }
        XCTAssertTrue(f.logs.snapshot.contains { $0.contains("event=post_asr_final_timeout") })
        XCTAssertFalse(f.logs.snapshot.contains { $0.contains("event=asr_final_missing") })
    }

    func testCloseIsABarrierBeforeAudioDeactivationAndReplacementCapture() {
        let f = Fixture(); f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        f.worker.async { held.signal(); release.wait() }
        held.wait()
        let replacement = Fixture()
        let returned = DispatchSemaphore(value: 0)
        let stoppedBeforeDeactivation = Locked(false)
        DispatchQueue.global().async {
            f.session.close()
            // This is the host's audioPolicy.deactivate() / replacement boundary.
            stoppedBeforeDeactivation.with { $0 = f.capture.state.snapshot.buffer == nil }
            replacement.start()
            returned.signal()
        }
        XCTAssertEqual(returned.wait(timeout: .now() + 0.04), .timedOut)
        XCTAssertEqual(replacement.capture.state.snapshot.starts, 0)
        release.signal()
        XCTAssertEqual(returned.wait(timeout: .now() + 1), .success)
        XCTAssertTrue(stoppedBeforeDeactivation.snapshot)
        eventually { replacement.capture.state.snapshot.starts == 1 }
    }

    func testCancelFencesAQueuedCaptureStartBeforeItOpensHardware() {
        let f = Fixture()
        let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        f.worker.async { held.signal(); release.wait() }
        held.wait()
        f.start()
        let closing = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { closing.signal(); f.session.close(); closed.signal() }
        closing.wait()
        XCTAssertEqual(closed.wait(timeout: .now() + 0.04), .timedOut)
        release.signal()
        XCTAssertEqual(closed.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(f.capture.state.snapshot.starts, 0)
    }

    func testLegacyASRCloseAllowsFinalButExplainsMissingFinal() {
        let f = Fixture { $0.finishTimeout = 0.08 }; f.start()
        eventually { f.capture.state.snapshot.starts == 1 }
        f.session.stopCapture()
        f.transport.feed(["type": "closed", "code": 1000])
        eventually { f.failures == ["ASR closed without final transcript"] }
        let successful = Fixture(); successful.start()
        successful.session.stopCapture()
        successful.transport.feed(["type": "closed", "code": 1000])
        successful.transport.feed(["type": "transcript", "sessionFinal": true, "text": "legacy"])
        eventually { successful.finals == ["legacy"] }
        XCTAssertTrue(successful.failures.isEmpty)
    }

    func testWarmReuseFencesOldCaptureCallbacksAndOldWireTerminal() {
        let f = Fixture(); f.start()
        eventually { f.capture.state.snapshot.buffer != nil }
        let oldBuffer = f.capture.state.snapshot.buffer!
        let oldInterruption = f.capture.state.snapshot.interrupted!
        eventually { f.transport.controls.contains { $0["type"] as? String == "start" } }
        let oldID = f.transport.controls.first { $0["type"] as? String == "start" }!["recordingId"] as! String
        f.transport.feed(["type": "transcript", "sessionFinal": true, "text": "first"])
        eventually { f.finals == ["first"] }
        f.session.startCapture(context: [:], vocabulary: [])
        f.transport.feed(["type": "ready"])
        eventually { f.capture.state.snapshot.starts == 2 }
        oldBuffer(Capture.buffer()); oldInterruption()
        f.transport.feed(["type": "closed", "finalReceived": false, "recordingId": oldID])
        f.capture.audio()
        eventually { f.transport.audio.count == 1 }
        XCTAssertTrue(f.failures.isEmpty)
        f.session.stopCapture()
        f.transport.feed(["type": "transcript", "sessionFinal": true, "text": "second"])
        eventually { f.finals == ["first", "second"] }
    }

    func testCloseCancelsWatchdogAndAllLateCallbacks() {
        let f = Fixture { $0.captureStallTimeout = 0.05 }; f.start()
        eventually { f.capture.state.snapshot.buffer != nil }
        let stale = f.capture.state.snapshot.buffer!
        f.session.close()
        eventually { f.transport.state.snapshot.cancellations > 0 }
        stale(Capture.buffer())
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertTrue(f.failures.isEmpty)
        XCTAssertTrue(f.transport.audio.isEmpty)
    }

    func testReleaseDiagnosticsNeverIncludeTranscriptProviderMessageOrCredentials() {
        let f = Fixture(); f.start()
        f.transport.feed(["type": "transcript", "text": "private-transcript"])
        f.transport.feed(["type": "error", "message": "private-provider-body", "providerCode": 45000081])
        eventually { !f.failures.isEmpty }
        let logs = f.logs.snapshot.joined(separator: "\n")
        XCTAssertTrue(logs.contains("code=45000081"))
        for secret in ["private-user", "private-transcript", "private-provider-body", "unused.invalid"] {
            XCTAssertFalse(logs.contains(secret))
        }
    }
}
