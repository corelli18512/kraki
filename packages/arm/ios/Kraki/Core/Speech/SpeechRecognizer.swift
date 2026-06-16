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

    /// Captured error code from the most recent recognition task. Set
    /// by the task callback in `beginRecognition`. The toggle gate in
    /// `MessageInputView` consults this AND probes `isAvailable` to
    /// detect "Dictation disabled at iOS level" — `isAvailable` is
    /// optimistic (returns true even when the global Dictation toggle
    /// is off), so the post-recording error is the reliable signal.
    /// Stays true across recordings within a session; reset by
    /// `clearRecognizerError()` on app foreground so a user who toggled
    /// Dictation on while away gets a fresh chance.
    var dictationDisabled: Bool = false

    /// Reset the dictation-disabled latch. Called on app foreground.
    func clearRecognizerError() {
        dictationDisabled = false
        error = nil
    }

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
            // Toggle from the input bar maps to the graceful finish
            // path so partial speech right at the moment of tap still
            // lands in `transcript`.
            finishRecording()
        } else {
            startRecording()
        }
    }

    func startRecording() {
        NSLog("[VOICE] startRecording called isRecording=\(isRecording)")
        guard !isRecording else { return }
        error = nil

        SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
            DispatchQueue.main.async {
                NSLog("[VOICE] auth status = \(authStatus.rawValue)")
                switch authStatus {
                case .authorized:
                    self?.requestMicAndStart()
                case .denied, .restricted:
                    NSLog("[VOICE] auth denied")
                    self?.error = "Speech recognition permission denied. Enable it in Settings → Privacy."
                case .notDetermined:
                    NSLog("[VOICE] auth notDetermined")
                    self?.error = "Speech recognition permission not determined."
                @unknown default:
                    self?.error = "Speech recognition unavailable."
                }
            }
        }
    }

    /// Graceful stop. Tells the recognizer "no more audio" and lets
    /// the task deliver its final result, which fills out
    /// `transcript` with the last partial that would otherwise be
    /// lost. `await`s the final result up to a short timeout — past
    /// that we hard-cancel so we don't leak the audio session
    /// indefinitely if the recognizer never replies.
    ///
    /// This is the correct path for normal push-to-talk release. The
    /// previous implementation called `recognitionTask.cancel()`
    /// immediately after `endAudio()`, which aborted the final-result
    /// callback inside Apple's framework — exactly the trailing
    /// speech the user just spoke. That's why on-release sends were
    /// silently dropping their captured text.
    @MainActor
    func finishRecording() async {
        NSLog("[VOICE] finishRecording entry isRecording=\(isRecording) transcript=\"\(transcript)\"")
        guard isRecording else { return }
        silenceTimer?.invalidate()
        silenceTimer = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        NSLog("[VOICE] finishRecording endAudio called, awaiting isFinal callback…")

        let deadline = Date().addingTimeInterval(Self.finishTimeout)
        var pollCount = 0
        while isRecording, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(40))
            pollCount += 1
        }
        NSLog("[VOICE] finishRecording polled \(pollCount)x; isRecording=\(isRecording) transcript=\"\(transcript)\"")

        if isRecording {
            NSLog("[VOICE] finishRecording TIMEOUT — forcing teardown")
            recognitionTask?.cancel()
            recognitionTask = nil
            recognitionRequest = nil
            isRecording = false
        }
        deactivateAudioSession()
    }

    /// Fire-and-forget overload for non-async call sites that don't
    /// need to read the transcript synchronously. Uses a detached
    /// task so the callback ordering matches the original
    /// `stopRecording`.
    func finishRecording() {
        Task { @MainActor in await self.finishRecording() }
    }

    /// Hard cancel. Discards anything in flight including any
    /// transcript that arrived. Use this for the cancel-arm path
    /// (user dragged up past threshold) where we don't want to keep
    /// their last words at all.
    func cancelRecording() {
        guard isRecording else { return }
        teardown()
        transcript = ""
    }

    /// Backwards-compat alias. Matches the previous behaviour
    /// (immediate cancel + cleanup) for any caller that hasn't been
    /// migrated to `finishRecording` / `cancelRecording`. Internally
    /// it's a hard cancel — preserve the historical effect.
    func stopRecording() {
        cancelRecording()
    }

    /// Private teardown — releases the audio session, engine,
    /// request, and task. Does NOT touch `transcript`. Called from
    /// both the graceful and the hard paths AND from the recognizer's
    /// own `isFinal` callback (which has just written the final
    /// transcript and must not have it wiped).
    private func teardown() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        isRecording = false
        deactivateAudioSession()
    }

    private static let finishTimeout: TimeInterval = 1.5

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

        // Let Apple choose between on-device and cloud recognition.
        //
        // The previous default of `requiresOnDeviceRecognition = true`
        // is the documented cause of the "Siri and Dictation are
        // disabled" error (kAFAssistantErrorDomain code 1101) on
        // devices where the on-device speech model isn't fully
        // configured — even when Dictation IS enabled. Apple's dev
        // forum thread on this confirms: on-device-only mode imposes
        // strict setup requirements (language pack downloaded, Siri
        // configured for that language, etc.) that are invisible to
        // `isAvailable` and silently fail at recognition time.
        //
        // Leaving this unset (i.e., false) lets the framework fall
        // back to Apple's cloud recognition when on-device isn't
        // ready. This works on every device with Dictation enabled
        // and a network connection — the standard expectation users
        // already have from the dictation keyboard.
        //
        // Revisit if we want strict on-device for offline / privacy
        // use cases. That would need an explicit user-facing opt-in
        // (Settings toggle) AND a pre-flight check that the language
        // model is downloaded before the first attempt.

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
                    let txt = result.bestTranscription.formattedString
                    let isFinal = result.isFinal
                    NSLog("[VOICE] task callback result.text=\"\(txt)\" isFinal=\(isFinal)")
                    self.transcript = txt
                    self.resetSilenceTimer()

                    if isFinal {
                        NSLog("[VOICE] task callback isFinal=true → teardown")
                        self.teardown()
                    }
                }

                if let error {
                    let nsError = error as NSError
                    if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216 {
                        NSLog("[VOICE] task callback error=216 (canceled) — ignored")
                        return
                    }
                    NSLog("[VOICE] task callback error=\(error.localizedDescription) domain=\(nsError.domain) code=\(nsError.code) isRecording=\(self.isRecording)")
                    // Latch the "Dictation disabled" condition so the
                    // mic-toggle gate can show the user a clear prompt
                    // next time they tap. The error string check is
                    // belt-and-braces — Apple has used several codes
                    // (1101, 1700) historically for the same root cause
                    // (Settings → General → Keyboard → Enable Dictation
                    // is off), but the message text "Siri and Dictation
                    // are disabled" has been stable.
                    let msg = error.localizedDescription.lowercased()
                    if msg.contains("dictation") || nsError.code == 1101 || nsError.code == 1700 {
                        NSLog("[VOICE] detected Dictation-disabled error — latching dictationDisabled=true")
                        self.dictationDisabled = true
                    }
                    if self.isRecording {
                        self.error = error.localizedDescription
                        self.cancelRecording()
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
            // Only auto-stop if we have some transcript content.
            // Graceful finish so the final partial flushes before we
            // close the recognizer — preserves the user's words.
            if !self.transcript.isEmpty {
                self.finishRecording()
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
