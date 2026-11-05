import AVFoundation
import Foundation
import VoiceInputCore

struct LiveVoiceInputAudioPolicy: VoiceInputAudioPolicy {
    var hasInputDevice: Bool {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return false }
        #endif
        return VoiceAudioInputAvailability.isAvailable
    }

    var permission: VoiceMicrophonePermission {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return .denied }
        #endif
        #if os(macOS)
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .notDetermined: return .undetermined
        default: return .denied
        }
        #else
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .undetermined: return .undetermined
        default: return .denied
        }
        #endif
    }

    func requestPermission() async -> Bool {
        switch permission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            #if os(macOS)
            return await AVCaptureDevice.requestAccess(for: .audio)
            #else
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
            #endif
        }
    }

    func activate() -> Bool {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return false }
        #endif
        #if os(iOS)
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try audio.setActive(true)
            return true
        } catch {
            KLog.d("🎙️ [voice] audio-session activation failed: \(error.localizedDescription)")
            return false
        }
        #else
        // No audio session on the Mac: lower other sounds ourselves.
        MacOutputVolumeDucker.shared.scheduleLowering()
        return true
        #endif
    }

    func deactivate() {
        #if DEBUG
        guard NativeTestRuntime.allowsLiveAudio else { return }
        #endif
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #else
        MacOutputVolumeDucker.shared.restore(reason: "recording ended")
        #endif
    }
}


/// Default: nothing to do when the microphone stops (iOS releases the audio
/// session, which ends ducking, when the recording is cleaned up).
extension VoiceInputAudioPolicy {
    func captureEnded() {}
}

extension LiveVoiceInputAudioPolicy {
    /// Mac: other sounds come back as soon as the microphone stops, not
    /// after the transcript is corrected.
    func captureEnded() {
        #if os(macOS)
        MacOutputVolumeDucker.shared.restore(reason: "capture stopped")
        #endif
    }
}
