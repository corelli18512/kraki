#if os(iOS)
/// SpeechRecognizer — On-device streaming speech-to-text using Apple's Speech framework.
///
/// Wraps `SFSpeechRecognizer` + `AVAudioEngine` into an `@Observable` class
/// that streams partial transcription results. Prefers on-device recognition
/// for privacy (no audio leaves the device). Auto-stops after ~2s of silence.

import Foundation
import Speech
import AVFoundation
import Observation

@Observable
final class SpeechRecognizer {

    // MARK: - Observable State

    /// Live transcription (partial + final results merged).
    private(set) var transcript = ""
    private(set) var isRecording = false
    private(set) var error: String?

    var isAvailable: Bool {
        SFSpeechRecognizer(locale: Locale.current)?.isAvailable ?? false
    }

    // MARK: - Internals

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?

    private static let silenceTimeout: TimeInterval = 2.0

    // MARK: - Public API

    /// Proactively request speech-recognition + microphone permissions
    /// without starting a recording session. Useful at the moment the
    /// user toggles into voice mode, so the system permission prompts
    /// appear before they press-and-hold to talk (avoids the first
    /// press being eaten by the permission dialog or crashing because
    /// of an unavailable audio session).
    func requestPermissionsIfNeeded() {
        SFSpeechRecognizer.requestAuthorization { _ in }
        AVAudioApplication.requestRecordPermission { _ in }
    }

    func toggleRecording() {
        if isRecording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    func startRecording() {
        guard !isRecording else { return }
        error = nil

        // Request permissions sequentially
        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            DispatchQueue.main.async {
                switch authStatus {
                case .authorized:
                    self?.requestMicAndStart()
                case .denied, .restricted:
                    self?.error = "Speech recognition permission denied. Enable it in Settings → Privacy."
                case .notDetermined:
                    self?.error = "Speech recognition permission not determined."
                @unknown default:
                    self?.error = "Speech recognition unavailable."
                }
            }
        }
    }

    func stopRecording() {
        guard isRecording else { return }
        silenceTimer?.invalidate()
        silenceTimer = nil
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        isRecording = false
        deactivateAudioSession()
    }

    // MARK: - Setup

    private func requestMicAndStart() {
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                if granted {
                    self?.beginRecognition()
                } else {
                    self?.error = "Microphone permission denied. Enable it in Settings → Privacy."
                }
            }
        }
    }

    private func beginRecognition() {
        // Clean up any prior session
        recognitionTask?.cancel()
        recognitionTask = nil

        let locale = Locale.current
        recognizer = SFSpeechRecognizer(locale: locale)

        guard let recognizer, recognizer.isAvailable else {
            error = "Speech recognition not available for \(locale.identifier)."
            return
        }

        do {
            try configureAudioSession()
        } catch {
            self.error = "Audio session setup failed: \(error.localizedDescription)"
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        // Prefer on-device recognition for privacy. Both branches of
        // the previous version did the same thing; the
        // iOS-18-availability check was a no-op so we drop it.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        // Contextual strings to improve coding-related recognition
        request.contextualStrings = [
            "Copilot", "Kraki", "tentacle", "relay", "session",
            "approve", "deny", "execute", "delegate",
            "commit", "merge", "branch", "pull request",
            "refactor", "deploy", "TypeScript", "Swift", "Python",
        ]

        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            self.error = "Audio engine failed to start: \(error.localizedDescription)"
            cleanUp()
            return
        }

        transcript = ""
        isRecording = true
        resetSilenceTimer()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    self.resetSilenceTimer()

                    if result.isFinal {
                        self.stopRecording()
                    }
                }

                if let error {
                    // Ignore cancellation errors (we trigger these on stopRecording)
                    let nsError = error as NSError
                    if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216 {
                        // "Request was canceled" — expected
                        return
                    }
                    if self.isRecording {
                        self.error = error.localizedDescription
                        self.stopRecording()
                    }
                }
            }
        }
    }

    // MARK: - Silence Detection

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(
            withTimeInterval: Self.silenceTimeout,
            repeats: false
        ) { [weak self] _ in
            guard let self, self.isRecording else { return }
            // Only auto-stop if we have some transcript content
            if !self.transcript.isEmpty {
                self.stopRecording()
            } else {
                // No speech yet — give more time
                self.resetSilenceTimer()
            }
        }
    }

    // MARK: - Audio Session

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Cleanup

    private func cleanUp() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false
    }

    deinit {
        silenceTimer?.invalidate()
        recognitionTask?.cancel()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }
}

#endif
