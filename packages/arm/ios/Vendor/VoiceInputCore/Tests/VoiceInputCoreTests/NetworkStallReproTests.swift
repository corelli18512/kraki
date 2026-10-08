import AVFoundation
import Foundation
import XCTest
@testable import VoiceInputCore

/// Manual repro for Doubao 45000081 (upload stalls mid-recording).
/// Skipped unless VOICE_STALL_REPRO_URL points at scripts/voice-stall-repro.
final class NetworkStallReproTests: XCTestCase {
    /// Real URLSessionWebSocketTask; records how long each send completion took.
    private final class TimedTransport: VoiceInputTransport {
        let live: LiveVoiceInputTransport
        let t0: TimeInterval
        let lock = NSLock()
        var maxSendLatency: TimeInterval = 0
        var completedAudioSends = 0
        init(url: URL, t0: TimeInterval) { live = LiveVoiceInputTransport(url: url); self.t0 = t0 }
        func resume() { live.resume() }
        func send(_ message: URLSessionWebSocketTask.Message, completion: @escaping (Error?) -> Void) {
            let started = ProcessInfo.processInfo.systemUptime
            var isAudio = false
            if case .data = message { isAudio = true }
            live.send(message) { [self] error in
                let latency = ProcessInfo.processInfo.systemUptime - started
                lock.lock()
                maxSendLatency = max(maxSendLatency, latency)
                if isAudio { completedAudioSends += 1 }
                lock.unlock()
                if latency > 0.5 {
                    print(String(format: "[client %6.2fs] slow send completion: %.2fs", started + latency - t0, latency))
                }
                completion(error)
            }
        }
        func receive(_ completion: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) { live.receive(completion) }
        func ping(_ completion: @escaping (Error?) -> Void) { live.ping(completion) }
        func cancel(with code: URLSessionWebSocketTask.CloseCode) { live.cancel(with: code) }
    }

    /// A healthy microphone: 100 ms of quiet noise every 100 ms at 48 kHz.
    private final class SteadyMic: VoiceInputCapture {
        private var timer: DispatchSourceTimer?
        func start(sampleRate: Double, onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
                   onInterruption: @escaping () -> Void) throws {
            let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "mic"))
            timer.schedule(deadline: .now(), repeating: 0.1, leeway: .milliseconds(2))
            timer.setEventHandler {
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
                buffer.frameLength = 4800
                let samples = buffer.floatChannelData![0]
                for i in 0..<4800 { samples[i] = Float.random(in: -0.003...0.003) }
                onBuffer(buffer)
            }
            self.timer = timer
            timer.resume()
        }
        func stop() { timer?.cancel(); timer = nil }
    }

    func testUploadStallMidRecording() throws {
        guard let raw = ProcessInfo.processInfo.environment["VOICE_STALL_REPRO_URL"],
              let url = URL(string: raw) else { throw XCTSkip("set VOICE_STALL_REPRO_URL") }
        let holdSeconds = Double(ProcessInfo.processInfo.environment["VOICE_STALL_HOLD_S"] ?? "16") ?? 16
        let t0 = ProcessInfo.processInfo.systemUptime
        let stamp = { String(format: "%6.2fs", ProcessInfo.processInfo.systemUptime - t0) }
        let transport = TimedTransport(url: url, t0: t0)
        let terminal = expectation(description: "terminal")
        var failure: String?
        let session = VoiceInputSession(
            configuration: VoiceInputConfiguration(gatewayURL: url, userID: "repro"),
            transport: transport, capture: SteadyMic(),
            onEvent: { event in
                switch event {
                case .failed(let reason):
                    print("[client \(stamp())] FAILED: \(reason)"); failure = reason; terminal.fulfill()
                case .final(let text, _):
                    print("[client \(stamp())] final: \(text)"); terminal.fulfill()
                case .gatewayReady: print("[client \(stamp())] gateway ready")
                default: break
                }
            },
            log: { line in
                if !line.contains("event=first_audio") { print("[client \(stamp())] \(line.replacingOccurrences(of: #"connection=\S+ recording=\S+ "#, with: "", options: .regularExpression))") }
            })
        session.startCapture(context: [:], vocabulary: [])
        // Keep "holding the button" like a long utterance, then release.
        DispatchQueue.global().asyncAfter(deadline: .now() + holdSeconds) {
            print("[client \(stamp())] user releases button")
            session.stopCapture()
        }
        wait(for: [terminal], timeout: holdSeconds + 30)
        session.close()
        print(String(format: "[client] max send-completion latency: %.2fs, audio sends completed: %d",
                     transport.maxSendLatency, transport.completedAudioSends))
        print("[client] outcome: \(failure ?? "success")")
    }
}
