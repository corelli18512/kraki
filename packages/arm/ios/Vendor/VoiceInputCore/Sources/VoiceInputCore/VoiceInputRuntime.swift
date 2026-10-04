import AVFoundation
import Foundation
import VoiceAudioSafety

// Internal dependency boundaries also let the real session state machine run in
// tests without requesting permission, opening hardware or creating a socket.
protocol VoiceInputTransport: AnyObject {
    func resume()
    func send(_ message: URLSessionWebSocketTask.Message, completion: @escaping (Error?) -> Void)
    func receive(_ completion: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    func ping(_ completion: @escaping (Error?) -> Void)
    func cancel(with code: URLSessionWebSocketTask.CloseCode)
}

final class LiveVoiceInputTransport: VoiceInputTransport {
    private let task: URLSessionWebSocketTask
    init(url: URL) { task = URLSession.shared.webSocketTask(with: url) }
    func resume() { task.resume() }
    func send(_ message: URLSessionWebSocketTask.Message, completion: @escaping (Error?) -> Void) {
        task.send(message, completionHandler: completion)
    }
    func receive(_ completion: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        task.receive(completionHandler: completion)
    }
    func ping(_ completion: @escaping (Error?) -> Void) { task.sendPing(pongReceiveHandler: completion) }
    func cancel(with code: URLSessionWebSocketTask.CloseCode) { task.cancel(with: code, reason: nil) }
}

protocol VoiceInputCapture: AnyObject {
    func start(sampleRate: Double, onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
               onInterruption: @escaping () -> Void) throws
    func stop()
}

final class LiveVoiceInputCapture: VoiceInputCapture {
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []

    func start(sampleRate: Double, onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
               onInterruption: @escaping () -> Void) throws {
        #if os(iOS)
        let permitted = AVAudioApplication.shared.recordPermission == .granted
        #else
        let permitted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        #endif
        guard permitted else {
            throw NSError(domain: "VoiceAudioCapture", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "microphone permission not granted"
            ])
        }
        guard VoiceAudioInputAvailability.isAvailable else {
            throw NSError(domain: "VoiceAudioCapture", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "audio input unavailable"
            ])
        }
        // All graph ownership lives on the session's serial queue. A fresh
        // engine per recording does not reuse a graph invalidated by a route change.
        let engine = AVAudioEngine()
        var error: NSError?
        guard VICStartAudioEngine(engine, sampleRate, { buffer, _ in onBuffer(buffer) }, &error) else {
            throw error ?? NSError(domain: "VoiceAudioCapture", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "audio input unavailable"
            ])
        }
        self.engine = engine
        let center = NotificationCenter.default
        // Subscribe after our own graph setup. Never tear an engine down on
        // CoreAudio's notification queue (Apple documents a deadlock there).
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange,
                                             object: engine, queue: nil) { _ in onInterruption() })
        #if os(iOS)
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                             object: nil, queue: nil) { note in
            if let value = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
               value == AVAudioSession.InterruptionType.began.rawValue { onInterruption() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                             object: nil, queue: nil) { _ in onInterruption() })
        #endif
    }

    func stop() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let engine { VICStopAudioEngine(engine) }
        engine = nil
    }

    deinit { stop() }
}
