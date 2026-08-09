import AVFoundation
import Foundation

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
        guard frameLength > 0, sourceRate >= targetRate, targetRate > 0 else { return nil }
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

private enum VoiceCaptureAuthorization {
    static var isAuthorized: Bool {
        #if os(iOS)
        return AVAudioApplication.shared.recordPermission == .granted
        #else
        return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        #endif
    }

    static var failureDescription: String {
        #if os(iOS)
        return "microphone permission not granted; enable Microphone access in Settings"
        #else
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        return "microphone permission not granted (status=\(status.rawValue)); enable in System Settings → Privacy → Microphone"
        #endif
    }
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
    private let task: URLSessionWebSocketTask
    private let engine = AVAudioEngine()

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
    private var lastPartial = ""
    private var captureEnded = false
    private var finishSent = false
    private var gatewayReady = false
    private var pendingAudio: [Data] = []

    private var dumpHandle: FileHandle?
    private var peakSample = 0
    private var totalBytes = 0
    private var chunkCount = 0
    private var firstSendTimestamp: Date?
    private var lastStatTimestamp = Date()

    public init(
        configuration: VoiceInputConfiguration,
        onEvent: @escaping EventHandler,
        log: @escaping Logger = { _ in },
        onMetric: @escaping MetricHandler = { _ in },
        onPartialObserved: @escaping PartialObservedHandler = {}
    ) {
        self.configuration = configuration
        self.correctionEnabled = configuration.correctionEnabled
        self.eventHandler = onEvent
        self.logger = log
        self.metricHandler = onMetric
        self.partialObserved = onPartialObserved
        self.pcmDumpPath = configuration.pcmDumpPath

        task = URLSession.shared.webSocketTask(with: configuration.gatewayURL)
        task.resume()
        metricHandler(.webSocketOpened)
        receiveLoop()
        send(json: configuration.gatewayAuthorizeMessage())
        scheduleAuthorizationTimeout()
        schedulePing()
    }

    private func emit(_ event: VoiceInputEvent) {
        eventHandler(event)
    }

    private func send(json dictionary: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(dictionary),
              let data = try? JSONSerialization.data(withJSONObject: dictionary),
              let string = String(data: data, encoding: .utf8) else {
            fail("invalid gateway control message")
            return
        }
        task.send(.string(string)) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.fail("ws send error: \(error.localizedDescription)")
            }
        }
    }

    private func sendPCM(_ data: Data) {
        task.send(.data(data)) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.fail("ws send error: \(error.localizedDescription)")
            }
        }
    }

    private func scheduleAuthorizationTimeout() {
        let timeout = configuration.authorizationTimeout
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.connectionAuthorized else { return }
            self.fail("gateway authorization not ready after \(Int(timeout))s")
        }
        authorizationTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    private func schedulePing() {
        guard configuration.pingInterval > 0, receiveLoopRunning else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.receiveLoopRunning else { return }
            self.task.sendPing { [weak self] error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if let error {
                        self.fail("ws ping error: \(error.localizedDescription)")
                    } else {
                        self.schedulePing()
                    }
                }
            }
        }
        pingWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + configuration.pingInterval, execute: work)
    }

    public func startCapture(
        context: [String: VoiceInputJSONValue],
        vocabulary: [String]
    ) {
        guard receiveLoopRunning, connectionAuthorized, !recordingActive else {
            fail("voice connection is not ready for a new recording")
            return
        }
        guard VoiceCaptureAuthorization.isAuthorized else {
            fail(VoiceCaptureAuthorization.failureDescription)
            return
        }

        resetRecordingState()
        recordingActive = true
        send(json: configuration.gatewayStartMessage(context: context, vocabulary: vocabulary))
        scheduleReadyTimeout()
        startEngine()
    }

    private func resetRecordingState() {
        timeoutWork?.cancel()
        timeoutWork = nil
        readyTimeoutWork?.cancel()
        readyTimeoutWork = nil
        terminalDelivered = false
        markedFirstAudio = false
        markedFirstPartial = false
        markedCorrectionFirstToken = false
        lastPartial = ""
        captureEnded = false
        finishSent = false
        gatewayReady = false
        pendingAudio.removeAll()
        peakSample = 0
        totalBytes = 0
        chunkCount = 0
        firstSendTimestamp = nil
        lastStatTimestamp = Date()
        dumpHandle?.closeFile()
        dumpHandle = nil
    }

    private func scheduleReadyTimeout() {
        let timeout = configuration.readyTimeout
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.recordingActive, !self.gatewayReady else { return }
            self.fail("gateway not ready after \(Int(timeout))s")
        }
        readyTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    private func startEngine() {
        if let path = pcmDumpPath {
            FileManager.default.createFile(atPath: path, contents: nil)
            dumpHandle = FileHandle(forWritingAtPath: path)
        }

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        logger("input format: \(inputFormat.sampleRate) Hz, \(inputFormat.channelCount) ch")
        guard inputFormat.sampleRate >= configuration.targetSampleRate,
              inputFormat.channelCount > 0 else {
            fail("audio input unavailable (format \(inputFormat.sampleRate) Hz / \(inputFormat.channelCount) ch); check input device")
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.handleBuffer(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
            firstSendTimestamp = Date()
            lastStatTimestamp = Date()
            metricHandler(.engineStarted)
            logger("audio engine started (buffering until recording ready)")
        } catch {
            fail("engine start failed: \(error.localizedDescription)")
        }
    }

    private func flushPending() {
        guard !pendingAudio.isEmpty else { return }
        metricHandler(.bufferFlushed)
        for chunk in pendingAudio { sendPCM(chunk) }
        pendingAudio.removeAll()
    }

    private func handleBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData?[0] else { return }
        guard let converted = VoicePCMConverter.convert(
            samples: channelData,
            frameLength: Int(buffer.frameLength),
            sourceRate: buffer.format.sampleRate,
            targetRate: configuration.targetSampleRate
        ) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.ingest(converted.data, peak: converted.peak)
        }
    }

    private func ingest(_ data: Data, peak: Float) {
        guard receiveLoopRunning, recordingActive, !captureEnded else { return }
        dumpHandle?.write(data)
        if !markedFirstAudio {
            markedFirstAudio = true
            metricHandler(.firstAudio)
        }
        chunkCount += 1
        totalBytes += data.count
        peakSample = max(peakSample, Int(peak * 32768))
        emit(.level(peak))
        if gatewayReady { sendPCM(data) } else { pendingAudio.append(data) }

        let now = Date()
        if now.timeIntervalSince(lastStatTimestamp) > 1 {
            lastStatTimestamp = now
            logger("capture: chunks=\(chunkCount) bytes=\(totalBytes) peak=\(peakSample)/32768\(gatewayReady ? "" : " (buffering)")")
        }
    }

    public func stopCapture() {
        guard recordingActive else { return }
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        DispatchQueue.main.async { [weak self] in self?.onCaptureEOF() }
    }

    private func onCaptureEOF() {
        guard receiveLoopRunning, recordingActive, !captureEnded else { return }
        captureEnded = true
        let duration = firstSendTimestamp.map { Date().timeIntervalSince($0) } ?? 0
        logger("capture end: chunks=\(chunkCount) bytes=\(totalBytes) peak=\(peakSample)/32768 dur=\(String(format: "%.2f", duration))s")

        let work = DispatchWorkItem { [weak self] in
            self?.fail("timed out waiting for transcript")
        }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + configuration.finishTimeout, execute: work)
        if gatewayReady { sendFinish() }
    }

    private func sendFinish() {
        guard !finishSent else { return }
        finishSent = true
        metricHandler(.finishSent)
        send(json: ["type": "finish"])
    }

    private func receiveLoop() {
        guard receiveLoopRunning else { return }
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.receiveLoopRunning else { return }
                switch result {
                case .success(.string(let string)):
                    self.handle(string)
                    self.receiveLoop()
                case .success:
                    self.receiveLoop()
                case .failure(let error):
                    self.fail("ws error: \(error.localizedDescription)")
                }
            }
        }
    }

    private func handle(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else { return }

        switch type {
        case "authorized":
            guard !connectionAuthorized else { return }
            connectionAuthorized = true
            authorizationTimeoutWork?.cancel()
            authorizationTimeoutWork = nil
            metricHandler(.connectionAuthorized)
            emit(.connectionAuthorized)
        case "ready":
            guard recordingActive else { return }
            metricHandler(.gatewayReady)
            readyTimeoutWork?.cancel()
            readyTimeoutWork = nil
            gatewayReady = true
            flushPending()
            emit(.gatewayReady)
            if captureEnded { sendFinish() }
        case "correction_delta":
            guard correctionEnabled, recordingActive else { return }
            let text = message["text"] as? String ?? ""
            guard !text.isEmpty else { return }
            if !markedCorrectionFirstToken {
                markedCorrectionFirstToken = true
                metricHandler(.correctionFirstToken)
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
                    metricHandler(.firstPartial)
                }
                lastPartial = text
                partialObserved()
                emit(.partial(text))
            }
        case "session_denied":
            fail("denied: \(message["reason"] ?? "?")")
        case "error":
            fail("gateway error: \(message["message"] ?? "?")")
        case "closed":
            metricHandler(.asrClosed)
        default:
            break
        }
    }

    private func complete(_ text: String, rawText: String?) {
        guard recordingActive, !terminalDelivered else { return }
        terminalDelivered = true
        metricHandler(correctionEnabled ? .final : .rawFinal)
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
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        recordingActive = false
        gatewayReady = false
        captureEnded = false
        finishSent = false
        pendingAudio.removeAll()
    }

    private func fail(_ reason: String) {
        guard receiveLoopRunning else { return }
        closeConnection(with: .goingAway)
        DispatchQueue.main.async { [eventHandler] in eventHandler(.failed(reason)) }
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
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        task.cancel(with: closeCode, reason: nil)
    }

    public func close() {
        guard receiveLoopRunning else { return }
        closeConnection(with: .normalClosure)
    }

    deinit {
        close()
    }
}
