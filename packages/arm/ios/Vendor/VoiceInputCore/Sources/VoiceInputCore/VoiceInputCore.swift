import AVFoundation
import Foundation

/// Product-owned configuration for one voice-input session.
///
/// `VoiceInputCore` does not read environment variables, UserDefaults, account
/// state, plans or UI settings. Each host app constructs this value from its
/// own product configuration and authentication system.
/// Sendable JSON value used for opaque per-session gateway context.
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

public struct VoiceInputConfiguration: Sendable {
    public var gatewayURL: URL
    public var apiKey: String?
    public var userID: String
    public var correctionEnabled: Bool
    public var context: [String: VoiceInputJSONValue]
    public var vocabulary: [String]
    /// Host-owned fields merged into the gateway start frame. Product auth
    /// (for example a nested short-lived lease) belongs here; the reusable
    /// core never obtains or interprets it.
    public var startFields: [String: VoiceInputJSONValue]
    public var targetSampleRate: Double
    public var readyTimeout: TimeInterval
    public var finishTimeout: TimeInterval
    public var pcmDumpPath: String?

    public init(
        gatewayURL: URL,
        apiKey: String? = nil,
        userID: String,
        correctionEnabled: Bool = true,
        context: [String: VoiceInputJSONValue] = [:],
        vocabulary: [String] = [],
        startFields: [String: VoiceInputJSONValue] = [:],
        targetSampleRate: Double = 16_000,
        readyTimeout: TimeInterval = 10,
        finishTimeout: TimeInterval = 25,
        pcmDumpPath: String? = nil
    ) {
        self.gatewayURL = gatewayURL
        self.apiKey = apiKey
        self.userID = userID
        self.correctionEnabled = correctionEnabled
        self.context = context
        self.vocabulary = vocabulary
        self.startFields = startFields
        self.targetSampleRate = targetSampleRate
        self.readyTimeout = readyTimeout
        self.finishTimeout = finishTimeout
        self.pcmDumpPath = pcmDumpPath
    }

    public func gatewayStartMessage() -> [String: Any] {
        // Host fields are installed first, then core protocol fields win. This
        // preserves arbitrary nested authorization while preventing a host from
        // accidentally replacing the lifecycle discriminator or opaque context.
        var start = startFields.mapValues { $0.foundationValue() }
        start["type"] = "start"
        start["uid"] = userID
        start["correction"] = correctionEnabled
        start["context"] = gatewayContext()
        if let apiKey, !apiKey.isEmpty { start["apiKey"] = apiKey }
        return start
    }

    func gatewayContext() -> [String: Any] {
        var output = context.mapValues { $0.foundationValue() }
        if !vocabulary.isEmpty { output["vocabulary"] = vocabulary }
        return output
    }
}

public enum VoicePCMConverter {
    /// Downmix the first Float32 channel to mono Int16 PCM at `targetRate`.
    /// Returns nil when the source format cannot satisfy the requested rate.
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

/// Events emitted by the reusable client engine.
///
/// The authoritative completion boundary is `.final`: `.correctionDelta` is
/// display-only and must never be pasted or treated as a completed session.
public enum VoiceInputEvent: Sendable, Equatable {
    case gatewayReady
    case level(Float)
    case partial(String)
    case correctionDelta(String)
    case final(String, rawText: String?)
    case failed(String)
}

/// Stable instrumentation hooks shared by VoiceType, Kraki and future hosts.
public enum VoiceInputMetric: String, Sendable {
    case webSocketOpened = "ws_open"
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

/// Protocol seam used by host-app tests and future alternate capture engines.
public protocol VoiceInputSessionProtocol: AnyObject {
    var correctionEnabled: Bool { get }
    var pcmDumpPath: String? { get }
    func stopCapture()
    func close()
}

/// Platform-specific permission verification. Permission prompting and audio
/// session policy stay in the host app.
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

/// Native voice-input session: microphone → 16 kHz PCM → gateway events.
///
/// This type deliberately owns no SwiftUI/AppKit UI, hotkey, pasteboard,
/// Accessibility, volume-ducking or account logic.
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
    private var timeoutWork: DispatchWorkItem?
    private var readyTimeoutWork: DispatchWorkItem?
    private var terminalDelivered = false
    private var markedFirstAudio = false
    private var markedFirstPartial = false
    private var markedCorrectionFirstToken = false
    private var lastPartial = ""
    private var captureEnded = false
    private var finishSent = false
    private var wsReady = false
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

        logger("session mode: correction=\(correctionEnabled ? "on" : "off (gateway-native)")")
        metricHandler(.webSocketOpened)
        task = URLSession.shared.webSocketTask(with: configuration.gatewayURL)
        task.resume()
        receiveLoop()

        send(json: configuration.gatewayStartMessage())

        let readyTimeout = configuration.readyTimeout
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.wsReady else { return }
            self.fail("gateway not ready after \(Int(readyTimeout))s")
        }
        readyTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + readyTimeout, execute: work)

        // Capture starts immediately. Audio produced before the gateway is
        // ready is buffered and flushed in order after the ready frame.
        startEngine()
    }

    private func emit(_ event: VoiceInputEvent) {
        eventHandler(event)
    }

    private func send(json dictionary: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(dictionary),
              let data = try? JSONSerialization.data(withJSONObject: dictionary),
              let string = String(data: data, encoding: .utf8) else {
            fail("invalid gateway start/control message")
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

    private func startEngine() {
        guard VoiceCaptureAuthorization.isAuthorized else {
            fail(VoiceCaptureAuthorization.failureDescription)
            return
        }
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
            logger("audio engine started (buffering until gateway ready)")
        } catch {
            fail("engine start failed: \(error.localizedDescription)")
        }
    }

    private func flushPending() {
        guard !pendingAudio.isEmpty else { return }
        metricHandler(.bufferFlushed)
        logger("flushing \(pendingAudio.count) buffered audio chunks to gateway")
        for chunk in pendingAudio { sendPCM(chunk) }
        pendingAudio.removeAll()
    }

    // AVAudioEngine tap thread: convert only, then confine mutable session
    // state and callbacks to the main thread.
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
        guard receiveLoopRunning, !captureEnded else { return }
        dumpHandle?.write(data)
        if !markedFirstAudio {
            markedFirstAudio = true
            metricHandler(.firstAudio)
        }
        chunkCount += 1
        totalBytes += data.count
        peakSample = max(peakSample, Int(peak * 32768))
        emit(.level(peak))
        if wsReady { sendPCM(data) } else { pendingAudio.append(data) }

        let now = Date()
        if now.timeIntervalSince(lastStatTimestamp) > 1 {
            lastStatTimestamp = now
            logger("capture: chunks=\(chunkCount) bytes=\(totalBytes) peak=\(peakSample)/32768\(wsReady ? "" : " (buffering)")")
        }
    }

    public func stopCapture() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        DispatchQueue.main.async { [weak self] in self?.onCaptureEOF() }
    }

    private func onCaptureEOF() {
        guard receiveLoopRunning, !captureEnded else { return }
        captureEnded = true
        let duration = firstSendTimestamp.map { Date().timeIntervalSince($0) } ?? 0
        logger("capture end: chunks=\(chunkCount) bytes=\(totalBytes) peak=\(peakSample)/32768 dur=\(String(format: "%.2f", duration))s dump=\(pcmDumpPath ?? "-")")

        let work = DispatchWorkItem { [weak self] in
            self?.fail("timed out waiting for transcript")
        }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + configuration.finishTimeout, execute: work)
        if wsReady {
            sendFinish()
        } else {
            logger("capture ended before gateway ready; finish deferred")
        }
    }

    private func sendFinish() {
        guard !finishSent else { return }
        finishSent = true
        metricHandler(.finishSent)
        send(json: ["type": "finish"])
        logger("finish sent")
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
        case "ready":
            logger("gateway ready")
            metricHandler(.gatewayReady)
            readyTimeoutWork?.cancel()
            wsReady = true
            flushPending()
            emit(.gatewayReady)
            if captureEnded { sendFinish() }
        case "correction_delta":
            guard correctionEnabled else { return }
            let text = message["text"] as? String ?? ""
            guard !text.isEmpty else { return }
            if !markedCorrectionFirstToken {
                markedCorrectionFirstToken = true
                metricHandler(.correctionFirstToken)
            }
            emit(.correctionDelta(text))
        case "transcript":
            let text = message["text"] as? String ?? ""
            if message["sessionFinal"] as? Bool == true {
                let rawText = message["rawText"] as? String
                if let rawText, rawText != text {
                    logger("correction changed transcript rawLen=\(rawText.count) correctedLen=\(text.count)")
                } else if correctionEnabled {
                    logger("correction left transcript unchanged")
                }
                complete(text, rawText: rawText)
            } else {
                if !markedFirstPartial {
                    markedFirstPartial = true
                    metricHandler(.firstPartial)
                }
                if text.count + 5 < lastPartial.count {
                    logger("partial len dropped \(lastPartial.count)→\(text.count) (ASR segment reset?)")
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
            logger("asr closed code=\(message["code"] ?? -1)")
        default:
            break
        }
    }

    private func complete(_ text: String, rawText: String?) {
        guard !terminalDelivered else { return }
        terminalDelivered = true
        metricHandler(correctionEnabled ? .final : .rawFinal)
        logger("\(correctionEnabled ? "corrected" : "gateway raw") final len=\(text.count) (last partial len=\(lastPartial.count))")
        if correctionEnabled, text.count * 2 < lastPartial.count, lastPartial.count - text.count > 10 {
            logger("WARN: final much shorter than last partial partialLen=\(lastPartial.count) finalLen=\(text.count)")
        }
        finishTerminalTask(with: .normalClosure)
        emit(.final(text, rawText: rawText))
    }

    private func fail(_ reason: String) {
        guard receiveLoopRunning else { return }
        finishTerminalTask(with: .goingAway)
        // Defer so a synchronous startup failure arrives after the host stores
        // its session reference.
        DispatchQueue.main.async { [eventHandler] in eventHandler(.failed(reason)) }
    }

    private func finishTerminalTask(with closeCode: URLSessionWebSocketTask.CloseCode) {
        receiveLoopRunning = false
        timeoutWork?.cancel()
        readyTimeoutWork?.cancel()
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
        finishTerminalTask(with: .normalClosure)
    }

    deinit {
        close()
    }
}
