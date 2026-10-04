import AVFoundation
import Foundation
import VoiceAudioSafety

public enum VoiceAudioInputAvailability {
    /// This never opens the input or requests permission.
    public static var isAvailable: Bool { VICHasDefaultInputDevice() }
}

/// Sendable JSON value used for opaque product-owned gateway fields.
public enum VoiceInputJSONValue: Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([VoiceInputJSONValue])
    case object([String: VoiceInputJSONValue])
    case null

    func foundationValue() -> Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .array(let values): return values.map { $0.foundationValue() }
        case .object(let values): return values.mapValues { $0.foundationValue() }
        case .null: return NSNull()
        }
    }
}

/// Product-owned configuration for one warm voice connection.
///
/// Authorization is connection-scoped. Per-recording correction context is
/// supplied to `startCapture`, allowing one WebSocket to carry many sequential
/// recordings without pinning stale chat context at foreground warm-up time.
public struct VoiceInputConfiguration: Sendable {
    public var gatewayURL: URL
    public var apiKey: String?
    public var userID: String
    public var correctionEnabled: Bool
    public var context: [String: VoiceInputJSONValue]
    public var vocabulary: [String]
    /// Host-owned fields merged into the connection-level authorize frame.
    public var authorizationFields: [String: VoiceInputJSONValue]
    /// Host-owned fields merged into every per-recording start frame.
    public var startFields: [String: VoiceInputJSONValue]
    public var targetSampleRate: Double
    public var authorizationTimeout: TimeInterval
    public var readyTimeout: TimeInterval
    public var finishTimeout: TimeInterval
    public var pingInterval: TimeInterval
    /// No PCM callbacks (not silence) during active capture is a local failure.
    public var captureStallTimeout: TimeInterval
    public var sendTimeout: TimeInterval
    public var maxBufferedAudioBytes: Int
    public var pcmDumpPath: String?

    public init(
        gatewayURL: URL,
        apiKey: String? = nil,
        userID: String,
        correctionEnabled: Bool = true,
        context: [String: VoiceInputJSONValue] = [:],
        vocabulary: [String] = [],
        authorizationFields: [String: VoiceInputJSONValue] = [:],
        startFields: [String: VoiceInputJSONValue] = [:],
        targetSampleRate: Double = 16_000,
        authorizationTimeout: TimeInterval = 10,
        readyTimeout: TimeInterval = 10,
        finishTimeout: TimeInterval = 25,
        pingInterval: TimeInterval = 25,
        captureStallTimeout: TimeInterval = 3,
        sendTimeout: TimeInterval = 5,
        maxBufferedAudioBytes: Int = 384_000,
        pcmDumpPath: String? = nil
    ) {
        self.gatewayURL = gatewayURL
        self.apiKey = apiKey
        self.userID = userID
        self.correctionEnabled = correctionEnabled
        self.context = context
        self.vocabulary = vocabulary
        self.authorizationFields = authorizationFields
        self.startFields = startFields
        self.targetSampleRate = targetSampleRate
        self.authorizationTimeout = authorizationTimeout
        self.readyTimeout = readyTimeout
        self.finishTimeout = finishTimeout
        self.pingInterval = pingInterval
        self.captureStallTimeout = captureStallTimeout
        self.sendTimeout = sendTimeout
        self.maxBufferedAudioBytes = maxBufferedAudioBytes
        self.pcmDumpPath = pcmDumpPath
    }

    public func gatewayAuthorizeMessage() -> [String: Any] {
        var authorize = authorizationFields.mapValues { $0.foundationValue() }
        authorize["type"] = "authorize"
        authorize["uid"] = userID
        return authorize
    }

    public func gatewayStartMessage(
        context contextOverride: [String: VoiceInputJSONValue]? = nil,
        vocabulary vocabularyOverride: [String]? = nil
    ) -> [String: Any] {
        var start = startFields.mapValues { $0.foundationValue() }
        start["type"] = "start"
        start["uid"] = userID
        start["correction"] = correctionEnabled
        start["context"] = gatewayContext(
            context: contextOverride ?? context,
            vocabulary: vocabularyOverride ?? vocabulary
        )
        if let apiKey, !apiKey.isEmpty { start["apiKey"] = apiKey }
        return start
    }

    private func gatewayContext(
        context: [String: VoiceInputJSONValue],
        vocabulary: [String]
    ) -> [String: Any] {
        var output = context.mapValues { $0.foundationValue() }
        if !vocabulary.isEmpty { output["vocabulary"] = vocabulary }
        return output
    }
}

public enum VoicePCMConverter {
    /// Downmix the first Float32 channel to mono Int16 PCM at `targetRate`.
    public static func convert(
        samples: UnsafePointer<Float>,
        frameLength: Int,
        sourceRate: Double,
        targetRate: Double
    ) -> (data: Data, peak: Float)? {
        guard frameLength > 0, sourceRate.isFinite, targetRate.isFinite,
              sourceRate >= targetRate, targetRate > 0 else { return nil }
        let ratio = sourceRate / targetRate
        let outputLength = Int(Double(frameLength) / ratio)
        guard outputLength > 0 else { return nil }

        var output = [Int16](repeating: 0, count: outputLength)
        var peak: Float = 0
        for index in 0..<outputLength {
            let sourceStart = Int(Double(index) * ratio)
            let sourceEnd = min(frameLength, Int(Double(index + 1) * ratio))
            var accumulator: Float = 0
            var count = 0
            for sourceIndex in sourceStart..<sourceEnd {
                accumulator += samples[sourceIndex]
                count += 1
            }
            let sample = count > 0 ? accumulator / Float(count) : 0
            guard sample.isFinite else { return nil }
            peak = max(peak, abs(sample))
            let clamped = max(-1.0, min(1.0, Double(sample)))
            output[index] = Int16(clamped * 32767)
        }
        return (output.withUnsafeBufferPointer { Data(buffer: $0) }, peak)
    }
}

public enum VoiceInputEvent: Sendable, Equatable {
    case connectionAuthorized
    case gatewayReady
    case level(Float)
    case partial(String)
    case correctionDelta(String)
    case final(String, rawText: String?)
    case failed(String)
}

public enum VoiceInputMetric: String, Sendable {
    case webSocketOpened = "ws_open"
    case connectionAuthorized = "authorized"
    case engineStarted = "engine_started"
    case firstAudio = "first_audio"
    case gatewayReady = "ready"
    case bufferFlushed = "buffer_flush"
    case firstPartial = "first_partial"
    case finishSent = "finish_sent"
    case asrClosed = "asr_closed"
    case correctionFirstToken = "correction_first_token"
    case final = "final"
    case rawFinal = "raw_final"
}

public protocol VoiceInputSessionProtocol: AnyObject {
    var correctionEnabled: Bool { get }
    var pcmDumpPath: String? { get }
    func startCapture(
        context: [String: VoiceInputJSONValue],
        vocabulary: [String]
    )
    func stopCapture()
    func close()
}

/// Long-lived native voice connection: one authorized WebSocket, many capture
/// cycles. Audio remains strictly sequential and each `startCapture` gets fresh
/// product context.
public final class VoiceInputSession: VoiceInputSessionProtocol {
    public typealias EventHandler = (VoiceInputEvent) -> Void
    public typealias Logger = (String) -> Void
    public typealias MetricHandler = (VoiceInputMetric) -> Void
    public typealias PartialObservedHandler = () -> Void

    public let correctionEnabled: Bool
    public let pcmDumpPath: String?

    private let configuration: VoiceInputConfiguration
    private let eventHandler: EventHandler
    private let logger: Logger
    private let metricHandler: MetricHandler
    private let partialObserved: PartialObservedHandler
    private let task: VoiceInputTransport
    private let capture: VoiceInputCapture
    // All mutable state is serialized independently of the UI.
    private let queue: DispatchQueue
    private let callbackQueue: DispatchQueue
    private let monotonicTime: () -> TimeInterval
    private let queueKey = DispatchSpecificKey<Bool>()
    private let cancellationLock = NSLock()
    private var closeRequested = false
    private var isCloseRequested: Bool {
        cancellationLock.lock(); defer { cancellationLock.unlock() }
        return closeRequested
    }
    private let connectionID = UUID().uuidString
    private var recordingID = UUID().uuidString
    private var inputTapInstalled = false
    private var captureWatchdog: DispatchSourceTimer?
    private var lastAudioAt: TimeInterval = 0
    private var lastLevelAt: TimeInterval = 0
    private var sentBytes = 0
    private var bufferedBytes = 0
    private var upstreamClosed = false
    private var upstreamFinalReceived = false
    private struct Write {
        let id = UUID()
        let message: URLSessionWebSocketTask.Message
        let audioBytes: Int
        let recordingID: String
    }
    private var writes: [Write] = []
    private var activeWrite: Write?
    private var sendTimeoutWork: DispatchWorkItem?

    private var receiveLoopRunning = true
    private var connectionAuthorized = false
    private var recordingActive = false
    private var authorizationTimeoutWork: DispatchWorkItem?
    private var timeoutWork: DispatchWorkItem?
    private var readyTimeoutWork: DispatchWorkItem?
    private var pingWork: DispatchWorkItem?
    private var terminalDelivered = false
    private var markedFirstAudio = false
    private var markedFirstPartial = false
    private var markedCorrectionFirstToken = false
    private var captureEnded = false
    private var finishSent = false
    private var gatewayReady = false
    private var pendingAudio: [Data] = []
    /// A recording started while the connection was still authorizing. The
    /// microphone buffers locally; `start` is sent once `authorized` arrives.
    private var pendingStart: (context: [String: VoiceInputJSONValue], vocabulary: [String])?

    private var dumpHandle: FileHandle?
    private var totalBytes = 0

    public convenience init(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping EventHandler,
        log: @escaping Logger = { _ in },
        onMetric: @escaping MetricHandler = { _ in },
        onPartialObserved: @escaping PartialObservedHandler = {}
    ) {
        self.init(configuration: configuration,
                  transport: LiveVoiceInputTransport(url: configuration.gatewayURL),
                  capture: LiveVoiceInputCapture(), onEvent: onEvent, log: log,
                  onMetric: onMetric, onPartialObserved: onPartialObserved)
    }

    init(configuration: VoiceInputConfiguration, transport: VoiceInputTransport,
         capture: VoiceInputCapture,
         queue: DispatchQueue = DispatchQueue(label: "voice-input.transport", qos: .userInitiated),
         callbackQueue: DispatchQueue = .main,
         monotonicTime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         onEvent: @escaping EventHandler, log: @escaping Logger = { _ in },
         onMetric: @escaping MetricHandler = { _ in },
         onPartialObserved: @escaping PartialObservedHandler = {}) {
        self.task = transport
        self.capture = capture
        self.queue = queue
        self.callbackQueue = callbackQueue
        self.monotonicTime = monotonicTime
        self.configuration = configuration
        self.correctionEnabled = configuration.correctionEnabled
        self.eventHandler = onEvent
        self.logger = log
        self.metricHandler = onMetric
        self.partialObserved = onPartialObserved
        self.pcmDumpPath = configuration.pcmDumpPath

        queue.setSpecific(key: queueKey, value: true)
        queue.async { [self] in
            guard !isCloseRequested else { return }
            task.resume()
            metric(.webSocketOpened)
            diagnostic("connection_open")
            receiveLoop()
            send(json: configuration.gatewayAuthorizeMessage())
            scheduleAuthorizationTimeout()
            schedulePing()
        }
    }

    private func emit(_ event: VoiceInputEvent) {
        callbackQueue.async { [eventHandler] in eventHandler(event) }
    }

    private func metric(_ value: VoiceInputMetric) {
        callbackQueue.async { [metricHandler] in metricHandler(value) }
    }

    /// Metadata only: never provider messages, transcripts, context, URLs or credentials.
    private func diagnostic(_ event: String, code: Int = 0) {
        let audioAgeMs = markedFirstAudio ? Int((monotonicTime() - lastAudioAt) * 1000) : -1
        logger("event=\(event) connection=\(connectionID) recording=\(recordingID) code=\(code) capturedBytes=\(totalBytes) sentBytes=\(sentBytes) bufferedBytes=\(bufferedBytes) audioAgeMs=\(audioAgeMs)")
    }

    private func send(json dictionary: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(dictionary),
              let data = try? JSONSerialization.data(withJSONObject: dictionary),
              let string = String(data: data, encoding: .utf8) else {
            fail("invalid gateway control message")
            return
        }
        enqueue(.string(string))
    }

    private func sendPCM(_ data: Data) { enqueue(.data(data), audioBytes: data.count) }

    private func enqueue(_ message: URLSessionWebSocketTask.Message, audioBytes: Int = 0) {
        guard receiveLoopRunning else { return }
        writes.append(Write(message: message, audioBytes: audioBytes, recordingID: recordingID))
        pumpWrites()
    }

    private func pumpWrites() {
        guard receiveLoopRunning, activeWrite == nil, !writes.isEmpty else { return }
        let write = writes.removeFirst()
        activeWrite = write
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.activeWrite?.id == write.id else { return }
            self.fail("voice upload stalled", tag: "send_stalled")
        }
        sendTimeoutWork = timeout
        queue.asyncAfter(deadline: .now() + configuration.sendTimeout, execute: timeout)
        task.send(write.message) { [weak self] error in
            self?.queue.async { [weak self] in
                guard let self, self.receiveLoopRunning, self.activeWrite?.id == write.id else { return }
                self.sendTimeoutWork?.cancel()
                self.sendTimeoutWork = nil
                self.activeWrite = nil
                if let error {
                    self.fail("ws send error: \(error.localizedDescription)", tag: "send_error", code: (error as NSError).code)
                    return
                }
                if self.recordingID == write.recordingID {
                    self.bufferedBytes -= write.audioBytes
                    self.sentBytes += write.audioBytes
                }
                self.pumpWrites()
            }
        }
    }

    private func scheduleAuthorizationTimeout() {
        let timeout = configuration.authorizationTimeout
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.connectionAuthorized else { return }
            self.fail("gateway authorization not ready after \(Int(timeout))s", tag: "authorization_timeout")
        }
        authorizationTimeoutWork = work
        queue.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    private func schedulePing() {
        guard configuration.pingInterval > 0, receiveLoopRunning else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.receiveLoopRunning else { return }
            self.task.ping { [weak self] error in
                self?.queue.async { [weak self] in
                    guard let self, self.receiveLoopRunning else { return }
                    if let error {
                        self.fail("ws ping error: \(error.localizedDescription)", tag: "ping_error", code: (error as NSError).code)
                    } else {
                        self.schedulePing()
                    }
                }
            }
        }
        pingWork = work
        queue.asyncAfter(deadline: .now() + configuration.pingInterval, execute: work)
    }

    public func startCapture(
        context: [String: VoiceInputJSONValue],
        vocabulary: [String]
    ) {
        queue.async { [self] in startRecording(context: context, vocabulary: vocabulary) }
    }

    private func sendStart(context: [String: VoiceInputJSONValue], vocabulary: [String]) {
        var message = configuration.gatewayStartMessage(context: context, vocabulary: vocabulary)
        message["recordingId"] = recordingID
        send(json: message)
    }

    private func startRecording(context: [String: VoiceInputJSONValue], vocabulary: [String]) {
        guard !isCloseRequested else { return }
        guard receiveLoopRunning, !recordingActive else {
            fail("voice connection is not ready for a new recording")
            return
        }
        resetRecordingState()
        recordingActive = true
        diagnostic("recording_start")
        if connectionAuthorized {
            sendStart(context: context, vocabulary: vocabulary)
            scheduleReadyTimeout()
        } else {
            // Never make the user wait for authorization: capture now, send
            // the buffered audio as soon as the connection is authorized.
            pendingStart = (context, vocabulary)
            diagnostic("capture_before_authorization")
        }
        startEngine()
    }

    private func resetRecordingState() {
        recordingID = UUID().uuidString
        upstreamClosed = false
        upstreamFinalReceived = false
        sentBytes = 0
        bufferedBytes = 0
        lastLevelAt = 0
        timeoutWork?.cancel()
        timeoutWork = nil
        readyTimeoutWork?.cancel()
        readyTimeoutWork = nil
        terminalDelivered = false
        markedFirstAudio = false
        markedFirstPartial = false
        markedCorrectionFirstToken = false
        captureEnded = false
        finishSent = false
        gatewayReady = false
        pendingAudio.removeAll()
        pendingStart = nil
        totalBytes = 0
        lastAudioAt = 0
        dumpHandle?.closeFile()
        dumpHandle = nil
    }

    private func scheduleReadyTimeout() {
        let timeout = configuration.readyTimeout
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.recordingActive, !self.gatewayReady else { return }
            self.fail("gateway not ready after \(Int(timeout))s", tag: "ready_timeout")
        }
        readyTimeoutWork = work
        queue.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    private func startEngine() {
        if let path = pcmDumpPath {
            FileManager.default.createFile(atPath: path, contents: nil)
            dumpHandle = FileHandle(forWritingAtPath: path)
        }

        let generation = recordingID
        do {
            try capture.start(sampleRate: configuration.targetSampleRate, onBuffer: { [weak self] buffer in
                self?.handleBuffer(buffer, generation: generation)
            }, onInterruption: { [weak self] in
                self?.queue.async { [weak self] in
                    guard let self, self.recordingID == generation, self.recordingActive, !self.captureEnded else { return }
                    self.fail("audio input changed during recording", tag: "capture_interrupted")
                }
            })
        } catch {
            capture.stop()
            fail(error.localizedDescription, tag: "capture_start_failed", code: (error as NSError).code)
            return
        }
        inputTapInstalled = true
        lastAudioAt = monotonicTime()
        metric(.engineStarted)
        diagnostic("engine_started")
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let interval = max(0.01, min(0.25, configuration.captureStallTimeout / 2))
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self] in
            guard let self, self.recordingActive, !self.captureEnded,
                  self.recordingID == generation else { return }
            if self.monotonicTime() - self.lastAudioAt >= self.configuration.captureStallTimeout {
                self.fail("audio capture stalled", tag: "capture_stalled")
            }
        }
        captureWatchdog = timer
        timer.resume()
    }

    private func stopEngine() {
        captureWatchdog?.cancel()
        captureWatchdog = nil
        guard inputTapInstalled else { return }
        inputTapInstalled = false
        capture.stop()
    }

    private func flushPending() {
        guard !pendingAudio.isEmpty else { return }
        metric(.bufferFlushed)
        for chunk in pendingAudio { sendPCM(chunk) }
        pendingAudio.removeAll()
    }

    private func handleBuffer(_ buffer: AVAudioPCMBuffer, generation: String) {
        // Copy/convert during the tap callback: AVAudioPCMBuffer is borrowed.
        let converted = buffer.floatChannelData.flatMap { channels in
            VoicePCMConverter.convert(samples: channels[0], frameLength: Int(buffer.frameLength),
                                      sourceRate: buffer.format.sampleRate, targetRate: configuration.targetSampleRate)
        }
        queue.async { [weak self] in
            guard let self, self.receiveLoopRunning, !self.isCloseRequested, self.recordingActive,
                  !self.captureEnded, self.recordingID == generation else { return }
            guard let converted else {
                self.fail("audio input format changed or is invalid", tag: "capture_invalid_format")
                return
            }
            self.ingest(converted.data, peak: converted.peak)
        }
    }

    private func ingest(_ data: Data, peak: Float) {
        guard receiveLoopRunning, recordingActive, !captureEnded else { return }
        lastAudioAt = monotonicTime()
        guard bufferedBytes + data.count <= configuration.maxBufferedAudioBytes else {
            fail("voice upload buffer exhausted", tag: "send_buffer_exhausted")
            return
        }
        bufferedBytes += data.count
        totalBytes += data.count
        dumpHandle?.write(data)
        if !markedFirstAudio {
            markedFirstAudio = true
            metric(.firstAudio)
            diagnostic("first_audio")
        }
        if lastAudioAt - lastLevelAt >= 1.0 / 30 {
            lastLevelAt = lastAudioAt
            emit(.level(peak))
        }
        if gatewayReady { sendPCM(data) } else { pendingAudio.append(data) }
    }

    public func stopCapture() {
        queue.async { [self] in
            guard receiveLoopRunning, recordingActive, !captureEnded else { return }
            stopEngine()
            // Drain buffers already copied by the tap before queuing finish.
            let generation = recordingID
            queue.async { [weak self] in
                guard let self, self.recordingID == generation else { return }
                self.onCaptureEOF()
            }
        }
    }

    private func onCaptureEOF() {
        guard receiveLoopRunning, recordingActive, !captureEnded else { return }
        captureEnded = true
        diagnostic("capture_end")
        scheduleFinalTimeout()
        if gatewayReady && !upstreamClosed { sendFinish() }
    }

    private func scheduleFinalTimeout() {
        guard timeoutWork == nil else { return }
        let generation = recordingID
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.recordingActive, self.recordingID == generation else { return }
            if self.upstreamClosed && !self.upstreamFinalReceived {
                self.fail("ASR closed without final transcript", tag: "asr_final_missing")
            } else if self.upstreamFinalReceived {
                self.fail("timed out waiting for final transcript after ASR completed", tag: "post_asr_final_timeout")
            } else {
                self.fail("timed out waiting for transcript", tag: "final_timeout")
            }
        }
        timeoutWork = work
        queue.asyncAfter(deadline: .now() + configuration.finishTimeout, execute: work)
    }

    private func sendFinish() {
        guard !finishSent else { return }
        finishSent = true
        metric(.finishSent)
        diagnostic("finish_sent")
        send(json: ["type": "finish"])
    }

    private func receiveLoop() {
        guard receiveLoopRunning else { return }
        task.receive { [weak self] result in
            self?.queue.async { [weak self] in
                guard let self, self.receiveLoopRunning else { return }
                switch result {
                case .success(.string(let string)):
                    self.handle(string)
                    self.receiveLoop()
                case .success:
                    self.receiveLoop()
                case .failure(let error):
                    self.fail("ws error: \(error.localizedDescription)", tag: "receive_error", code: (error as NSError).code)
                }
            }
        }
    }

    private func handle(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else { return }
        if let id = message["recordingId"] as? String, id != recordingID { return }

        switch type {
        case "authorized":
            guard !connectionAuthorized else { return }
            connectionAuthorized = true
            authorizationTimeoutWork?.cancel()
            authorizationTimeoutWork = nil
            metric(.connectionAuthorized)
            diagnostic("authorized")
            emit(.connectionAuthorized)
            if recordingActive, let pending = pendingStart {
                pendingStart = nil
                sendStart(context: pending.context, vocabulary: pending.vocabulary)
                scheduleReadyTimeout()
            }
        case "ready":
            guard recordingActive else { return }
            metric(.gatewayReady)
            diagnostic("ready")
            readyTimeoutWork?.cancel()
            readyTimeoutWork = nil
            gatewayReady = true
            flushPending()
            emit(.gatewayReady)
            if captureEnded && !upstreamClosed { sendFinish() }
        case "correction_delta":
            guard correctionEnabled, recordingActive else { return }
            let text = message["text"] as? String ?? ""
            guard !text.isEmpty else { return }
            if !markedCorrectionFirstToken {
                markedCorrectionFirstToken = true
                metric(.correctionFirstToken)
            }
            emit(.correctionDelta(text))
        case "transcript":
            guard recordingActive else { return }
            let text = message["text"] as? String ?? ""
            if message["sessionFinal"] as? Bool == true {
                complete(text, rawText: message["rawText"] as? String)
            } else {
                if !markedFirstPartial {
                    markedFirstPartial = true
                    metric(.firstPartial)
                }
                callbackQueue.async { [partialObserved] in partialObserved() }
                emit(.partial(text))
            }
        case "session_denied":
            fail("denied: \(message["reason"] ?? "?")")
        case "error":
            fail("gateway error: \(message["message"] ?? "?")", tag: "gateway_error",
                 code: message["providerCode"] as? Int ?? 0)
        case "closed":
            guard recordingActive else { return }
            metric(.asrClosed)
            diagnostic("asr_closed", code: message["code"] as? Int ?? 0)
            upstreamClosed = true
            // New brokers distinguish missing-final from normal ASR shutdown
            // while correction is pending. Legacy closed frames are ambiguous:
            // keep waiting, but report the actual missing-final stage on timeout.
            if let finalReceived = message["finalReceived"] as? Bool {
                upstreamFinalReceived = finalReceived
                if !finalReceived {
                    fail("ASR closed without final transcript", tag: "asr_final_missing")
                } else {
                    stopEngine()
                    onCaptureEOF()
                }
            }
        default:
            break
        }
    }

    private func complete(_ text: String, rawText: String?) {
        guard recordingActive, !terminalDelivered else { return }
        terminalDelivered = true
        metric(correctionEnabled ? .final : .rawFinal)
        diagnostic("final")
        finishRecordingLocally()
        emit(.final(text, rawText: rawText))
    }

    private func finishRecordingLocally() {
        timeoutWork?.cancel()
        timeoutWork = nil
        readyTimeoutWork?.cancel()
        readyTimeoutWork = nil
        dumpHandle?.closeFile()
        dumpHandle = nil
        stopEngine()
        // An unsolicited final may arrive before the user releases. Never send
        // queued audio/finish frames outside the now-completed recording.
        writes.removeAll { $0.recordingID == recordingID }
        recordingActive = false
        gatewayReady = false
        captureEnded = false
        finishSent = false
        pendingAudio.removeAll()
        pendingStart = nil
    }

    private func fail(_ reason: String, tag: String = "session_error", code: Int = 0) {
        guard receiveLoopRunning, !isCloseRequested else { return }
        diagnostic(tag, code: code)
        closeConnection(with: .goingAway)
        emit(.failed(reason))
    }

    private func closeConnection(with closeCode: URLSessionWebSocketTask.CloseCode) {
        receiveLoopRunning = false
        authorizationTimeoutWork?.cancel()
        authorizationTimeoutWork = nil
        timeoutWork?.cancel()
        timeoutWork = nil
        readyTimeoutWork?.cancel()
        readyTimeoutWork = nil
        pingWork?.cancel()
        pingWork = nil
        dumpHandle?.closeFile()
        dumpHandle = nil
        stopEngine()
        sendTimeoutWork?.cancel()
        sendTimeoutWork = nil
        writes.removeAll()
        activeWrite = nil
        pendingAudio.removeAll()
        task.cancel(with: closeCode)
    }

    public func close() {
        // Preserve the host's existing teardown contract: on return hardware is
        // stopped, so iOS may deactivate AVAudioSession or begin a replacement.
        // Mark intent before the barrier to fence a not-yet-executed start.
        cancellationLock.lock()
        closeRequested = true
        cancellationLock.unlock()
        let teardown = { [self] in
            guard receiveLoopRunning else { return }
            closeConnection(with: .normalClosure)
            diagnostic("connection_close")
        }
        if DispatchQueue.getSpecific(key: queueKey) == true { teardown() }
        else { queue.sync(execute: teardown) }
    }

    deinit {
        // No callback retains the session. If a host drops it without close(),
        // deinit has exclusive ownership and must still release hardware/timers.
        captureWatchdog?.cancel()
        authorizationTimeoutWork?.cancel()
        readyTimeoutWork?.cancel()
        timeoutWork?.cancel()
        sendTimeoutWork?.cancel()
        pingWork?.cancel()
        capture.stop()
        task.cancel(with: .normalClosure)
    }
}
